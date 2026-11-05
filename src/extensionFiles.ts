import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { dataDir } from "./db.js";
import type { McpServers } from "./workspaceMcp.js";

export const EXTENSION_AGENTS = ["pi", "claude", "cursor", "devin", "codex"] as const;
export type ExtensionAgent = typeof EXTENSION_AGENTS[number];
type ObjectMap = Record<string, unknown>;
type Ownership = Record<string, { original?: unknown; applied: unknown; pending?: unknown; before?: unknown }>;

export function extensionPaths(home = homedir(), env = process.env) {
  const devin = process.platform === "win32"
    ? join(env.APPDATA || join(home, "AppData", "Roaming"), "devin")
    : join(env.XDG_CONFIG_HOME || join(home, ".config"), "devin");
  const pi = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const codex = env.CODEX_HOME || join(home, ".codex");
  const claude = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return {
    pi: { mcp: join(pi, "mcp.json"), skills: join(pi, "skills") },
    claude: { mcp: env.CLAUDE_CONFIG_DIR ? join(claude, ".claude.json") : join(home, ".claude.json"), skills: join(claude, "skills") },
    cursor: { mcp: join(home, ".cursor", "mcp.json"), skills: join(home, ".cursor", "skills") },
    devin: { mcp: join(devin, "mcp_config.json"), skills: join(devin, "skills") },
    codex: { mcp: join(codex, "config.toml"), skills: join(codex, "skills") },
  };
}

export function skillStore(): string { return join(dataDir(), "extensions", "skills"); }

export function objectMap(value: unknown): value is ObjectMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRegularFile(path: string): void {
  if (!existsSync(path)) {
    // existsSync follows symlinks; also reject dangling ones.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("配置文件不能是符号链接"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return;
  }
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("配置文件必须是普通文件");
}

export function readNativeConfig(path: string): ObjectMap {
  assertRegularFile(path);
  if (!existsSync(path)) return {};
  let value: unknown;
  try { value = path.endsWith(".toml") ? parse(readFileSync(path, "utf8")) : JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("现有配置格式无效，请修复后重试"); }
  if (!objectMap(value)) throw new Error("现有配置必须是对象");
  return value;
}

export function atomicWrite(path: string, text: string, backup = false): void {
  assertRegularFile(path);
  mkdirSync(dirname(path), { recursive: true });
  if (backup && existsSync(path)) atomicWrite(`${path}.agent-board.bak`, readFileSync(path, "utf8"));
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, text, { mode: 0o600, flag: "wx" });
    renameSync(staging, path);
  } finally { rmSync(staging, { force: true }); }
}

/** Journal both old and new values before writing; retries also recover interrupted writes. */
export function syncNativeMcp(path: string, desired: ObjectMap): void {
  const statePath = `${path}.agent-board.json`;
  if (!Object.keys(desired).length && !existsSync(statePath)) return;
  const config = readNativeConfig(path);
  const key = path.endsWith(".toml") ? "mcp_servers" : "mcpServers";
  const raw = config[key] ?? {};
  if (!objectMap(raw)) throw new Error("现有 MCP 服务器列表无效");
  const servers = { ...raw };
  const previous = readNativeConfig(statePath) as Ownership;
  const next: Ownership = Object.create(null);
  for (const [name, entry] of Object.entries(previous)) {
    if (!objectMap(entry) || !("applied" in entry)) throw new Error("MCP 同步记录无效");
    if (equalNativeValues(servers[name], entry.applied) || ("pending" in entry && equalNativeValues(servers[name], entry.pending)) ||
        ("before" in entry && equalNativeValues(servers[name], entry.before))) {
      if ("original" in entry) servers[name] = entry.original;
      else delete servers[name];
    } else if (Object.hasOwn(desired, name) && !equalNativeValues(servers[name], entry.original)) {
      throw new Error(`MCP ${name} 已在应用中修改，请导入或移除冲突后重试`);
    }
  }
  for (const [name, applied] of Object.entries(desired)) {
    if (!Object.hasOwn(previous, name) && Object.hasOwn(servers, name) && !sameNativeServer(servers[name], applied)) {
      throw new Error(`MCP ${name} 已存在不同配置，请先处理同名冲突`);
    }
    // An identical imported entry is adopted, so disabling it actually removes it.
    next[name] = { ...(Object.hasOwn(previous, name) && "original" in previous[name] ? { original: previous[name].original } : {}), applied };
    servers[name] = applied;
  }
  const changed = !equalNativeValues(raw, servers);
  // Keep removed entries in the journal until the native file is successfully replaced.
  const journal = { ...previous };
  for (const [name, entry] of Object.entries(next)) {
    journal[name] = Object.hasOwn(previous, name)
      ? { ...previous[name], pending: entry.applied, ...(Object.hasOwn(raw, name) ? { before: raw[name] } : {}) }
      : { ...entry, ...(Object.hasOwn(raw, name) ? { before: raw[name] } : {}) };
  }
  atomicWrite(statePath, JSON.stringify(journal, null, 2));
  if (changed) {
    const updated = { ...config, [key]: servers };
    atomicWrite(path, path.endsWith(".toml") ? stringify(updated as Parameters<typeof stringify>[0]) : `${JSON.stringify(updated, null, 2)}\n`, true);
  }
  if (Object.keys(next).length) atomicWrite(statePath, JSON.stringify(next, null, 2));
  else rmSync(statePath, { force: true });
}

// TOML tables have null prototypes; compare their values with JSON journal objects.
function equalNativeValues(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right)));
}

function sameNativeServer(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => {
    if (!objectMap(value)) return value;
    const copy = { ...value };
    if ((copy.type === "stdio" && copy.command) || (copy.type === "http" && copy.url)) delete copy.type;
    if (copy.transport === "http" && copy.url) delete copy.transport;
    return copy;
  };
  return equalNativeValues(normalize(left), normalize(right));
}

/** Cursor print mode needs explicit MCP approval for entries enabled through the board. */
export function hasManagedCursorMcp(): boolean {
  const path = extensionPaths().cursor.mcp;
  if (!existsSync(`${path}.agent-board.json`)) return false;
  const ownership = readNativeConfig(`${path}.agent-board.json`);
  const servers = readNativeConfig(path).mcpServers;
  if (!objectMap(servers)) return false;
  return Object.entries(ownership).some(([name, entry]) => objectMap(entry) && equalNativeValues(servers[name], entry.applied));
}

export function nativeMcpServers(kind: ExtensionAgent, servers: McpServers): ObjectMap {
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => {
    const { headers, ...rest } = server;
    if (kind === "codex") return [name, { ...rest, ...(headers ? { http_headers: headers } : {}) }];
    if (kind === "claude") return [name, { ...server, type: server.url ? "http" : "stdio" }];
    if (kind === "devin" && server.url) return [name, { ...server, transport: "http" }];
    return [name, server];
  }));
}

export function inspectNativeMcp(path: string, desired: ObjectMap): void {
  const statePath = `${path}.agent-board.json`;
  if (!Object.keys(desired).length && !existsSync(statePath)) return;
  const config = readNativeConfig(path);
  const raw = config[path.endsWith(".toml") ? "mcp_servers" : "mcpServers"] ?? {};
  if (!objectMap(raw)) throw new Error("现有 MCP 服务器列表无效");
  for (const [name, server] of Object.entries(desired)) {
    if (!sameNativeServer(raw[name], server)) throw new Error(`MCP ${name} 尚未同步或已在应用中修改`);
  }
  const previous = readNativeConfig(statePath);
  if (Object.keys(desired).some(name => !Object.hasOwn(previous, name))) throw new Error("MCP 已存在但尚未纳管，请重新同步");
  if (Object.keys(previous).some(name => !Object.hasOwn(desired, name))) throw new Error("存在待移除的 MCP，请重新同步");
}

function linkTarget(path: string): string | undefined {
  try { return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}

export function nativeSkillPresent(root: string, name: string): boolean {
  return existsSync(join(root, name));
}

export function managedSkillNames(root: string, store: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => {
    const target = linkTarget(join(root, name));
    return target && dirname(target) === resolve(store) && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name);
  });
}

export function inspectNativeSkills(root: string, desired: Record<string, string>, store: string): void {
  for (const [name, source] of Object.entries(desired)) {
    if (!existsSync(join(source, "SKILL.md"))) throw new Error("技能主副本丢失，请检查存储目录");
    if (!nativeSkillPresent(root, name)) throw new Error(`Skill ${name} 尚未同步`);
  }
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const target = linkTarget(join(root, name));
    if (target && dirname(target) === resolve(store) && !Object.hasOwn(desired, name)) throw new Error("存在待移除的 Skill，请重新同步");
  }
}

/** Explicit toggles replace/delete same-name entries; never follow a skill symlink when removing it. */
export function syncNativeSkills(root: string, desired: Record<string, string>, store = skillStore(), names = Object.keys(desired)): void {
  if (names.length && existsSync(root) && existsSync(store) && realpathSync(root) === realpathSync(store)) throw new Error("技能主副本不能放在目标 Agent 目录中");
  for (const name of names) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error("技能名称无效");
    const source = Object.hasOwn(desired, name) ? desired[name] : undefined;
    if (source && (!isAbsolute(source) || dirname(source) !== resolve(store))) throw new Error("技能主副本路径无效");
    const path = join(root, name);
    if (!source) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    if (resolve(path) === source) throw new Error("技能主副本不能放在目标 Agent 目录中");
    if (linkTarget(path) === source) continue;
    mkdirSync(root, { recursive: true });
    rmSync(path, { recursive: true, force: true });
    symlinkSync(source, path, process.platform === "win32" ? "junction" : "dir");
  }
}

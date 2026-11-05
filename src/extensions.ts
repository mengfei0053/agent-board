import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { getPool, upsertMetaMany } from "./db.js";
import { HttpError } from "./httpError.js";
import { resolveAllowedDirectory } from "./paths.js";
import { withSettingsLock } from "./settingsLock.js";
import { parseWorkspaceMcp, type McpServer, type McpServers } from "./workspaceMcp.js";
import { EXTENSION_AGENTS, extensionPaths, inspectNativeMcp, inspectNativeSkills, nativeMcpServers, objectMap, readNativeConfig, skillStore, syncNativeMcp, syncNativeSkills, type ExtensionAgent } from "./extensionFiles.js";

const execFileAsync = promisify(execFile);
const MASK = "••••••••";
const META_KEY = "extensions";
type McpEntry = { name: string; config: McpServer; apps: ExtensionAgent[] };
type SkillEntry = { name: string; description: string; source: string; apps: ExtensionAgent[] };
export type ExtensionCatalog = { revision: number; mcp: McpEntry[]; skills: SkillEntry[] };
type SyncResult = { agent: ExtensionAgent; resource: "mcp" | "skills"; ok: boolean; error?: string };
type Dependencies = {
  load: () => Promise<ExtensionCatalog>;
  save: (catalog: ExtensionCatalog) => Promise<void>;
  paths: ReturnType<typeof extensionPaths>;
  store: string;
};

function nameOf(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value) || ["constructor", "prototype"].includes(value)) {
    throw new HttpError(400, "名称须为 1–80 位字母、数字、下划线或连字符");
  }
  return value;
}

function appsOf(value: unknown): ExtensionAgent[] {
  if (!Array.isArray(value) || value.some(v => !(EXTENSION_AGENTS as readonly unknown[]).includes(v))) {
    throw new HttpError(400, "请选择有效的目标 Agent");
  }
  return [...new Set(value)] as ExtensionAgent[];
}

function maskConfig(config: McpServer): McpServer {
  const result = structuredClone(config);
  for (const key of ["env", "headers"] as const) {
    if (result[key]) result[key] = Object.fromEntries(Object.keys(result[key]!).map(name => [name, MASK]));
  }
  return result;
}

function parseConfig(name: string, raw: unknown, previous?: McpServer): McpServer {
  if (!objectMap(raw)) throw new HttpError(400, "MCP 配置必须是 JSON 对象");
  const config = structuredClone(raw);
  for (const key of ["env", "headers"] as const) {
    if (!objectMap(config[key])) continue;
    for (const [field, value] of Object.entries(config[key])) {
      if (value !== MASK) continue;
      if (!previous?.[key] || !Object.hasOwn(previous[key]!, field)) throw new HttpError(400, "新凭据不能使用隐藏占位符");
      config[key][field] = previous[key]![field];
    }
  }
  return parseWorkspaceMcp(JSON.stringify({ mcpServers: { [name]: config } }))![name];
}

/** Copy complete skill packages while bounding size and rejecting links outside the package. */
function copySkill(source: string, destination: string): void {
  const root = realpathSync(source);
  let count = 0;
  let bytes = 0;
  const visit = (from: string, to: string, ancestors: Set<string>) => {
    const real = realpathSync(from);
    if (real !== root && !real.startsWith(root + sep)) throw new HttpError(400, "Skill 包含指向目录外的符号链接");
    if (ancestors.has(real)) throw new HttpError(400, "Skill 包含循环符号链接");
    const stat = statSync(real);
    if (++count > 2000 || (bytes += stat.isFile() ? stat.size : 0) > 20 * 1024 * 1024) throw new HttpError(413, "Skill 超过 2000 个文件或 20 MB");
    if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      const next = new Set(ancestors).add(real);
      for (const name of readdirSync(real)) {
        if (name !== ".git" && name !== "node_modules") visit(join(real, name), join(to, name), next);
      }
    } else if (stat.isFile()) {
      copyFileSync(real, to);
      chmodSync(to, stat.mode & 0o777);
    } else throw new HttpError(400, "Skill 只能包含普通文件和目录");
  };
  visit(root, destination, new Set());
}

export class ExtensionManager {
  private results: SyncResult[] = [];
  constructor(private deps: Dependencies) {}

  async document() {
    const catalog = await this.deps.load();
    return {
      ...catalog,
      mcp: catalog.mcp.map(entry => ({ ...entry, config: maskConfig(entry.config) })),
      agents: EXTENSION_AGENTS.map(id => ({ id, ...this.deps.paths[id] })),
      skillStore: this.deps.store,
      syncResults: this.sync(catalog, true).map(result => {
        const previous = this.results.find(entry => entry.agent === result.agent && entry.resource === result.resource && !entry.ok);
        return !result.ok && previous ? previous : result;
      }),
    };
  }

  mutate(action: string, body: Record<string, unknown>) {
    return withSettingsLock(async () => {
      const catalog = structuredClone(await this.deps.load());
      if (body.revision !== catalog.revision) throw new HttpError(409, "配置已被其他页面修改，请重新加载后重试");
      let rollbackInstall: (() => void) | undefined;
      if (action === "save-mcp") this.saveMcp(catalog, body);
      else if (action === "set-apps") this.setApps(catalog, body);
      else if (action === "delete") this.remove(catalog, body);
      else if (action === "import-mcp") this.importMcp(catalog, body);
      else if (action === "install-skill") rollbackInstall = await this.installSkill(catalog, body);
      else if (action !== "sync") throw new HttpError(404, "未知扩展操作");
      if (action !== "sync") {
        catalog.revision++;
        try { await this.deps.save(catalog); }
        catch { rollbackInstall?.(); throw new HttpError(500, "扩展配置保存失败，请重试"); }
      }
      this.results = this.sync(catalog);
      return this.document();
    });
  }

  private saveMcp(catalog: ExtensionCatalog, body: Record<string, unknown>) {
    const name = nameOf(body.name);
    const index = catalog.mcp.findIndex(entry => entry.name === name);
    if (index < 0 && catalog.mcp.length >= 200) throw new HttpError(400, "最多管理 200 个 MCP");
    if (index < 0 && catalog.mcp.some(entry => entry.name.replaceAll("-", "_") === name.replaceAll("-", "_"))) {
      throw new HttpError(400, "MCP 名称不能仅以连字符和下划线区分");
    }
    const entry = { name, config: parseConfig(name, body.config, catalog.mcp[index]?.config), apps: appsOf(body.apps) };
    if (index >= 0) catalog.mcp[index] = entry;
    else catalog.mcp.push(entry);
  }

  private setApps(catalog: ExtensionCatalog, body: Record<string, unknown>) {
    if (body.resource !== "mcp" && body.resource !== "skills") throw new HttpError(400, "无效的资源类型");
    const entry = catalog[body.resource].find(entry => entry.name === body.name);
    if (!entry) throw new HttpError(404, "条目不存在");
    entry.apps = appsOf(body.apps);
  }

  private remove(catalog: ExtensionCatalog, body: Record<string, unknown>) {
    if (body.resource !== "mcp" && body.resource !== "skills") throw new HttpError(400, "无效的资源类型");
    const entries = catalog[body.resource];
    const index = entries.findIndex(entry => entry.name === body.name);
    if (index < 0) throw new HttpError(404, "条目不存在");
    // Keep private skill copies for recovery; only the catalog and managed links are removed.
    entries.splice(index, 1);
  }

  private importMcp(catalog: ExtensionCatalog, body: Record<string, unknown>) {
    const [agent] = appsOf([body.agent]);
    const config = readNativeConfig(this.deps.paths[agent].mcp);
    const raw = config[agent === "codex" ? "mcp_servers" : "mcpServers"] ?? {};
    if (!objectMap(raw)) throw new HttpError(400, "应用的 MCP 配置无效");
    // Validate the whole import before changing the catalog. Never silently discard auth options.
    for (const [name, value] of Object.entries(raw)) {
      if (!objectMap(value)) throw new HttpError(400, "应用的 MCP 条目无效");
      const { type, transport, http_headers, ...rest } = value;
      if ((type && !["stdio", "http", "streamable-http"].includes(String(type))) || (transport && !["http", "stdio"].includes(String(transport)))) {
        throw new HttpError(400, `MCP ${name} 使用暂不支持的传输类型`);
      }
      const server = { ...rest, ...(http_headers ? { headers: http_headers } : {}) };
      const previous = catalog.mcp.find(entry => entry.name === name);
      if (previous && !isDeepStrictEqual(previous.config, parseConfig(name, server))) {
        throw new HttpError(409, `MCP ${name} 与管理中心同名但配置不同，请先处理冲突`);
      }
      this.saveMcp(catalog, { name, config: server, apps: [...new Set([...(previous?.apps ?? []), agent])] });
    }
  }

  private async installSkill(catalog: ExtensionCatalog, body: Record<string, unknown>) {
    const apps = appsOf(body.apps);
    let source: string;
    let temporary: string | undefined;
    let label: string;
    try {
      if (typeof body.url === "string" && body.url.trim()) {
        const url = body.url.trim();
        if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/.test(url)) throw new HttpError(400, "请输入 GitHub HTTPS 仓库地址");
        const ref = typeof body.ref === "string" ? body.ref.trim() : "";
        if (ref && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(ref) || ref.includes(".."))) throw new HttpError(400, "分支名称无效");
        temporary = mkdtempSync(join(tmpdir(), "agent-board-skills-"));
        const repo = join(temporary, "repo");
        try {
          await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--single-branch", ...(ref ? ["--branch", ref] : []), "--", url, repo], {
            timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
          });
        } catch { throw new HttpError(400, "无法下载技能仓库，请检查地址、分支与网络"); }
        const subdir = typeof body.subdir === "string" ? body.subdir.trim() : "";
        source = resolve(repo, subdir);
        if (source !== repo && !source.startsWith(repo + sep)) throw new HttpError(400, "技能路径必须在仓库内");
        if (!existsSync(source)) throw new HttpError(400, "仓库内未找到技能目录");
        source = realpathSync(source);
        if (source !== repo && !source.startsWith(repo + sep)) throw new HttpError(400, "技能路径必须在仓库内");
        label = `${url}${ref ? `#${ref}` : ""}${subdir ? `:${subdir}` : ""}`;
      } else {
        if (typeof body.path !== "string") throw new HttpError(400, "请输入技能目录或 GitHub 仓库地址");
        const requested = resolve(body.path);
        const managedCopy = dirname(requested) === resolve(this.deps.store) && existsSync(requested) && dirname(realpathSync(requested)) === resolve(this.deps.store);
        source = managedCopy ? realpathSync(requested) : resolveAllowedDirectory(body.path, "Skill 目录");
        label = source;
      }
      const skillFile = join(source, "SKILL.md");
      if (!existsSync(skillFile) || !statSync(skillFile).isFile() || statSync(skillFile).size > 256 * 1024) throw new HttpError(400, "目录须包含不超过 256 KB 的 SKILL.md");
      if (!realpathSync(skillFile).startsWith(source + sep)) throw new HttpError(400, "SKILL.md 必须在技能目录内");
      const content = readFileSync(skillFile, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
      if (!frontmatter || !/^name:[ \t]*\S+/m.test(frontmatter) || !/^description:[ \t]*\S+/m.test(frontmatter)) throw new HttpError(400, "SKILL.md 须包含 name 和 description frontmatter");
      const name = nameOf(body.name || basename(source));
      const target = join(this.deps.store, name);
      const restoring = source === target;
      if (catalog.skills.some(entry => entry.name === name) || (!restoring && existsSync(target))) throw new HttpError(409, "技能名称已存在（包括保留的主副本），请使用其他名称或从本机导入恢复主副本");
      if (catalog.skills.length >= 200) throw new HttpError(400, "最多管理 200 个 Skill");
      mkdirSync(this.deps.store, { recursive: true });
      if (!restoring) {
        const staging = mkdtempSync(join(this.deps.store, ".install-"));
        try {
          copySkill(source, join(staging, "skill"));
          renameSync(join(staging, "skill"), target);
        } finally { rmSync(staging, { recursive: true, force: true }); }
      }
      catalog.skills.push({ name, description: (/^description:[ \t]*(.+)$/m.exec(frontmatter)?.[1] ?? "").slice(0, 300), source: label, apps });
      return restoring ? undefined : () => rmSync(target, { recursive: true, force: true });
    } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
  }

  private sync(catalog: ExtensionCatalog, inspect = false): SyncResult[] {
    const results: SyncResult[] = [];
    for (const agent of EXTENSION_AGENTS) {
      for (const resource of ["mcp", "skills"] as const) {
        try {
          if (resource === "mcp") {
            const servers = Object.fromEntries(catalog.mcp.filter(entry => entry.apps.includes(agent)).map(entry => [entry.name, entry.config])) as McpServers;
            (inspect ? inspectNativeMcp : syncNativeMcp)(this.deps.paths[agent].mcp, nativeMcpServers(agent, servers));
          } else {
            const skills = Object.fromEntries(catalog.skills.filter(entry => entry.apps.includes(agent)).map(entry => [entry.name, join(this.deps.store, entry.name)]));
            for (const path of Object.values(skills)) if (!existsSync(join(path, "SKILL.md"))) throw new Error("技能主副本丢失，请检查存储目录");
            (inspect ? inspectNativeSkills : syncNativeSkills)(this.deps.paths[agent].skills, skills, this.deps.store);
          }
          results.push({ agent, resource, ok: true });
        } catch (error) {
          results.push({ agent, resource, ok: false, error: error instanceof Error ? error.message : "同步失败" });
        }
      }
    }
    return results;
  }

  async discoverSkills() {
    const catalog = await this.deps.load();
    const entries: { agent: ExtensionAgent | "board"; name: string; path: string }[] = [];
    for (const agent of EXTENSION_AGENTS) {
      const root = this.deps.paths[agent].skills;
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (name.startsWith(".") || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) continue;
        const path = join(root, name);
        if (!existsSync(join(path, "SKILL.md"))) continue;
        if (dirname(realpathSync(path)) === resolve(this.deps.store)) continue;
        entries.push({ agent, name, path });
      }
    }
    if (existsSync(this.deps.store)) {
      for (const name of readdirSync(this.deps.store)) {
        if (name.startsWith(".") || catalog.skills.some(entry => entry.name === name)) continue;
        const path = join(this.deps.store, name);
        if (existsSync(join(path, "SKILL.md"))) entries.push({ agent: "board", name, path });
      }
    }
    return entries;
  }
}

let manager: ExtensionManager | undefined;
export function setExtensionManagerForTests(value: ExtensionManager | undefined): void { manager = value; }
export function extensionManager(): ExtensionManager {
  return manager ??= new ExtensionManager({
    paths: extensionPaths(), store: skillStore(),
    async load() {
      const result = await getPool().query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [META_KEY]);
      return result.rows[0] ? JSON.parse(result.rows[0].value) as ExtensionCatalog : { revision: 0, mcp: [], skills: [] };
    },
    async save(catalog) { await upsertMetaMany([[META_KEY, JSON.stringify(catalog)]]); },
  });
}

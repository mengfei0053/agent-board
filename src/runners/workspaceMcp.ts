import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CliCommandKey } from "../cliPaths.js";
import { parseWorkspaceMcp, type McpServers } from "../workspaceMcp.js";

type JsonObject = Record<string, unknown>;
type ManagedEntry = { original?: unknown; applied: unknown };

function readObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  if (lstatSync(path).isSymbolicLink()) throw new Error(`MCP config must not be a symlink: ${path}`);
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Invalid MCP JSON file: ${path}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected MCP object: ${path}`);
  return value as JsonObject;
}

function writeObject(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(staging, path);
  } finally { rmSync(staging, { force: true }); }
}

/** Retain pre-existing servers and restore only entries still owned by the board. */
export function syncProjectMcp(path: string, desired: JsonObject): void {
  const statePath = `${path}.agent-board.json`;
  if (!Object.keys(desired).length && !existsSync(statePath)) return;
  const config = readObject(path);
  const rawServers = config.mcpServers ?? {};
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) throw new Error(`Invalid mcpServers: ${path}`);
  const servers = { ...rawServers } as JsonObject;
  const previous = readObject(statePath) as Record<string, ManagedEntry>;
  const next: Record<string, ManagedEntry> = Object.create(null);
  for (const [name, entry] of Object.entries(previous)) {
    if (!entry || typeof entry !== "object" || !("applied" in entry)) throw new Error(`Invalid MCP ownership file: ${statePath}`);
    if (isDeepStrictEqual(servers[name], entry.applied)) {
      if ("original" in entry) servers[name] = entry.original;
      else delete servers[name];
    } else if (Object.hasOwn(desired, name) && !isDeepStrictEqual(servers[name], entry.original)) {
      throw new Error(`MCP server ${name} was edited outside agent-board: ${path}`);
    }
  }
  for (const [name, applied] of Object.entries(desired)) {
    next[name] = { ...(Object.hasOwn(servers, name) ? { original: servers[name] } : {}), applied };
    servers[name] = applied;
  }
  // Record ownership before replacing the native config so a failed write is recoverable.
  // Keep old ownership while clearing; remove it only after restoring the config.
  if (Object.keys(next).length) writeObject(statePath, next);
  if (!isDeepStrictEqual(config.mcpServers, servers)) writeObject(path, { ...config, mcpServers: servers });
  if (!Object.keys(next).length) rmSync(statePath, { force: true });
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }`;
  }
  return JSON.stringify(value);
}

export type PreparedMcp = { args: string[]; cleanup: () => void; serverNames: string[] };

/** Called for every launch, including resume, before the agent can read its configuration. */
export function prepareWorkspaceMcp(kind: CliCommandKey, cwd: string, raw?: string): PreparedMcp {
  const servers: McpServers = parseWorkspaceMcp(raw) ?? {};
  const serverNames = Object.keys(servers);
  const result: PreparedMcp = { args: [], cleanup() {}, serverNames };
  if (kind === "agent" || kind === "devin") {
    const desired = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name,
      kind === "devin" ? { ...server, transport: server.url ? "http" : "stdio" } : server,
    ]));
    const path = kind === "agent" ? join(cwd, ".cursor", "mcp.json") : join(cwd, ".devin", "mcp_config.local.json");
    syncProjectMcp(path, desired);
    if (kind === "agent" && serverNames.length) result.args.push("--approve-mcps");
    return result;
  }
  if (!serverNames.length) return result;
  if (kind === "codex") {
    // Codex merges CLI overrides with existing same-name entries (including auth fields).
    for (const [name, server] of Object.entries(servers)) {
      const { headers, ...rest } = server;
      result.args.push("-c", `mcp_servers.${name}=${toml({ ...rest, ...(headers ? { http_headers: headers } : {}) })}`);
    }
    return result;
  }
  if (kind !== "claude" && kind !== "pi") throw new Error(`Workspace MCP is not supported for ${kind}`);
  const dir = mkdtempSync(join(tmpdir(), "agent-board-mcp-"));
  result.cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const nativeServers = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name,
      kind === "claude" ? { ...server, type: server.url ? "http" : "stdio" } : server,
    ]));
    const path = join(dir, "mcp.json");
    writeObject(path, { mcpServers: nativeServers });
    result.args.push("--mcp-config", path);
    return result;
  } catch (error) { result.cleanup(); throw error; }
}

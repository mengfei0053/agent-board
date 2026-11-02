import { HttpError } from "./httpError.js";

export type McpServer = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};
export type McpServers = Record<string, McpServer>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(detail: string): never {
  throw new HttpError(400, `settings.mcp: ${detail}`);
}

function stringMap(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!object(value) || Object.values(value).some((v) => typeof v !== "string" || v.includes("\0"))) {
    invalid(`${field} must be an object of strings`);
  }
  return value as Record<string, string>;
}

function parseServer(raw: unknown, name: string): McpServer {
  if (!object(raw)) invalid(`${name} must be an object`);
  const allowed = new Set(["command", "args", "env", "url", "headers", "type"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) invalid(`${name} contains unsupported fields`);
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (Boolean(command) === Boolean(url)) invalid(`${name} needs exactly one of command or url`);
  if (command.includes("\0") || url.includes("\0")) invalid(`${name} contains NUL`);
  if (command) {
    if (raw.url !== undefined || raw.headers !== undefined || (raw.type !== undefined && raw.type !== "stdio")) {
      invalid(`${name}: stdio supports command, args and env`);
    }
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((v) => typeof v !== "string" || v.includes("\0")))) {
      invalid(`${name}.args must be an array of strings`);
    }
    return { command, ...(raw.args ? { args: raw.args as string[] } : {}), ...(raw.env !== undefined ? { env: stringMap(raw.env, `${name}.env`) } : {}) };
  }
  if (raw.command !== undefined || raw.args !== undefined || raw.env !== undefined ||
      (raw.type !== undefined && raw.type !== "http" && raw.type !== "streamable-http")) {
    invalid(`${name}: remote servers support HTTP url and headers`);
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) invalid(`${name}: use an HTTP(S) URL without credentials`);
  } catch { invalid(`${name}: invalid HTTP(S) URL`); }
  return { url, ...(raw.headers !== undefined ? { headers: stringMap(raw.headers, `${name}.headers`) } : {}) };
}

/** Plain text remains a prompt note; JSON is executable configuration and must validate. */
export function parseWorkspaceMcp(text: string | undefined): McpServers | undefined {
  const value = text?.trim();
  if (!value || !/^[\[{]/.test(value)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(value); } catch { invalid("invalid JSON"); }
  if (!object(raw) || !object(raw.mcpServers) || Object.keys(raw).some((key) => key !== "mcpServers")) {
    invalid('expected {"mcpServers":{"name":{"url":"https://…/mcp"}}}');
  }
  const servers: McpServers = Object.create(null);
  const names = new Set<string>();
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    const canonical = name.replaceAll("-", "_");
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || ["__proto__", "constructor", "prototype"].includes(name) || names.has(canonical)) {
      invalid("server names must be unique letters, digits, underscores or hyphens");
    }
    names.add(canonical);
    servers[name] = parseServer(entry, name);
  }
  return servers;
}

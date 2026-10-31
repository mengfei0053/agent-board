/** Wire types shared with the Android `protocol` module. */

export const PROTOCOL_VERSION = 1;
export const AGENT_KINDS = ["pi", "claude", "cursor", "devin", "codex"] as const;
export const TASK_STATUSES = new Set(["queued", "running", "paused", "succeeded", "failed", "stopped"]);
export const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped"]);
export const PRE_STORE_CODES = new Set([
  "board_offline",
  "forbidden",
  "unauthorized",
  "bad_request",
  "rate_limited",
]);

const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VISIBLE_KEY = /^[\x21-\x7E]{8,80}$/;

export type Envelope = {
  v: number;
  id: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
};

export function encode(message: Envelope): string {
  return JSON.stringify(message);
}

export function parseEnvelope(text: string): Envelope {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("message is not JSON");
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("message must be an object");
  const obj = root as Record<string, unknown>;
  if (obj.v !== 1) throw new Error(obj.v == null ? "v is required" : "unsupported protocol version");
  if (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 100 || /[^\x21-\x7E]/.test(obj.id)) {
    throw new Error("id must be 1-100 visible ASCII characters");
  }
  if (typeof obj.type !== "string" || !obj.type) throw new Error("type is required");
  if (typeof obj.ts !== "number") throw new Error("ts is required");
  const payload = obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
    ? (obj.payload as Record<string, unknown>)
    : {};
  return { v: 1, id: obj.id, type: obj.type, ts: obj.ts, payload };
}

export function frame(type: string, payload: Record<string, unknown>, id = newId("m")): Envelope {
  return { v: PROTOCOL_VERSION, id, type, ts: Date.now(), payload };
}

export function newId(prefix: string): string {
  return prefix + crypto.randomUUID().replace(/-/g, "");
}

export function text(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

export function validBoardId(value: string): boolean {
  return BOARD_ID.test(value);
}

export function validKey(value: string): boolean {
  return VISIBLE_KEY.test(value);
}

export function isLocalPath(value: string): boolean {
  if (!value.trim() || value.length > 1024) return false;
  if ([...value].some((ch) => ch < " " || ch === "\u007f")) return false;
  return !value.includes("://");
}

export function validateCreate(payload: Record<string, unknown>): string | null {
  const boardId = text(payload, "boardId") ?? "";
  const title = (text(payload, "title") ?? "").trim();
  const prompt = (text(payload, "prompt") ?? "").trim();
  const agent = text(payload, "agent") ?? "";
  const cwd = text(payload, "cwd") ?? "";
  const key = text(payload, "idempotencyKey") ?? "";
  if (!validBoardId(boardId)) return "boardId must be 1-64 letters, digits, '.', '_' or '-'";
  if (!title || title.length > 200) return "title is required, up to 200 characters";
  if (!prompt || prompt.length > 20_000) return "prompt is required, up to 20000 characters";
  if (!(AGENT_KINDS as readonly string[]).includes(agent)) return `agent must be one of ${AGENT_KINDS.join(", ")}`;
  if (!isLocalPath(cwd)) return "cwd is required and must be a local path";
  if (!validKey(key)) return "idempotencyKey must be 8-80 visible ASCII characters";
  return null;
}

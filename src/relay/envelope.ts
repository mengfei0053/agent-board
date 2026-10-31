import { RELAY_LIMITS } from "./limits.js";

export const PROTOCOL_VERSION = 1;

export type Envelope = {
  v: number;
  id: string;
  type: string;
  ts: number;
  payload: Record<string, unknown>;
};

export function newMessageId(prefix: string): string {
  const id = prefix + crypto.randomUUID().replace(/-/g, "");
  return id.length <= 100 ? id : id.slice(0, 100);
}

export function frame(
  type: string,
  payload: Record<string, unknown>,
  id = newMessageId("m"),
): Envelope {
  return { v: PROTOCOL_VERSION, id, type, ts: Date.now(), payload };
}

export function encodeFrame(message: Envelope): string {
  return JSON.stringify(message);
}

export function parseEnvelope(text: string): Envelope | null {
  if (Buffer.byteLength(text) > RELAY_LIMITS.maxFrameBytes) return null;
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return null;
  const obj = root as Record<string, unknown>;
  if (obj.v !== PROTOCOL_VERSION) return null;
  if (typeof obj.id !== "string" || obj.id.length < 1 || obj.id.length > 100) return null;
  if (typeof obj.type !== "string" || !obj.type) return null;
  if (typeof obj.ts !== "number" || !Number.isFinite(obj.ts)) return null;
  const payload =
    obj.payload && typeof obj.payload === "object" && !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : {};
  return { v: PROTOCOL_VERSION, id: obj.id, type: obj.type, ts: obj.ts, payload };
}

/** Log-safe URL: scheme, host, and path. Query, hash, and userinfo are dropped. */
export function redactWsUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
}

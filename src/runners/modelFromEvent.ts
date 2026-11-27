import { fields } from "./eventFields.js";

export function modelFromJsonLine(line: string): string | undefined {
  try {
    return modelFromEvent(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export function modelFromEvent(event: unknown): string | undefined {
  const ev = fields(event);
  if (!ev) return;
  const candidates = [ev.model, ev.modelId, ev.model_name, ev.displayModelId];
  for (const name of ["message", "data", "event", "result", "session", "info", "payload", "assistantMessageEvent"]) {
    candidates.push(fields(ev[name])?.model);
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
}

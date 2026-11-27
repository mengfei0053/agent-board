import { fields } from "./eventFields.js";

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim() || undefined;
}

export function sessionFromJsonLine(line: string): string | undefined {
  try {
    return sessionFromEvent(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** Accept a resume handle only from a session-init event, not arbitrary payload ids. */
export function sessionFromEvent(event: unknown): string | undefined {
  const ev = fields(event);
  if (!ev) return;
  if (ev.type === "session" || ev.type === "session.resume_hint") {
    return clean(ev.id) || clean(ev.session_id) || clean(ev.sessionId);
  }
  if (ev.type === "thread.started" || ev.type === "thread.created") {
    return clean(ev.thread_id) || clean(ev.threadId) || clean(ev.session_id);
  }
  if (ev.type === "session_meta") {
    const payload = fields(ev.payload);
    return clean(payload?.session_id) || clean(ev.session_id) || clean(payload?.id);
  }
  if (ev.type === "system" && (ev.subtype === "init" || ev.subtype === "session")) {
    return clean(ev.session_id) || clean(ev.sessionId);
  }
}

/**
 * Session id from a CLI event that is explicitly a session-init.
 * Arbitrary events with `payload.id` are not accepted — those ids are not
 * a resume handle for this run.
 */
const SESSION_INIT_TYPES = new Set([
  "session",
  "session_meta",
  "thread.started",
  "thread.created",
]);

function clean(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

export function sessionFromJsonLine(line: string): string | undefined {
  try {
    const ev = JSON.parse(line) as Record<string, any>;
    const type = typeof ev.type === "string" ? ev.type : "";

    if (type === "session") {
      return clean(ev.id) || clean(ev.session_id) || clean(ev.sessionId);
    }
    if (type === "thread.started" || type === "thread.created") {
      return clean(ev.thread_id) || clean(ev.threadId) || clean(ev.session_id);
    }
    if (type === "session_meta") {
      return (
        clean(ev.payload?.session_id) ||
        clean(ev.session_id) ||
        clean(ev.payload?.id)
      );
    }
    if (type === "system" && (ev.subtype === "init" || ev.subtype === "session")) {
      return clean(ev.session_id) || clean(ev.sessionId);
    }
    if (!SESSION_INIT_TYPES.has(type)) return undefined;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Best-effort extract of CLI session / chat id from a stream-json line. */
export function sessionFromJsonLine(line: string): string | undefined {
  try {
    const ev = JSON.parse(line) as Record<string, any>;
    const bag: unknown[] = [
      ev.session_id,
      ev.sessionId,
      ev.chatId,
      ev.chat_id,
      ev.conversation_id,
      ev.conversationId,
      // pi: {"type":"session","id":"..."}
      ev.type === "session" ? ev.id : undefined,
      ev.session?.id,
      ev.data?.session_id,
      ev.data?.sessionId,
    ];
    for (const c of bag) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

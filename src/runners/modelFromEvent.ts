export function modelFromJsonLine(line: string): string | undefined {
  try {
    const ev = JSON.parse(line) as Record<string, any>;
    const bag: unknown[] = [
      ev.model,
      ev.modelId,
      ev.model_name,
      ev.displayModelId,
      ev.message?.model,
      ev.data?.model,
      ev.event?.model,
      ev.result?.model,
      ev.session?.model,
      ev.info?.model,
      ev.payload?.model,
    ];
    // Claude Code stream-json often has type=system subtype=init with model
    if (ev.type === "system" && ev.model) bag.push(ev.model);
    if (ev.type === "assistant" && ev.message?.model) bag.push(ev.message.model);
    // Cursor stream-json
    if (ev.type === "result" && ev.model) bag.push(ev.model);
    // pi json mode may include model in message_start / agent events later
    if (ev.assistantMessageEvent?.model) bag.push(ev.assistantMessageEvent.model);
    // Codex turn_context / session payload
    if (ev.type === "turn_context" && ev.payload?.model) bag.push(ev.payload.model);
    for (const c of bag) {
      if (typeof c === "string" && c.trim()) return c.trim();
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

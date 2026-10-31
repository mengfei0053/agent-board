/**
 * SSE board payloads are clipped summaries. An open detail keeps the full
 * prompt/output until a non-summary task (GET /api/tasks/:id) replaces it.
 */
export function mergeBoardTask(prev, incoming) {
  if (!incoming) return prev;
  if (!incoming.boardSummary || !prev || prev.id !== incoming.id) return incoming;
  return {
    ...prev,
    ...incoming,
    prompt: incoming.promptTruncated ? prev.prompt : incoming.prompt,
    output: incoming.outputTruncated ? prev.output : incoming.output,
    outputs: incoming.outputTruncated ? prev.outputs : incoming.outputs,
    prompts: incoming.promptTruncated ? prev.prompts : incoming.prompts,
    status: incoming.status,
    summary: incoming.summary ?? prev.summary,
    lastEvent: incoming.lastEvent,
    pid: incoming.pid,
    sessionId: incoming.sessionId ?? prev.sessionId,
    iteration: incoming.iteration ?? prev.iteration,
    boardSummary: false,
  };
}

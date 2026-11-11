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
    endedAt: incoming.endedAt,
    error: incoming.error,
    exitCode: incoming.exitCode,
    sessionId: incoming.sessionId ?? prev.sessionId,
    iteration: incoming.iteration ?? prev.iteration,
    boardSummary: false,
  };
}

function compareIsoDesc(aIso, bIso) {
  const aStr = String(aIso || "");
  const bStr = String(bIso || "");
  if (aStr === bStr) return 0;
  if (!aStr) return 1;
  if (!bStr) return -1;
  const aMs = Date.parse(aStr);
  const bMs = Date.parse(bStr);
  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
    return bMs - aMs;
  }
  return bStr.localeCompare(aStr);
}

/**
 * Return the task's last completion timestamp (ISO string) for sorting the "done" lane.
 * Prefers `endedAt` (or a newer round output `at` if present), falling back to
 * `updatedAt` and `createdAt`.
 * @param {any} task
 * @returns {string}
 */
export function lastCompletedAt(task) {
  if (!task) return "";
  let latest = typeof task.endedAt === "string" ? task.endedAt : "";
  const turns = Array.isArray(task.outputs) ? task.outputs : [];
  for (const turn of turns) {
    const at = typeof turn?.at === "string" ? turn.at : "";
    if (at && compareIsoDesc(at, latest) < 0) latest = at;
  }
  return latest || String(task.updatedAt || task.createdAt || "");
}

/**
 * Compare two completed tasks by last completion time descending,
 * breaking ties by `createdAt` descending then `id` ascending.
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
export function compareDoneTasks(a, b) {
  const byCompleted = compareIsoDesc(lastCompletedAt(a), lastCompletedAt(b));
  if (byCompleted !== 0) return byCompleted;
  const byCreated = compareIsoDesc(a?.createdAt, b?.createdAt);
  if (byCreated !== 0) return byCreated;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

/**
 * Sort tasks for a board swimlane.
 * - `done`: sorted by last completion time descending (most recently completed on top).
 * - other lanes: sorted by `createdAt` descending.
 * @param {string} lane
 * @param {any[]} items
 * @returns {any[]}
 */
export function sortLaneTasks(lane, items) {
  const list = Array.isArray(items) ? [...items] : [];
  if (lane === "done") {
    return list.sort(compareDoneTasks);
  }
  return list.sort((a, b) => {
    const byCreated = compareIsoDesc(a?.createdAt, b?.createdAt);
    if (byCreated !== 0) return byCreated;
    return String(a?.id || "").localeCompare(String(b?.id || ""));
  });
}

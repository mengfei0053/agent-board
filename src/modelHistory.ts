import { getPool } from "./db.js";
import { HttpError } from "./httpError.js";
import { MAX_MODEL_CHARS } from "./limits.js";
import type { AgentKind } from "./types.js";

export const MODEL_HISTORY_LIMIT = 20;
const KINDS: AgentKind[] = ["pi", "claude", "cursor", "devin", "codex", "kimi"];
type ModelHistory = Record<AgentKind, string[]>;

export async function readModelHistory(): Promise<ModelHistory> {
  const history: ModelHistory = { pi: [], claude: [], cursor: [], devin: [], codex: [], kimi: [] };
  const { rows } = await getPool().query<{ kind: AgentKind; model: string }>(`
    SELECT kind, model FROM (
      SELECT kind, model, last_used_at,
        ROW_NUMBER() OVER (PARTITION BY kind ORDER BY last_used_at DESC, model) AS position
      FROM model_history
    ) recent WHERE position <= $1 ORDER BY kind, last_used_at DESC, model
  `, [MODEL_HISTORY_LIMIT]);
  for (const row of rows) {
    if (KINDS.includes(row.kind)) history[row.kind].push(row.model);
  }
  return history;
}

/** Import legacy browser records once; existing database timestamps are preserved. */
export async function importModelHistory(raw: unknown): Promise<ModelHistory> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "history must be an object");
  }
  const records: { kind: string; model: string; last_used_at: string }[] = [];
  const now = Date.now();
  for (const [kind, models] of Object.entries(raw)) {
    if (!KINDS.includes(kind as AgentKind)) throw new HttpError(400, "unknown history kind");
    if (!Array.isArray(models) || models.length > MODEL_HISTORY_LIMIT) {
      throw new HttpError(400, "history must contain at most 20 models per kind");
    }
    for (const [index, model] of models.entries()) {
      if (typeof model !== "string" || !model.trim() || model.trim().length > MAX_MODEL_CHARS) {
        throw new HttpError(400, "invalid history model");
      }
      if (!records.some((r) => r.kind === kind && r.model === model.trim())) {
        records.push({ kind, model: model.trim(), last_used_at: new Date(now - index).toISOString() });
      }
    }
  }
  if (records.length) {
    await getPool().query(`
      INSERT INTO model_history (kind, model, last_used_at)
      SELECT kind, model, last_used_at FROM jsonb_to_recordset($1::jsonb)
        AS imported(kind TEXT, model TEXT, last_used_at TIMESTAMPTZ)
      ON CONFLICT (kind, model) DO NOTHING
    `, [JSON.stringify(records)]);
  }
  return readModelHistory();
}

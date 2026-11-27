/** A single provider usage report. Null means unknown, not zero. */
export type RunnerUsage = {
  /** Deduplication key scoped to this runner invocation. */
  key: string;
  /** Fresh input only; cache reads and writes are separate buckets. */
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
  costUsd: number | null;
  requests: number | null;
  model?: string;
  provider?: string;
  source?: "pi.message_end" | "claude.result" | "codex.turn";
  status?: "success" | "failed" | "aborted";
  costSource?: "provider" | "pi-catalog" | "claude-cli";
  /** Whole response (Pi) or whole turn (Claude/Codex), never tool time used as TTFT. */
  durationMs?: number;
  /** Board-observed first nonempty text delta, relative to this response's start. */
  firstTokenMs?: number;
};

export const usageColumns = [
  "run_key",
  "event_key",
  "occurred_ms",
  "agent",
  "model",
  "fresh_input",
  "output_tokens",
  "cache_read",
  "cache_write",
  "total_tokens",
  "cost_usd",
  "requests",
  "provider",
  "source",
  "status",
  "cost_source",
  "duration_ms",
  "first_token_ms",
] as const;

/** Only identifiers, never a URL, authorization header, free text, or a connection string. */
export function usageLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const s = value.trim();
  return /^[\p{L}\p{N}][\p{L}\p{N}._:+/@\[\]-]{0,191}$/u.test(s) &&
    !s.includes("://") &&
    !/(?:^|[/@:])(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|glpat-|AKIA[A-Z0-9]{16}|Bearer:)/i.test(s) &&
    !/^[^/]+:[^/]+@/.test(s)
    ? s
    : undefined;
}

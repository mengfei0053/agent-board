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
};

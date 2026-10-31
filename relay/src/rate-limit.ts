/** Sliding window counter. All hits live in memory and disappear with the process. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error("rate limit must be at least 1");
    if (!Number.isFinite(windowMs) || windowMs < 1) throw new Error("rate window must be positive");
  }

  allow(key: string): boolean {
    const now = this.now();
    const fresh = (this.hits.get(key) ?? []).filter((ts) => now - ts < this.windowMs);
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(key, fresh);
    return true;
  }
}

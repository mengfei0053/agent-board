import { RELAY_LIMITS } from "./limits.js";
import type { MappedTask } from "./map.js";

/**
 * Dialer-lifetime create idempotency. Survives WebSocket reconnects and
 * session replacement. Dies with the board process.
 *
 * Relay-side identity is `(boardId, cmd type, idempotencyKey)`. This dialer
 * serves one board, and the cache is for successful `cmd.create` only.
 * Failures are not stored. An in-flight key shares one Promise across sessions;
 * closing a socket does not cancel it.
 */
export class CreateIdempotency {
  private completed = new Map<string, MappedTask>();
  private order: string[] = [];
  private inflight = new Map<string, Promise<MappedTask>>();

  constructor(private readonly cap = RELAY_LIMITS.idempotencyCache) {}

  run(key: string, factory: () => Promise<MappedTask>): Promise<MappedTask> {
    const hit = this.completed.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = factory()
      .then((task) => {
        this.remember(key, task);
        return task;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private remember(key: string, task: MappedTask): void {
    if (this.completed.has(key)) {
      this.order = this.order.filter((item) => item !== key);
    }
    this.completed.set(key, task);
    this.order.push(key);
    while (this.order.length > this.cap) {
      const oldest = this.order.shift();
      if (oldest) this.completed.delete(oldest);
    }
  }
}

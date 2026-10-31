import type { Workspace } from "../types.js";
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

/**
 * Dialer-lifetime idempotency for workspace create and delete.
 * Keyed separately from task create. Failures are not stored.
 * An in-flight key shares one Promise; closing a socket does not cancel it.
 */
export class WorkspaceIdempotency {
  private completed = new Map<string, Workspace | string>();
  private order: string[] = [];
  private inflight = new Map<string, Promise<Workspace | string>>();

  constructor(private readonly cap = RELAY_LIMITS.idempotencyCache) {}

  runCreate(key: string, factory: () => Promise<Workspace>): Promise<Workspace> {
    return this.run(`create\0${key}`, factory);
  }

  runDelete(key: string, factory: () => Promise<string>): Promise<string> {
    return this.run(`delete\0${key}`, factory);
  }

  private run<T extends Workspace | string>(key: string, factory: () => Promise<T>): Promise<T> {
    const hit = this.completed.get(key);
    if (hit !== undefined) return Promise.resolve(hit as T);
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = factory()
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private remember(key: string, value: Workspace | string): void {
    if (this.completed.has(key)) {
      this.order = this.order.filter((item) => item !== key);
    }
    this.completed.set(key, value);
    this.order.push(key);
    while (this.order.length > this.cap) {
      const oldest = this.order.shift();
      if (oldest) this.completed.delete(oldest);
    }
  }
}

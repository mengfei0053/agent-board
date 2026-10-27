import type { BoardEvent } from "./types.js";

type Listener = (ev: BoardEvent) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publish(ev: BoardEvent) {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      /* ignore broken SSE clients */
    }
  }
}

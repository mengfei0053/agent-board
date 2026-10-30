import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publish, subscribe } from "./bus.js";
import type { BoardEvent } from "./types.js";

describe("bus", () => {
  it("delivers events to subscribers and supports unsubscribe", () => {
    const seen: BoardEvent[] = [];
    const unsub = subscribe((ev) => seen.push(ev));
    publish({ type: "hello", tasks: [], workspaces: [] });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].type, "hello");
    unsub();
    publish({ type: "task_delete", taskIds: ["x"] });
    assert.equal(seen.length, 1);
  });

  it("isolates listener errors", () => {
    const ok: BoardEvent[] = [];
    const unsub1 = subscribe(() => {
      throw new Error("boom");
    });
    const unsub2 = subscribe((ev) => ok.push(ev));
    publish({ type: "task_delete", taskIds: ["a"] });
    assert.equal(ok.length, 1);
    unsub1();
    unsub2();
  });
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  appendLog,
  disableMemoryStoreForTests,
  enableMemoryStoreForTests,
  failNextPersistForTests,
  flushPersist,
  persistQueueDepthForTests,
  setAfterLogInsertForTests,
  setFlushPersistMaxRoundsForTests,
  setPersistDryRunForTests,
} from "./store.js";

describe("flushPersist drain (R3-M1)", () => {
  beforeEach(() => {
    enableMemoryStoreForTests();
    setPersistDryRunForTests(true);
  });

  afterEach(async () => {
    setAfterLogInsertForTests(null);
    setFlushPersistMaxRoundsForTests(null);
    try {
      await flushPersist();
    } catch {
      /* leftover queue from a failed assertion should not mask that assertion */
    }
    disableMemoryStoreForTests();
  });

  it("drains a backlog that spans more than one log batch", async () => {
    for (let i = 0; i < 201; i++) appendLog("t-ok", `line-${i}`);
    await flushPersist();
    assert.deepEqual(persistQueueDepthForTests(), { logs: 0, tasks: 0, logQueued: false });
  });

  it("throws when the round cap is hit with logs still queued", async () => {
    setFlushPersistMaxRoundsForTests(1);
    for (let i = 0; i < 201; i++) appendLog("t-bulk", "x");
    await assert.rejects(
      flushPersist(),
      /did not drain after 1 round \(logs=1, logQueued=true/,
    );
  });

  it("throws when new log lines keep arriving during flush", async () => {
    setFlushPersistMaxRoundsForTests(3);
    setAfterLogInsertForTests(() => {
      appendLog("t-overflow", "again");
    });
    appendLog("t-overflow", "seed");
    await assert.rejects(flushPersist(), /did not drain after 3 round/);
    assert.ok(persistQueueDepthForTests().logs > 0);
  });

  it("still reports a persist failure after the queue drains", async () => {
    failNextPersistForTests("log");
    appendLog("t-fail", "z");
    await assert.rejects(flushPersist(), /persist failed/);
    assert.equal(persistQueueDepthForTests().logs, 0);
  });
});

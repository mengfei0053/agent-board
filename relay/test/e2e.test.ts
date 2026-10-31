import assert from "node:assert/strict";
import test from "node:test";
import { runE2E } from "../scripts/e2e.js";

test("fake connector and phones cover the P0 command and completion loop", { timeout: 20_000 }, async () => {
  const result = await runE2E({ quiet: true });
  assert.equal(result.idempotentReplay, true);
  assert.equal(result.unauthorizedRejected, true);
  assert.equal(result.droppedWithoutPhone, true);
  assert.equal(result.reconnectResynced, true);
  assert.equal(result.taskDone.payload?.status, "stopped");
  assert.equal(result.observerTaskDone.payload?.eventId, result.taskDone.payload?.eventId);
  assert.equal(result.snapshot.type, "evt.snapshot");
  assert.equal(result.createAck.payload?.stage, "executed");
});

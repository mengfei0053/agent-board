import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AuthStore } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { setup } from "./support.js";

const hubs: Array<{ dispose: () => void }> = [];

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.dispose();
});

test("pair codes are high entropy, one-time, and short lived", () => {
  const { auth, hub, clock } = setup({ pairTtlMs: 5_000 });
  hubs.push(hub);
  const created = auth.createPairCode(["thinkbook-main"], 1_000);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.ok(created.pairCode.startsWith("pc_"));
  assert.ok(created.pairCode.length >= 40);

  const paired = auth.pair(created.pairCode, "pixel", "ip-a");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  assert.equal(paired.role, "phone");
  assert.deepEqual(paired.boardIds, ["thinkbook-main"]);
  const again = auth.pair(created.pairCode, "pixel", "ip-b");
  assert.equal(again.ok, false);
  if (!again.ok) assert.equal(again.code, "unauthorized");

  const second = auth.createPairCode(["thinkbook-main"], 1_000);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  clock.t += 1_000;
  const expired = auth.pair(second.pairCode, "pixel", "ip-c");
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.code, "unauthorized");
});

test("pair attempts are rate limited", () => {
  const { auth, hub } = setup({ pairAttemptLimit: 2 });
  hubs.push(hub);
  const created = auth.createPairCode(["thinkbook-main"]);
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(auth.pair("not-a-code", "pixel", "brute").ok, false);
  assert.equal(auth.pair("not-a-code", "pixel", "brute").ok, false);
  const blocked = auth.pair(created.pairCode, "pixel", "brute");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, "rate_limited");
});

test("device refresh keeps the board binding and revoke kills the token", () => {
  const { auth, hub } = setup();
  hubs.push(hub);
  const paired = auth.pair(must(auth.createPairCode(["thinkbook-main"])).pairCode, "pixel", "ip");
  assert.equal(paired.ok, true);
  if (!paired.ok) return;
  const refreshed = auth.refresh(paired.deviceToken);
  assert.equal(refreshed.ok, true);
  if (!refreshed.ok) return;
  assert.equal(refreshed.deviceId, paired.deviceId);
  assert.deepEqual(refreshed.boardIds, ["thinkbook-main"]);
  assert.equal(auth.verifyDevice(paired.deviceToken), null);
  assert.equal(auth.revokeDevice(refreshed.deviceId), true);
  assert.equal(auth.verifyDevice(refreshed.deviceToken), null);
  assert.equal(auth.refresh(refreshed.deviceToken).ok, false);
});

test("board credentials are scoped and revocable", () => {
  const { auth, hub } = setup();
  hubs.push(hub);
  assert.equal(auth.verifyBoard("board-token-value", "thinkbook-main").ok, true);
  assert.equal(auth.verifyBoard("nope", "thinkbook-main").ok, false);
  const issued = auth.issueBoardToken(["thinkbook-main"]);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  const wrong = auth.verifyBoard(issued.boardToken, "other-board");
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.equal(wrong.code, "forbidden");
  assert.equal(auth.revokeBoardToken(issued.boardToken) !== null, true);
  assert.equal(auth.verifyBoard(issued.boardToken, "thinkbook-main").ok, false);
  assert.equal(auth.revokeBoardId("thinkbook-main").ok, true);
  assert.equal(auth.verifyBoard("board-token-value", "thinkbook-main").ok, false);
  const restored = auth.issueBoardToken(["thinkbook-main"]);
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  assert.equal(auth.verifyBoard(restored.boardToken, "thinkbook-main").ok, true);
});

test("issuing a board token does not restore the revoked bootstrap credential", () => {
  const { auth, hub } = setup();
  hubs.push(hub);
  const revoked = auth.revokeBoardId("thinkbook-main");
  assert.equal(revoked.ok, true);
  assert.equal(auth.verifyBoard("board-token-value", "thinkbook-main").ok, false);

  const issued = auth.issueBoardToken(["thinkbook-main"]);
  assert.equal(issued.ok, true);
  if (!issued.ok) return;
  assert.equal(auth.verifyBoard("board-token-value", "thinkbook-main").ok, false);
  assert.equal(auth.verifyBoard("board-token-value", "other-board").ok, false);
  assert.equal(auth.verifyBoard(issued.boardToken, "thinkbook-main").ok, true);
  const other = auth.verifyBoard(issued.boardToken, "other-board");
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.code, "forbidden");

  const rejected: Array<{ type?: string; payload?: { code?: string } }> = [];
  const stale = hub.attachBoard((message) => {
    rejected.push(message);
  }, () => {});
  hub.handleBoard(stale, {
    v: 1,
    id: "reg-old",
    type: "board.register",
    ts: 1,
    payload: { boardId: "thinkbook-main", token: "board-token-value" },
  });
  assert.equal(rejected.at(-1)?.payload?.code, "unauthorized");
  assert.equal(hub.stats().boardsOnline, 0);
  const frames: Array<{ type?: string }> = [];
  const live = hub.attachBoard((message) => {
    frames.push(message);
  }, () => {});
  hub.handleBoard(live, {
    v: 1,
    id: "reg-new",
    type: "board.register",
    ts: 1,
    payload: { boardId: "thinkbook-main", token: issued.boardToken },
  });
  assert.equal(frames.at(-1)?.type, "ack");
  assert.equal(hub.stats().boardsOnline, 1);
});

test("idempotency TTL cannot be shorter than the command timeout", () => {
  const rejected = loadConfig({
    ADMIN_TOKEN: "admin-token-value-123",
    BOARD_TOKEN: "board-token-value-123",
    CMD_TIMEOUT_MS: "8000",
    IDEMPOTENCY_TTL_MS: "1000",
  });
  assert.equal(rejected.ok, false);
});

test("production requires admin and board tokens", () => {
  assert.equal(loadConfig({ NODE_ENV: "production" }).ok, false);
  const ready = loadConfig({
    NODE_ENV: "production",
    ADMIN_TOKEN: "admin-token-value-123",
    BOARD_TOKEN: "board-token-value-123",
    PAIR_TTL_MS: "120000",
  });
  assert.equal(ready.ok, true);
  if (!ready.ok) return;
  assert.equal(ready.config.pairTtlMs, 120_000);
  assert.equal(ready.config.generatedAdminToken, false);
  const local = loadConfig({});
  assert.equal(local.ok, true);
  if (!local.ok) return;
  assert.equal(local.config.generatedAdminToken, true);
  assert.equal(local.config.generatedBoardToken, true);
});

function must<T extends { ok: true; pairCode: string } | { ok: false; message: string }>(result: T): { pairCode: string } {
  if (!result.ok) throw new Error(result.message);
  return result;
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRelayManager, type StoredRelay } from "./manager.js";
import type { EmbeddedRelay } from "./run.js";

type StartOpts = Parameters<NonNullable<Parameters<typeof createRelayManager>[0]["start"]>>[0];

function harness(opts: { stored?: StoredRelay | null; env?: NodeJS.ProcessEnv; ready?: "ok" | "fail" | "hang"; fetchImpl?: typeof fetch } = {}) {
  const started: StartOpts[] = [];
  const closed: number[] = [];
  const persisted: StoredRelay[] = [];
  const logs: string[] = [];
  const manager = createRelayManager({
    loadStored: async () => opts.stored ?? null,
    persist: async (value) => { persisted.push(value); },
    env: opts.env ?? {},
    log: (_level, message) => { logs.push(message); },
    settleMs: 50,
    fetchImpl: opts.fetchImpl,
    start: (o) => {
      const index = started.push(o) - 1;
      const ready = opts.ready === "fail" ? Promise.reject(new Error("x"))
        : opts.ready === "hang" ? new Promise<void>(() => {})
        : Promise.resolve();
      const relay: EmbeddedRelay = { ready, close: async () => { closed.push(index); } };
      return relay;
    },
  });
  return { manager, started, closed, persisted, logs };
}

const issueResponse = (token = `bt_${"a".repeat(43)}`) =>
  (async () => new Response(JSON.stringify({ boardToken: token }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

describe("relay manager", () => {
  it("stays off with no env and no saved settings", async () => {
    const h = harness();
    await h.manager.init();
    assert.equal(h.started.length, 0);
    assert.equal(h.manager.settings().source, "none");
  });

  it("falls back to env when nothing is saved", async () => {
    const h = harness({ env: { RELAY_WS_URL: "wss://r.example/v1/ws", BOARD_ID: "b1", BOARD_TOKEN: "tok" } });
    await h.manager.init();
    assert.equal(h.started.length, 1);
    assert.equal(h.manager.settings().source, "env");
  });

  it("saved settings win over env", async () => {
    const h = harness({
      stored: { enabled: true, relayWsUrl: "wss://saved.example/v1/ws", boardId: "saved", boardToken: "s", boardLabel: "Saved" },
      env: { RELAY_WS_URL: "wss://env.example/v1/ws", BOARD_ID: "env", BOARD_TOKEN: "e" },
    });
    await h.manager.init();
    assert.equal(h.started.length, 1);
    assert.equal(h.started[0].config.boardId, "saved");
  });

  it("save issues a token with the admin token, persists, dials without restart, and never leaks secrets", async () => {
    let seen: { url: string; auth: string | null; body: unknown } | null = null;
    const token = `bt_${"b".repeat(43)}`;
    const h = harness({
      fetchImpl: (async (url: URL, init: RequestInit) => {
        seen = { url: String(url), auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ boardToken: token }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await h.manager.init();
    const view = await h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "thinkbook", adminToken: "admin-secret" });
    assert.deepEqual(seen, { url: "https://r.example/auth/board/issue", auth: "Bearer admin-secret", body: { boardIds: ["thinkbook"], rotate: false } });
    assert.equal(h.persisted.length, 1);
    assert.equal(h.persisted[0].boardToken, token);
    assert.equal(h.persisted[0].boardLabel, "thinkbook");
    assert.equal(h.started.length, 1);
    assert.equal(h.started[0].config.boardToken, token);
    assert.equal(view.status, "connected");
    assert.equal(view.hasToken, true);
    const serialized = JSON.stringify(view) + h.logs.join("\n");
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("admin-secret"), false);
    assert.equal(JSON.stringify(h.persisted).includes("admin-secret"), false);
  });

  it("re-saving replaces the previous connection", async () => {
    const h = harness({ fetchImpl: issueResponse() });
    await h.manager.init();
    await h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "one", adminToken: "a" });
    await h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "two", adminToken: "a" });
    assert.equal(h.started.length, 2);
    assert.deepEqual(h.closed, [0]);
    assert.equal(h.started[1].config.boardId, "two");
  });

  it("a blank token keeps the saved one for the same relay and board", async () => {
    const h = harness({ stored: { enabled: true, relayWsUrl: "wss://r.example/v1/ws", boardId: "b", boardToken: "kept", boardLabel: "b" } });
    await h.manager.init();
    await h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "b", boardLabel: "New name" });
    assert.equal(h.persisted[0].boardToken, "kept");
    assert.equal(h.persisted[0].boardLabel, "New name");
    await assert.rejects(h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "other" }), /管理员令牌/);
  });

  it("rejects bad input without persisting or dialing", async () => {
    const h = harness({ fetchImpl: issueResponse() });
    await h.manager.init();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ boardId: "b", adminToken: "a" }, /中继地址/],
      [{ relayWsUrl: "wss://r.example/v1/ws", adminToken: "a" }, /看板 ID/],
      [{ relayWsUrl: "wss://r.example/v1/ws", boardId: "bad/id", adminToken: "a" }, /看板 ID/],
      [{ relayWsUrl: "https://r.example", boardId: "b", adminToken: "a" }, /ws:\/\//],
      [{ relayWsUrl: "wss://u:p@r.example/v1/ws", boardId: "b", adminToken: "a" }, /账号密码/],
      [{ relayWsUrl: "not a url", boardId: "b", adminToken: "a" }, /有效的 URL/],
    ];
    for (const [input, pattern] of cases) await assert.rejects(h.manager.save(input), pattern);
    assert.equal(h.persisted.length, 0);
    assert.equal(h.started.length, 0);
  });

  it("maps relay errors to friendly messages and does not persist on failure", async () => {
    const unauthorized = harness({ fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch });
    await assert.rejects(unauthorized.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "b", adminToken: "bad" }), /管理员令牌无效/);
    const down = harness({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    await assert.rejects(down.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "b", adminToken: "a" }), /无法连接中继/);
    const junk = harness({ fetchImpl: issueResponse("not-a-token") });
    await assert.rejects(junk.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "b", adminToken: "a" }), /无效的看板令牌/);
    for (const h of [unauthorized, down, junk]) assert.equal(h.persisted.length, 0);
  });

  it("reports connecting while the first handshake is pending, and keeps the error out of secrets", async () => {
    const h = harness({ fetchImpl: issueResponse(), ready: "hang" });
    await h.manager.init();
    const view = await h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "b", adminToken: "a" });
    assert.equal(view.status, "connecting");
  });

  it("disconnect stops dialing but keeps the saved settings", async () => {
    const h = harness({ stored: { enabled: true, relayWsUrl: "wss://r.example/v1/ws", boardId: "b", boardToken: "t", boardLabel: "b" } });
    await h.manager.init();
    const view = await h.manager.disconnect();
    assert.equal(h.closed.length, 1);
    assert.equal(h.persisted[0].enabled, false);
    assert.equal(view.enabled, false);
    assert.equal(view.status, "off");
    assert.equal(view.boardId, "b");
    assert.equal(h.started.length, 1);
  });

  it("serializes concurrent saves so only the last connection stays open", async () => {
    const h = harness({ fetchImpl: issueResponse() });
    await h.manager.init();
    await Promise.all([
      h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "a", adminToken: "x" }),
      h.manager.save({ relayWsUrl: "wss://r.example/v1/ws", boardId: "b", adminToken: "x" }),
    ]);
    assert.equal(h.started.length, 2);
    assert.deepEqual(h.closed, [0]);
  });

  it("a corrupt saved row does not stop startup", async () => {
    const manager = createRelayManager({ loadStored: async () => { throw new Error("boom"); }, persist: async () => {}, env: {}, log: () => {} });
    await assert.doesNotReject(manager.init());
    assert.equal(manager.settings().source, "none");
  });
});

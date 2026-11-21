import assert from "node:assert/strict";
import { test } from "node:test";
import { serve, type HttpBindings } from "@hono/node-server";
import { once } from "node:events";
import { grokWebRoutes } from "./grokWebRoutes.js";

const base = "http://127.0.0.1:8791";
const state = { state: "pending" as const };
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } } as HttpBindings);
const localHeaders = { host: "127.0.0.1:8791", origin: base, "x-board-local": "1", "content-type": "application/json" };

test("local settings can start authorization, read its status and list deployments without caching", async () => {
  let starts = 0;
  const app = grokWebRoutes({ start: () => { starts++; return state; }, status: () => state, deployments: async () => ["review-bot"] });
  const env = peer("::ffff:127.0.0.1");
  const start = await app.request(base + "/login", { method: "POST", headers: localHeaders, body: "{}" }, env);
  assert.equal(start.status, 200);
  assert.equal(starts, 1);
  assert.deepEqual(await start.json(), state);
  const status = await app.request(base + "/login", { headers: localHeaders }, env);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), state);
  const deployments = await app.request(base + "/deployments", { headers: localHeaders }, env);
  assert.deepEqual(await deployments.json(), { slugs: ["review-bot"] });
});

test("the Node adapter supplies the real loopback peer to the mounted routes", async () => {
  const routes = grokWebRoutes({ start: () => state, status: () => state, deployments: async () => [] });
  const server = serve({ fetch: routes.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const res = await fetch(origin + "/login", { method: "POST", headers: {
      origin, "content-type": "application/json", "x-board-local": "1",
    }, body: "{}" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), state);
  } finally { await new Promise<void>((done, fail) => server.close(err => err ? fail(err) : done())); }
});

test("missing peer, remote, proxied and non-same-origin requests cannot invoke SDK commands", async () => {
  let calls = 0;
  const record = () => { calls++; return state; };
  const app = grokWebRoutes({ start: record, status: record, deployments: async () => { calls++; return []; } });
  const cases: [string | undefined, Record<string, string>][] = [
    [undefined, {}], ["192.168.1.9", {}], ["127.0.0.1", { forwarded: "for=127.0.0.1" }],
    ["127.0.0.1", { "x-forwarded-for": "127.0.0.1" }], ["127.0.0.1", { "sec-fetch-site": "cross-site" }],
    ["127.0.0.1", { "x-board-local": "" }], ["127.0.0.1", { origin: "https://elsewhere.invalid" }],
    ["127.0.0.1", { host: "elsewhere.invalid" }],
  ];
  for (const [address, overrides] of cases) {
    for (const [method, path] of [["POST", "/login"], ["GET", "/login"], ["GET", "/deployments"]]) {
      const res = await app.request(base + path, { method, headers: { ...localHeaders, ...overrides } }, address ? peer(address) : undefined);
      assert.equal(res.status, 403);
    }
  }
  const { origin: _, ...noOrigin } = localHeaders;
  assert.equal((await app.request(base + "/login", { method: "POST", headers: noOrigin }, peer("::1"))).status, 403);
  assert.equal((await app.request(base + "/login", { method: "POST", headers: localHeaders, body: '{"key":"not-accepted"}' }, peer("::1"))).status, 400);
  assert.equal(calls, 0);
});

test("deployment command failures are not returned as CLI output", async () => {
  const app = grokWebRoutes({ start: () => state, status: () => state, deployments: async () => { throw Error("private fixture"); } });
  const res = await app.request(base + "/deployments", { headers: localHeaders }, peer("::1"));
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /private fixture/);
});

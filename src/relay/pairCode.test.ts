import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createBoardPairCode } from "./pairCode.js";

test("creates a one-board code on the configured relay without exposing credentials", async () => {
  const code = `pc_${"a".repeat(43)}`;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/auth/pair/create");
    assert.equal(req.headers.authorization, "Bearer admin-secret");
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), { boardIds: ["board-1"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ pairCode: code, expiresAt: 123456 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const env = { RELAY_WS_URL: `ws://127.0.0.1:${address.port}/v1/ws`, BOARD_ID: "board-1", BOARD_TOKEN: "board-secret" };
    assert.deepEqual(await createBoardPairCode("admin-secret", env), { pairCode: code, expiresAt: 123456, boardId: "board-1" });
    await assert.rejects(createBoardPairCode("admin-secret", {}), /配置并启用/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadRelayDialerConfig } from "./config.js";

const SECRET = "super-secret-token-value";

describe("loadRelayDialerConfig", () => {
  it("stays disabled and does not throw when relay env is absent", () => {
    assert.doesNotThrow(() => loadRelayDialerConfig({}));
    const cfg = loadRelayDialerConfig({});
    assert.equal(cfg.enabled, false);
    if (!cfg.enabled) assert.equal(cfg.level, "info");
  });

  it("skips incomplete env without exiting", () => {
    const cfg = loadRelayDialerConfig({ RELAY_WS_URL: "wss://relay.example/v1/ws", BOARD_ID: "board" });
    assert.equal(cfg.enabled, false);
    if (!cfg.enabled) {
      assert.equal(cfg.level, "info");
      assert.match(cfg.reason, /BOARD_TOKEN/);
      assert.equal(cfg.reason.includes(SECRET), false);
    }
  });

  it("warns when RELAY_ENABLED=1 but fields are missing", () => {
    const cfg = loadRelayDialerConfig({ RELAY_ENABLED: "1", RELAY_WS_URL: "wss://relay.example/v1/ws" });
    assert.equal(cfg.enabled, false);
    if (!cfg.enabled) assert.equal(cfg.level, "warn");
  });

  it("honors the kill switch even when credentials are present", () => {
    for (const flag of ["0", "false", "off"]) {
      const cfg = loadRelayDialerConfig({
        RELAY_ENABLED: flag,
        RELAY_WS_URL: "wss://relay.example/v1/ws",
        BOARD_ID: "board",
        BOARD_TOKEN: SECRET,
      });
      assert.equal(cfg.enabled, false);
      if (!cfg.enabled) assert.equal(cfg.reason.includes(SECRET), false);
    }
  });

  it("rejects a bad URL when enable was intended", () => {
    const cfg = loadRelayDialerConfig({
      RELAY_ENABLED: "1",
      RELAY_WS_URL: "http://relay.example/v1/ws",
      BOARD_ID: "board",
      BOARD_TOKEN: SECRET,
    });
    assert.equal(cfg.enabled, false);
    if (!cfg.enabled) {
      assert.equal(cfg.level, "error");
      assert.match(cfg.reason, /ws:/);
      assert.equal(cfg.reason.includes(SECRET), false);
    }
  });

  it("rejects credentials embedded in the URL", () => {
    const cfg = loadRelayDialerConfig({
      RELAY_WS_URL: "wss://user:pass@relay.example/v1/ws",
      BOARD_ID: "board",
      BOARD_TOKEN: SECRET,
    });
    assert.equal(cfg.enabled, false);
    if (!cfg.enabled) {
      assert.equal(cfg.level, "error");
      assert.equal(cfg.reason.includes("pass"), false);
      assert.equal(cfg.reason.includes(SECRET), false);
    }
  });

  it("accepts aliases only when the primary key is absent", () => {
    const aliased = loadRelayDialerConfig({
      AGENT_BOARD_RELAY_WS_URL: "wss://alias.example/v1/ws",
      AGENT_BOARD_ID: "phone1",
      AGENT_BOARD_RELAY_TOKEN: SECRET,
      RECONNECT_MIN_MS: "250",
      RELAY_RECONNECT_MAX_MS: "4000",
    });
    assert.equal(aliased.enabled, true);
    if (aliased.enabled) {
      assert.equal(aliased.boardId, "phone1");
      assert.equal(aliased.relayWsUrl, "wss://alias.example/v1/ws");
      assert.equal(aliased.boardLabel, "ThinkBook");
      assert.equal(aliased.reconnectMinMs, 250);
      assert.equal(aliased.reconnectMaxMs, 4000);
      assert.equal(aliased.boardToken, SECRET);
    }

    const primaryWins = loadRelayDialerConfig({
      RELAY_WS_URL: "wss://primary.example/v1/ws",
      AGENT_BOARD_RELAY_WS_URL: "wss://alias.example/v1/ws",
      BOARD_ID: "board",
      AGENT_BOARD_ID: "other",
      BOARD_TOKEN: SECRET,
    });
    assert.equal(primaryWins.enabled, true);
    if (primaryWins.enabled) {
      assert.equal(primaryWins.relayWsUrl, "wss://primary.example/v1/ws");
      assert.equal(primaryWins.boardId, "board");
    }
  });

  it("does not fall through when the primary key is set but empty", () => {
    const cfg = loadRelayDialerConfig({
      RELAY_WS_URL: "",
      AGENT_BOARD_RELAY_WS_URL: "wss://alias.example/v1/ws",
      BOARD_ID: "board",
      BOARD_TOKEN: SECRET,
    });
    assert.equal(cfg.enabled, false);
  });

  it("rejects reconnect bounds that are not positive or ordered", () => {
    const zero = loadRelayDialerConfig({
      RELAY_WS_URL: "wss://relay.example/v1/ws",
      BOARD_ID: "board",
      BOARD_TOKEN: SECRET,
      RELAY_RECONNECT_MIN_MS: "0",
    });
    assert.equal(zero.enabled, false);
    const inverted = loadRelayDialerConfig({
      RELAY_WS_URL: "wss://relay.example/v1/ws",
      BOARD_ID: "board",
      BOARD_TOKEN: SECRET,
      RELAY_RECONNECT_MIN_MS: "2000",
      RELAY_RECONNECT_MAX_MS: "500",
    });
    assert.equal(inverted.enabled, false);
    if (!inverted.enabled) assert.equal(inverted.reason.includes(SECRET), false);
  });

  it("never throws on garbage", () => {
    assert.doesNotThrow(() => loadRelayDialerConfig({
      RELAY_ENABLED: "1",
      RELAY_WS_URL: "not a url",
      BOARD_ID: "bad id",
      BOARD_TOKEN: SECRET,
      RELAY_RECONNECT_MIN_MS: "nope",
    }));
  });
});

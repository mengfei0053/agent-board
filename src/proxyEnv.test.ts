import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  PROXY_ENV_KEYS,
  _resetProxyEnvOverridesForTests,
  childProcessEnv,
  getProxyEnvSettings,
  lastInjectedProxyKeys,
  lastInjectedProxyKind,
  parseProxyEnvJson,
} from "./proxyEnv.js";

afterEach(() => {
  _resetProxyEnvOverridesForTests({});
});

describe("parseProxyEnvJson", () => {
  it("handles empty / invalid", () => {
    assert.deepEqual(parseProxyEnvJson(""), {
      byKind: {},
      migratedFromLegacy: false,
    });
    assert.deepEqual(parseProxyEnvJson("{"), {
      byKind: {},
      migratedFromLegacy: false,
    });
  });

  it("migrates legacy flat shape to all kinds", () => {
    const { byKind, migratedFromLegacy } = parseProxyEnvJson(
      JSON.stringify({ HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "" }),
    );
    assert.equal(migratedFromLegacy, true);
    assert.equal(byKind.pi?.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(byKind.codex?.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(byKind.pi?.HTTPS_PROXY, undefined);
  });

  it("parses per-kind shape", () => {
    const { byKind, migratedFromLegacy } = parseProxyEnvJson(
      JSON.stringify({
        pi: { HTTP_PROXY: "http://pi-proxy", NO_PROXY: "localhost" },
        claude: {},
      }),
    );
    assert.equal(migratedFromLegacy, false);
    assert.deepEqual(byKind.pi, {
      HTTP_PROXY: "http://pi-proxy",
      NO_PROXY: "localhost",
    });
    assert.equal(byKind.claude, undefined);
  });
});

describe("childProcessEnv / getProxyEnvSettings", () => {
  it("injects overrides and lowercase mirrors", () => {
    _resetProxyEnvOverridesForTests({
      pi: { HTTP_PROXY: "http://override:1", HTTPS_PROXY: "http://override:2" },
    });
    const env = childProcessEnv("pi", { NO_COLOR: "1" });
    assert.equal(env.HTTP_PROXY, "http://override:1");
    assert.equal(env.http_proxy, "http://override:1");
    assert.equal(env.HTTPS_PROXY, "http://override:2");
    assert.equal(env.NO_COLOR, "1");
    assert.deepEqual(lastInjectedProxyKeys, ["HTTP_PROXY", "HTTPS_PROXY"]);
    assert.equal(lastInjectedProxyKind, "pi");
  });

  it("leaves process.env when no override for kind", () => {
    _resetProxyEnvOverridesForTests({
      codex: { ALL_PROXY: "socks5://x" },
    });
    const env = childProcessEnv("pi");
    assert.equal(lastInjectedProxyKeys.length, 0);
    assert.equal(lastInjectedProxyKind, "pi");
    assert.ok(env.PATH);
  });

  it("reports settings with override vs inherited", () => {
    _resetProxyEnvOverridesForTests({
      agent: { NO_PROXY: "127.0.0.1" },
    });
    const { proxyEnv } = getProxyEnvSettings();
    assert.equal(proxyEnv.agent.NO_PROXY.override, "127.0.0.1");
    assert.equal(proxyEnv.agent.NO_PROXY.inherited, false);
    assert.equal(proxyEnv.pi.NO_PROXY.override, "");
    assert.ok(PROXY_ENV_KEYS.includes("HTTP_PROXY"));
  });
});

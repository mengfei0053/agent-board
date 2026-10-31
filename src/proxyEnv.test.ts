import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  PROXY_ENV_KEYS,
  _resetProxyEnvOverridesForTests,
  childProcessEnv,
  getProxyEnvSettings,
  isRedactedProxyPlaceholder,
  lastInjectedProxyKeys,
  lastInjectedProxyKind,
  parseProxyEnvJson,
  planProxyEnvOverrides,
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

  it("does not copy service secrets into the child env", () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://postgres:secret@127.0.0.1/db";
    try {
      const env = childProcessEnv("pi");
      assert.equal(env.DATABASE_URL, undefined);
      assert.ok(env.PATH);
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it("redacts proxy credentials in settings", () => {
    _resetProxyEnvOverridesForTests({
      pi: { HTTP_PROXY: "http://user:s3cret@127.0.0.1:7890" },
    });
    const { proxyEnv } = getProxyEnvSettings();
    assert.equal(proxyEnv.pi.HTTP_PROXY.override, "http://user:***@127.0.0.1:7890");
    assert.equal(proxyEnv.pi.HTTP_PROXY.effective, "http://user:***@127.0.0.1:7890");
    assert.equal(proxyEnv.pi.HTTP_PROXY.configured, true);
    assert.equal(proxyEnv.pi.HTTP_PROXY.hasCredential, true);
    const env = childProcessEnv("pi");
    assert.equal(env.HTTP_PROXY, "http://user:s3cret@127.0.0.1:7890");
    assert.equal(isRedactedProxyPlaceholder(proxyEnv.pi.HTTP_PROXY.override), true);
    const planned = planProxyEnvOverrides({
      pi: { HTTP_PROXY: proxyEnv.pi.HTTP_PROXY.override, HTTPS_PROXY: "http://fresh:1" },
    });
    assert.equal(planned.next.pi?.HTTP_PROXY, "http://user:s3cret@127.0.0.1:7890");
    assert.equal(planned.next.pi?.HTTPS_PROXY, "http://fresh:1");
  });

  it("passes runner auth env and still strips database credentials", () => {
    const prevOpen = process.env.OPENAI_API_KEY;
    const prevCursor = process.env.CURSOR_API_KEY;
    const prevDb = process.env.DATABASE_URL;
    process.env.OPENAI_API_KEY = "sk-test-openai";
    process.env.CURSOR_API_KEY = "cursor-secret";
    process.env.DATABASE_URL = "postgresql://postgres:secret@127.0.0.1/db";
    try {
      const codex = childProcessEnv("codex");
      assert.equal(codex.OPENAI_API_KEY, "sk-test-openai");
      assert.equal(codex.CURSOR_API_KEY, undefined);
      assert.equal(codex.DATABASE_URL, undefined);
      const agent = childProcessEnv("agent");
      assert.equal(agent.CURSOR_API_KEY, "cursor-secret");
      assert.equal(agent.OPENAI_API_KEY, undefined);
      assert.equal(agent.DATABASE_URL, undefined);
    } finally {
      if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpen;
      if (prevCursor === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevCursor;
      if (prevDb === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevDb;
    }
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

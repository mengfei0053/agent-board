import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { childProcessEnv, _resetProxyEnvOverridesForTests } from "./proxyEnv.js";
import {
  MAX_PROCESS_ENV_PER_KIND,
  _resetProcessEnvOverridesForTests,
  applyProcessEnvMemory,
  getProcessEnvSettings,
  parseProcessEnvJson,
  planProcessEnvOverrides,
} from "./processEnv.js";

afterEach(() => {
  _resetProcessEnvOverridesForTests({});
  _resetProxyEnvOverridesForTests({});
});

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

describe("parseProcessEnvJson", () => {
  it("handles empty, invalid, and unknown shapes", () => {
    assert.deepEqual(parseProcessEnvJson(""), {});
    assert.deepEqual(parseProcessEnvJson("{"), {});
    assert.deepEqual(parseProcessEnvJson("[]"), {});
    assert.deepEqual(parseProcessEnvJson(JSON.stringify({ nope: { A: "1" } })), {});
  });

  it("drops invalid, reserved, empty, and oversized entries", () => {
    const parsed = parseProcessEnvJson(JSON.stringify({
      pi: {
        OK: "value",
        "bad-key": "x",
        DATABASE_URL: "postgres://secret",
        EMPTY: "  ",
        LONG: "x".repeat(8_193),
        NUMBER: 1,
      },
    }));
    assert.deepEqual(parsed, { pi: { OK: "value" } });
  });

  it("caps entries per kind", () => {
    const map: Record<string, string> = {};
    for (let i = 0; i < MAX_PROCESS_ENV_PER_KIND + 5; i += 1) map[`K${i}`] = "v";
    const parsed = parseProcessEnvJson(JSON.stringify({ codex: map }));
    assert.equal(Object.keys(parsed.codex || {}).length, MAX_PROCESS_ENV_PER_KIND);
  });
});

describe("planProcessEnvOverrides", () => {
  it("replaces a kind wholesale and drops empty values", () => {
    _resetProcessEnvOverridesForTests({ pi: { OLD: "1" }, codex: { KEEP: "1" } });
    const planned = planProcessEnvOverrides({
      pi: { NEW: "2", EMPTY: "", NULLED: null },
    });
    assert.deepEqual(planned.next.pi, { NEW: "2" });
    assert.deepEqual(planned.next.codex, { KEEP: "1" });
    assert.equal(planned.json.includes("OLD"), false);
  });

  it("clears a kind with an empty object", () => {
    _resetProcessEnvOverridesForTests({ pi: { OLD: "1" } });
    const planned = planProcessEnvOverrides({ pi: {} });
    assert.equal(planned.next.pi, undefined);
    assert.deepEqual(parseProcessEnvJson(planned.json), {});
  });

  it("rejects invalid keys, reserved keys, and bad values", () => {
    assert.throws(() => planProcessEnvOverrides({ pi: { "BAD KEY": "x" } }), /invalid key/);
    assert.throws(() => planProcessEnvOverrides({ pi: { HTTP_PROXY: "http://x" } }), /reserved/);
    assert.throws(() => planProcessEnvOverrides({ pi: { DATABASE_URL: "postgres://x" } }), /reserved/);
    assert.throws(() => planProcessEnvOverrides({ pi: { OK: 1 } }), /must be a string/);
    assert.throws(() => planProcessEnvOverrides({ pi: { OK: "a\0b" } }), /NUL/);
    assert.throws(() => planProcessEnvOverrides({ nope: {} }), /unknown processEnv kind/);
    assert.throws(() => planProcessEnvOverrides({ pi: [] }), /must be an object/);
    assert.throws(() => planProcessEnvOverrides(null), /processEnv must be an object/);
  });
});

describe("custom process env in childProcessEnv", () => {
  it("applies only to its kind and overrides inherited values", () => {
    withEnv("OPENAI_API_KEY", "board-key", () => {
      applyProcessEnvMemory({ pi: { OPENAI_API_KEY: "pi-key", EXTRA_FLAG: "1" } });
      const pi = childProcessEnv("pi");
      assert.equal(pi.OPENAI_API_KEY, "pi-key");
      assert.equal(pi.EXTRA_FLAG, "1");
      assert.equal(childProcessEnv("codex").OPENAI_API_KEY, "board-key");
      assert.equal(childProcessEnv("codex").EXTRA_FLAG, undefined);
    });
  });

  it("keeps proxy overrides ahead of custom variables", () => {
    applyProcessEnvMemory({ pi: { HTTP_PROXY: "http://custom:1" } });
    _resetProxyEnvOverridesForTests({ pi: { HTTP_PROXY: "http://proxy:2" } });
    assert.equal(childProcessEnv("pi").HTTP_PROXY, "http://proxy:2");
  });

  it("still filters control-plane secrets", () => {
    applyProcessEnvMemory({ pi: { DATABASE_URL: "postgresql://postgres:secret@127.0.0.1/db" } });
    assert.equal(childProcessEnv("pi").DATABASE_URL, undefined);
  });

  it("returns all kinds in the settings document", () => {
    _resetProcessEnvOverridesForTests({ claude: { ANTHROPIC_MODEL: "m" } });
    const doc = getProcessEnvSettings();
    assert.deepEqual(doc.processEnv.claude, { ANTHROPIC_MODEL: "m" });
    assert.deepEqual(doc.processEnv.pi, {});
    assert.deepEqual(doc.processEnv.codex, {});
  });
});

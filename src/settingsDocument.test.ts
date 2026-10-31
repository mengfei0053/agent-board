import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { _resetCliPathOverridesForTests } from "./cliPaths.js";
import { _resetCodexSandboxForTests } from "./codexSandbox.js";
import { childProcessEnv, _resetProxyEnvOverridesForTests } from "./proxyEnv.js";
import { _resetQuickPromptsForTests } from "./quickPrompts.js";
import {
  readSettingsDocument,
  setSettingsMetaUpsertForTests,
  writeSettingsDocument,
} from "./settingsDocument.js";

const SECRET = "s3cret-pass";
const PROXY = `http://user:${SECRET}@127.0.0.1:8899`;
const PLACEHOLDER = "http://user:***@127.0.0.1:8899";

afterEach(() => {
  setSettingsMetaUpsertForTests(null);
  _resetProxyEnvOverridesForTests({});
  _resetCliPathOverridesForTests({});
  _resetQuickPromptsForTests([]);
  _resetCodexSandboxForTests(true);
});

describe("settings document", () => {
  it("redacts a new proxy credential and keeps a *** placeholder", async () => {
    const logs = captureConsole();
    setSettingsMetaUpsertForTests(async () => undefined);
    try {
      const saved = await writeSettingsDocument({
        proxyEnv: { codex: { HTTP_PROXY: PROXY } },
        quickPrompts: [{ id: "qp1", label: "Ship", content: "ship it" }],
      }, { allowClear: false });
      assert.equal(saved.proxyEnv.codex.HTTP_PROXY.override, PLACEHOLDER);
      assert.equal(saved.proxyEnv.codex.HTTP_PROXY.hasCredential, true);
      assert.equal(saved.quickPrompts[0]?.content, "ship it");
      assert.equal(JSON.stringify(saved).includes(SECRET), false);
      assert.equal(childProcessEnv("codex").HTTP_PROXY, PROXY);

      const kept = await writeSettingsDocument({
        proxyEnv: { codex: { HTTP_PROXY: PLACEHOLDER } },
      }, { allowClear: false });
      assert.equal(kept.proxyEnv.codex.HTTP_PROXY.override, PLACEHOLDER);
      assert.equal(kept.quickPrompts[0]?.label, "Ship");
      assert.equal(childProcessEnv("codex").HTTP_PROXY, PROXY);
      assert.equal(JSON.stringify(kept).includes(SECRET), false);

      const read = await readSettingsDocument();
      assert.equal(JSON.stringify(read).includes(SECRET), false);
      assert.equal(logs(), false);
    } finally {
      logs.restore();
    }
  });

  it("rejects clear without resetting, and hides persist failures that echo the secret", async () => {
    setSettingsMetaUpsertForTests(async () => undefined);
    await writeSettingsDocument({
      proxyEnv: { codex: { HTTP_PROXY: PROXY } },
    }, { allowClear: false });

    await assert.rejects(
      writeSettingsDocument({ clear: true, proxyEnv: { codex: { HTTP_PROXY: PROXY } } }, { allowClear: false }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "clear is not allowed");
        assert.equal(JSON.stringify(err).includes(SECRET), false);
        return true;
      },
    );
    assert.equal(childProcessEnv("codex").HTTP_PROXY, PROXY);

    setSettingsMetaUpsertForTests(async () => {
      throw new Error(`duplicate key ${PROXY}`);
    });
    await assert.rejects(
      writeSettingsDocument({ proxyEnv: { pi: { HTTP_PROXY: PROXY } } }, { allowClear: false }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal(err.message, "settings write failed");
        assert.equal("cause" in err && (err as { cause?: unknown }).cause !== undefined, false);
        assert.equal(JSON.stringify(err).includes(SECRET), false);
        return true;
      },
    );
    const afterFailure = await readSettingsDocument();
    assert.equal(afterFailure.proxyEnv.pi.HTTP_PROXY.configured, false);
    assert.equal(afterFailure.proxyEnv.codex.HTTP_PROXY.hasCredential, true);
  });

  it("lets HTTP clear and does not replace omitted settings groups", async () => {
    setSettingsMetaUpsertForTests(async () => undefined);
    await writeSettingsDocument({
      proxyEnv: { codex: { HTTP_PROXY: "http://127.0.0.1:1" } },
      quickPrompts: [{ label: "Keep", content: "kept" }],
      codexSandbox: false,
    }, { allowClear: true });
    const partial = await writeSettingsDocument({ cliPaths: { codex: "codex-bin" } }, { allowClear: true });
    assert.equal(partial.cliPaths.codex.override, "codex-bin");
    assert.equal(partial.proxyEnv.codex.HTTP_PROXY.override, "http://127.0.0.1:1");
    assert.equal(partial.quickPrompts[0]?.label, "Keep");
    assert.equal(partial.codexSandbox, false);

    const cleared = await writeSettingsDocument({ clear: true }, { allowClear: true });
    assert.equal(cleared.proxyEnv.codex.HTTP_PROXY.override, "");
    assert.equal(cleared.cliPaths.codex.override, "");
    assert.equal(cleared.codexSandbox, true);
    assert.equal(cleared.quickPrompts[0]?.label, "Keep");
  });
});

function captureConsole(): (() => boolean) & { restore(): void } {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(args.map((item) => {
      try {
        return typeof item === "string" ? item : JSON.stringify(item);
      } catch {
        return String(item);
      }
    }).join(" "));
  };
  console.log = push;
  console.warn = push;
  console.error = push;
  const done = () => lines.some((line) => line.includes(SECRET));
  done.restore = () => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
  return done;
}

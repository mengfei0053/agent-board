import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  CLI_COMMAND_DEFAULTS,
  CLI_COMMAND_KEYS,
  _resetCliPathOverridesForTests,
  getCliPathSettings,
  parseCliPathsJson,
  resolveCliCommand,
  whichResolved,
} from "./cliPaths.js";

afterEach(() => {
  _resetCliPathOverridesForTests({});
});

describe("parseCliPathsJson / resolveCliCommand", () => {
  it("parses and ignores junk", () => {
    assert.deepEqual(parseCliPathsJson(""), {});
    assert.deepEqual(parseCliPathsJson("{"), {});
    assert.deepEqual(
      parseCliPathsJson(JSON.stringify({ pi: " /opt/pi ", nope: "x", claude: "  " })),
      { pi: "/opt/pi" },
    );
  });

  it("resolves override or default", () => {
    assert.equal(resolveCliCommand("pi"), CLI_COMMAND_DEFAULTS.pi);
    _resetCliPathOverridesForTests({ pi: "/custom/pi" });
    assert.equal(resolveCliCommand("pi"), "/custom/pi");
    assert.equal(resolveCliCommand("codex"), "codex");
  });

  it("getCliPathSettings reflects overrides", () => {
    _resetCliPathOverridesForTests({ agent: "/bin/agent" });
    const { cliPaths } = getCliPathSettings();
    assert.equal(cliPaths.agent.override, "/bin/agent");
    assert.equal(cliPaths.agent.effective, "/bin/agent");
    assert.equal(cliPaths.pi.default, "pi");
    assert.equal(CLI_COMMAND_KEYS.length, 5);
  });
});

describe("whichResolved", () => {
  it("checks absolute path existence", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-which-"));
    try {
      const bin = join(dir, "mybin");
      writeFileSync(bin, "#!/bin/sh\n");
      chmodSync(bin, 0o755);
      assert.equal(whichResolved(bin), bin);
      assert.equal(whichResolved(join(dir, "missing")), null);
      assert.equal(whichResolved(""), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves a known PATH command", () => {
    const sh = whichResolved("sh");
    assert.ok(sh);
    assert.match(sh!, /sh$/);
  });
});

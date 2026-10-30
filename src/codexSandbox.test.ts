import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  _resetCodexSandboxForTests,
  getCodexSandboxSettings,
  isCodexSandboxEnabled,
  parseCodexSandboxValue,
} from "./codexSandbox.js";

afterEach(() => {
  _resetCodexSandboxForTests(true);
});

describe("parseCodexSandboxValue", () => {
  it("defaults empty to true (sandbox on)", () => {
    assert.equal(parseCodexSandboxValue(null), true);
    assert.equal(parseCodexSandboxValue(""), true);
    assert.equal(parseCodexSandboxValue("  "), true);
  });

  it("parses falsey / truthy strings", () => {
    for (const v of ["0", "false", "off", "no", "FALSE"]) {
      assert.equal(parseCodexSandboxValue(v), false, v);
    }
    for (const v of ["1", "true", "on", "yes", "TRUE"]) {
      assert.equal(parseCodexSandboxValue(v), true, v);
    }
  });

  it("parses JSON booleans / numbers / strings", () => {
    assert.equal(parseCodexSandboxValue("false"), false);
    assert.equal(parseCodexSandboxValue("true"), true);
    assert.equal(parseCodexSandboxValue("0"), false);
    assert.equal(parseCodexSandboxValue(JSON.stringify(false)), false);
    assert.equal(parseCodexSandboxValue(JSON.stringify(true)), true);
    assert.equal(parseCodexSandboxValue(JSON.stringify(0)), false);
    assert.equal(parseCodexSandboxValue(JSON.stringify("off")), false);
    assert.equal(parseCodexSandboxValue(JSON.stringify("on")), true);
  });
});

describe("isCodexSandboxEnabled / getCodexSandboxSettings", () => {
  it("reflects in-memory flag", () => {
    assert.equal(isCodexSandboxEnabled(), true);
    _resetCodexSandboxForTests(false);
    assert.equal(isCodexSandboxEnabled(), false);
    assert.deepEqual(getCodexSandboxSettings(), { codexSandbox: false });
  });
});

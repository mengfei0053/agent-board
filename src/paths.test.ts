import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInsideRoot } from "./paths.js";

describe("isInsideRoot", () => {
  it("treats / as containing its children", () => {
    assert.equal(isInsideRoot("/", "/tmp/work"), true);
    assert.equal(isInsideRoot("/", "/"), true);
    assert.equal(isInsideRoot("/home/me", "/home/me/proj"), true);
    assert.equal(isInsideRoot("/home/me", "/home/media"), false);
  });
});

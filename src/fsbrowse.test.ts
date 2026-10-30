import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { browseHome, listDirs } from "./fsbrowse.js";

describe("listDirs", () => {
  const probe = join(browseHome, ".agent-board-fsbrowse-test");
  const visible = join(browseHome, "agent-board-fsbrowse-visible");

  before(() => {
    mkdirSync(probe, { recursive: true });
    mkdirSync(visible, { recursive: true });
  });

  after(() => {
    rmSync(probe, { recursive: true, force: true });
    rmSync(visible, { recursive: true, force: true });
  });

  it("lists home and hides dot dirs", () => {
    const res = listDirs(browseHome);
    assert.equal(res.path, browseHome);
    assert.equal(res.parent, null);
    assert.ok(res.entries.includes("agent-board-fsbrowse-visible"));
    assert.ok(!res.entries.includes(".agent-board-fsbrowse-test"));
  });

  it("expands ~ and returns parent under home", () => {
    const res = listDirs("~/agent-board-fsbrowse-visible");
    assert.equal(res.path, visible);
    assert.equal(res.parent, browseHome);
    assert.deepEqual(res.entries, []);
  });

  it("rejects paths outside home", () => {
    assert.throws(() => listDirs("/tmp"), /outside home/);
    assert.throws(() => listDirs("/etc"), /outside home/);
  });

  it("rejects non-directory", () => {
    const filePath = join(visible, "not-a-dir.txt");
    writeFileSync(filePath, "x");
    assert.throws(() => listDirs(filePath), /not a directory/);
  });
});

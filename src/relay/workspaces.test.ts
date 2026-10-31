import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enrichWorkspaces } from "./workspaces.js";
import { makeWorkspace } from "./harness.js";

describe("relay workspaces", () => {
  it("demotes isGit when a later refresh fails", async () => {
    const workspace = makeWorkspace();
    const first = await enrichWorkspaces([workspace], async () => ({ ok: true }));
    assert.equal(first[0]?.isGit, true);
    const failed = await enrichWorkspaces([workspace], async () => {
      throw new Error("git rev-parse timed out");
    });
    assert.equal(failed[0]?.isGit, false);
    const ineligible = await enrichWorkspaces([workspace], async () => ({ ok: false }));
    assert.equal(ineligible[0]?.isGit, false);
  });

  it("drops workspace paths that are not local", async () => {
    const rows = await enrichWorkspaces(
      [makeWorkspace({ path: "https://example.invalid/repo" })],
      async () => ({ ok: true }),
    );
    assert.equal(rows.length, 0);
  });
});

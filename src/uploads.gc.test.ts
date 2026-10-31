import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isRepoDataPath, repoDataDir } from "./db.js";
import { gcOrphanUploads, openUploadNoFollow, writeUploadOwner } from "./uploads.js";

function oldFile(dir: string, name: string): string {
  const abs = join(dir, name);
  writeFileSync(abs, "attachment-bytes");
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
  utimesSync(abs, past, past);
  return abs;
}

describe("upload GC isolation (S5)", () => {
  it("does not delete files in a second root or a foreign owner", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "ab-gc-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "ab-gc-b-"));
    assert.equal(isRepoDataPath(rootA), false);
    assert.equal(isRepoDataPath(rootB), false);
    assert.notEqual(resolveSafe(rootA), resolveSafe(repoDataDir()));

    const kept = oldFile(rootB, "keptfile1.png");
    writeUploadOwner(rootB, { id: "owner-b", adoptedAt: 0 });

    const claimed = oldFile(rootA, "oldfile1.png");
    const first = await gcOrphanUploads(new Set(), {
      dir: rootA,
      ownerId: "owner-a",
      maxAgeMs: 0,
      dropRows: false,
    });
    assert.equal(first, 0, "unstamped root is claimed and not deleted");
    assert.equal(existsSync(claimed), true);
    assert.equal(existsSync(kept), true);

    const mismatched = await gcOrphanUploads(new Set(), {
      dir: rootB,
      ownerId: "owner-a",
      maxAgeMs: 0,
      dropRows: false,
    });
    assert.equal(mismatched, 0);
    assert.equal(existsSync(kept), true);

    writeUploadOwner(rootA, { id: "owner-a", adoptedAt: 0 });
    const swept = await gcOrphanUploads(new Set(), {
      dir: rootA,
      ownerId: "owner-a",
      maxAgeMs: 0,
      dropRows: false,
    });
    assert.equal(swept, 1);
    assert.equal(existsSync(claimed), false);
    assert.equal(existsSync(kept), true);
    const trash = readdirSync(join(rootA, ".trash"));
    assert.ok(trash.some((name) => name.endsWith("oldfile1.png")));
  });

  it("does not open a symlink inside the upload root", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-gc-link-"));
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "secret");
    const link = join(dir, "linked01.txt");
    symlinkSync(outside, link);
    assert.equal(openUploadNoFollow(link), null);
    assert.equal(existsSync(outside), true);
  });

  it("refuses the repo data directory when the test guard is set", async () => {
    const prev = process.env.AGENT_BOARD_REFUSE_REPO_DATA;
    process.env.AGENT_BOARD_REFUSE_REPO_DATA = "1";
    try {
      await assert.rejects(
        gcOrphanUploads(new Set(), { dir: repoDataDir(), ownerId: "x", dropRows: false }),
        /refusing to touch repo data/,
      );
    } finally {
      if (prev === undefined) delete process.env.AGENT_BOARD_REFUSE_REPO_DATA;
      else process.env.AGENT_BOARD_REFUSE_REPO_DATA = prev;
    }
  });
});

function resolveSafe(p: string): string {
  return p;
}

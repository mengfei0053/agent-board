import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  MAX_ATTACHMENTS_PER_TASK,
  MAX_ATTACHMENT_BYTES,
  MAX_UPLOAD_BYTES,
  absoluteUploadPath,
  appendAttachmentsToPrompt,
  collectUploadRefs,
  expandUploadUrlsInPrompt,
  extForMime,
  isAllowedImageMime,
  isSafeStoredName,
  isSafeUploadName,
  mimeForStoredName,
  normalizeAttachmentsInput,
  uploadNameReferenced,
  publicUploadUrl,
  stripImageMarkdown,
  uploadsDir,
  ensureUploadsDir,
} from "./uploads.js";

const tempUploads = mkdtempSync(join(tmpdir(), "agent-board-uploads-test-"));
process.env.UPLOADS_DIR = tempUploads;
process.env.AGENT_BOARD_REFUSE_REPO_DATA = "1";

describe("uploads mime / name guards", () => {
  it("allows known image mimes and maps ext", () => {
    assert.equal(isAllowedImageMime("image/png"), true);
    assert.equal(isAllowedImageMime("IMAGE/JPEG"), true);
    assert.equal(isAllowedImageMime("application/pdf"), false);
    assert.equal(extForMime("image/webp"), ".webp");
    assert.equal(extForMime("image/jpg"), ".jpg");
    assert.equal(extForMime("text/plain"), null);
  });

  it("validates safe upload and stored names", () => {
    assert.equal(isSafeUploadName("abc_12.png"), true);
    assert.equal(isSafeUploadName("../x.png"), false);
    assert.equal(isSafeUploadName("a.pdf"), false);
    assert.equal(isSafeStoredName("abc_12.pdf"), true);
    assert.equal(isSafeStoredName("x.JSON"), true);
    assert.equal(isSafeStoredName("../../etc/passwd"), false);
    assert.equal(isSafeStoredName("noext"), false);
  });

  it("resolves absolute paths under uploadsDir and rejects traversal", () => {
    ensureUploadsDir();
    const ok = absoluteUploadPath("safe_file.png");
    assert.ok(ok);
    assert.ok(ok!.startsWith(uploadsDir()));
    assert.equal(absoluteUploadPath("../escape.png"), null);
    assert.equal(absoluteUploadPath("bad name.png"), null);
  });

  it("maps mime from extension and public url", () => {
    assert.equal(mimeForStoredName("a.pdf"), "application/pdf");
    assert.equal(mimeForStoredName("a.unknown", "x/y"), "x/y");
    assert.equal(publicUploadUrl("z.png"), "/uploads/z.png");
    assert.ok(MAX_UPLOAD_BYTES > 0);
    assert.ok(MAX_ATTACHMENT_BYTES > MAX_UPLOAD_BYTES);
    assert.equal(MAX_ATTACHMENTS_PER_TASK, 20);
  });
});

describe("uploadNameReferenced", () => {
  it("sees attachments and prompt urls, ignores other tasks' files", () => {
    const tasks = [
      { attachments: [{ name: "a.png" }], prompt: "see /uploads/b.png" },
      { prompt: "nope" },
    ];
    assert.equal(uploadNameReferenced("a.png", tasks), true);
    assert.equal(uploadNameReferenced("b.png", tasks), true);
    assert.equal(uploadNameReferenced("c.png", tasks), false);
  });

  it("sees continue prompts and historical outputs", () => {
    const names = collectUploadRefs([
      {
        prompts: [{ prompt: "see /uploads/cont.png" }],
        outputs: [{ text: "saved /uploads/hist.pdf" }],
      },
    ]);
    assert.equal(names.has("cont.png"), true);
    assert.equal(names.has("hist.pdf"), true);
    assert.equal(uploadNameReferenced("hist.pdf", [
      { outputs: [{ text: "saved /uploads/hist.pdf" }] },
    ]), true);
  });
});

describe("expandUploadUrlsInPrompt / appendAttachmentsToPrompt", () => {
  const imgName = "utest_img_aa1.png";
  const attName = "utest_att_bb2.pdf";
  const imgPath = join(tempUploads, imgName);
  const attPath = join(tempUploads, attName);

  before(() => {
    ensureUploadsDir();
    writeFileSync(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(attPath, "pdf");
  });

  after(() => {
    for (const p of [imgPath, attPath]) {
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it("expands existing image markdown to absolute path", () => {
    const prompt = `see ![alt](/uploads/${imgName}) end`;
    const out = expandUploadUrlsInPrompt(prompt);
    assert.ok(out.includes(imgPath));
    assert.ok(out.includes(`![alt](${imgPath})`));
    assert.ok(!out.includes(`](/uploads/${imgName})`));
  });

  it("keeps url when file missing", () => {
    const prompt = "![x](/uploads/missing_zz9.png)";
    assert.equal(expandUploadUrlsInPrompt(prompt), prompt);
  });

  it("passes through empty / non-matching", () => {
    assert.equal(expandUploadUrlsInPrompt(""), "");
    assert.equal(expandUploadUrlsInPrompt("no images"), "no images");
  });

  it("appends attachment absolute paths", () => {
    const out = appendAttachmentsToPrompt("do work", [
      {
        name: attName,
        originalName: "报告.pdf",
        url: `/uploads/${attName}`,
        mime: "application/pdf",
        size: 3,
      },
    ]);
    assert.match(out, /【任务附件】/);
    assert.match(out, /报告\.pdf/);
    assert.ok(out.includes(attPath));
  });

  it("skips missing attachments and empty list", () => {
    assert.equal(appendAttachmentsToPrompt("p", undefined), "p");
    assert.equal(appendAttachmentsToPrompt("p", []), "p");
    const out = appendAttachmentsToPrompt("p", [
      {
        name: "gone_xx1.bin",
        originalName: "g",
        url: "/uploads/gone_xx1.bin",
        mime: "application/octet-stream",
        size: 1,
      },
    ]);
    assert.equal(out, "p");
  });
});

describe("stripImageMarkdown / normalizeAttachmentsInput", () => {
  const attName = "utest_norm_cc3.txt";
  const attPath = join(tempUploads, attName);

  before(() => {
    ensureUploadsDir();
    writeFileSync(attPath, "hi");
  });

  after(() => {
    try {
      if (existsSync(attPath)) unlinkSync(attPath);
    } catch {
      /* ignore */
    }
  });

  it("strips image markdown for titles", () => {
    assert.equal(stripImageMarkdown("a ![x](/uploads/a.png) b"), "a b");
    assert.equal(stripImageMarkdown(""), "");
  });

  it("normalizes valid attachment records", () => {
    const out = normalizeAttachmentsInput([
      { name: attName, originalName: "note.txt", mime: "text/plain", size: 2 },
      null,
      { name: "../bad.txt" },
      "skip",
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, attName);
    assert.equal(out[0].originalName, "note.txt");
    assert.equal(out[0].url, `/uploads/${attName}`);
  });

  it("throws when attachment file missing", () => {
    assert.throws(
      () => normalizeAttachmentsInput([{ name: "missing_dd4.bin" }]),
      (err: { status?: number; message?: string }) =>
        err?.status === 400 && /不存在|无效/.test(String(err.message)),
    );
  });

  it("returns [] for null and rejects a non-array", () => {
    assert.deepEqual(normalizeAttachmentsInput(null), []);
    assert.throws(
      () => normalizeAttachmentsInput({}),
      (err: { status?: number }) => err?.status === 400,
    );
  });
});

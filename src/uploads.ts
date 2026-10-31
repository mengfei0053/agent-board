import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";
import { nanoid } from "nanoid";
import type { TaskAttachment } from "./types.js";
import { assertDataRootAllowed, dataDir, databaseUrl } from "./db.js";
import { getPool } from "./db.js";

const OWNER_FILE = ".agent-board-upload-owner";
const TRASH_DIR = ".trash";

/** Upload root. `UPLOADS_DIR` wins; otherwise `<DATA_DIR>/uploads`. */
export function uploadsDir(): string {
  const raw = process.env.UPLOADS_DIR?.trim();
  if (raw) return resolve(raw);
  return join(dataDir(), "uploads");
}

/** Stable id for the database that owns this upload root. */
export function uploadOwnerId(dbUrl = databaseUrl()): string {
  return createHash("sha256").update(dbUrl).digest("hex");
}

/** Max upload size for prompt images (bytes). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Max size for task attachments (bytes). */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** Max attachments per task. */
export const MAX_ATTACHMENTS_PER_TASK = 20;

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const SAFE_IMAGE_NAME = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i;
/** Stored upload/attachment filenames on disk (nanoid + safe ext). */
const SAFE_STORED_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,16}$/;

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  xz: "application/x-xz",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  html: "text/html",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  log: "text/plain",
  py: "text/x-python",
  js: "text/javascript",
  ts: "text/typescript",
  sh: "text/x-shellscript",
  sql: "application/sql",
};

export function ensureUploadsDir(dir = uploadsDir()): void {
  assertDataRootAllowed(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function isAllowedImageMime(mime: string): boolean {
  return Boolean(MIME_EXT[mime.toLowerCase()]);
}

/** Magic-byte check so a renamed HTML file cannot be served as an image. */
export function sniffImageMime(buf: Uint8Array): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

const UPLOAD_REF_RE = /\/uploads\/([A-Za-z0-9_-]+\.[A-Za-z0-9]{1,16})/g;

export type UploadRefSource = {
  attachments?: { name: string }[] | undefined;
  prompt?: string;
  output?: string;
  prompts?: { prompt?: string }[] | undefined;
  outputs?: { text?: string }[] | undefined;
};

/** Every stored upload name referenced by attachments or any persisted text field. */
export function collectUploadRefs(tasks: Iterable<UploadRefSource>): Set<string> {
  const names = new Set<string>();
  for (const t of tasks) {
    for (const a of t.attachments || []) {
      if (a?.name) names.add(a.name);
    }
    const texts = [
      t.prompt,
      t.output,
      ...(t.prompts || []).map((p) => p.prompt),
      ...(t.outputs || []).map((o) => o.text),
    ];
    for (const text of texts) {
      if (!text) continue;
      for (const m of text.matchAll(UPLOAD_REF_RE)) {
        if (m[1]) names.add(m[1]);
      }
    }
  }
  return names;
}

export function uploadNameReferenced(
  name: string,
  tasks: Iterable<UploadRefSource>,
): boolean {
  return collectUploadRefs(tasks).has(name);
}

export function extForMime(mime: string): string | null {
  return MIME_EXT[mime.toLowerCase()] ?? null;
}

export function isSafeUploadName(name: string): boolean {
  return SAFE_IMAGE_NAME.test(name);
}

export function isSafeStoredName(name: string): boolean {
  return SAFE_STORED_NAME.test(name);
}

export function absoluteUploadPath(name: string, dir = uploadsDir()): string | null {
  if (!isSafeStoredName(name) && !isSafeUploadName(name)) return null;
  const abs = resolve(dir, name);
  const rootAbs = resolve(dir);
  if (!abs.startsWith(rootAbs + "/") && abs !== rootAbs) {
    return null;
  }
  return abs;
}

/** Open a stored file without following a symlink planted in the upload root. */
export function openUploadNoFollow(abs: string): { fd: number; size: number } | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      closeSync(fd);
      return null;
    }
    return { fd, size: st.size };
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    throw err;
  }
}

function writeExclusiveFile(dest: string, buf: Buffer): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(dest, flags, 0o644);
  try {
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) break;
      off += n;
    }
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }
  closeSync(fd);
}

export function publicUploadUrl(name: string): string {
  return `/uploads/${name}`;
}

export function mimeForStoredName(name: string, fallback = "application/octet-stream"): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_MIME[ext] || fallback;
}

function sanitizeOriginalName(name: string): string {
  const base = String(name || "file").replace(/[/\\]/g, "_").trim() || "file";
  return base.slice(0, 180);
}

function safeExtFromFilename(filename: string): string {
  const raw = extname(filename || "").replace(/^\./, "").toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]/g, "").slice(0, 16);
  return cleaned || "bin";
}

/**
 * Rewrite markdown image URLs `/uploads/x.png` → absolute file paths
 * so local Agent CLIs can read the image from disk.
 */
export function expandUploadUrlsInPrompt(prompt: string): string {
  if (!prompt) return prompt;
  return prompt.replace(
    /!\[([^\]]*)\]\((\/uploads\/([A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp)))\)/gi,
    (_m, alt: string, _url: string, name: string) => {
      const abs = absoluteUploadPath(name);
      if (!abs || !existsSync(abs)) return `![${alt}](${_url})`;
      return `![${alt}](${abs})`;
    },
  );
}

/** Append absolute attachment paths so the agent can open them. */
export function appendAttachmentsToPrompt(
  prompt: string,
  attachments: TaskAttachment[] | undefined,
): string {
  if (!attachments?.length) return prompt;
  const lines: string[] = [];
  for (const a of attachments) {
    const abs = absoluteUploadPath(a.name);
    if (!abs || !existsSync(abs)) continue;
    const label = a.originalName || a.name;
    lines.push(`- ${label}: ${abs}`);
  }
  if (!lines.length) return prompt;
  const block = `\n\n【任务附件】（本地绝对路径，可直接读取）\n${lines.join("\n")}`;
  return `${prompt || ""}${block}`;
}

/** Strip image markdown for short titles / card text. */
export function stripImageMarkdown(text: string): string {
  return String(text || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function saveUploadFile(
  file: File,
): Promise<{ name: string; url: string; mime: string; size: number }> {
  const mime = (file.type || "").toLowerCase();
  const ext = extForMime(mime);
  if (!ext) {
    throw Object.assign(new Error("仅支持 PNG / JPEG / GIF / WebP 图片"), { status: 400 });
  }
  if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`图片过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`), {
      status: 400,
    });
  }
  ensureUploadsDir();
  const dir = uploadsDir();
  const name = `${nanoid(12)}${ext}`;
  const dest = join(dir, name);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`图片过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`), {
      status: 400,
    });
  }
  const sniffed = sniffImageMime(buf);
  if (!sniffed || sniffed !== mime && !(mime === "image/jpg" && sniffed === "image/jpeg")) {
    throw Object.assign(new Error("文件内容与图片类型不符"), { status: 400 });
  }
  writeExclusiveFile(dest, buf);
  try {
    await rememberUpload({ name, originalName: file.name || name, mime: sniffed, size: buf.length });
  } catch (err) {
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }
  return { name, url: publicUploadUrl(name), mime: sniffed, size: buf.length };
}

export async function saveAttachmentFile(file: File): Promise<TaskAttachment> {
  if (typeof file.size === "number" && file.size > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(
      new Error(`附件过大（上限 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB）`),
      { status: 400 },
    );
  }
  ensureUploadsDir();
  const originalName = sanitizeOriginalName(file.name || "file");
  const ext = safeExtFromFilename(originalName);
  const dir = uploadsDir();
  const name = `${nanoid(12)}.${ext}`;
  const dest = join(dir, name);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw Object.assign(
      new Error(`附件过大（上限 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB）`),
      { status: 400 },
    );
  }
  if (buf.length === 0) {
    throw Object.assign(new Error("附件为空文件"), { status: 400 });
  }
  writeExclusiveFile(dest, buf);
  const mime =
    (file.type || "").trim() || mimeForStoredName(name, "application/octet-stream");
  try {
    await rememberUpload({ name, originalName, mime, size: buf.length });
  } catch (err) {
    try { unlinkSync(dest); } catch { /* ignore */ }
    throw err;
  }
  return {
    name,
    originalName,
    url: publicUploadUrl(name),
    mime,
    size: buf.length,
  };
}

async function rememberUpload(row: {
  name: string;
  originalName: string;
  mime: string;
  size: number;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO uploads (name, original_name, mime, size)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET
       original_name = EXCLUDED.original_name,
       mime = EXCLUDED.mime,
       size = EXCLUDED.size`,
    [row.name, row.originalName.slice(0, 180), row.mime.slice(0, 200), row.size],
  );
}

export function deleteAttachmentFiles(attachments: TaskAttachment[] | undefined): void {
  if (!attachments?.length) return;
  for (const a of attachments) unlinkUploadFile(a.name);
}

function unlinkUploadFile(name: string, dir = uploadsDir()): void {
  const abs = absoluteUploadPath(name, dir);
  if (!abs) return;
  try {
    const st = lstatSync(abs);
    if (!st.isFile()) return;
    unlinkSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    console.warn(`[uploads] could not remove attachment ${name}:`, err);
  }
}

type OwnerStamp = { id: string; adoptedAt: number };

function ownerPath(dir: string): string {
  return join(dir, OWNER_FILE);
}

export function readUploadOwner(dir: string): OwnerStamp | null {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath(dir), "utf8")) as OwnerStamp;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.adoptedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeUploadOwner(dir: string, stamp: OwnerStamp): void {
  writeFileSync(ownerPath(dir), JSON.stringify(stamp));
}

function ownerAllowsDelete(dir: string, ownerId: string): OwnerStamp | null {
  const stamp = readUploadOwner(dir);
  if (!stamp || stamp.id !== ownerId) return null;
  return stamp;
}

/**
 * Unlink files no remaining task points at. `tasks` is the post-delete set.
 * Shared attachments stay on disk. A root owned by another database is left alone.
 */
export async function removeUploadsIfUnreferenced(
  names: string[],
  tasks: Iterable<UploadRefSource>,
  opts?: { dir?: string; ownerId?: string },
): Promise<void> {
  const dir = opts?.dir ?? uploadsDir();
  const ownerId = opts?.ownerId ?? uploadOwnerId();
  if (!ownerAllowsDelete(dir, ownerId)) return;
  const unique = [...new Set(names.filter(Boolean))];
  const referenced = collectUploadRefs(tasks);
  const dropped: string[] = [];
  for (const name of unique) {
    if (referenced.has(name)) continue;
    unlinkUploadFile(name, dir);
    dropped.push(name);
  }
  if (!dropped.length) return;
  try {
    await getPool().query(`DELETE FROM uploads WHERE name = ANY($1::text[])`, [dropped]);
  } catch (err) {
    console.warn("[uploads] could not drop upload rows:", err);
  }
}

export type GcOrphanOptions = {
  maxAgeMs?: number;
  dir?: string;
  ownerId?: string;
  now?: number;
  /** When false, skip the uploads-table DELETE (unit tests with no pool). */
  dropRows?: boolean;
};

/**
 * Quarantine unreferenced files in one upload root.
 * A directory is not deletable just because the current database has no refs:
 * the root must carry this database's owner stamp, and files that predate the
 * stamp (a populated dir claimed on first sight) are left in place.
 * The first call on an unstamped directory writes the stamp and deletes nothing.
 */
export async function gcOrphanUploads(
  referenced: Set<string>,
  maxAgeMsOrOpts: number | GcOrphanOptions = 24 * 60 * 60 * 1000,
): Promise<number> {
  const opts: GcOrphanOptions =
    typeof maxAgeMsOrOpts === "number" ? { maxAgeMs: maxAgeMsOrOpts } : maxAgeMsOrOpts;
  const dir = opts.dir ?? uploadsDir();
  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now();
  const ownerId = opts.ownerId ?? uploadOwnerId();
  ensureUploadsDir(dir);
  let stamp = readUploadOwner(dir);
  if (!stamp) {
    writeUploadOwner(dir, { id: ownerId, adoptedAt: now });
    return 0;
  }
  if (stamp.id !== ownerId) return 0;

  const trash = join(dir, TRASH_DIR);
  const dropped: string[] = [];
  const justQuarantined = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (name === OWNER_FILE || name === TRASH_DIR) continue;
    if (!isSafeStoredName(name) && !isSafeUploadName(name)) continue;
    if (referenced.has(name)) continue;
    const abs = join(dir, name);
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) continue;
      if (st.mtimeMs < stamp.adoptedAt) continue;
      if (now - st.mtimeMs < maxAgeMs) continue;
      mkdirSync(trash, { recursive: true });
      const trashedName = `${now}-${name}`;
      const trashed = join(trash, trashedName);
      renameSync(abs, trashed);
      // Start the retention clock at quarantine time, not the original mtime.
      const stampDate = new Date(now);
      utimesSync(trashed, stampDate, stampDate);
      justQuarantined.add(trashedName);
      dropped.push(name);
    } catch (err) {
      console.warn(`[uploads] gc skip ${name}:`, err);
    }
  }
  if (existsSync(trash)) {
    for (const name of readdirSync(trash)) {
      if (justQuarantined.has(name)) continue;
      const abs = join(trash, name);
      try {
        const st = lstatSync(abs);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs < maxAgeMs) continue;
        unlinkSync(abs);
      } catch (err) {
        console.warn(`[uploads] gc trash skip ${name}:`, err);
      }
    }
  }
  if (dropped.length && opts.dropRows !== false) {
    try {
      await getPool().query(`DELETE FROM uploads WHERE name = ANY($1::text[])`, [dropped]);
    } catch (err) {
      console.warn("[uploads] gc row delete failed:", err);
    }
  }
  return dropped.length;
}

export function normalizeAttachmentsInput(
  raw: unknown,
): TaskAttachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("attachments must be an array"), { status: 400 });
  }
  const out: TaskAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name || !isSafeStoredName(name)) continue;
    const abs = absoluteUploadPath(name);
    if (!abs || !existsSync(abs)) {
      throw Object.assign(new Error(`附件不存在或无效: ${name}`), { status: 400 });
    }
    const originalName = sanitizeOriginalName(
      typeof rec.originalName === "string" ? rec.originalName : name,
    );
    const mime =
      typeof rec.mime === "string" && rec.mime.trim()
        ? rec.mime.trim()
        : mimeForStoredName(name);
    const size =
      typeof rec.size === "number" && Number.isFinite(rec.size)
        ? Math.max(0, Math.floor(rec.size))
        : 0;
    out.push({
      name,
      originalName,
      url: publicUploadUrl(name),
      mime,
      size,
    });
    if (out.length > MAX_ATTACHMENTS_PER_TASK) {
      throw Object.assign(
        new Error(`附件过多（上限 ${MAX_ATTACHMENTS_PER_TASK} 个）`),
        { status: 400 },
      );
    }
  }
  return out;
}

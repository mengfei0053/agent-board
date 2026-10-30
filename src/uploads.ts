import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { TaskAttachment } from "./types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const uploadsDir = join(root, "data", "uploads");

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

export function ensureUploadsDir(): void {
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
}

export function isAllowedImageMime(mime: string): boolean {
  return Boolean(MIME_EXT[mime.toLowerCase()]);
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

export function absoluteUploadPath(name: string): string | null {
  if (!isSafeStoredName(name) && !isSafeUploadName(name)) return null;
  const abs = resolve(uploadsDir, name);
  const rootAbs = resolve(uploadsDir);
  if (!abs.startsWith(rootAbs + "/") && abs !== rootAbs) {
    return null;
  }
  return abs;
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
  const name = `${nanoid(12)}${ext}`;
  const dest = join(uploadsDir, name);
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`图片过大（上限 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB）`), {
      status: 400,
    });
  }
  await pipeline(Readable.from(buf), createWriteStream(dest));
  return { name, url: publicUploadUrl(name), mime, size: buf.length };
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
  const name = `${nanoid(12)}.${ext}`;
  const dest = join(uploadsDir, name);
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
  await pipeline(Readable.from(buf), createWriteStream(dest));
  const mime =
    (file.type || "").trim() || mimeForStoredName(name, "application/octet-stream");
  return {
    name,
    originalName,
    url: publicUploadUrl(name),
    mime,
    size: buf.length,
  };
}

export function deleteAttachmentFiles(attachments: TaskAttachment[] | undefined): void {
  if (!attachments?.length) return;
  for (const a of attachments) {
    const abs = absoluteUploadPath(a.name);
    if (!abs) continue;
    try {
      if (existsSync(abs)) unlinkSync(abs);
    } catch (err) {
      console.warn(`[uploads] could not remove attachment ${a.name}:`, err);
    }
  }
}

export function normalizeAttachmentsInput(
  raw: unknown,
): TaskAttachment[] {
  if (!Array.isArray(raw)) return [];
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

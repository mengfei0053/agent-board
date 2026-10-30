import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const uploadsDir = join(root, "data", "uploads");

/** Max upload size (bytes). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const SAFE_NAME = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i;

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
  return SAFE_NAME.test(name);
}

export function absoluteUploadPath(name: string): string | null {
  if (!isSafeUploadName(name)) return null;
  const abs = resolve(uploadsDir, name);
  if (!abs.startsWith(resolve(uploadsDir) + "/") && abs !== resolve(uploadsDir)) {
    return null;
  }
  return abs;
}

export function publicUploadUrl(name: string): string {
  return `/uploads/${name}`;
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

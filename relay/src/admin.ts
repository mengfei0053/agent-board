import { readFileSync } from "node:fs";
import type { ServerResponse } from "node:http";

const assets = new Map([
  ["/admin", { type: "text/html; charset=utf-8", body: readFileSync(new URL("../public/admin.html", import.meta.url)) }],
  ["/admin/", { type: "text/html; charset=utf-8", body: readFileSync(new URL("../public/admin.html", import.meta.url)) }],
  ["/admin/admin.css", { type: "text/css; charset=utf-8", body: readFileSync(new URL("../public/admin.css", import.meta.url)) }],
  ["/admin/admin.js", { type: "text/javascript; charset=utf-8", body: readFileSync(new URL("../public/admin.js", import.meta.url)) }],
]);

export function serveAdmin(path: string, method: string | undefined, res: ServerResponse): boolean {
  const asset = assets.get(path);
  if (!asset) return false;
  const allowed = method === "GET" || method === "HEAD";
  res.writeHead(allowed ? 200 : 405, {
    "content-type": asset.type,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    ...(allowed ? { "content-length": asset.body.length } : { allow: "GET, HEAD" }),
  });
  res.end(allowed && method !== "HEAD" ? asset.body : undefined);
  return true;
}

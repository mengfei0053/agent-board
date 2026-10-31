import { HttpError } from "../httpError.js";

/** Error returned to the relay as an `err` frame. `message` is already safe to send. */
export class RelayCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RelayCommandError";
    this.code = code;
  }
}

function clip(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
}

function stableHttpMessage(err: HttpError): string {
  const msg = err.message;
  if (/exceeds \d+ characters/.test(msg) && !msg.includes("/") && !msg.includes("\\")) return msg;
  if (/cwd required|path required/i.test(msg)) return "cwd is required";
  if (/must be an absolute path/i.test(msg)) return "cwd must be an absolute path";
  if (/not a directory/i.test(msg)) return "cwd is not a directory";
  if (/outside allowed roots/i.test(msg)) return "cwd is outside allowed roots";
  if (/not found/i.test(msg)) return "cwd not found";
  if (err.statusCode >= 500) return "board request failed";
  return "bad request";
}

/** Map manager / HTTP failures onto relay codes. Never includes paths or stack traces. */
export function relayErrorFrom(err: unknown): RelayCommandError {
  if (err instanceof RelayCommandError) {
    return new RelayCommandError(err.code, clip(err.message) || "bad request");
  }
  if (err instanceof Error && err.message === "not found") {
    return new RelayCommandError("task_not_found", "task not found");
  }
  if (err instanceof HttpError) {
    const message = stableHttpMessage(err);
    if (message === "cwd is required") return new RelayCommandError("cwd_required", message);
    if (err.statusCode === 404) return new RelayCommandError("task_not_found", "task not found");
    if (err.statusCode === 403) return new RelayCommandError("forbidden", "forbidden");
    if (err.statusCode >= 500) return new RelayCommandError("board_http", "board request failed");
    return new RelayCommandError("bad_request", message);
  }
  return new RelayCommandError("board_http", "board request failed");
}

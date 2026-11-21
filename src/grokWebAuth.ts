import { execFile, spawn } from "node:child_process";
import { parse } from "node:path";
import { promisify } from "node:util";
import { cliEnv, resolveBdkCommand } from "./runners/grok.js";

export type GrokWebAuthStatus = {
  state: "idle" | "pending" | "success" | "failed";
  loginUrl?: string;
  message?: string;
};

const cwd = parse(process.cwd()).root;
const loginFailure = "BDK login failed. Please retry.";
const envOverride = "Environment credentials take precedence. Remove them before using browser login.";
const hasOverride = (env: NodeJS.ProcessEnv) => Boolean(env.CURSOR_API_KEY || env.CURSOR_API_KEY_FILE || env.CURSOR_SERVICE_ACCOUNT_KEY);
// Match the complete standalone stderr line emitted by 0.7.2, not a URL substring.
// No URL normalization, extra/duplicate params, credentials, fragments or trailing text.
const loginLink = /^ *(https:\/\/cursor\.com\/loginDeepControl\?challenge=[A-Za-z0-9_-]{43}&uuid=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}&mode=login&redirectTarget=cli)\r?$/;
let state: GrokWebAuthStatus = { state: "idle" };
let running = false;
function status(): GrokWebAuthStatus { return { ...state }; }

function start(): GrokWebAuthStatus {
  if (running) return status();
  const env = cliEnv();
  if (hasOverride(env)) {
    state = { state: "failed", message: envOverride };
    return status();
  }
  try {
    const [bin, ...prefix] = resolveBdkCommand();
    const child = spawn(bin, [...prefix, "login"], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    running = true;
    state = { state: "pending" };
    const kill = () => { child.kill("SIGKILL"); };
    const fail = (message: string) => {
      state = { state: "failed", message };
      kill();
      child.stdout.destroy();
      child.stderr.destroy();
    };
    process.once("exit", kill);
    const timer = setTimeout(() => fail("BDK login timed out. Please retry."), 5 * 60_000);
    let bytes = 0;
    let partial = "";
    const accept = (chunk: Buffer) => {
      if (state.state !== "pending") return false;
      bytes += chunk.length;
      if (bytes <= 64 * 1024) return true;
      fail(loginFailure);
      return false;
    };
    child.stdout.on("data", accept); // Identity and storage path are never used.
    child.stderr.on("data", (chunk: Buffer) => {
      if (!accept(chunk) || state.loginUrl) return;
      const lines = (partial + chunk.toString("latin1")).split("\n");
      partial = lines.pop()!; // Never publish a prefix before seeing the line terminator.
      for (const line of lines) {
        const match = loginLink.exec(line);
        if (match) {
          state = { state: "pending", loginUrl: match[1] };
          partial = "";
          break;
        }
      }
    });
    child.once("error", () => fail(loginFailure));
    child.once("close", code => {
      clearTimeout(timer);
      process.removeListener("exit", kill);
      running = false;
      if (state.state !== "pending") return;
      if (hasOverride(process.env)) state = { state: "failed", message: envOverride };
      else state = code === 0 && state.loginUrl ? { state: "success" } : { state: "failed", message: loginFailure };
    });
  } catch {
    state = { state: "failed", message: loginFailure };
  }
  return status();
}

const exec = promisify(execFile);
async function listDeployments(teamId?: string): Promise<string[]> {
  try {
    const [bin, ...prefix] = resolveBdkCommand();
    const env = cliEnv();
    const slugs = new Set<string>();
    const seenTokens = new Set<string>();
    let token: string | undefined;
    const signal = AbortSignal.timeout(30_000);
    for (let page = 0; page < 10; page++) {
      const args = [...prefix, "deployment", "list", "--json", "--fields", "slug"];
      if (teamId) args.push("--team", teamId);
      if (token) args.push(`--page-token=${token}`);
      const { stdout } = await exec(bin, args, { cwd, env, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true });
      const data = JSON.parse(stdout);
      if (!Array.isArray(data?.items)) break;
      for (const item of data.items) {
        if (typeof item?.slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item.slug)) slugs.add(item.slug);
      }
      token = data.nextPageToken;
      if (token == null || token === "") return [...slugs];
      if (typeof token !== "string" || token.length > 1024 || /[\x00-\x1f\x7f]/.test(token) || seenTokens.has(token)) break;
      seenTokens.add(token);
    }
  } catch { /* exec errors include raw stderr and argv; never propagate them. */ }
  throw new Error("Cannot list BDK deployments.");
}

const listings = new Map<string | undefined, Promise<string[]>>();
export const grokWebAuth = {
  start, status,
  deployments(teamId?: string): Promise<string[]> {
    const existing = listings.get(teamId);
    if (existing) return existing;
    if (listings.size >= 4) return Promise.reject(new Error("Too many pending deployment lists."));
    const pending = listDeployments(teamId).finally(() => listings.delete(teamId));
    listings.set(teamId, pending);
    return pending;
  },
};

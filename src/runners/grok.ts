import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, parse } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getGrokBotSettings } from "../grokBot.js";
import { summarizeOutput, upsertOutputTurn } from "../extractOutput.js";
import type { Runner } from "./types.js";

const sessionPattern = /^ses_[a-f0-9]{24}$/;
const remoteWarning = "Remote work may still be running; check the deployment before retrying.";
class RunError extends Error {}

// No workspace cwd, inherited NODE_OPTIONS, endpoint overrides, board DB/API secrets,
// npm project binaries, shell, or CLI stdout/stderr forwarding.
function cliEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", AGENT_SERVE_NO_UPDATE_CHECK: "1" };
  env.PATH = (process.env.PATH ?? "").split(delimiter)
    .filter(dir => isAbsolute(dir) && !dir.split(/[\\/]/).includes("node_modules")).join(delimiter);
  for (const key of ["HOME", "USERPROFILE", "SystemRoot", "XDG_CONFIG_HOME", "AGENT_SERVE_CONFIG_DIR",
    "CURSOR_API_KEY", "CURSOR_API_KEY_FILE", "CURSOR_SERVICE_ACCOUNT_KEY"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RunError("Invalid BDK JSON response.");
  return value as JsonObject;
}

function readCli(bin: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(bin, args, {
      cwd: parse(process.cwd()).root, env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    });
    // Wait for close even after killing the local CLI. A stopped observer never cancels a deployment.
    const kill = () => { child.kill("SIGKILL"); };
    signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, 135_000);
    const chunks: Buffer[] = [];
    let size = 0;
    let launchError = false;
    child.on("error", () => { launchError = true; });
    child.stdout.on("data", (buf: Buffer) => {
      size += buf.length;
      if (size > 8 * 1024 * 1024) kill();
      else chunks.push(buf);
    });
    child.on("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (launchError) return reject(new RunError("Cannot start bdk. Check the operator-installed executable and Node version."));
      if (size > 8 * 1024 * 1024) return reject(new RunError("BDK response exceeds the observation limit."));
      if (code !== 0) {
        const reason = code === 5 ? "authentication/permission denied" : code === 3 ? "delivery pending" : `exit ${code ?? "signal/timeout"}`;
        return reject(new RunError(`BDK ${args.slice(0, 2).join(" ")} failed (${reason}).`));
      }
      try { resolve(object(JSON.parse(Buffer.concat(chunks).toString("utf8")))); }
      catch { reject(new RunError("Invalid BDK JSON response.")); }
    });
  });
}

// Platform deliveryId and the SDK send's deliveryId are not interchangeable.
// Match our unique wake, then its turnId, never the last execution/text in the session.
function completedReply(snapshot: JsonObject, id: string, wake: string): string | undefined {
  if (snapshot.sessionId !== id || !Array.isArray(snapshot.events)) throw new RunError("Unexpected BDK event envelope.");
  let turn: string | undefined;
  let text = "";
  for (const raw of snapshot.events) {
    const event = object(raw);
    const data = event.data as JsonObject | undefined;
    if (data?.parentCallId != null) continue;
    if (event.type === "message.received" && data?.text === wake && typeof event.turnId === "string") turn = event.turnId;
    if (!turn || event.turnId !== turn) continue;
    if (event.type === "message.completed" && typeof data?.text === "string" && data.text.trim()) text = data.text;
    if (event.type === "turn.failed" || event.type === "session.failed") throw new RunError("Hosted Grok turn failed.");
    if (event.type === "turn.completed") return text || (typeof data?.result === "string" ? data.result : "");
  }
  return undefined;
}

export const grokRunner: Runner = {
  start(task, hooks, opts) {
    const stopController = new AbortController();
    const { signal } = stopController;
    const deadline = AbortSignal.timeout(30 * 60_000);
    const observing = AbortSignal.any([signal, deadline]);
    let submitting = false;
    const run = async () => {
      const { enabled, slug } = getGrokBotSettings();
      if (!enabled || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new RunError("No enabled Grok deployment configured.");
      const followup = opts?.continuePrompt !== undefined;
      let resume: string | undefined;
      if (followup) {
        const [prefix, boundSlug, id, extra] = (task.sessionId ?? "").split(":");
        if (prefix !== "grok-prod" || boundSlug !== slug || !sessionPattern.test(id ?? "") || extra !== undefined) {
          throw new RunError("Cannot continue: missing session or Grok deployment binding changed. No message sent.");
        }
        resume = id;
      }
      if (task.model || task.thinkingEffort || task.attachments?.length || opts?.workspaceMcp?.trim()) {
        throw new RunError("Hosted Grok uses its deployed model/tools; local attachments, workspace MCP and model overrides are unsupported.");
      }
      const prompt = (opts?.continuePrompt ?? task.prompt).trim();
      const wake = `[Agent Board request: ${randomUUID()}]\n${prompt}`;
      if (!prompt || wake.length > 65536 || wake.includes("\0") || Buffer.byteLength(wake) > 120_000) throw new RunError("Empty or oversized/invalid Grok message.");
      const bin = process.env.AGENT_BOARD_BDK_BIN ?? "bdk";
      if (bin !== "bdk" && !isAbsolute(bin)) throw new RunError("AGENT_BOARD_BDK_BIN must be an absolute executable path.");
      const env = cliEnv();
      const cli = (...args: string[]) => readCli(bin, args, env, observing);
      const version = await cli("--version", "--json");
      if (version.name !== "@grok/agent-sdk" || version.version !== "0.7.2") throw new RunError("Expected operator-installed @cursor/bdk@0.7.2.");
      observing.throwIfAborted();
      hooks.onStatus({ status: "running", startedAt: new Date().toISOString(), lastEvent: "grok_submitting", summary: "Hosted Grok: stopping the board does not cancel remote work." });
      submitting = true;
      const ack = await cli("session", "create", "--prod", "--slug", slug, ...(resume ? ["--session", resume] : []), `--message=${wake}`, "--wait", "--json");
      const id = ack.sessionId;
      if (typeof id !== "string" || !sessionPattern.test(id) || (resume && resume !== id) || typeof ack.deliveryId !== "string" || !ack.deliveryId) {
        throw new RunError("BDK did not confirm the expected hosted session.");
      }
      observing.throwIfAborted();
      hooks.onStatus({ sessionId: `grok-prod:${slug}:${id}`, lastEvent: "grok_observing" });
      for (;;) {
        const snapshot = await cli("session", "get", id, "--prod", "--slug", slug, "--view", "events", "--json");
        observing.throwIfAborted();
        const output = completedReply(snapshot, id, wake);
        if (output !== undefined) {
          // Publish only the final assistant prose. No raw event, tool output, token,
          // CLI argument vector, or even the assistant reply goes through onLog.
          const text = output.trim();
          if ([env.CURSOR_API_KEY, env.CURSOR_SERVICE_ACCOUNT_KEY].some(key => key && text.includes(key)) || /continuationToken\s*["']?\s*[:=]/i.test(text)) {
            throw new RunError("Sensitive reply withheld.");
          }
          hooks.onStatus({ status: "succeeded", exitCode: 0, lastEvent: "turn.completed",
            ...(text ? { output: text, outputs: upsertOutputTurn(task.outputs, { iteration: task.iteration, text, at: new Date().toISOString() }), summary: summarizeOutput(text) }
              : { summary: "Hosted Grok turn completed without text." }),
          });
          return;
        }
        await sleep(3000, undefined, { signal: observing });
      }
    };
    const settled = run().catch((error: unknown) => {
      if (signal.aborted) hooks.onStatus({ status: "stopped", summary: remoteWarning, lastEvent: "grok_observer_stopped" });
      else {
        const reason = deadline.aborted ? "Hosted turn observation timed out." : error instanceof RunError ? error.message : "Grok observer failed.";
        hooks.onStatus({ status: "failed", lastEvent: "grok_failed", error: submitting ? `${reason} ${remoteWarning}` : reason });
      }
    });
    const stop = () => stopController.abort();
    return { stop, settled, stopAndWait: async () => { stop(); await settled; } };
  },
};

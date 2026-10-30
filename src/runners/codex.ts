import type { Runner } from "./types.js";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { isCodexSandboxEnabled } from "../codexSandbox.js";

/**
 * OpenAI Codex CLI (`codex` on PATH).
 * Non-interactive board: `codex exec --json` (JSONL thread events).
 * Sandbox (meta.codex_sandbox, default ON):
 *   ON  → `--approve-for-me` (workspace-write; blocks LAN like 192.168.x)
 *   OFF → `-s danger-full-access` (allows company GitLab; safer than
 *         `--dangerously-bypass-approvals-and-sandbox` which drops all sandboxing)
 * Always pass `--dangerously-bypass-hook-trust` so PreToolUse delete-guards run headlessly.
 * Resume: sandbox flags are exec-level options, so place them BEFORE `resume`:
 *   `codex exec [-s danger-full-access|--approve-for-me] resume <thread_id> --json …`
 *   (`codex exec resume` itself does not accept -s/--approve-for-me.)
 * Continue without sessionId: fresh `codex exec` with the original task.prompt (never `--last`).
 */
export function approvalFlags(sandboxEnabled = isCodexSandboxEnabled()): string[] {
  if (sandboxEnabled) {
    return ["--approve-for-me"];
  }
  // Safer of the two “no workspace-write” options that can reach 192.168.3.11.
  return ["-s", "danger-full-access"];
}

export function baseExecFlags(
  taskModel?: string,
  sandboxEnabled = isCodexSandboxEnabled(),
): string[] {
  const flags = [
    "--json",
    "--color",
    "never",
    ...approvalFlags(sandboxEnabled),
    // Board-managed machine: run ~/.codex hooks (e.g. block-dangerous-deletes)
    // without requiring an interactive /hooks trust prompt.
    "--dangerously-bypass-hook-trust",
    "--skip-git-repo-check",
  ];
  if (taskModel) flags.push("-m", taskModel);
  return flags;
}

/**
 * Flags after `resume <id>`: resume does not accept -s/--approve-for-me.
 * Sandbox/approval flags must be passed as exec-level options before `resume`.
 */
export function resumeFlags(taskModel?: string): string[] {
  const flags = [
    "--json",
    "--dangerously-bypass-hook-trust",
    "--skip-git-repo-check",
  ];
  if (taskModel) flags.push("-m", taskModel);
  return flags;
}

export type CodexArgInput = {
  prompt: string;
  sessionId?: string;
  model?: string;
};

export type CodexBuildResult = {
  args: string[];
  prompt: string;
  continueNewSession: boolean;
  sandbox: boolean;
};

/** Pure CLI argv for Codex (no spawn). */
export function buildCodexArgs(
  task: CodexArgInput,
  opts?: { continuePrompt?: string },
  sandboxEnabled = isCodexSandboxEnabled(),
): CodexBuildResult {
  const isContinue = Boolean(opts?.continuePrompt);
  let args: string[];
  let prompt: string;
  let continueNewSession = false;

  if (isContinue && task.sessionId) {
    prompt = opts?.continuePrompt?.trim() || task.prompt;
    // -s / --approve-for-me are options of `codex exec`, not of `resume`.
    args = [
      "exec",
      ...approvalFlags(sandboxEnabled),
      "resume",
      task.sessionId,
      ...resumeFlags(task.model),
      prompt,
    ];
  } else if (isContinue && !task.sessionId) {
    // First round failed before thread.started — do NOT resume --last (wrong session).
    prompt = task.prompt;
    args = ["exec", ...baseExecFlags(task.model, sandboxEnabled), prompt];
    continueNewSession = true;
  } else {
    prompt = opts?.continuePrompt?.trim() || task.prompt;
    args = ["exec", ...baseExecFlags(task.model, sandboxEnabled), prompt];
  }

  return { args, prompt, continueNewSession, sandbox: sandboxEnabled };
}

export const codexRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildCodexArgs(task, opts);
    if (built.continueNewSession) {
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "codex",
          note: "no sessionId; starting fresh exec with task.prompt (not resume --last)",
          sandbox: built.sandbox,
        }),
      );
    }

    let status = task.status;
    return spawnLogged(resolveCliCommand("codex"), built.args, task.cwd, hooks, {
      cliKind: "codex",
      getStatus: () => status,
      classifyLine: (line, h) => {
        const detected = modelFromJsonLine(line);
        if (detected && !task.model) {
          task.model = detected;
          h.onStatus({ model: detected });
        }
        const sid = sessionFromJsonLine(line);
        if (sid && sid !== task.sessionId) {
          task.sessionId = sid;
          h.onStatus({ sessionId: sid });
        }
        try {
          const ev = JSON.parse(line) as {
            type?: string;
            item?: { type?: string; item_type?: string };
            error?: { message?: string } | string;
            message?: string;
          };
          if (!ev.type) return;
          const itemType = ev.item?.type || ev.item?.item_type;
          const label = itemType ? `${ev.type}:${itemType}` : ev.type;
          status = "running";
          h.onStatus({ status: "running", lastEvent: label });

          if (ev.type === "turn.failed" || ev.type === "error") {
            const errMsg =
              (typeof ev.error === "string" && ev.error) ||
              (ev.error && typeof ev.error === "object" && ev.error.message) ||
              (typeof ev.message === "string" && ev.message) ||
              label;
            h.onStatus({ lastEvent: label, error: String(errMsg).slice(0, 300) });
          }
        } catch {
          /* plain text */
        }
      },
    });
  },
};

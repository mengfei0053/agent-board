import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { mergeContinueWithoutSession } from "./promptForRun.js";

export type DevinArgInput = {
  prompt: string;
  sessionId?: string;
  model?: string;
};

export type DevinBuildResult = {
  args: string[];
  prompt: string;
  continueNewSession: boolean;
};

/** Pure CLI argv for Devin (no spawn / session lookup). */
export function buildDevinArgs(
  task: DevinArgInput,
  opts?: { continuePrompt?: string },
): DevinBuildResult {
  const prompt = opts?.continuePrompt?.trim() || task.prompt;
  const isContinue = Boolean(opts?.continuePrompt);
  // Non-interactive board: auto-approve workspace edits; skip trust prompt.
  const args = [
    "-p",
    "--permission-mode",
    "accept-edits",
    "--respect-workspace-trust",
    "false",
  ];

  let promptForRun = prompt;
  let continueNewSession = false;
  if (isContinue) {
    if (task.sessionId) {
      args.push("-r", task.sessionId);
    } else {
      // First round failed before session — do NOT -c (wrong cwd session).
      promptForRun = mergeContinueWithoutSession(task.prompt, opts?.continuePrompt || "");
      continueNewSession = true;
    }
  }

  if (task.model) args.push("--model", task.model);
  args.push("--", promptForRun);

  return { args, prompt: promptForRun, continueNewSession };
}

export const devinRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildDevinArgs(task, opts);
    if (built.continueNewSession) {
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "devin",
          note: "no sessionId; fresh run with original prompt plus continue instruction (not -c)",
        }),
      );
    }

    let status = task.status;
    let sawAgentError = false;

    return spawnLogged(
      resolveCliCommand("devin"),
      built.args,
      task.cwd,
      {
        onStatus: (p) => {
          if (
            p.status === "succeeded" ||
            p.status === "failed" ||
            p.status === "stopped"
          ) {
            // Do not bind "the newest session in cwd" — that crosses tasks.
            if (!task.sessionId) {
              hooks.onLog(
                JSON.stringify({
                  type: "devin_session_unbound",
                  note: "this run has no session id; continue will not attach to another task's latest session",
                }),
              );
            }
            if (sawAgentError && p.status === "succeeded") {
              status = "failed";
              hooks.onStatus({
                ...p,
                status: "failed",
                error: p.error || "Devin agent error (see logs)",
              });
              return;
            }
          }
          if (p.status) status = p.status;
          hooks.onStatus(p);
        },
        onLog: hooks.onLog,
      },
      {
        cliKind: "devin",
        getStatus: () => status,
        classifyLine: (line, h) => {
          const trimmed = line.trim();
          // Devin sometimes prints Agent error then still exits; mark flag only —
          // wait for process close so full stdout is logged before terminal status.
          if (/^Error:\s*Agent error/i.test(trimmed)) {
            sawAgentError = true;
            h.onStatus({
              lastEvent: "agent_error",
              error: trimmed.slice(0, 300),
            });
            if (status !== "running" && status !== "stopped") {
              status = "running";
              h.onStatus({ status: "running", lastEvent: "agent_error" });
            }
            return;
          }
          if (trimmed && !trimmed.startsWith("{")) {
            if (status !== "running" && status !== "failed" && status !== "stopped") {
              status = "running";
              h.onStatus({ status: "running", lastEvent: "stdout" });
            }
          }
        },
      },
    );
  },
};

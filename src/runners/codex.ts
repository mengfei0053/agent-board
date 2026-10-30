import type { Runner } from "./types.js";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import { spawnLogged } from "./common.js";

/**
 * OpenAI Codex CLI (`codex` on PATH).
 * Non-interactive board: `codex exec --json` (JSONL thread events).
 * Approvals: `--approve-for-me` alone (implies workspace-write; mutually exclusive with `-s`).
 * Resume: `codex exec resume <thread_id> --json …`
 * Continue without sessionId: fresh `codex exec` with the original task.prompt (never `--last`).
 */
function baseExecFlags(taskModel?: string): string[] {
  const flags = [
    "--json",
    "--color",
    "never",
    "--approve-for-me",
    "--skip-git-repo-check",
  ];
  if (taskModel) flags.push("-m", taskModel);
  return flags;
}

/** resume subcommand does not take -s/--approve-for-me; keep --json + optional model. */
function resumeFlags(taskModel?: string): string[] {
  const flags = ["--json", "--skip-git-repo-check"];
  if (taskModel) flags.push("-m", taskModel);
  return flags;
}

export const codexRunner: Runner = {
  start(task, hooks, opts) {
    const isContinue = Boolean(opts?.continuePrompt);
    let args: string[];
    let prompt: string;

    if (isContinue && task.sessionId) {
      prompt = opts?.continuePrompt?.trim() || task.prompt;
      args = ["exec", "resume", task.sessionId, ...resumeFlags(task.model), prompt];
    } else if (isContinue && !task.sessionId) {
      // First round failed before thread.started — do NOT resume --last (wrong session).
      prompt = task.prompt;
      args = ["exec", ...baseExecFlags(task.model), prompt];
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "codex",
          note: "no sessionId; starting fresh exec with task.prompt (not resume --last)",
        }),
      );
    } else {
      prompt = opts?.continuePrompt?.trim() || task.prompt;
      args = ["exec", ...baseExecFlags(task.model), prompt];
    }

    let status = task.status;
    return spawnLogged("codex", args, task.cwd, hooks, {
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

import type { Runner } from "./types.js";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import { spawnLogged } from "./common.js";

/**
 * OpenAI Codex CLI (`codex` on PATH).
 * Non-interactive board: `codex exec --json` (JSONL thread events).
 * Approvals: `--approve-for-me` alone (implies workspace-write; mutually exclusive with `-s`).
 * Resume: `codex exec resume <thread_id| --last> --json …`
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
    const prompt = opts?.continuePrompt?.trim() || task.prompt;
    const isContinue = Boolean(opts?.continuePrompt);
    let args: string[];

    if (isContinue) {
      args = ["exec", "resume"];
      if (task.sessionId) {
        args.push(task.sessionId);
      } else {
        args.push("--last");
        hooks.onLog(
          JSON.stringify({
            type: "continue_fallback",
            kind: "codex",
            note: "no sessionId; using exec resume --last",
          }),
        );
      }
      args.push(...resumeFlags(task.model), prompt);
    } else {
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

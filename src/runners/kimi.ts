import { resolveCliCommand } from "../cliPaths.js";
import { spawnLogged } from "./common.js";
import { mergeContinueWithoutSession } from "./promptForRun.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";

export type KimiArgInput = {
  prompt: string;
  sessionId?: string;
  model?: string;
};

export type KimiBuildResult = {
  args: string[];
  prompt: string;
  continueNewSession: boolean;
};

/** Pure CLI argv for Kimi Code (no spawn / session lookup). */
export function buildKimiArgs(
  task: KimiArgInput,
  opts?: { continuePrompt?: string },
): KimiBuildResult {
  const isContinue = Boolean(opts?.continuePrompt);
  const args = ["--output-format", "stream-json"];
  let prompt = opts?.continuePrompt?.trim() || task.prompt;
  let continueNewSession = false;

  if (isContinue && task.sessionId) {
    args.push("--session", task.sessionId);
  } else if (isContinue) {
    // Do not attach to the newest session in cwd, which may belong to another task.
    prompt = mergeContinueWithoutSession(task.prompt, opts?.continuePrompt || "");
    continueNewSession = true;
  }

  if (task.model) args.push("--model", task.model);
  args.push("--prompt", prompt);
  return { args, prompt, continueNewSession };
}

export const kimiRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildKimiArgs(task, opts);
    if (built.continueNewSession) {
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "kimi",
          note: "no sessionId; fresh run with original prompt plus continue instruction (not --continue)",
        }),
      );
    }

    let status = task.status;
    return spawnLogged(resolveCliCommand("kimi"), built.args, task.cwd, hooks, {
      cliKind: "kimi",
      workspaceMcp: opts?.workspaceMcp,
      getStatus: () => status,
      classifyLine: (line, h) => {
        const sessionId = sessionFromJsonLine(line);
        if (sessionId && sessionId !== task.sessionId) {
          task.sessionId = sessionId;
          h.onStatus({ sessionId });
        }
        try {
          const ev = JSON.parse(line) as { role?: string; type?: string };
          const label = [ev.role, ev.type].filter(Boolean).join(":");
          if (label) {
            status = "running";
            h.onStatus({ status: "running", lastEvent: label });
          }
        } catch {
          /* plain text */
        }
      },
    });
  },
};

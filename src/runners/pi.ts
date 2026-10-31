import { nanoid } from "nanoid";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";
import { mergeContinueWithoutSession } from "./promptForRun.js";

export type PiArgInput = {
  id: string;
  prompt: string;
  sessionId?: string;
  model?: string;
};

/** Pure CLI argv for pi (no spawn). */
export function buildPiArgs(
  task: PiArgInput,
  opts?: { continuePrompt?: string; freshSessionId?: string },
): { args: string[]; prompt: string; sessionId: string; assignSession: boolean } {
  const isContinue = Boolean(opts?.continuePrompt?.trim());
  const prompt =
    isContinue && !task.sessionId
      ? mergeContinueWithoutSession(task.prompt, opts?.continuePrompt || "")
      : opts?.continuePrompt?.trim() || task.prompt;
  // A fresh run must not reuse task.id — that session file would keep the previous chat.
  const sessionId = task.sessionId || opts?.freshSessionId || `${task.id}-${nanoid(8)}`;
  const args = ["-p", "--mode", "json", "--session-id", sessionId];
  if (task.model) args.push("--model", task.model);
  args.push(prompt);
  return {
    args,
    prompt,
    sessionId,
    assignSession: !task.sessionId,
  };
}

export const piRunner: Runner = {
  start(task, hooks, opts) {
    const built = buildPiArgs(task, opts);
    if (built.assignSession) hooks.onStatus({ sessionId: built.sessionId });

    let status = task.status;
    return spawnLogged(resolveCliCommand("pi"), built.args, task.cwd, hooks, {
      cliKind: "pi",
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
          const ev = JSON.parse(line) as { type?: string; toolName?: string };
          if (!ev.type) return;
          h.onStatus({ lastEvent: ev.type });
          if (ev.type === "agent_start" || ev.type === "tool_execution_start") {
            if (ev.toolName === "ask_user_question") {
              status = "blocked";
              h.onStatus({ status: "blocked", lastEvent: ev.type });
            } else {
              status = "running";
              h.onStatus({ status: "running", lastEvent: ev.type });
            }
          } else if (ev.type === "agent_settled") {
            h.onStatus({ lastEvent: ev.type, summary: "agent settled" });
          }
        } catch {
          /* non-json line */
        }
      },
    });
  },
};

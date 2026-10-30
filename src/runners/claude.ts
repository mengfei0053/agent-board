import { randomUUID } from "node:crypto";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";

export const claudeRunner: Runner = {
  start(task, hooks, opts) {
    const isContinue = Boolean(opts?.continuePrompt);
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    let prompt: string;

    if (isContinue && task.sessionId) {
      prompt = opts?.continuePrompt?.trim() || task.prompt;
      args.push("--resume", task.sessionId);
    } else if (isContinue && !task.sessionId) {
      // First round failed before session — do NOT --continue (wrong cwd session).
      prompt = task.prompt;
      const sid = randomUUID();
      task.sessionId = sid;
      hooks.onStatus({ sessionId: sid });
      args.push("--session-id", sid);
      hooks.onLog(
        JSON.stringify({
          type: "continue_new_session",
          kind: "claude",
          note: "no sessionId; starting fresh session with task.prompt (not --continue)",
          sessionId: sid,
        }),
      );
    } else {
      prompt = opts?.continuePrompt?.trim() || task.prompt;
      const sid = task.sessionId || randomUUID();
      if (!task.sessionId) hooks.onStatus({ sessionId: sid });
      task.sessionId = sid;
      args.push("--session-id", sid);
    }

    if (task.model) args.push("--model", task.model);
    args.push(prompt);

    let status = task.status;
    return spawnLogged(resolveCliCommand("claude"), args, task.cwd, hooks, {
      cliKind: "claude",
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
          const ev = JSON.parse(line) as { type?: string; subtype?: string };
          const label = [ev.type, ev.subtype].filter(Boolean).join(":");
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

import { randomUUID } from "node:crypto";
import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";

export const claudeRunner: Runner = {
  start(task, hooks, opts) {
    const prompt = opts?.continuePrompt?.trim() || task.prompt;
    const isContinue = Boolean(opts?.continuePrompt);
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (isContinue) {
      if (task.sessionId) {
        args.push("--resume", task.sessionId);
      } else {
        // Fallback: most recent conversation in cwd (fragile if multiple tasks share cwd)
        args.push("--continue");
        hooks.onLog(
          JSON.stringify({
            type: "continue_fallback",
            kind: "claude",
            note: "no sessionId; using --continue (cwd most-recent)",
          }),
        );
      }
    } else {
      const sid = task.sessionId || randomUUID();
      if (!task.sessionId) hooks.onStatus({ sessionId: sid });
      task.sessionId = sid;
      args.push("--session-id", sid);
    }

    if (task.model) args.push("--model", task.model);
    args.push(prompt);

    let status = task.status;
    return spawnLogged("claude", args, task.cwd, hooks, {
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

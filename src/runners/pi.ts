import { modelFromJsonLine } from "./modelFromEvent.js";
import { sessionFromJsonLine } from "./sessionFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";
import { resolveCliCommand } from "../cliPaths.js";

export const piRunner: Runner = {
  start(task, hooks, opts) {
    const prompt = opts?.continuePrompt?.trim() || task.prompt;
    const sessionId = task.sessionId || task.id;
    // Persist session so later "继续任务" can resume the same context.
    const args = ["-p", "--mode", "json", "--session-id", sessionId];
    if (task.model) args.push("--model", task.model);
    args.push(prompt);

    if (!task.sessionId) hooks.onStatus({ sessionId });

    let status = task.status;
    return spawnLogged(resolveCliCommand("pi"), args, task.cwd, hooks, {
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

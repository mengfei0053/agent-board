import { modelFromJsonLine } from "./modelFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";

export const piRunner: Runner = {
  start(task, hooks) {
    const args = ["-p", "--mode", "json", "--no-session"];
    if (task.model) {
      // allow "wb/cn:glm-5.3" or "provider/model" forms pi understands via --model
      args.push("--model", task.model);
    }
    args.push(task.prompt);

    let status = task.status;
    return spawnLogged("pi", args, task.cwd, hooks, {
      getStatus: () => status,
      classifyLine: (line, h) => {
        const detected = modelFromJsonLine(line);
        if (detected && !task.model) {
          task.model = detected;
          h.onStatus({ model: detected });
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
            // exit handler will set succeeded; keep running until process exits
            h.onStatus({ lastEvent: ev.type, summary: "agent settled" });
          }
        } catch {
          /* non-json line */
        }
      },
    });
  },
};

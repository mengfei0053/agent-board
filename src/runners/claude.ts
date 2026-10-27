import { modelFromJsonLine } from "./modelFromEvent.js";
import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";

export const claudeRunner: Runner = {
  start(task, hooks) {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (task.model) args.push("--model", task.model);
    args.push(task.prompt);

    let status = task.status;
    return spawnLogged("claude", args, task.cwd, hooks, {
      getStatus: () => status,
      classifyLine: (line, h) => {
        const detected = modelFromJsonLine(line);
        if (detected && !task.model) {
          task.model = detected;
          h.onStatus({ model: detected });
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

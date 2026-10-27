import type { Runner } from "./types.js";
import { spawnLogged } from "./common.js";

export const cursorRunner: Runner = {
  start(task, hooks) {
    // Cursor Agent CLI: non-interactive print + stream-json
    const args = ["-p", "--output-format", "stream-json"];
    if (task.model) args.push("--model", task.model);
    args.push(task.prompt);

    let status = task.status;
    return spawnLogged("agent", args, task.cwd, hooks, {
      getStatus: () => status,
      classifyLine: (line, h) => {
        try {
          const ev = JSON.parse(line) as { type?: string };
          if (ev.type) {
            status = "running";
            h.onStatus({ status: "running", lastEvent: ev.type });
          }
        } catch {
          /* plain */
        }
      },
    });
  },
};

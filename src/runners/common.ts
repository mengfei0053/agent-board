import { spawn } from "node:child_process";
import type { RunnerHandle, RunnerHooks } from "./types.js";
import type { TaskStatus } from "../types.js";

export function spawnLogged(
  cmd: string,
  args: string[],
  cwd: string,
  hooks: RunnerHooks,
  opts: {
    classifyLine?: (line: string, hooks: RunnerHooks) => void;
    getStatus: () => TaskStatus;
  },
): RunnerHandle {
  let stoppedByUser = false;
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  hooks.onStatus({ status: "running", pid: child.pid, startedAt: new Date().toISOString() });
  hooks.onLog(JSON.stringify({ type: "spawn", cmd, args, cwd, pid: child.pid }));

  let buf = "";
  const feed = (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      hooks.onLog(line);
      opts.classifyLine?.(line, hooks);
    }
  };

  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);

  child.on("error", (err) => {
    if (stoppedByUser) return;
    hooks.onStatus({
      status: "failed",
      error: String(err),
      endedAt: new Date().toISOString(),
    });
  });

  child.on("close", (code) => {
    if (buf.trim()) {
      hooks.onLog(buf);
      opts.classifyLine?.(buf, hooks);
      buf = "";
    }
    hooks.onLog(JSON.stringify({ type: "exit", code }));
    if (stoppedByUser) return;
    const cur = opts.getStatus();
    if (cur === "stopped" || cur === "failed") return;
    if (code === 0) {
      hooks.onStatus({ status: "succeeded", exitCode: code, endedAt: new Date().toISOString() });
    } else {
      hooks.onStatus({
        status: "failed",
        exitCode: code,
        error: `exit ${code}`,
        endedAt: new Date().toISOString(),
      });
    }
  });

  return {
    pid: child.pid,
    stop: () => {
      stoppedByUser = true;
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    },
  };
}

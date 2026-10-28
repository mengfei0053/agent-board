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
    if (stoppedByUser) return;
    buf += chunk.toString("utf8");
    // Cap per-chunk processing so a huge dump cannot block the event loop.
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
    if (stoppedByUser) {
      hooks.onLog(JSON.stringify({ type: "exit", code, stopped: true }));
      return;
    }
    if (buf.trim()) {
      hooks.onLog(buf);
      opts.classifyLine?.(buf, hooks);
      buf = "";
    }
    hooks.onLog(JSON.stringify({ type: "exit", code }));
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

  const signalGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* ignore */
      }
    }
  };

  return {
    pid: child.pid,
    stop: () => {
      if (stoppedByUser) return;
      stoppedByUser = true;
      // Cut pipes first so exit dumps cannot flood writeLog/SSE on this tick.
      try {
        child.stdout?.removeAllListeners("data");
        child.stderr?.removeAllListeners("data");
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
      buf = "";
      signalGroup("SIGTERM");
      const pid = child.pid;
      if (pid) {
        setTimeout(() => {
          try {
            // Throws if process is gone
            process.kill(-pid, 0);
            signalGroup("SIGKILL");
          } catch {
            try {
              process.kill(pid, 0);
              try {
                child.kill("SIGKILL");
              } catch {
                /* ignore */
              }
            } catch {
              /* already dead */
            }
          }
        }, 1200).unref?.();
      }
      try {
        child.unref();
      } catch {
        /* ignore */
      }
    },
  };
}

import { spawn } from "node:child_process";
import { childProcessEnv, lastInjectedProxyKeys } from "../proxyEnv.js";
import type { RunnerHandle, RunnerHooks } from "./types.js";
import type { TaskStatus } from "../types.js";

/** Consecutive 429 strikes before board kills the runner. */
export const RATE_LIMIT_STRIKE_LIMIT = 5;

const PROGRESS_TYPES = new Set([
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "agent_message",
  "agent.message",
  "message",
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "response.created",
  "response.completed",
  "assistant",
  "tool_call",
  "tool_result",
  "result",
]);

const ERROR_TYPES = new Set(["error", "turn.failed", "rate_limit", "exception"]);

export function lineLooksLike429(line: string): boolean {
  if (/\b429\b/.test(line)) return true;
  if (/too\s+many\s+requests/i.test(line)) return true;
  return false;
}

/** Codex (and similar) already exhausted their own reconnect budget for 429. */
export function isExceededRetryLimit429(line: string): boolean {
  return /exceeded\s+retry\s+limit/i.test(line) && lineLooksLike429(line);
}

export function is429StrikeLine(line: string): boolean {
  if (!lineLooksLike429(line)) return false;
  const trimmed = line.trim();
  try {
    const ev = JSON.parse(trimmed) as {
      type?: string;
      message?: string;
      error?: { message?: string } | string;
      status?: number | string;
    };
    const t = String(ev.type || "").toLowerCase();
    if (ERROR_TYPES.has(t) || t.includes("error") || t.includes("rate")) return true;
    const msg =
      (typeof ev.message === "string" && ev.message) ||
      (typeof ev.error === "string" && ev.error) ||
      (ev.error && typeof ev.error === "object" && ev.error.message) ||
      "";
    if (lineLooksLike429(String(msg))) return true;
    if (String(ev.status) === "429") return true;
  } catch {
    /* plain text */
  }
  // stderr / reconnect banners
  if (/reconnecting/i.test(line)) return true;
  if (/status[:\s]+429|HTTP\/?\S*\s*429|error[^\\n]{0,40}429/i.test(line)) return true;
  return false;
}

export function isProgressLine(line: string): boolean {
  if (is429StrikeLine(line)) return false;
  const trimmed = line.trim();
  try {
    const ev = JSON.parse(trimmed) as {
      type?: string;
      item?: { type?: string; item_type?: string };
    };
    const t = String(ev.type || "");
    if (!t) return false;
    const lower = t.toLowerCase();
    if (ERROR_TYPES.has(lower) || lower.includes("error")) return false;
    if (PROGRESS_TYPES.has(lower) || PROGRESS_TYPES.has(t)) return true;
    const itemType = ev.item?.type || ev.item?.item_type;
    if (itemType && /agent_message|message|command_execution|tool/i.test(itemType)) {
      return !/error|fail/i.test(itemType);
    }
    // Any non-error typed JSONL event counts as progress (resets consecutive 429s).
    return true;
  } catch {
    return false;
  }
}

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
  let endedByWatchdog = false;
  let consecutive429 = 0;
  const env = childProcessEnv({ NO_COLOR: "1", FORCE_COLOR: "0" });
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  hooks.onStatus({ status: "running", pid: child.pid, startedAt: new Date().toISOString() });
  hooks.onLog(
    JSON.stringify({
      type: "spawn",
      cmd,
      args,
      cwd,
      pid: child.pid,
      ...(lastInjectedProxyKeys.length
        ? { proxyEnvKeys: [...lastInjectedProxyKeys] }
        : {}),
    }),
  );

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

  const cutPipesAndKill = () => {
    try {
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      child.stdout?.destroy();
      child.stderr?.destroy();
    } catch {
      /* ignore */
    }
    signalGroup("SIGTERM");
    const pid = child.pid;
    if (pid) {
      setTimeout(() => {
        try {
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
  };

  const failForRateLimit = (reason: string, strike: number, sample: string) => {
    if (stoppedByUser || endedByWatchdog) return;
    endedByWatchdog = true;
    const error = "连续 429 次数过多，已自动结束";
    hooks.onLog(
      JSON.stringify({
        type: "rate_limit_kill",
        reason,
        consecutive429: strike,
        limit: RATE_LIMIT_STRIKE_LIMIT,
        sample: sample.slice(0, 400),
        error,
      }),
    );
    hooks.onStatus({
      status: "failed",
      error,
      lastEvent: "rate_limit_kill",
      endedAt: new Date().toISOString(),
      pid: undefined,
    });
    cutPipesAndKill();
  };

  const noteLineForRateLimit = (line: string) => {
    if (stoppedByUser || endedByWatchdog) return;
    if (isExceededRetryLimit429(line)) {
      // Codex already burned its reconnect budget (e.g. 1/5 exceeded … 429) — kill now.
      failForRateLimit("exceeded_retry_limit_429", Math.max(consecutive429, 1), line);
      return;
    }
    if (is429StrikeLine(line)) {
      consecutive429 += 1;
      hooks.onLog(
        JSON.stringify({
          type: "rate_limit_strike",
          consecutive429,
          limit: RATE_LIMIT_STRIKE_LIMIT,
        }),
      );
      if (consecutive429 >= RATE_LIMIT_STRIKE_LIMIT) {
        failForRateLimit("consecutive_429", consecutive429, line);
      }
      return;
    }
    if (isProgressLine(line)) {
      if (consecutive429 > 0) {
        hooks.onLog(
          JSON.stringify({
            type: "rate_limit_strike_reset",
            previous: consecutive429,
          }),
        );
      }
      consecutive429 = 0;
    }
  };

  let buf = "";
  const feed = (chunk: Buffer) => {
    if (stoppedByUser || endedByWatchdog) return;
    buf += chunk.toString("utf8");
    // Cap per-chunk processing so a huge dump cannot block the event loop.
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.trim()) continue;
      hooks.onLog(line);
      opts.classifyLine?.(line, hooks);
      noteLineForRateLimit(line);
      if (endedByWatchdog) return;
    }
  };

  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);

  child.on("error", (err) => {
    if (stoppedByUser || endedByWatchdog) return;
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
    if (endedByWatchdog) {
      hooks.onLog(JSON.stringify({ type: "exit", code, rateLimited: true }));
      return;
    }
    if (buf.trim()) {
      hooks.onLog(buf);
      opts.classifyLine?.(buf, hooks);
      noteLineForRateLimit(buf);
      buf = "";
      if (endedByWatchdog) {
        hooks.onLog(JSON.stringify({ type: "exit", code, rateLimited: true }));
        return;
      }
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

  return {
    pid: child.pid,
    stop: () => {
      if (stoppedByUser || endedByWatchdog) return;
      stoppedByUser = true;
      // Cut pipes first so exit dumps cannot flood writeLog/SSE on this tick.
      cutPipesAndKill();
    },
  };
}

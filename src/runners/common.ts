import { spawn } from "node:child_process";
import { isBoardMetaLine } from "../extractOutput.js";
import { childProcessEnv, lastInjectedProxyKeys } from "../proxyEnv.js";
import type { CliCommandKey } from "../cliPaths.js";
import type { RunnerHandle, RunnerHooks } from "./types.js";
import type { TaskStatus } from "../types.js";
import {
  createStreamLineState,
  endStream,
  pushStreamBytes,
  type StreamLineState,
} from "../streamLines.js";

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
    /** Agent kind — selects per-kind proxy overrides. */
    cliKind: CliCommandKey;
    classifyLine?: (line: string, hooks: RunnerHooks) => void;
    getStatus: () => TaskStatus;
  },
): RunnerHandle {
  let stoppedByUser = false;
  let endedByWatchdog = false;
  let consecutive429 = 0;
  const env = childProcessEnv(opts.cliKind, { NO_COLOR: "1", FORCE_COLOR: "0" });
  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  hooks.onStatus({ status: "running", pid: child.pid, startedAt: new Date().toISOString() });
  const previewArg = (arg: string) => {
    if (arg.includes("\n") || arg.length > 80) return `[${arg.length} chars]`;
    return arg.replace(/\/\/([^/\s:@]+):([^/\s@]+)@/g, "//$1:***@");
  };
  hooks.onLog(
    JSON.stringify({
      type: "spawn",
      cmd,
      args: args.map(previewArg),
      cwd,
      pid: child.pid,
      ...(lastInjectedProxyKeys.length
        ? { proxyEnvKeys: [...lastInjectedProxyKeys] }
        : {}),
    }),
  );

  let closed = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const markClosed = () => {
    if (closed) return;
    closed = true;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  };

  const signalGroup = (sig: NodeJS.Signals) => {
    // Once the child has exited, its pid may be reused. Never signal it again.
    if (closed || !child.pid) return;
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
    if (closed) return;
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
      killTimer = setTimeout(() => {
        killTimer = null;
        if (closed) return;
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
      }, 1200);
      killTimer.unref?.();
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

  const stdoutState = createStreamLineState();
  const stderrState = createStreamLineState();

  const emitLine = (line: string, stream: "stdout" | "stderr") => {
    if (!line.trim()) return;
    // Child text must not impersonate board lifecycle events (start/exit/…).
    const stored = isBoardMetaLine(line)
      ? JSON.stringify({
          type: "agent_stream",
          stream,
          note: "reserved board event type from child was not stored raw",
          preview: line.trim().slice(0, 180),
        })
      : line;
    hooks.onLog(stored);
    opts.classifyLine?.(line, hooks);
    noteLineForRateLimit(line);
  };

  const feed = (state: StreamLineState, stream: "stdout" | "stderr", chunk: Buffer) => {
    if (stoppedByUser || endedByWatchdog || closed) return;
    const pushed = pushStreamBytes(state, chunk);
    if (pushed.truncated) {
      hooks.onLog(JSON.stringify({ type: "stream_truncated", stream, reason: "line_too_long" }));
      return;
    }
    if (pushed.droppedLines > 0) {
      hooks.onLog(
        JSON.stringify({
          type: "stream_truncated",
          stream,
          reason: "too_many_lines",
          droppedLines: pushed.droppedLines,
        }),
      );
    }
    for (const line of pushed.lines) {
      emitLine(line, stream);
      if (endedByWatchdog) return;
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => feed(stdoutState, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => feed(stderrState, "stderr", chunk));

  child.on("error", (err) => {
    if (stoppedByUser || endedByWatchdog || closed) return;
    hooks.onStatus({
      status: "failed",
      error: String(err),
      endedAt: new Date().toISOString(),
    });
  });

  const drainTail = (state: StreamLineState, stream: "stdout" | "stderr") => {
    const rest = endStream(state).trim();
    if (!rest) return;
    emitLine(rest, stream);
  };

  child.on("close", (code) => {
    markClosed();
    if (stoppedByUser) {
      hooks.onLog(JSON.stringify({ type: "exit", code, stopped: true }));
      return;
    }
    if (endedByWatchdog) {
      hooks.onLog(JSON.stringify({ type: "exit", code, rateLimited: true }));
      return;
    }
    drainTail(stdoutState, "stdout");
    if (endedByWatchdog) {
      hooks.onLog(JSON.stringify({ type: "exit", code, rateLimited: true }));
      return;
    }
    drainTail(stderrState, "stderr");
    if (endedByWatchdog) {
      hooks.onLog(JSON.stringify({ type: "exit", code, rateLimited: true }));
      return;
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
      if (closed || stoppedByUser || endedByWatchdog) return;
      stoppedByUser = true;
      // Cut pipes first so exit dumps cannot flood writeLog/SSE on this tick.
      cutPipesAndKill();
    },
  };
}

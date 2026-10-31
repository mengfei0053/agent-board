import { spawn } from "node:child_process";

export type SpawnCollectResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Async spawn with a hard timeout. Does not use spawnSync, so the
 * HTTP thread can keep serving stop / SSE while a CLI probe runs.
 */
export function spawnCollect(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBytes?: number;
    signal?: AbortSignal;
  },
): Promise<SpawnCollectResult> {
  const maxBytes = opts.maxBytes ?? 256_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hard) clearTimeout(hard);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    const cut = (child: ReturnType<typeof spawn> | undefined, sig: NodeJS.Signals) => {
      if (!child) return;
      try { child.stdout?.destroy(); } catch { /* ignore */ }
      try { child.stderr?.destroy(); } catch { /* ignore */ }
      try {
        if (child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        try { child.kill(sig); } catch { /* ignore */ }
      }
    };
    let child: ReturnType<typeof spawn> | undefined;
    const onAbort = () => {
      timedOut = true;
      cut(child, "SIGKILL");
      finish(null);
    };
    if (opts.signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "aborted", timedOut: true });
      return;
    }
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolve({
        code: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
      });
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      cut(child, "SIGKILL");
    }, opts.timeoutMs);
    timer.unref?.();
    // Descendants can hold the pipes open after the direct child is killed.
    // Settle anyway so a probe cannot outlive its deadline.
    hard = setTimeout(() => {
      timedOut = true;
      cut(child, "SIGKILL");
      finish(null);
    }, opts.timeoutMs + 500);
    hard.unref?.();
    const take = (into: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (into === "stdout") {
        if (stdout.length < maxBytes) stdout += text.slice(0, maxBytes - stdout.length);
      } else if (stderr.length < maxBytes) {
        stderr += text.slice(0, maxBytes - stderr.length);
      }
    };
    child.stdout?.on("data", (c: Buffer) => take("stdout", c));
    child.stderr?.on("data", (c: Buffer) => take("stderr", c));
    child.on("error", (err) => {
      stderr += err instanceof Error ? err.message : String(err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

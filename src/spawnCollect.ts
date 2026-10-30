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
  },
): Promise<SpawnCollectResult> {
  const maxBytes = opts.maxBytes ?? 256_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
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
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
    timer.unref?.();
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

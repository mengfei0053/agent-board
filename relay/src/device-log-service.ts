import { Worker } from "node:worker_threads";
import type { DeviceLogs, Entry, Query } from "./device-logs.js";

export type LogCommand = { op: "append"; deviceId: string; entries: Entry[] } |
  { op: "list"; query: Query } | { op: "open" | "prune" | "close" };
export type LogReply = { ok: true; value?: unknown } | { ok: false };
export class LogQueueFull extends Error {}

// One serial SQLite connection; bound the backlog even when fsync or a DB lock stalls.
export class DeviceLogService {
  private readonly pending: { resolve(value: unknown): void; reject(error: Error): void }[] = [];
  private stopped = false;

  private constructor(private readonly worker: Worker, private readonly now: () => number) {
    worker.on("message", (reply: LogReply) => {
      const call = this.pending.shift();
      if (reply.ok) call?.resolve(reply.value);
      else call?.reject(new Error("device log database operation failed"));
    });
    const stop = () => {
      this.stopped = true;
      for (const call of this.pending.splice(0)) call.reject(new Error("device log worker stopped"));
    };
    worker.on("error", stop);
    worker.on("exit", stop);
  }

  static async open(filename: string | undefined, now: () => number): Promise<DeviceLogService> {
    const options = { workerData: { filename }, execArgv: [] };
    let worker: Worker;
    // tsx dev/test runs source directly. Production loads only the compiled JS worker.
    if (import.meta.url.endsWith(".ts")) {
      const source = new URL("./device-log-worker.ts", import.meta.url);
      const api = JSON.stringify(import.meta.resolve("tsx/esm/api"));
      const bootstrap = `import(${api}).then(({ tsImport }) => tsImport(${JSON.stringify(source.href)}, ${JSON.stringify(import.meta.url)}))`;
      worker = new Worker(bootstrap, { ...options, eval: true });
    } else {
      worker = new Worker(new URL("./device-log-worker.js", import.meta.url), options);
    }
    const service = new DeviceLogService(worker, now);
    try {
      await service.run({ op: "open" });
      return service;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }

  run(command: Extract<LogCommand, { op: "append" }>): Promise<ReturnType<DeviceLogs["append"]>>;
  run(command: Extract<LogCommand, { op: "list" }>): Promise<ReturnType<DeviceLogs["list"]>>;
  run(command: { op: "open" | "prune" | "close" }): Promise<void>;
  async run(command: LogCommand): Promise<unknown> {
    if (this.stopped) throw new Error("device log worker stopped");
    if (command.op !== "close" && this.pending.length >= 32) throw new LogQueueFull();
    this.worker.postMessage({ command, now: this.now() });
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
}

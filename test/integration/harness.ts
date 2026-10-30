/**
 * Shared setup for API integration tests:
 * - embedded Postgres (isolated, no production DB)
 * - dynamic import of app after DATABASE_URL is set
 * - fake runners (no real CLI spawn)
 */
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import type { Runner, RunnerHooks, RunnerStartOptions } from "../../src/runners/types.js";
import type { Task } from "../../src/types.js";

export type RunnerCall = {
  prompt: string;
  continuePrompt?: string;
  sessionId?: string;
  workspaceId: string;
};

let pg: EmbeddedPostgres | null = null;
let pgDir = "";
let databaseUrl = "";
export const runnerCalls: RunnerCall[] = [];

export function getDatabaseUrl(): string {
  return databaseUrl;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close();
        reject(new Error("no port"));
        return;
      }
      const port = addr.port;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export async function startTestDb(): Promise<string> {
  if (databaseUrl) return databaseUrl;
  const port = await freePort();
  pgDir = mkdtempSync(join(tmpdir(), "agent-board-pg-"));
  pg = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("agent_board_test");
  databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/agent_board_test`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.AGENT_BOARD_WEBHOOK_SECRET = "test-webhook-secret";
  return databaseUrl;
}

export async function stopTestDb(): Promise<void> {
  if (pg) {
    try {
      await pg.stop();
    } catch {
      /* ignore */
    }
    pg = null;
  }
  if (pgDir && existsSync(pgDir)) {
    try {
      rmSync(pgDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  pgDir = "";
  databaseUrl = "";
}

function makeFakeRunner(): Runner {
  return {
    start(task: Task, hooks: RunnerHooks, opts?: RunnerStartOptions) {
      runnerCalls.push({
        prompt: task.prompt,
        continuePrompt: opts?.continuePrompt,
        sessionId: task.sessionId,
        workspaceId: task.workspaceId,
      });
      const sessionId = task.sessionId || `fake-sess-${task.id}`;
      hooks.onStatus({
        status: "running",
        sessionId,
        startedAt: new Date().toISOString(),
        pid: 4242,
      });
      // Settle quickly without real CLI
      queueMicrotask(() => {
        hooks.onLog(JSON.stringify({ type: "agent_end", message: { content: [{ type: "text", text: "fake done" }] } }));
        hooks.onStatus({
          status: "succeeded",
          exitCode: 0,
          endedAt: new Date().toISOString(),
          pid: undefined,
        });
      });
      return {
        pid: 4242,
        stop() {
          hooks.onStatus({
            status: "stopped",
            endedAt: new Date().toISOString(),
            pid: undefined,
          });
        },
      };
    },
  };
}

export function installFakeRunners(runners: Record<string, Runner>): void {
  runnerCalls.length = 0;
  const fake = makeFakeRunner();
  for (const k of Object.keys(runners)) {
    runners[k] = fake;
  }
}

export function freshWorkspacePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-board-ws-"));
  return dir;
}

export async function readSseHello(res: Response): Promise<unknown> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = /event:\s*hello\s*\ndata:\s*(\{[\s\S]*?\})\s*\n/.exec(buf);
      if (m) return JSON.parse(m[1]);
      if (buf.length > 2_000_000) throw new Error("SSE buffer overflow waiting for hello");
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  throw new Error(`hello event not found in: ${buf.slice(0, 500)}`);
}

export async function jsonOf(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON (${res.status}): ${text.slice(0, 300)}`);
  }
}

/** Ensure mkdir exists for static path checks */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

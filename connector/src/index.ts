import { WebSocket } from "ws";
import { createBody, toRelayTask, toThinWorkspace, type BoardTask, type BoardWorkspace } from "./map.js";

type Env = {
  relayWs: string;
  boardToken: string;
  boardId: string;
  boardUrl: string;
  label: string;
};

function readEnv(): Env {
  const relayWs = process.env.RELAY_WS ?? "";
  const boardToken = process.env.BOARD_TOKEN ?? "";
  const boardId = process.env.BOARD_ID ?? "";
  const boardUrl = (process.env.BOARD_URL ?? "http://127.0.0.1:8791").replace(/\/$/, "");
  if (!relayWs || !boardToken || !boardId) {
    console.error("RELAY_WS, BOARD_TOKEN, and BOARD_ID are required");
    process.exit(1);
  }
  return { relayWs, boardToken, boardId, boardUrl, label: process.env.BOARD_LABEL ?? boardId };
}

export async function fetchSnapshot(boardUrl: string, fetcher: typeof fetch = fetch) {
  const [tasksRes, spacesRes] = await Promise.all([
    fetcher(`${boardUrl}/api/tasks`),
    fetcher(`${boardUrl}/api/workspaces`),
  ]);
  if (!tasksRes.ok || !spacesRes.ok) throw new Error("board snapshot failed");
  const tasksJson = await tasksRes.json() as { tasks?: BoardTask[] };
  const spacesJson = await spacesRes.json() as { workspaces?: BoardWorkspace[] };
  const tasks = (tasksJson.tasks ?? []).map(toRelayTask).filter((task) => task != null);
  const workspaces = [];
  for (const workspace of spacesJson.workspaces ?? []) {
    const git = await fetcher(`${boardUrl}/api/workspaces/${encodeURIComponent(workspace.id)}/git-status`);
    const thin = toThinWorkspace(workspace, git.ok);
    if (thin) workspaces.push(thin);
  }
  return { tasks, workspaces };
}

export async function applyCommand(boardUrl: string, type: string, payload: Record<string, unknown>, fetcher: typeof fetch = fetch) {
  if (type === "cmd.create") {
    const res = await fetcher(`${boardUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody(payload)),
    });
    const json = await res.json() as { task?: BoardTask; error?: string };
    if (!res.ok || !json.task) return { stage: "failed" as const, message: json.error ?? "create failed" };
    return { stage: "executed" as const, task: toRelayTask(json.task) };
  }
  const taskId = String(payload.taskId ?? "");
  const path = type === "cmd.stop" ? "stop" : "continue";
  const res = await fetcher(`${boardUrl}/api/tasks/${encodeURIComponent(taskId)}/${path}`, { method: "POST" });
  const json = await res.json() as { task?: BoardTask; error?: string };
  if (!res.ok || !json.task) return { stage: "failed" as const, message: json.error ?? `${path} failed` };
  return { stage: "executed" as const, task: toRelayTask(json.task) };
}

async function main() {
  const env = readEnv();
  const ws = new WebSocket(env.relayWs);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      v: 1,
      id: `c${Date.now()}`,
      type: "board.register",
      ts: Date.now(),
      payload: { token: env.boardToken, boardId: env.boardId, label: env.label },
    }));
  });
  ws.on("message", (data) => {
    void onMessage(env, ws, String(data));
  });
}

async function onMessage(env: Env, ws: WebSocket, raw: string) {
  const message = JSON.parse(raw) as { id: string; type: string; payload?: Record<string, unknown> };
  if (message.type === "cmd.create" || message.type === "cmd.continue" || message.type === "cmd.stop") {
    const payload = message.payload ?? {};
    const result = await applyCommand(env.boardUrl, message.type, payload).catch((err: unknown) => ({
      stage: "failed" as const,
      message: err instanceof Error ? err.message : "board request failed",
    }));
    ws.send(JSON.stringify({
      v: 1,
      id: `r${Date.now()}`,
      type: "cmd.result",
      ts: Date.now(),
      payload: { idempotencyKey: payload.idempotencyKey, boardId: env.boardId, ...result },
    }));
    return;
  }
  if (message.type === "ack") {
    const snap = await fetchSnapshot(env.boardUrl).catch(() => null);
    if (!snap) return;
    ws.send(JSON.stringify({
      v: 1,
      id: `s${Date.now()}`,
      type: "evt.snapshot",
      ts: Date.now(),
      payload: { boardId: env.boardId, generation: 1, seq: Date.now(), ...snap },
    }));
  }
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("index.ts") || entry.endsWith("index.js")) main();

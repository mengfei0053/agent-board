import assert from "node:assert/strict";
import test from "node:test";
import { applyCommand, fetchSnapshot } from "../src/index.js";
import { createBody, mapStatus, toRelayTask, toThinWorkspace } from "../src/map.js";

test("board statuses and worktrees map onto the phone protocol", () => {
  assert.equal(mapStatus("draft"), "queued");
  assert.equal(mapStatus("blocked"), "paused");
  assert.equal(mapStatus("archived"), "stopped");
  assert.equal(mapStatus("nope"), null);
  const task = toRelayTask({
    id: "t1",
    title: "Ship",
    kind: "codex",
    status: "running",
    updatedAt: "2026-10-31T00:00:00.000Z",
  });
  assert.equal(task?.status, "running");
  assert.equal(task?.agent, "codex");
  assert.equal(toThinWorkspace({ id: "w", name: "repo", path: "https://nope" }, true), null);
  assert.equal(toThinWorkspace({ id: "w", name: "repo", path: "/src" }, true)?.isGit, true);
  assert.deepEqual(createBody({
    agent: "pi",
    title: "T",
    prompt: "P",
    cwd: "/src",
    useGitWorktree: true,
  }).useGitWorktree, true);
  assert.equal("useGitWorktree" in createBody({ agent: "pi", title: "T", prompt: "P", cwd: "/src" }), false);
});

test("create forwards useGitWorktree and does not call the relay", async () => {
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/api/tasks") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.useGitWorktree, true);
      assert.equal(body.start, true);
      return json({ task: { id: "t1", title: body.title, kind: body.kind, status: "running", updatedAt: "2026-10-31T00:00:00.000Z" } }, 201);
    }
    if (url.endsWith("/api/tasks")) return json({ tasks: [] });
    if (url.endsWith("/api/workspaces")) return json({ workspaces: [{ id: "w", name: "repo", path: "/src" }] });
    if (url.endsWith("/git-status")) return json({ branch: "main" });
    return json({ error: "missing" }, 404);
  }) as typeof fetch;

  const created = await applyCommand("http://127.0.0.1:8791", "cmd.create", {
    agent: "pi",
    title: "Ship",
    prompt: "prompt",
    cwd: "/src",
    useGitWorktree: true,
  }, fetcher);
  assert.equal(created.stage, "executed");
  assert.equal(created.task?.id, "t1");
  const snap = await fetchSnapshot("http://127.0.0.1:8791", fetcher);
  assert.equal(snap.workspaces[0]?.isGit, true);
  assert.equal(calls.some((call) => call.includes("mengfei.tech") || call.includes("/v1/ws")), false);
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

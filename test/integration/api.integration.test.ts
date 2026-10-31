/**
 * API integration tests (I1–I7 high + I8–I11 medium + I12 low) against embedded Postgres + fake runners.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  startTestDb,
  stopTestDb,
  installFakeRunners,
  runnerCalls,
  runnerProtocol,
  setFakeRunnerHold,
  freshWorkspacePath,
  readSseHello,
  jsonOf,
  ensureDir,
} from "./harness.js";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearGitStatusCacheForTests, gitReadOnlyEnv } from "../../src/gitStatus.js";
import { browseHome } from "../../src/fsbrowse.js";
import { isRepoDataPath, jsonDbPath, logsDir } from "../../src/db.js";

await startTestDb();

const { app } = await import("../../src/server.js");
const {
  initStore,
  resetStoreForTests,
  flushPersist,
  closePool,
  getPool,
  appendLog,
  purgeArchivedTaskLogs,
  pruneTaskLogsForTests,
  logLineCount,
  getTask,
} = await import("../../src/store.js");
const { clearHandlesForTests, setNextTaskIdForTests } = await import("../../src/manager.js");
const { runners } = await import("../../src/runners/index.js");

await initStore();
installFakeRunners(runners as Record<string, (typeof runners)[keyof typeof runners]>);

async function waitSettled(taskId: string, timeoutMs = 3000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await app.request(`/api/tasks/${taskId}`);
    const body = await jsonOf(res);
    const st = body.task?.status;
    if (st && !["queued", "running", "blocked"].includes(st)) {
      return body.task;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${taskId} did not settle`);
}

describe("integration I1–I12", () => {
  beforeEach(async () => {
    clearHandlesForTests();
    installFakeRunners(runners as Record<string, (typeof runners)[keyof typeof runners]>);
    await resetStoreForTests();
  });

  after(async () => {
    clearHandlesForTests();
    await flushPersist();
    await closePool();
    await stopTestDb();
  });

  it("I1 workspace CRUD + settings persist to Postgres", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);

    const create = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "集成空间", path }),
    });
    assert.equal(create.status, 201);
    const { workspace } = await jsonOf(create);
    assert.equal(workspace.name, "集成空间");
    assert.equal(workspace.path, path);

    const patch = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          systemPrompt: "你是空间助手",
          skills: ["skill-a", "skill-b"],
          mcp: '{"mcpServers":{"demo":{}}}',
        },
      }),
    });
    assert.equal(patch.status, 200);
    const patched = await jsonOf(patch);
    assert.equal(patched.workspace.settings.systemPrompt, "你是空间助手");
    assert.deepEqual(patched.workspace.settings.skills, ["skill-a", "skill-b"]);

    await flushPersist();
    const pg = getPool();
    const row = await pg.query(
      `SELECT name, path, settings FROM workspaces WHERE id = $1`,
      [workspace.id],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].name, "集成空间");
    assert.equal(row.rows[0].path, path);
    const settings =
      typeof row.rows[0].settings === "string"
        ? JSON.parse(row.rows[0].settings)
        : row.rows[0].settings;
    assert.equal(settings.systemPrompt, "你是空间助手");
    assert.deepEqual(settings.skills, ["skill-a", "skill-b"]);

    const got = await app.request(`/api/workspaces/${workspace.id}`);
    assert.equal(got.status, 200);
    const listed = await app.request("/api/workspaces");
    const listBody = await jsonOf(listed);
    assert.ok(listBody.workspaces.some((w: any) => w.id === workspace.id));

    // rename
    const rename = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "改名空间" }),
    });
    assert.equal(rename.status, 200);
    assert.equal((await jsonOf(rename)).workspace.name, "改名空间");

    // delete empty workspace
    const del = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "DELETE",
    });
    assert.equal(del.status, 200);
    assert.equal((await app.request(`/api/workspaces/${workspace.id}`)).status, 404);
  });

  it("I2 task lifecycle draft → start → move → batch-delete (fake runner)", async () => {
    const path = freshWorkspacePath();
    const createWs = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "任务空间", path }),
    });
    const { workspace } = await jsonOf(createWs);

    const draftRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "写一个 hello",
        title: "hello 任务",
        start: false,
      }),
    });
    assert.equal(draftRes.status, 201);
    const { task: draft } = await jsonOf(draftRes);
    assert.equal(draft.status, "draft");

    const startRes = await app.request(`/api/tasks/${draft.id}/start`, {
      method: "POST",
    });
    assert.equal(startRes.status, 200);
    assert.ok(runnerCalls.length >= 1);

    const settled = await waitSettled(draft.id);
    assert.equal(settled.status, "succeeded");
    assert.ok(settled.sessionId);

    const moveRes = await app.request(`/api/tasks/${draft.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "archived" }),
    });
    assert.equal(moveRes.status, 200);
    assert.equal((await jsonOf(moveRes)).task.status, "archived");

    const delRes = await app.request("/api/tasks/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [draft.id] }),
    });
    assert.equal(delRes.status, 200);
    const delBody = await jsonOf(delRes);
    assert.ok(delBody.deleted.includes(draft.id));
    assert.equal((await app.request(`/api/tasks/${draft.id}`)).status, 404);
  });

  it("I3 continue: workspace prefix on first start, skipped when session exists", async () => {
    const path = freshWorkspacePath();
    const createWs = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "注入空间", path }),
    });
    const { workspace } = await jsonOf(createWs);
    await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          systemPrompt: "SPACE_PROMPT_MARKER",
          skills: ["inject-skill"],
          mcp: "mcp-config-marker",
        },
      }),
    });

    const draftRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "USER_PROMPT_BODY",
        start: false,
      }),
    });
    const { task } = await jsonOf(draftRes);

    runnerCalls.length = 0;
    await app.request(`/api/tasks/${task.id}/start`, { method: "POST" });
    await waitSettled(task.id);
    assert.ok(runnerCalls.length >= 1);
    assert.match(runnerCalls[0].prompt, /SPACE_PROMPT_MARKER/);
    assert.match(runnerCalls[0].prompt, /inject-skill/);
    assert.match(runnerCalls[0].prompt, /mcp-config-marker/);
    assert.match(runnerCalls[0].prompt, /USER_PROMPT_BODY/);

    const afterStart = await jsonOf(await app.request(`/api/tasks/${task.id}`));
    assert.ok(afterStart.task.sessionId);

    runnerCalls.length = 0;
    const cont = await app.request(`/api/tasks/${task.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "CONTINUE_PROMPT_BODY" }),
    });
    assert.equal(cont.status, 200);
    await waitSettled(task.id);
    assert.ok(runnerCalls.length >= 1);
    // With session: workspace prefix must NOT be re-applied to the runner task prompt
    assert.doesNotMatch(runnerCalls[0].prompt, /SPACE_PROMPT_MARKER/);
    assert.equal(runnerCalls[0].continuePrompt, "CONTINUE_PROMPT_BODY");
  });

  it("I4 webhook auth: disabled / unauthorized / ok", async () => {
    const path = freshWorkspacePath();
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "hook空间", path }),
      }),
    );

    const bad = await app.request("/api/hooks/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wrong",
      },
      body: JSON.stringify({
        prompt: "from hook",
        agent: "pi",
        workspaceId: workspace.id,
      }),
    });
    assert.equal(bad.status, 401);

    const okBearer = await app.request("/api/hooks/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-webhook-secret",
      },
      body: JSON.stringify({
        prompt: "from hook bearer",
        agent: "pi",
        workspaceId: workspace.id,
        start: false,
      }),
    });
    assert.equal(okBearer.status, 201);
    assert.equal((await jsonOf(okBearer)).task.status, "draft");

    const okHeader = await app.request("/webhook/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": "test-webhook-secret",
      },
      body: JSON.stringify({
        prompt: "from hook header",
        kind: "pi",
        workspaceId: workspace.id,
        lane: "draft",
      }),
    });
    assert.equal(okHeader.status, 201);

    const prev = process.env.AGENT_BOARD_WEBHOOK_SECRET;
    delete process.env.AGENT_BOARD_WEBHOOK_SECRET;
    try {
      const disabled = await app.request("/api/hooks/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-webhook-secret",
        },
        body: JSON.stringify({
          prompt: "x",
          agent: "pi",
          workspaceId: workspace.id,
        }),
      });
      assert.equal(disabled.status, 503);
    } finally {
      process.env.AGENT_BOARD_WEBHOOK_SECRET = prev;
    }
  });

  it("I5 PUT /api/settings round-trip", async () => {
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cliPaths: { pi: "/tmp/fake-pi" },
        quickPrompts: [{ label: "总结", content: "一句话总结" }],
        codexSandbox: false,
      }),
    });
    assert.equal(put.status, 200);
    const body = await jsonOf(put);
    assert.equal(body.cliPaths.pi.override, "/tmp/fake-pi");
    assert.equal(body.codexSandbox, false);
    assert.ok(Array.isArray(body.quickPrompts));
    assert.ok(body.quickPrompts.some((q: any) => q.content === "一句话总结"));

    const got = await jsonOf(await app.request("/api/settings"));
    assert.equal(got.cliPaths.pi.override, "/tmp/fake-pi");

    const cleared = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    assert.equal(cleared.status, 200);
    const after = await jsonOf(cleared);
    assert.equal(after.cliPaths.pi.override, "");
  });

  it("I6 uploads HTTP image + attachment + fetch", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
      0x00, 0x05, 0xfe, 0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const fd = new FormData();
    fd.append("file", new File([png], "dot.png", { type: "image/png" }));
    const up = await app.request("/api/uploads", { method: "POST", body: fd });
    assert.equal(up.status, 201);
    const saved = await jsonOf(up);
    assert.ok(saved.name || saved.url);
    const name = saved.name || String(saved.url).split("/").pop();
    const get = await app.request(`/uploads/${name}`);
    assert.equal(get.status, 200);
    assert.match(get.headers.get("content-type") || "", /image\/png/);

    const fd2 = new FormData();
    fd2.append("file", new File([Buffer.from("hello attach")], "note.txt", { type: "text/plain" }));
    const up2 = await app.request("/api/uploads?as=attachment", { method: "POST", body: fd2 });
    assert.equal(up2.status, 201);
    const att = await jsonOf(up2);
    assert.ok(att.name);
    const get2 = await app.request(`/uploads/${att.name}?download=1&filename=note.txt`);
    assert.equal(get2.status, 200);
    assert.match(get2.headers.get("content-disposition") || "", /attachment/);
  });

  it("I7 SSE hello event includes tasks and workspaces", async () => {
    const path = freshWorkspacePath();
    await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "SSE空间", path }),
    });
    const ac = new AbortController();
    const res = await app.request("/api/events", { signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const hello = (await readSseHello(res)) as {
      type: string;
      tasks: unknown[];
      workspaces: { name: string }[];
    };
    ac.abort();
    assert.equal(hello.type, "hello");
    assert.ok(Array.isArray(hello.tasks));
    assert.ok(Array.isArray(hello.workspaces));
    assert.ok(hello.workspaces.some((w) => w.name === "SSE空间"));
  });
  it("I8 JSON → PG migration imports tasks/logs and archives db.json", async () => {
    const migId = "mig_task_json_1";
    const payload = {
      tasks: [
        {
          id: migId,
          title: "migrated",
          kind: "pi",
          cwd: "/tmp/mig",
          prompt: "from-json-db",
          iteration: 1,
          status: "stopped",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
          endedAt: "2026-01-02T00:01:00.000Z",
          summary: "migrated task",
        },
      ],
    };
    assert.equal(isRepoDataPath(logsDir()), false);
    mkdirSync(logsDir(), { recursive: true });
    writeFileSync(jsonDbPath(), JSON.stringify(payload), "utf8");
    writeFileSync(
      join(logsDir(), `${migId}.jsonl`),
      `${JSON.stringify({ type: "start" })}\nmigrated-log-line\n`,
      "utf8",
    );

    clearHandlesForTests();
    installFakeRunners(runners as Record<string, (typeof runners)[keyof typeof runners]>);
    await resetStoreForTests();

    const got = await jsonOf(await app.request(`/api/tasks/${migId}`));
    assert.equal(got.task?.prompt, "from-json-db");
    assert.equal(got.task?.title, "migrated");
    assert.ok(got.logLineCount >= 1);
    const logBody = await jsonOf(await app.request(`/api/tasks/${migId}/log?lines=100`));
    assert.ok(
      (logBody.log || []).some(
        (l: string) => l.includes("migrated-log-line") || l.includes('"start"'),
      ),
    );

    assert.equal(existsSync(jsonDbPath()), false);
    const archived = readdirSync(join(jsonDbPath(), "..")).filter((f) =>
      f.startsWith("db.json.migrated-"),
    );
    assert.ok(archived.length >= 1);
    for (const f of archived) {
      try {
        unlinkSync(join(jsonDbPath(), "..", f));
      } catch {
        /* ignore */
      }
    }
  });

  it("I9 archive purge clears task_logs but keeps task row", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "归档日志空间", path }),
      }),
    );
    const { task } = await jsonOf(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pi",
          workspaceId: workspace.id,
          prompt: "keep-me",
          title: "archive-log",
          start: false,
        }),
      }),
    );
    appendLog(task.id, "line-before-archive-1");
    appendLog(task.id, "line-before-archive-2");
    await flushPersist();
    assert.ok(logLineCount(task.id) >= 2);

    const move = await app.request(`/api/tasks/${task.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "archived" }),
    });
    assert.equal(move.status, 200);
    assert.equal((await jsonOf(move)).task.status, "archived");

    const purged = await purgeArchivedTaskLogs();
    assert.ok(purged.tasks >= 1);
    assert.equal(logLineCount(task.id), 0);

    const still = getTask(task.id);
    assert.ok(still);
    assert.equal(still!.prompt, "keep-me");
    assert.equal(still!.status, "archived");

    const api = await jsonOf(await app.request(`/api/tasks/${task.id}`));
    assert.equal(api.task.prompt, "keep-me");
    assert.equal(api.logLineCount, 0);
  });

  it("I10 browse rejects paths outside home", async () => {
    const bad = await app.request("/api/browse?path=/tmp");
    assert.equal(bad.status, 400);
    const badBody = await jsonOf(bad);
    assert.match(String(badBody.error), /outside home/i);

    const ok = await app.request(`/api/browse?path=${encodeURIComponent(browseHome)}`);
    assert.equal(ok.status, 200);
    const body = await jsonOf(ok);
    assert.equal(body.path, browseHome);
    assert.equal(body.parent, null);
    assert.ok(Array.isArray(body.entries));
  });

  it("I11 fake runner protocol: status/log order, continuePrompt, stop while held", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "协议空间", path }),
      }),
    );

    // happy path protocol
    runnerProtocol.length = 0;
    const { task } = await jsonOf(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pi",
          workspaceId: workspace.id,
          prompt: "proto-run",
          start: true,
        }),
      }),
    );
    const settled = await waitSettled(task.id);
    assert.equal(settled.status, "succeeded");
    const kinds = runnerProtocol.filter((e) => e.taskId === task.id).map((e) => e.kind);
    assert.deepEqual(
      kinds.slice(0, 4),
      ["start", "status", "log", "status"],
    );
    const statuses = runnerProtocol
      .filter((e) => e.taskId === task.id && e.kind === "status")
      .map((e) => (e as { status: string }).status);
    assert.deepEqual(statuses, ["running", "succeeded"]);

    // continuePrompt plumbing
    runnerCalls.length = 0;
    runnerProtocol.length = 0;
    const cont = await app.request(`/api/tasks/${task.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "MORE_PLEASE" }),
    });
    assert.equal(cont.status, 200);
    await waitSettled(task.id);
    assert.equal(runnerCalls[0]?.continuePrompt, "MORE_PLEASE");
    assert.equal(
      runnerProtocol.find((e) => e.kind === "start" && e.taskId === task.id)?.continuePrompt,
      "MORE_PLEASE",
    );

    // stop while held running
    setFakeRunnerHold(true);
    runnerProtocol.length = 0;
    const held = await jsonOf(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pi",
          workspaceId: workspace.id,
          prompt: "hold-me",
          start: true,
        }),
      }),
    );
    // wait until running
    const startWait = Date.now();
    let running = false;
    while (Date.now() - startWait < 2000) {
      const t = (await jsonOf(await app.request(`/api/tasks/${held.task.id}`))).task;
      if (t.status === "running") {
        running = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(running, "expected running while held");
    const stopRes = await app.request(`/api/tasks/${held.task.id}/stop`, { method: "POST" });
    assert.equal(stopRes.status, 200);
    const stopped = await waitSettled(held.task.id);
    assert.equal(stopped.status, "stopped");
    assert.ok(runnerProtocol.some((e) => e.kind === "stop" && e.taskId === held.task.id));
    setFakeRunnerHold(false);
  });

  it("I12 GET /api/health smoke", async () => {
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    const body = await jsonOf(res);
    assert.equal(body.ok, true);
  });

  it("M3 rejects bad task input and oversized bodies", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "校验空间", path }),
      }),
    );

    const strFalse = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "x",
        start: "false",
      }),
    });
    assert.equal(strFalse.status, 400);

    const rel = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "pi", cwd: "relative/path", prompt: "x" }),
    });
    assert.equal(rel.status, 400);

    const fileCwd = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "pi", cwd: "/etc/hosts", prompt: "x" }),
    });
    assert.equal(fileCwd.status, 400);

    const overPrompt = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "p".repeat(100_001),
      }),
    });
    assert.equal(overPrompt.status, 413);

    const huge = await app.request("/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "5000000",
      },
      body: JSON.stringify({ kind: "pi", workspaceId: workspace.id, prompt: "x" }),
    });
    assert.equal(huge.status, 413);
  });

  it("S2 serves html attachments as download, not inline html", async () => {
    const fd = new FormData();
    fd.append(
      "file",
      new File([Buffer.from("<script>alert(1)</script>")], "x.html", { type: "text/html" }),
    );
    const up = await app.request("/api/uploads?as=attachment", { method: "POST", body: fd });
    assert.equal(up.status, 201);
    const saved = await jsonOf(up);
    const get = await app.request(`/uploads/${saved.name}`);
    assert.equal(get.status, 200);
    assert.match(get.headers.get("content-disposition") || "", /attachment/i);
    assert.equal(get.headers.get("x-content-type-options"), "nosniff");
    assert.equal(get.headers.get("content-type"), "application/octet-stream");
  });

  it("M2 create does not report success when persist fails", async () => {
    const { failNextPersistForTests } = await import("../../src/store.js");
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "故障空间", path }),
      }),
    );
    failNextPersistForTests("task");
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "should-not-stick",
        start: false,
      }),
    });
    assert.equal(res.status, 500);
    const listed = await jsonOf(await app.request("/api/tasks"));
    assert.ok(!(listed.tasks || []).some((t: { prompt?: string }) => t.prompt === "should-not-stick"));
    const health = await app.request("/api/health");
    assert.equal(health.status, 503);
    const recover = freshWorkspacePath();
    const again = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "恢复空间", path: recover }),
    });
    assert.equal(again.status, 201);
    const health2 = await app.request("/api/health");
    assert.equal(health2.status, 200);
    await assert.rejects(flushPersist(), /persist failed/);
    const health3 = await app.request("/api/health");
    assert.equal(health3.status, 200);
  });

  it("M1 prune keeps board meta in original order with an exact line budget", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "裁剪空间", path }),
      }),
    );
    const { task } = await jsonOf(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pi",
          workspaceId: workspace.id,
          prompt: "trim",
          start: false,
        }),
      }),
    );
    const start = JSON.stringify({ type: "start" });
    const cont = JSON.stringify({ type: "continue", iteration: 2 });
    const exit = JSON.stringify({ type: "exit", code: 0 });
    appendLog(task.id, start);
    appendLog(task.id, "A");
    appendLog(task.id, "B");
    appendLog(task.id, cont);
    appendLog(task.id, "C");
    appendLog(task.id, exit);
    await flushPersist();
    await pruneTaskLogsForTests(task.id, 4);
    const rows = await getPool().query<{ line: string }>(
      `SELECT line FROM task_logs WHERE task_id = $1 ORDER BY id ASC`,
      [task.id],
    );
    assert.deepEqual(
      rows.rows.map((r) => r.line),
      [start, cont, "C", exit],
    );
  });

  it("R2-M1 DB prune applies the character budget under the line cap", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "字符预算", path }),
      }),
    );
    const { task } = await jsonOf(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "pi", workspaceId: workspace.id, prompt: "chars", start: false }),
      }),
    );
    for (let i = 0; i < 6; i++) appendLog(task.id, `L${i}${"x".repeat(1000)}`);
    await flushPersist();
    await pruneTaskLogsForTests(task.id, 100, 2500);
    const rows = await getPool().query<{ line: string }>(
      `SELECT line FROM task_logs WHERE task_id = $1 ORDER BY id ASC`,
      [task.id],
    );
    const total = rows.rows.reduce((n, r) => n + r.line.length, 0);
    assert.ok(rows.rows.length < 6);
    assert.ok(total <= 2500);
  });

  it("R2-M2 keeps degrade until a failed task batch is retried", async () => {
    const { failNextPersistForTests, upsertTask, isPersistDegraded } = await import("../../src/store.js");
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "批次故障", path }),
      }),
    );
    const make = async (prompt: string) => {
      const { task } = await jsonOf(
        await app.request("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "pi", workspaceId: workspace.id, prompt, start: false }),
        }),
      );
      return task;
    };
    const a = await make("batch-a");
    const b = await make("batch-b");
    await flushPersist();
    failNextPersistForTests("task");
    failNextPersistForTests("task");
    upsertTask({ ...a, title: "title-a2", updatedAt: new Date().toISOString() });
    upsertTask({ ...b, title: "title-b2", updatedAt: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(isPersistDegraded(), true);
    const other = freshWorkspacePath();
    ensureDir(other);
    const again = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "无关成功", path: other }),
    });
    assert.equal(again.status, 201);
    const health = await app.request("/api/health");
    assert.equal(health.status, 503);
    await flushPersist().catch(() => undefined);
    const rows = await getPool().query<{ title: string }>(
      `SELECT title FROM tasks WHERE id = ANY($1::text[]) ORDER BY title ASC`,
      [[a.id, b.id]],
    );
    assert.deepEqual(rows.rows.map((r) => r.title), ["title-a2", "title-b2"]);
    const health2 = await app.request("/api/health");
    assert.equal(health2.status, 200);
  });

  it("R2-M12 invalid continue JSON does not start the task", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "继续校验", path }),
      }),
    );
    const created = await jsonOf(
      await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pi",
          workspaceId: workspace.id,
          prompt: "base",
          start: true,
        }),
      }),
    );
    const settled = await waitSettled(created.task.id);
    assert.equal(settled.status, "succeeded");
    const callsBefore = runnerCalls.length;
    const bad = await app.request(`/api/tasks/${created.task.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"prompt\":",
    });
    assert.equal(bad.status, 400);
    assert.equal(runnerCalls.length, callsBefore);
    const empty = await app.request(`/api/tasks/${created.task.id}/continue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });
    assert.equal(empty.status, 200);
  });

  it("R2-M12 rejects workspace settings of the wrong type", async () => {
    const path = freshWorkspacePath();
    ensureDir(path);
    const { workspace } = await jsonOf(
      await app.request("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "设置类型", path }),
      }),
    );
    const primed = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { systemPrompt: "keep-me" } }),
    });
    assert.equal(primed.status, 200);
    const bad = await app.request(`/api/workspaces/${workspace.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: "bad" }),
    });
    assert.equal(bad.status, 400);
    const got = await jsonOf(await app.request(`/api/workspaces/${workspace.id}`));
    assert.equal(got.workspace.settings.systemPrompt, "keep-me");
  });

  it("R2-M13 concurrent settings patches keep both CLI keys", async () => {
    const { setSettingsBarrierForTests } = await import("../../src/settingsLock.js");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setSettingsBarrierForTests(gate);
    const a = app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPaths: { pi: "/tmp/pi-from-a" } }),
    });
    await new Promise((r) => setTimeout(r, 30));
    const b = app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPaths: { claude: "/tmp/claude-from-b" } }),
    });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);
    const body = await jsonOf(await app.request("/api/settings"));
    assert.equal(body.cliPaths.pi.override, "/tmp/pi-from-a");
    assert.equal(body.cliPaths.claude.override, "/tmp/claude-from-b");
    setSettingsBarrierForTests(null);
  });

  it("I13 git-status lists every repo under the workspace and ignores client paths", async () => {
    clearGitStatusCacheForTests();
    const path = freshWorkspacePath();
    ensureDir(path);
    const git = (cwd: string, args: string[]) => {
      execFileSync("git", args, {
        cwd,
        stdio: "pipe",
        env: gitReadOnlyEnv({
          ...process.env,
          GIT_AUTHOR_NAME: "Tester",
          GIT_AUTHOR_EMAIL: "tester@example.com",
          GIT_COMMITTER_NAME: "Tester",
          GIT_COMMITTER_EMAIL: "tester@example.com",
        }),
      });
    };
    git(path, ["init", "-b", "main"]);
    writeFileSync(join(path, "README.md"), "a\n");
    git(path, ["add", "README.md"]);
    git(path, ["commit", "-m", "init readme"]);
    writeFileSync(join(path, "README.md"), "changed\n");
    const nested = join(path, "pkgs", "lib");
    mkdirSync(nested, { recursive: true });
    git(nested, ["init", "-b", "dev"]);
    writeFileSync(join(nested, "lib.txt"), "lib\n");
    git(nested, ["add", "lib.txt"]);
    git(nested, ["commit", "-m", "lib init"]);

    const create = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "git 空间", path }),
    });
    assert.equal(create.status, 201);
    const { workspace } = await jsonOf(create);

    const missing = await app.request("/api/workspaces/does-not-exist/git-status");
    assert.equal(missing.status, 404);

    const res = await app.request(
      `/api/workspaces/${workspace.id}/git-status?path=/etc&refresh=1`,
    );
    assert.equal(res.status, 200);
    const body = await jsonOf(res);
    assert.equal(body.workspaceId, workspace.id);
    assert.equal(body.root, path);
    assert.equal(body.caps.maxDepth, 6);
    assert.equal(body.caps.maxRepos, 32);
    assert.equal(body.caps.maxDirs, 4000);
    assert.equal(body.caps.maxFilesPerRepo, 200);
    assert.equal(body.repos.length, 2);
    const top = body.repos.find((repo: { relPath: string }) => repo.relPath === ".");
    const child = body.repos.find((repo: { relPath: string }) => repo.relPath === join("pkgs", "lib"));
    assert.equal(top.branch, "main");
    assert.equal(top.dirty, true);
    assert.equal(top.subject, "init readme");
    assert.ok(top.files.some((file: { path: string; code: string }) => file.path === "README.md" && file.code === " M"));
    assert.equal(child.branch, "dev");
    assert.equal(child.dirty, false);
    assert.ok(body.repos.every((repo: { path: string }) => repo.path === path || repo.path.startsWith(path + "/")));

    const cached = await jsonOf(await app.request(`/api/workspaces/${workspace.id}/git-status`));
    assert.equal(cached.cached, true);

    rmSync(path, { recursive: true, force: true });
    const gone = await app.request(`/api/workspaces/${workspace.id}/git-status?refresh=1`);
    assert.equal(gone.status, 400);
  });

function gitEnv(): NodeJS.ProcessEnv {
  return gitReadOnlyEnv({
    ...process.env,
    GIT_AUTHOR_NAME: "Tester",
    GIT_AUTHOR_EMAIL: "tester@example.com",
    GIT_COMMITTER_NAME: "Tester",
    GIT_COMMITTER_EMAIL: "tester@example.com",
  });
}

function gitExec(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), stdio: "pipe" }).toString("utf8");
}

function initGitRepo(dir: string, commit = true): void {
  gitExec(dir, ["init", "-b", "main"]);
  if (!commit) return;
  writeFileSync(join(dir, "README.md"), "hi\n");
  gitExec(dir, ["add", "README.md"]);
  gitExec(dir, ["commit", "-m", "init"]);
}

function worktreeNames(root: string): string[] {
  const dir = join(root, ".agent-board", "worktrees");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

describe("git worktree HTTP", () => {
  const roots: string[] = [];

  beforeEach(async () => {
    clearHandlesForTests();
    installFakeRunners(runners as Record<string, (typeof runners)[keyof typeof runners]>);
    await resetStoreForTests();
    setNextTaskIdForTests(null);
    clearGitStatusCacheForTests();
  });

  after(async () => {
    setNextTaskIdForTests(null);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  async function makeWorkspace(path: string): Promise<{ id: string; path: string }> {
    roots.push(path);
    const create = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wt", path }),
    });
    assert.equal(create.status, 201);
    const { workspace } = await jsonOf(create);
    return workspace;
  }

  async function taskCount(): Promise<number> {
    const body = await jsonOf(await app.request("/api/tasks"));
    return body.tasks.length;
  }

  it("reports eligibility and round-trips an opted-in create", async () => {
    const path = freshWorkspacePath();
    initGitRepo(path);
    const workspace = await makeWorkspace(path);
    const head = gitExec(path, ["rev-parse", "HEAD"]).trim();

    const elig = await app.request(`/api/workspaces/${workspace.id}/git-worktree-eligibility`);
    assert.equal(elig.status, 200);
    const eligBody = await jsonOf(elig);
    assert.equal(eligBody.ok, true);
    assert.equal(eligBody.root, workspace.path);
    assert.equal(eligBody.head, head);

    const missing = await app.request("/api/workspaces/nope/git-worktree-eligibility");
    assert.equal(missing.status, 404);

    const off = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "stay on the root",
        title: "off",
        useGitWorktree: false,
      }),
    });
    assert.equal(off.status, 201);
    const offTask = (await jsonOf(off)).task;
    assert.equal(offTask.cwd, workspace.path);
    assert.equal(offTask.worktree, undefined);

    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "use a worktree",
        title: "on",
        useGitWorktree: true,
        start: true,
      }),
    });
    assert.equal(created.status, 201);
    const task = (await jsonOf(created)).task;
    assert.equal(task.workspaceId, workspace.id);
    assert.equal(task.cwd, join(workspace.path, ".agent-board", "worktrees", task.id));
    assert.equal(task.worktree.owned, true);
    assert.equal(task.worktree.branch, `agent-board/${task.id}`);
    assert.equal(task.worktree.baseHead, head);
    assert.equal(existsSync(task.cwd), true);
    assert.equal(gitExec(task.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), task.worktree.branch);

    await flushPersist();
    const row = await getPool().query(`SELECT cwd, worktree FROM tasks WHERE id = $1`, [task.id]);
    const stored = typeof row.rows[0].worktree === "string" ? JSON.parse(row.rows[0].worktree) : row.rows[0].worktree;
    assert.equal(row.rows[0].cwd, task.cwd);
    assert.equal(stored.branch, task.worktree.branch);
    assert.equal(stored.owned, true);

    const hook = await app.request("/api/hooks/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-webhook-secret",
      },
      body: JSON.stringify({
        prompt: "webhook worktree",
        agent: "pi",
        workspaceId: workspace.id,
        useGitWorktree: true,
      }),
    });
    assert.equal(hook.status, 201);
    const hooked = (await jsonOf(hook)).task;
    assert.equal(hooked.cwd, join(workspace.path, ".agent-board", "worktrees", hooked.id));
    assert.equal(hooked.worktree.owned, true);

    const del = await app.request("/api/tasks/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [task.id] }),
    });
    assert.equal(del.status, 200);
    const delBody = await jsonOf(del);
    assert.deepEqual(delBody.warnings, []);
    assert.equal(existsSync(task.cwd), false);
    assert.throws(() => gitExec(workspace.path, ["show-ref", "--verify", "--quiet", `refs/heads/${task.worktree.branch}`]));
  });

  it("returns 400 for ineligible, unborn, invalid boolean, and existing path without leftovers", async () => {
    const plain = freshWorkspacePath();
    writeFileSync(join(plain, "note.txt"), "x\n");
    const plainWs = await makeWorkspace(plain);
    const plainElig = await jsonOf(await app.request(`/api/workspaces/${plainWs.id}/git-worktree-eligibility`));
    assert.equal(plainElig.ok, false);

    const plainCreate = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: plainWs.id,
        prompt: "nope",
        useGitWorktree: true,
      }),
    });
    assert.equal(plainCreate.status, 400);
    assert.match((await jsonOf(plainCreate)).error, /git work tree root/);
    assert.equal(await taskCount(), 0);
    assert.deepEqual(worktreeNames(plain), []);

    const unbornPath = freshWorkspacePath();
    initGitRepo(unbornPath, false);
    const unbornWs = await makeWorkspace(unbornPath);
    const unbornElig = await jsonOf(await app.request(`/api/workspaces/${unbornWs.id}/git-worktree-eligibility`));
    assert.equal(unbornElig.ok, false);
    assert.match(unbornElig.reason, /no commits/);
    const unbornCreate = await app.request("/webhook/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-secret": "test-webhook-secret",
      },
      body: JSON.stringify({
        prompt: "unborn",
        agent: "pi",
        workspaceId: unbornWs.id,
        useGitWorktree: true,
      }),
    });
    assert.equal(unbornCreate.status, 400);
    assert.match((await jsonOf(unbornCreate)).error, /no commits/);
    assert.equal(await taskCount(), 0);
    assert.deepEqual(worktreeNames(unbornPath), []);

    const repo = freshWorkspacePath();
    initGitRepo(repo);
    const ws = await makeWorkspace(repo);
    const badBool = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: ws.id,
        prompt: "bad",
        useGitWorktree: "yes",
      }),
    });
    assert.equal(badBool.status, 400);
    assert.match((await jsonOf(badBool)).error, /useGitWorktree must be a boolean/);
    const badHook = await app.request("/api/hooks/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-webhook-secret",
      },
      body: JSON.stringify({
        prompt: "bad",
        agent: "pi",
        workspaceId: ws.id,
        useGitWorktree: 1,
      }),
    });
    assert.equal(badHook.status, 400);
    assert.match((await jsonOf(badHook)).error, /useGitWorktree must be a boolean/);
    assert.equal(await taskCount(), 0);
    assert.deepEqual(worktreeNames(repo), []);

    const id = "exists-http-1";
    const dest = join(repo, ".agent-board", "worktrees", id);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "keep.txt"), "keep\n");
    setNextTaskIdForTests(id);
    const existsRes = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: ws.id,
        prompt: "exists",
        useGitWorktree: true,
      }),
    });
    assert.equal(existsRes.status, 400);
    assert.match((await jsonOf(existsRes)).error, /already exists/);
    assert.equal(await taskCount(), 0);
    assert.equal(readFileSync(join(dest, "keep.txt"), "utf8"), "keep\n");
  });

  it("keeps a dirty worktree on delete and returns a warning", async () => {
    const path = freshWorkspacePath();
    initGitRepo(path);
    const workspace = await makeWorkspace(path);
    const created = await app.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pi",
        workspaceId: workspace.id,
        prompt: "dirty",
        title: "dirty",
        useGitWorktree: true,
      }),
    });
    assert.equal(created.status, 201);
    const task = (await jsonOf(created)).task;
    writeFileSync(join(task.cwd, "wip.txt"), "wip\n");
    const del = await app.request("/api/tasks/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [task.id] }),
    });
    assert.equal(del.status, 200);
    const body = await jsonOf(del);
    assert.ok(body.deleted.includes(task.id));
    assert.equal(body.warnings[0].code, "worktree_cleanup_skipped_dirty");
    assert.equal(existsSync(join(task.cwd, "wip.txt")), true);
    assert.equal(await taskCount(), 0);
  });

  it("returns 500 when git cannot be spawned and does not leave a task", async () => {
    const path = freshWorkspacePath();
    initGitRepo(path);
    const workspace = await makeWorkspace(path);
    const saved = process.env.PATH;
    process.env.PATH = join(freshWorkspacePath(), "missing-bin");
    try {
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "pi",
          workspaceId: workspace.id,
          prompt: "no git",
          useGitWorktree: true,
        }),
      });
      assert.equal(res.status, 500);
      assert.match((await jsonOf(res)).error, /git /);
    } finally {
      process.env.PATH = saved;
    }
    assert.equal(await taskCount(), 0);
    assert.deepEqual(worktreeNames(path), []);
  });
});
});


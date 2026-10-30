/**
 * High-priority API integration tests (I1–I7) against embedded Postgres + fake runners.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  startTestDb,
  stopTestDb,
  installFakeRunners,
  runnerCalls,
  freshWorkspacePath,
  readSseHello,
  jsonOf,
  ensureDir,
} from "./harness.js";

await startTestDb();

const { app } = await import("../../src/server.js");
const {
  initStore,
  resetStoreForTests,
  flushPersist,
  closePool,
  getPool,
} = await import("../../src/store.js");
const { clearHandlesForTests } = await import("../../src/manager.js");
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

describe("integration I1–I7", () => {
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
});

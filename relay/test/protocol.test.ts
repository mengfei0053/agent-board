import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseMessage } from "../src/protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("cmd.create keeps idempotency fields and drops unknown ones", () => {
  const parsed = parseMessage({
    v: 1,
    id: "phone-create-1",
    type: "cmd.create",
    ts: 1761890000000,
    payload: {
      boardId: "thinkbook-main",
      idempotencyKey: "android-req-7f3a",
      title: "Fix login flake",
      prompt: "Investigate the flaky login test and propose a fix.",
      agent: "cursor",
      cwd: "/home/me/src/app",
      note: "ignore me",
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== "cmd.create") return;
  assert.equal(parsed.idempotencyKey, "android-req-7f3a");
  assert.equal(parsed.envelope.payload?.note, undefined);
});

test("evt.task.done requires the terminal cursor fields", () => {
  const stopped = parseMessage(done("stopped"));
  assert.equal(stopped.ok, true);
  if (!stopped.ok || stopped.kind !== "evt.task.done") return;
  assert.equal(stopped.taskId, "task_01");
  assert.equal(stopped.generation, 1);
  assert.equal(stopped.seq, 4);
  assert.equal(stopped.eventId, "board-done-1");

  for (const status of ["queued", "running", "paused"]) {
    const parsed = parseMessage(done(status));
    assert.equal(parsed.ok, false, status);
  }
});

test("malformed envelopes are rejected", () => {
  assert.equal(parseMessage("{").ok, false);
  const version = parseMessage({ v: 2, id: "x", type: "board.list", ts: 1 });
  assert.equal(version.ok, false);
  if (!version.ok) assert.equal(version.code, "bad_version");
  const missing = parseMessage({
    v: 1,
    id: "phone-create-1",
    type: "cmd.create",
    ts: 1,
    payload: { boardId: "thinkbook-main", title: "t", prompt: "p" },
  });
  assert.equal(missing.ok, false);
});

test("task workspaceId is optional and forwarded", () => {
  const withId = parseMessage(frame("evt.task", "task-ws", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 2,
    eventId: "task-ws",
    task: { id: "task_01", title: "Fix login flake", status: "running", updatedAt: 10, agent: "cursor", workspaceId: "ws_app", note: "drop" },
  }));
  assert.equal(withId.ok, true);
  if (!withId.ok || withId.kind !== "evt.task") return;
  const task = withId.envelope.payload?.task as { workspaceId?: string; note?: string };
  assert.equal(task.workspaceId, "ws_app");
  assert.equal(task.note, undefined);

  const omitted = parseMessage(frame("evt.snapshot", "snap-old", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 1,
    eventId: "snap-old",
    version: 1,
    capturedAt: 10,
    tasks: [{ id: "task_01", title: "Fix login flake", status: "queued", updatedAt: 10 }],
  }));
  assert.equal(omitted.ok, true);
  if (!omitted.ok || omitted.kind !== "evt.snapshot") return;
  const rows = omitted.envelope.payload?.tasks as Array<{ workspaceId?: string }>;
  assert.equal(rows[0]?.workspaceId, undefined);

  const bad = parseMessage(frame("evt.task", "task-bad-ws", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 2,
    eventId: "task-bad-ws",
    task: { id: "task_01", title: "Fix login flake", status: "running", updatedAt: 10, workspaceId: "nope id" },
  }));
  assert.equal(bad.ok, false);
});

test("workspace commands keep their fields and drop unknown ones", () => {
  const created = parseMessage(frame("cmd.workspace.create", "ws-new", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    name: " App ",
    path: "/home/me/src/app",
    note: "ignore",
  }));
  assert.equal(created.ok, true);
  if (!created.ok || created.kind !== "cmd.workspace.create") return;
  assert.equal(created.envelope.payload?.name, "App");
  assert.equal(created.envelope.payload?.path, "/home/me/src/app");
  assert.equal(created.envelope.payload?.note, undefined);

  const relative = parseMessage(frame("cmd.workspace.create", "ws-rel", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    name: "App",
    path: "relative",
  }));
  assert.equal(relative.ok, false);

  const removed = parseMessage(frame("cmd.workspace.delete", "ws-del", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-del-1",
    workspaceId: "_nanoid01",
    note: "ignore",
  }));
  assert.equal(removed.ok, true);
  if (!removed.ok || removed.kind !== "cmd.workspace.delete") return;
  assert.equal(removed.envelope.payload?.workspaceId, "_nanoid01");
  assert.equal(removed.envelope.payload?.note, undefined);

  const lookup = parseMessage(frame("cmd.lookup", "ws-look", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    cmd: "cmd.workspace.create",
  }));
  assert.equal(lookup.ok, true);

  const ack = parseMessage(frame("ack", "ack-ws", {
    ref: "phone-ws-create-1",
    stage: "executed",
    boardId: "thinkbook-main",
    idempotencyKey: "android-ws-7f3a",
    commandId: "cmd-ws-1",
    workspace: { id: "ws_app", name: "App", path: "/home/me/src/app", isGit: true },
    extra: true,
  }));
  assert.equal(ack.ok, true);
  if (!ack.ok || ack.kind !== "ack") return;
  assert.equal((ack.envelope.payload?.workspace as { id: string }).id, "ws_app");
  assert.equal(ack.envelope.payload?.extra, undefined);
});

test("task detail fields and cmd.detail round-trip", () => {
  const parsed = parseMessage(frame("evt.task", "task-detail", {
    boardId: "thinkbook-main",
    generation: 1,
    seq: 2,
    eventId: "task-detail",
    task: {
      id: "task_01",
      title: "Fix login flake",
      status: "running",
      updatedAt: 10,
      agent: "cursor",
      workspaceId: "ws_app",
      iteration: 2,
      cwd: "/home/me/src/app",
      sessionId: "sess-123",
      promptPreview: "short",
      resumeCommand: "cd /home/me/src/app && agent --resume sess-123",
      detail: "full",
      prompt: "line one\nline two",
      turns: [{ iteration: 1, prompt: "line one\nline two", output: "reply" }],
      sideJobs: [{ id: "j1", kind: "monitor", title: "watch", status: "running" }],
    },
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== "evt.task") return;
  const task = parsed.envelope.payload?.task as { detail?: string; resumeCommand?: string; turns?: unknown[] };
  assert.equal(task.detail, "full");
  assert.equal(task.resumeCommand?.includes("agent --resume"), true);
  assert.equal(task.turns?.length, 1);

  const detail = parseMessage(frame("cmd.detail", "detail-1", {
    boardId: "thinkbook-main",
    idempotencyKey: "android-detail-01",
    taskId: "task_01",
    note: "drop",
  }));
  assert.equal(detail.ok, true);
  if (!detail.ok || detail.kind !== "cmd.detail") return;
  assert.equal(detail.taskId, "task_01");
  assert.equal(detail.envelope.payload?.note, undefined);

  const continued = parseMessage(frame("cmd.continue", "cont-prompt", {
    boardId: "thinkbook-main",
    idempotencyKey: "idem-continue",
    taskId: "task_01",
    prompt: "keep going\nplease",
  }));
  assert.equal(continued.ok, true);
  if (!continued.ok || continued.kind !== "cmd.continue") return;
  assert.equal(continued.envelope.payload?.prompt, "keep going\nplease");
});

function frame(type: string, id: string, payload: Record<string, unknown>) {
  return { v: 1, id, type, ts: 1761890000000, payload };
}

test("board.register accepts the capability names and lookup accepts the new commands", () => {
  const parsed = parseMessage({
    v: 1,
    id: "reg-caps",
    type: "board.register",
    ts: 1,
    payload: {
      boardId: "thinkbook-main",
      token: "board-token",
      capabilities: ["archive.list", "archive.write", "workspace.settings", "board.settings"],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok || parsed.kind !== "board.register") return;
  assert.deepEqual(parsed.capabilities, [
    "archive.list",
    "archive.write",
    "workspace.settings",
    "board.settings",
  ]);
  const unknown = parseMessage({
    v: 1,
    id: "reg-bad",
    type: "board.register",
    ts: 1,
    payload: { boardId: "thinkbook-main", token: "board-token", capabilities: ["archive.list", "nope"] },
  });
  assert.equal(unknown.ok, false);
  const command = parseMessage(frame("cmd.settings.get", "settings-get", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-get-1",
    note: "drop",
  }));
  assert.equal(command.ok, true);
  if (!command.ok || command.kind !== "cmd.settings.get") return;
  assert.equal(command.envelope.payload?.note, undefined);
  for (const cmd of ["cmd.workspace.get", "cmd.workspace.update", "cmd.settings.get", "cmd.settings.put", "cmd.archive"]) {
    const lookup = parseMessage(frame("cmd.lookup", `look-${cmd}`, {
      boardId: "thinkbook-main",
      idempotencyKey: "settings-get-1",
      cmd,
    }));
    assert.equal(lookup.ok, true, cmd);
    if (!lookup.ok || lookup.kind !== "cmd.lookup") return;
    assert.equal(lookup.cmd, cmd);
  }
  const oldList = parseMessage(frame("cmd.archive.list", "arch-old", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-01",
    limit: 20,
  }));
  assert.equal(oldList.ok, true);
  if (!oldList.ok || oldList.kind !== "cmd.archive.list") return;
  assert.equal(oldList.workspaceId, undefined);
  assert.equal(oldList.envelope.payload?.workspaceId, undefined);
  const scoped = parseMessage(frame("cmd.archive.list", "arch-scope", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-02",
    workspaceId: "ws_app",
    note: "drop",
  }));
  assert.equal(scoped.ok, true);
  if (!scoped.ok || scoped.kind !== "cmd.archive.list") return;
  assert.equal(scoped.workspaceId, "ws_app");
  assert.equal(scoped.envelope.payload?.workspaceId, "ws_app");
  assert.equal(scoped.envelope.payload?.note, undefined);
  const blankScope = parseMessage(frame("cmd.archive.list", "arch-blank", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-03",
    workspaceId: "",
  }));
  assert.equal(blankScope.ok, true);
  if (!blankScope.ok || blankScope.kind !== "cmd.archive.list") return;
  assert.equal(blankScope.envelope.payload?.workspaceId, undefined);
  const cleared = parseMessage(frame("cmd.settings.put", "settings-clear", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-clear-1",
    clear: true,
    codexSandbox: false,
  }));
  assert.equal(cleared.ok, false);
  if (cleared.ok) return;
  assert.equal(cleared.code, "bad_request");
  assert.equal(cleared.message, "clear is not allowed");
  const secret = "s3cret-pass";
  const put = parseMessage(frame("cmd.settings.put", "settings-put", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-01",
    proxyEnv: { codex: { HTTP_PROXY: `http://user:${secret}@127.0.0.1:8899` } },
    note: "drop",
  }));
  assert.equal(put.ok, true);
  if (!put.ok || put.kind !== "cmd.settings.put") return;
  assert.equal(put.envelope.payload?.note, undefined);
  const forwarded = put.envelope.payload?.proxyEnv as { codex: { HTTP_PROXY: string } };
  assert.equal(forwarded.codex.HTTP_PROXY, `http://user:${secret}@127.0.0.1:8899`);
  const placeholder = parseMessage(frame("cmd.settings.put", "settings-star", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-02",
    proxyEnv: { codex: { HTTP_PROXY: "http://user:***@127.0.0.1:8899" } },
  }));
  assert.equal(placeholder.ok, true);
  if (!placeholder.ok || placeholder.kind !== "cmd.settings.put") return;
  const kept = placeholder.envelope.payload?.proxyEnv as { codex: { HTTP_PROXY: string } };
  assert.equal(kept.codex.HTTP_PROXY, "http://user:***@127.0.0.1:8899");
  const ack = parseMessage(frame("ack", "ack-settings", {
    ref: "settings-put",
    stage: "executed",
    settings: {
      cliPaths: { codex: { default: "codex", override: "", effective: "codex", resolved: null, label: "codex" } },
      proxyEnv: {
        codex: {
          HTTP_PROXY: {
            override: `http://user:${secret}@127.0.0.1:8899`,
            effective: `http://user:${secret}@127.0.0.1:8899`,
            inherited: false,
            configured: true,
            hasCredential: false,
          },
        },
      },
      quickPrompts: [],
      codexSandbox: true,
      leaked: secret,
    },
  }));
  assert.equal(ack.ok, true);
  if (!ack.ok) return;
  const settings = ack.envelope.payload?.settings as {
    leaked?: string;
    proxyEnv: { codex: { HTTP_PROXY: { override: string; hasCredential: boolean } } };
  };
  assert.equal(settings.leaked, undefined);
  assert.equal(settings.proxyEnv.codex.HTTP_PROXY.override, "http://user:***@127.0.0.1:8899");
  assert.equal(settings.proxyEnv.codex.HTTP_PROXY.hasCredential, true);
  assert.equal(JSON.stringify(ack.envelope).includes(secret), false);
  const archiveAck = parseMessage(frame("ack", "ack-archive", {
    ref: "phone-archive-1",
    stage: "executed",
    archived: true,
    taskId: "task_01",
    task: { id: "task_01", title: "Fix login flake", status: "archived", updatedAt: 10 },
  }));
  assert.equal(archiveAck.ok, true);
  if (!archiveAck.ok) return;
  assert.equal(archiveAck.envelope.payload?.archived, true);
  assert.equal(archiveAck.envelope.payload?.taskId, "task_01");
  assert.equal(archiveAck.envelope.payload?.task, undefined);
  const card = parseMessage(frame("ack", "ack-ws-card", {
    ref: "phone-ws-get-1",
    stage: "executed",
    workspace: {
      id: "ws_app",
      name: "App",
      path: "/home/me/src/app",
      isGit: true,
      settings: { systemPrompt: "keep", skills: ["skill-a"], mcp: "" },
      git: { branch: "main", dirty: false, ahead: null, behind: 0, detached: false, repoCount: 1, error: null },
      files: ["secret.txt"],
    },
  }));
  assert.equal(card.ok, true);
  if (!card.ok) return;
  const workspace = card.envelope.payload?.workspace as { settings?: { systemPrompt: string }; git?: { ahead: null }; files?: string[] };
  assert.equal(workspace.settings?.systemPrompt, "keep");
  assert.equal(workspace.git?.ahead, null);
  assert.equal(workspace.files, undefined);
  const snapshot = parseMessage({
    v: 1,
    id: "snap-thin",
    type: "evt.snapshot",
    ts: 10,
    payload: {
      boardId: "thinkbook-main",
      generation: 1,
      seq: 1,
      eventId: "evt-1",
      version: 1,
      capturedAt: 10,
      tasks: [],
      workspaces: [{
        id: "ws_app",
        name: "App",
        path: "/home/me/src/app",
        isGit: true,
        settings: { systemPrompt: "hidden" },
      }],
    },
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok || snapshot.kind !== "evt.snapshot") return;
  const rows = snapshot.envelope.payload?.workspaces as Array<{ settings?: unknown; isGit?: boolean }>;
  assert.equal(rows[0]?.isGit, true);
  assert.equal(rows[0]?.settings, undefined);
  const unknownType = parseMessage(frame("cmd.not-a-command", "nope", {}));
  assert.equal(unknownType.ok, false);
  if (unknownType.ok) return;
  assert.equal(unknownType.code, "bad_type");
});

test("PROTOCOL.md websocket examples parse", () => {
  for (const file of [path.join(root, "PROTOCOL.md"), path.join(root, "..", "PROTOCOL.md")]) {
    const text = readFileSync(file, "utf8");
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)];
    assert.ok(blocks.length >= 8, file);
    let checked = 0;
    for (const block of blocks) {
      const value = JSON.parse(block[1] ?? "") as { v?: number; type?: string };
      if (value.v !== 1 || typeof value.type !== "string") continue;
      const parsed = parseMessage(value);
      assert.equal(parsed.ok, true, parsed.ok ? value.type : `${file} ${value.type}: ${parsed.message}`);
      checked += 1;
    }
    assert.ok(checked >= 8, file);
  }
});

function done(status: string) {
  return {
    v: 1,
    id: "board-done-1",
    type: "evt.task.done",
    ts: 1761890005000,
    payload: {
      boardId: "thinkbook-main",
      taskId: "task_01",
      status,
      generation: 1,
      seq: 4,
      eventId: "board-done-1",
      title: "Fix login flake",
      summary: "Stopped by client",
    },
  };
}

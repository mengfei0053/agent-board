import assert from "node:assert/strict";
import test from "node:test";
import type { BoardConn } from "../src/hub.js";
import type { Envelope } from "../src/protocol.js";
import { frame, helloPhone, setup, task, type Peer } from "./support.js";

const CAPS = ["archive.list", "archive.write", "workspace.settings", "board.settings"] as const;
const SECRET = "s3cret-pass";
const PLACEHOLDER = "http://user:***@127.0.0.1:8899";

function register(fx: ReturnType<typeof setup>, peer: Peer, capabilities: readonly string[]): BoardConn {
  const conn = fx.hub.attachBoard(peer.send, peer.close);
  fx.hub.handleBoard(conn, frame("board.register", `reg-${capabilities.join(".")}`, {
    boardId: "thinkbook-main",
    token: "board-token-value",
    label: "ThinkBook",
    capabilities: [...capabilities],
  }));
  return conn;
}

function settingsDoc(override = PLACEHOLDER) {
  return {
    cliPaths: {
      codex: { default: "codex", override: "", effective: "codex", resolved: null, label: "codex" },
    },
    proxyEnv: {
      codex: {
        HTTP_PROXY: {
          override,
          effective: override,
          inherited: false,
          configured: true,
          hasCredential: override.includes("***"),
        },
      },
    },
    quickPrompts: [{ id: "qp1", label: "继续", content: "请继续" }],
    codexSandbox: true,
  };
}

function executed(messages: Envelope[], ref: string): Envelope | undefined {
  return [...messages].reverse().find((message) =>
    message.type === "ack" && message.payload?.ref === ref && message.payload?.stage === "executed");
}

test("a phone must be signed in, and a foreign boardId is not stored", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  register(fx, boardPeer, CAPS);
  const unsigned = fx.peer();
  const raw = fx.hub.attachPhone(unsigned.send, unsigned.close);
  fx.hub.handlePhone(raw, frame("cmd.settings.get", "no-hello", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-get-01",
  }));
  assert.equal(unsigned.messages.at(-1)?.payload?.code, "unauthorized");

  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.settings.put", "foreign", {
    boardId: "other-board",
    idempotencyKey: "settings-put-01",
    codexSandbox: false,
  }));
  assert.equal(phonePeer.messages.at(-1)?.payload?.code, "forbidden");
  assert.equal(boardPeer.messages.some((message) => message.type === "cmd.settings.put"), false);

  fx.hub.handlePhone(phone.conn, frame("cmd.settings.get", "settings-get", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-get-01",
  }));
  const forwarded = boardPeer.messages.find((message) => message.type === "cmd.settings.get");
  assert.equal(forwarded?.payload?.idempotencyKey, "settings-get-01");
  assert.equal(phonePeer.messages.at(-1)?.payload?.stage, "accepted");
  fx.hub.dispose();
});

test("a missing capability is unsupported and is not stored", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  register(fx, boardPeer, ["archive.list"]);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  for (const [type, payload] of [
    ["cmd.archive", { taskId: "task_01" }],
    ["cmd.workspace.get", { workspaceId: "ws_app" }],
    ["cmd.settings.put", { codexSandbox: false }],
  ] as const) {
    fx.hub.handlePhone(phone.conn, frame(type, type, {
      boardId: "thinkbook-main",
      idempotencyKey: `${type}-key-01`,
      ...payload,
    }));
    const err = phonePeer.messages.at(-1);
    assert.equal(err?.type, "err", type);
    assert.equal(err?.payload?.code, "unsupported", type);
    assert.equal(boardPeer.messages.some((message) => message.type === type), false, type);
    fx.hub.handlePhone(phone.conn, frame("cmd.lookup", `look-${type}`, {
      boardId: "thinkbook-main",
      idempotencyKey: `${type}-key-01`,
      cmd: type,
    }));
    assert.equal(phonePeer.messages.at(-1)?.payload?.stage, "unknown", type);
  }
  fx.hub.handlePhone(phone.conn, frame("cmd.archive.list", "arch-old", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-key-01",
  }));
  assert.equal(boardPeer.messages.some((message) => message.type === "cmd.archive.list"), true);
  fx.hub.dispose();
});

test("settings writes redact the journal, keep a placeholder, and do not replay a different body", () => {
  const fx = setup({ tokenTtlMs: 120_000 });
  const boardPeer = fx.peer();
  const board = register(fx, boardPeer, CAPS);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  const proxy = `http://user:${SECRET}@127.0.0.1:8899`;
  fx.hub.handlePhone(phone.conn, frame("cmd.settings.put", "settings-put", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-01",
    proxyEnv: { codex: { HTTP_PROXY: proxy } },
    note: "drop",
  }));
  const forwarded = boardPeer.messages.find((message) => message.type === "cmd.settings.put");
  assert.equal((forwarded?.payload?.proxyEnv as { codex: { HTTP_PROXY: string } }).codex.HTTP_PROXY, proxy);
  assert.equal(forwarded?.payload?.note, undefined);
  assert.equal(JSON.stringify(phonePeer.messages).includes(SECRET), false);
  assert.equal(fx.logs.join("\n").includes(SECRET), false);

  fx.hub.handleBoard(board, frame("ack", "ack-put", {
    ref: forwarded?.id,
    stage: "executed",
    settings: settingsDoc(proxy),
  }));
  const ack = executed(phonePeer.messages, "settings-put");
  const stored = ack?.payload?.settings as { proxyEnv: { codex: { HTTP_PROXY: { override: string; hasCredential: boolean } } } };
  assert.equal(stored.proxyEnv.codex.HTTP_PROXY.override, PLACEHOLDER);
  assert.equal(stored.proxyEnv.codex.HTTP_PROXY.hasCredential, true);
  assert.equal(JSON.stringify(phonePeer.messages).includes(SECRET), false);

  fx.hub.handlePhone(phone.conn, frame("cmd.settings.put", "settings-bad", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-err",
    proxyEnv: { codex: { HTTP_PROXY: proxy } },
  }));
  const failed = boardPeer.messages.find((message) => message.payload?.idempotencyKey === "settings-put-err");
  fx.hub.handleBoard(board, frame("err", "err-put", {
    ref: failed?.id,
    code: "bad_request",
    message: `rejected ${proxy}`,
  }));
  assert.equal(phonePeer.messages.at(-1)?.payload?.message, `rejected ${PLACEHOLDER}`);
  assert.equal(JSON.stringify(phonePeer.messages).includes(SECRET), false);

  boardPeer.messages.length = 0;
  fx.hub.handlePhone(phone.conn, frame("cmd.settings.put", "settings-other", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-01",
    proxyEnv: { codex: { HTTP_PROXY: "http://user:other-secret@10.0.0.1:8899" } },
  }));
  assert.equal(boardPeer.messages.some((message) => message.type === "cmd.settings.put"), false);
  assert.equal(phonePeer.messages.at(-1)?.payload?.duplicate, true);
  assert.equal(JSON.stringify(phonePeer.messages).includes("other-secret"), false);
  assert.equal(JSON.stringify(phonePeer.messages).includes(SECRET), false);

  fx.hub.disconnectPhone(phone.conn);
  const againPeer = fx.peer();
  const again = helloPhone(fx.hub, fx.auth, againPeer, "pixel-2");
  fx.hub.handlePhone(again.conn, frame("cmd.lookup", "look-put", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-01",
    cmd: "cmd.settings.put",
  }));
  const looked = againPeer.messages.at(-1);
  assert.equal(looked?.payload?.stage, "executed");
  assert.equal(looked?.payload?.duplicate, true);
  const lookedSettings = looked?.payload?.settings as { proxyEnv: { codex: { HTTP_PROXY: { override: string } } } };
  assert.equal(lookedSettings.proxyEnv.codex.HTTP_PROXY.override, PLACEHOLDER);
  assert.equal(JSON.stringify(againPeer.messages).includes(SECRET), false);

  fx.hub.handlePhone(again.conn, frame("cmd.settings.put", "settings-star", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-02",
    proxyEnv: { codex: { HTTP_PROXY: PLACEHOLDER } },
  }));
  const starred = boardPeer.messages.find((message) => message.payload?.idempotencyKey === "settings-put-02");
  assert.equal((starred?.payload?.proxyEnv as { codex: { HTTP_PROXY: string } }).codex.HTTP_PROXY, PLACEHOLDER);

  fx.clock.t += 60_001;
  fx.hub.handlePhone(again.conn, frame("cmd.lookup", "look-expired", {
    boardId: "thinkbook-main",
    idempotencyKey: "settings-put-01",
    cmd: "cmd.settings.put",
  }));
  assert.equal(againPeer.messages.at(-1)?.payload?.stage, "unknown");
  assert.equal(fx.logs.join("\n").includes(SECRET), false);
  fx.hub.dispose();
});

test("an old phone still lists the archive without workspaceId, and a scoped page keeps it", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  const board = register(fx, boardPeer, ["archive.list"]);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.create", "create-old", {
    boardId: "thinkbook-main",
    idempotencyKey: "create-old-01",
    title: "Fix login flake",
    prompt: "keep going",
    agent: "cursor",
  }));
  fx.hub.handlePhone(phone.conn, frame("cmd.archive.list", "arch-old", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-old-01",
    limit: 20,
  }));
  const oldPage = boardPeer.messages.find((message) => message.payload?.idempotencyKey === "archive-old-01");
  assert.equal(oldPage?.type, "cmd.archive.list");
  assert.equal(oldPage?.payload?.workspaceId, undefined);
  fx.hub.handlePhone(phone.conn, frame("cmd.archive.list", "arch-scope", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-scope-01",
    workspaceId: "ws_app",
    note: "drop",
  }));
  const scoped = boardPeer.messages.find((message) => message.payload?.idempotencyKey === "archive-scope-01");
  assert.equal(scoped?.payload?.workspaceId, "ws_app");
  assert.equal(scoped?.payload?.note, undefined);
  fx.hub.handleBoard(board, frame("ack", "ack-scope", {
    ref: scoped?.id,
    stage: "executed",
    archive: { tasks: [{ ...task("archived", "task_old"), workspaceId: "ws_app" }] },
  }));
  const page = executed(phonePeer.messages, "arch-scope");
  const rows = page?.payload?.archive as { tasks: Array<{ id: string; workspaceId?: string }> };
  assert.equal(rows.tasks[0]?.workspaceId, "ws_app");
  fx.hub.dispose();
});

test("archive and workspace acks round-trip without a hot-list task", () => {
  const fx = setup();
  const boardPeer = fx.peer();
  const board = register(fx, boardPeer, CAPS);
  const phonePeer = fx.peer();
  const phone = helloPhone(fx.hub, fx.auth, phonePeer);
  fx.hub.handlePhone(phone.conn, frame("cmd.archive", "arch-write", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-write-01",
    taskId: "task_01",
  }));
  const forwarded = boardPeer.messages.find((message) => message.type === "cmd.archive");
  fx.hub.handleBoard(board, frame("ack", "ack-arch", {
    ref: forwarded?.id,
    stage: "executed",
    archived: true,
    taskId: "task_01",
    task: task("archived"),
  }));
  const ack = executed(phonePeer.messages, "arch-write");
  assert.equal(ack?.payload?.archived, true);
  assert.equal(ack?.payload?.taskId, "task_01");
  assert.equal(ack?.payload?.task, undefined);
  fx.hub.handlePhone(phone.conn, frame("cmd.lookup", "look-arch", {
    boardId: "thinkbook-main",
    idempotencyKey: "archive-write-01",
    cmd: "cmd.archive",
  }));
  assert.equal(phonePeer.messages.at(-1)?.payload?.task, undefined);
  assert.equal(phonePeer.messages.at(-1)?.payload?.archived, true);

  fx.hub.handlePhone(phone.conn, frame("cmd.workspace.get", "ws-get", {
    boardId: "thinkbook-main",
    idempotencyKey: "ws-get-01",
    workspaceId: "ws_app",
  }));
  const get = boardPeer.messages.find((message) => message.type === "cmd.workspace.get");
  assert.equal(get?.payload?.workspaceId, "ws_app");
  fx.hub.handleBoard(board, frame("ack", "ack-ws", {
    ref: get?.id,
    stage: "executed",
    workspace: {
      id: "ws_app",
      name: "App",
      path: "/home/me/src/app",
      isGit: true,
      settings: { systemPrompt: "keep", skills: ["skill-a"], mcp: "" },
      git: { branch: "main", dirty: false, ahead: null, behind: 1, detached: false, repoCount: 1, error: null },
    },
  }));
  const card = executed(phonePeer.messages, "ws-get")?.payload?.workspace as {
    settings: { systemPrompt: string };
    git: { ahead: null; behind: number };
  };
  assert.equal(card.settings.systemPrompt, "keep");
  assert.equal(card.git.ahead, null);
  assert.equal(card.git.behind, 1);
  fx.hub.dispose();
});

import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { abortableSleep, maybeStartEmbeddedRelay, startEmbeddedRelay } from "./run.js";
import type { ConnectorSession } from "./session.js";
import { RELAY_LIMITS } from "./limits.js";
import {
  defer,
  enabledConfig,
  makeTask,
  makeWorkspace,
  memoryFacade,
  MockRelay,
  waitFor,
} from "./harness.js";

describe("embedded relay run", { concurrency: 1 }, () => {
  it("accepts a register ack when the envelope id differs and payload.ref is the register id", async () => {
    const relay = new MockRelay();
    await relay.listen();
    const facade = memoryFacade();
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url),
      facade,
      log: () => {},
    });
    try {
      await dialer.ready;
      const register = relay.received.find((frame) => frame.type === "board.register");
      const ack = relay.sent.find((frame) => frame.type === "ack" && frame.payload.ref === register?.id);
      assert.ok(register);
      assert.ok(ack);
      assert.notEqual(ack.id, register.id);
      assert.equal(ack.payload.ref, register.id);
      assert.equal(ack.payload.generation, 1);
    } finally {
      await dialer.close();
      await relay.close();
    }
    assert.equal(facade.listeners.size, 0);
  });

  it("registers, sends a snapshot, and resets backoff after a registered session", async () => {
    const relay = new MockRelay();
    await relay.listen();
    const facade = memoryFacade({ tasks: [makeTask({ status: "succeeded" })] });
    const delays: number[] = [];
    const logs: string[] = [];
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 40, reconnectMaxMs: 5_000 }),
      facade,
      log: (_level, message) => logs.push(message),
      sleep: async (ms, signal) => {
        delays.push(ms);
        await abortableSleep(ms, signal);
      },
    });
    try {
      await dialer.ready;
      await waitFor(() => relay.received.some((frame) => frame.type === "evt.snapshot"));
      const snapshot = relay.received.find((frame) => frame.type === "evt.snapshot");
      assert.equal(snapshot?.payload.generation, 1);
      assert.equal((snapshot?.payload.tasks as Array<{ status: string }>)[0]?.status, "succeeded");
      assert.equal(relay.received.some((frame) => frame.type === "evt.task.done"), false);
      relay.drop();
      await waitFor(() => {
        const snapshots = relay.received.filter((frame) => frame.type === "evt.snapshot");
        return delays.length >= 1
          && relay.generation >= 3
          && snapshots.some((frame) => frame.payload.generation === 2);
      });
      assert.equal(delays[0], 40);
      const second = relay.received.filter((frame) => frame.type === "evt.snapshot");
      assert.equal(second[1]?.payload.generation, 2);
      assert.equal(logs.some((line) => line.includes("test-board-token")), false);
      assert.equal(facade.listeners.size, 1);
    } finally {
      await dialer.close();
      await relay.close();
    }
    assert.equal(facade.listeners.size, 0);
  });

  it("drains a command that arrived before the register ack at that generation", async () => {
    const relay = new MockRelay();
    relay.generation = 4;
    relay.beforeAck = (ws) => {
      relay.send(ws, "cmd.create", {
        boardId: "thinkbook",
        idempotencyKey: "create-key-1",
        title: "Early",
        prompt: "before ack",
        agent: "pi",
        cwd: "/tmp/repo",
      }, "cmd-early");
    };
    await relay.listen();
    const facade = memoryFacade();
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url),
      facade,
      log: () => {},
    });
    try {
      await dialer.ready;
      await waitFor(() => relay.received.some((frame) => frame.type === "ack" && frame.id === "cmd-early"));
      const types = relay.received.map((frame) => frame.type);
      const snapshotAt = types.indexOf("evt.snapshot");
      const ackAt = types.indexOf("ack");
      assert.ok(snapshotAt >= 0 && snapshotAt < ackAt);
      const snapshot = relay.received[snapshotAt];
      assert.equal(snapshot?.payload.generation, 4);
      assert.equal(facade.creates, 1);
      assert.equal(facade.tasks[0]?.title, "Early");
    } finally {
      await dialer.close();
      await relay.close();
    }
  });

  it("doubles reconnect delay until a cap and stops when closed during backoff", async () => {
    const delays: number[] = [];
    const dialer = startEmbeddedRelay({
      config: enabledConfig("ws://127.0.0.1:1", { reconnectMinMs: 30, reconnectMaxMs: 50, openTimeoutMs: 200 }),
      facade: memoryFacade(),
      log: () => {},
      sleep: async (ms, signal) => {
        delays.push(ms);
        await abortableSleep(ms, signal);
      },
    });
    await assert.rejects(dialer.ready);
    await waitFor(() => delays.length >= 2);
    assert.equal(delays[0], 30);
    assert.equal(delays[1], 50);
    const started = Date.now();
    await dialer.close();
    assert.ok(Date.now() - started < 1_000);
  });

  it("closes promptly while the socket is still connecting", async () => {
    const sockets: net.Socket[] = [];
    const server = net.createServer((socket) => {
      sockets.push(socket);
      socket.pause();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const dialer = startEmbeddedRelay({
      config: enabledConfig(`ws://127.0.0.1:${port}`, {
        openTimeoutMs: 8_000,
        reconnectMinMs: 60_000,
      }),
      facade: memoryFacade(),
      log: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      const started = Date.now();
      await dialer.close();
      assert.ok(Date.now() - started < 1_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes promptly while waiting for board.register", async () => {
    const relay = new MockRelay();
    relay.silent = true;
    await relay.listen();
    const facade = memoryFacade();
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { registerTimeoutMs: 8_000, reconnectMinMs: 60_000 }),
      facade,
      log: () => {},
    });
    try {
      await waitFor(() => relay.received.some((frame) => frame.type === "board.register"));
      const started = Date.now();
      await dialer.close();
      assert.ok(Date.now() - started < 1_000);
    } finally {
      await relay.close();
    }
    assert.equal(facade.listeners.size, 0);
  });

  it("rejects ready on an invalid register and does not leak listeners", async () => {
    const relay = new MockRelay();
    relay.rejectCode = "unauthorized";
    await relay.listen();
    const logs: string[] = [];
    const facade = memoryFacade();
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 40 }),
      facade,
      log: (_level, message) => logs.push(message),
    });
    try {
      await assert.rejects(dialer.ready);
      await waitFor(() => logs.some((line) => line.includes("register rejected")));
      assert.equal(logs.some((line) => line.includes("test-board-token")), false);
    } finally {
      await dialer.close();
      await relay.close();
    }
    assert.equal(facade.listeners.size, 0);
  });

  it("reconnects when the bus buffer overflows and leaves the process up", async () => {
    const relay = new MockRelay();
    await relay.listen();
    const facade = memoryFacade({
      tasks: [makeTask()],
      workspaces: [makeWorkspace()],
    });
    const gate = defer<{ ok: boolean }>();
    let calls = 0;
    facade.gitEligibility = () => {
      calls += 1;
      if (calls === 1) return gate.promise;
      return Promise.resolve({ ok: false });
    };
    const crashes: string[] = [];
    const onCrash = (err: Error) => crashes.push(err.message);
    process.on("uncaughtException", onCrash);
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 20, reconnectMaxMs: 40 }),
      facade,
      log: () => {},
    });
    try {
      await waitFor(() => calls >= 1);
      for (let i = 0; i < RELAY_LIMITS.maxBusBuffer + 3; i += 1) {
        facade.publish({
          type: "task_log",
          taskId: "t1",
          line: `n${i}`,
          at: "2026-10-31T00:00:00.000Z",
        });
      }
      gate.resolve({ ok: false });
      await waitFor(() => relay.generation >= 3);
      assert.equal(crashes.length, 0);
      assert.ok(facade.listeners.size <= 1);
    } finally {
      process.off("uncaughtException", onCrash);
      await dialer.close();
      await relay.close();
    }
  });

  it("rejects a live command flood while create is held and reconnects", async () => {
    const relay = new MockRelay();
    await relay.listen();
    const facade = memoryFacade();
    const gate = defer<ReturnType<typeof makeTask>>();
    facade.createImpl = (input) => {
      facade.creates += 1;
      const task = makeTask({
        id: "held",
        title: input.title,
        kind: input.kind,
        cwd: input.cwd,
        prompt: input.prompt,
        status: "queued",
      });
      facade.tasks.push(task);
      return gate.promise.then(() => task);
    };
    const crashes: string[] = [];
    const onCrash = (err: Error) => crashes.push(err.message);
    process.on("uncaughtException", onCrash);
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 20, reconnectMaxMs: 40 }),
      facade,
      log: () => {},
    });
    try {
      await dialer.ready;
      const ws = relay.clients[0];
      assert.ok(ws);
      relay.send(ws, "cmd.create", {
        boardId: "thinkbook",
        idempotencyKey: "create-key-1",
        title: "Hold",
        prompt: "wait",
        agent: "pi",
        cwd: "/tmp/repo",
      }, "cmd-hold");
      await waitFor(() => facade.creates === 1);
      for (let i = 0; i < RELAY_LIMITS.maxLiveCommands + 8; i += 1) {
        relay.send(ws, "cmd.create", {
          boardId: "thinkbook",
          idempotencyKey: `flood-key-${i}`,
          title: "Flood",
          prompt: "again",
          agent: "pi",
          cwd: "/tmp/repo",
        }, `flood-${i}`);
      }
      await waitFor(() => relay.received.some((frame) => frame.type === "err" && frame.payload.code === "rate_limited"));
      await waitFor(() => relay.generation >= 3);
      assert.equal(facade.creates, 1);
      assert.equal(crashes.length, 0);
      assert.equal(facade.listeners.size, 1);
    } finally {
      process.off("uncaughtException", onCrash);
      gate.resolve(facade.tasks[0] ?? makeTask());
      await dialer.close();
      await relay.close();
    }
    assert.equal(facade.listeners.size, 0);
    assert.equal(facade.creates, 1);
  });

  it("does not keep closed-session command queues across reconnect floods", async () => {
    const relay = new MockRelay();
    await relay.listen();
    const facade = memoryFacade();
    const gate = defer<ReturnType<typeof makeTask>>();
    facade.createImpl = (input) => {
      facade.creates += 1;
      const task = makeTask({
        id: "shared",
        title: input.title,
        kind: input.kind,
        cwd: input.cwd,
        prompt: input.prompt,
        status: "queued",
      });
      facade.tasks.push(task);
      return gate.promise.then(() => task);
    };
    const seen: ConnectorSession[] = [];
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 15, reconnectMaxMs: 30 }),
      facade,
      log: () => {},
      onSession: (session) => {
        if (session) seen.push(session);
      },
    });
    try {
      await dialer.ready;
      const first = relay.clients[0];
      assert.ok(first);
      relay.send(first, "cmd.create", {
        boardId: "thinkbook",
        idempotencyKey: "create-key-1",
        title: "Hold",
        prompt: "wait",
        agent: "pi",
        cwd: "/tmp/repo",
      }, "cmd-hold");
      await waitFor(() => facade.creates === 1);
      const generations = 8;
      for (let generation = 0; generation < generations; generation += 1) {
        const ws = relay.clients[0];
        assert.ok(ws);
        const generationBefore = relay.generation;
        relay.send(ws, "cmd.create", {
          boardId: "thinkbook",
          idempotencyKey: "create-key-1",
          title: "Hold",
          prompt: "wait",
          agent: "pi",
          cwd: "/tmp/repo",
        }, `join-${generation}`);
        for (let i = 0; i < RELAY_LIMITS.maxLiveCommands + 4; i += 1) {
          relay.send(ws, "cmd.create", {
            boardId: "thinkbook",
            idempotencyKey: `flood-${generation}-${i}-key`,
            title: "Flood",
            prompt: "queued",
            agent: "pi",
            cwd: "/tmp/repo",
          }, `flood-${generation}-${i}`);
        }
        await waitFor(() => relay.generation > generationBefore);
      }
      await waitFor(() => seen.length >= generations);
      await waitFor(() => relay.received.filter((frame) => frame.type === "evt.snapshot").length >= generations);
      assert.equal(facade.creates, 1);
      assert.ok(seen.length >= generations);
      for (const session of seen) {
        assert.equal(session.queuedCommandCount(), 0);
      }
    } finally {
      gate.resolve(facade.tasks[0] ?? makeTask());
      await dialer.close();
      await relay.close();
    }
    assert.equal(facade.creates, 1);
    for (const session of seen) assert.equal(session.queuedCommandCount(), 0);
  });

  it("returns null when relay env is incomplete", () => {
    const logs: string[] = [];
    const started = maybeStartEmbeddedRelay({
      env: {},
      log: (_level, message) => logs.push(message),
    });
    assert.equal(started, null);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.includes("token"), false);
  });
});

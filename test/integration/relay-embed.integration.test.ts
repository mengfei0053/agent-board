import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startEmbeddedRelay } from "../../src/relay/run.js";
import {
  defer,
  enabledConfig,
  makeTask,
  memoryFacade,
  MockRelay,
  waitFor,
} from "../../src/relay/harness.js";

describe("embedded relay integration", { concurrency: 1 }, () => {
  it("creates one task, emits one done, and does not repeat done after reconnect", async () => {
    const relay = new MockRelay();
    await relay.listen();
    const facade = memoryFacade();
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 20, reconnectMaxMs: 40 }),
      facade,
      log: () => {},
    });
    try {
      await dialer.ready;
      relay.send(relay.clients[0]!, "cmd.create", {
        boardId: "thinkbook",
        idempotencyKey: "create-key-1",
        title: "From phone",
        prompt: "ship it",
        agent: "codex",
        cwd: "/tmp/repo",
        useGitWorktree: true,
      }, "cmd-1");
      await waitFor(() => facade.creates === 1 && facade.tasks.length === 1);
      assert.equal(facade.tasks[0]?.title, "From phone");
      await waitFor(() => relay.received.some((frame) => frame.id === "cmd-1" && frame.type === "ack"));

      const created = facade.tasks[0]!;
      created.status = "running";
      facade.publish({ type: "task_upsert", task: { ...created } });
      created.status = "succeeded";
      created.summary = "landed";
      facade.publish({ type: "task_upsert", task: { ...created } });
      await waitFor(() => relay.received.filter((frame) => frame.type === "evt.task.done").length === 1);
      facade.publish({ type: "task_upsert", task: { ...created, summary: "landed" } });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(relay.received.filter((frame) => frame.type === "evt.task.done").length, 1);

      const doneBefore = relay.received.filter((frame) => frame.type === "evt.task.done").length;
      relay.drop();
      await waitFor(() => relay.received.filter((frame) => frame.type === "evt.snapshot").length >= 2);
      const snapshots = relay.received.filter((frame) => frame.type === "evt.snapshot");
      assert.notEqual(snapshots[0]?.payload.generation, snapshots[1]?.payload.generation);
      const secondTasks = snapshots[1]?.payload.tasks as Array<{ id: string; status: string }>;
      assert.equal(secondTasks.some((task) => task.id === created.id && task.status === "succeeded"), true);
      assert.equal(relay.received.filter((frame) => frame.type === "evt.task.done").length, doneBefore);
    } finally {
      await dialer.close();
      await relay.close();
    }
  });

  it("retries a completed create without calling the facade again", async () => {
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
      const payload = {
        boardId: "thinkbook",
        idempotencyKey: "create-key-1",
        title: "Once",
        prompt: "please",
        agent: "pi",
        cwd: "/tmp/repo",
      };
      relay.send(relay.clients[0]!, "cmd.create", payload, "cmd-a");
      await waitFor(() => relay.received.some((frame) => frame.id === "cmd-a"));
      relay.drop();
      await waitFor(() => relay.clients.length === 1 && relay.generation >= 3);
      relay.send(relay.clients[0]!, "cmd.create", payload, "cmd-b");
      await waitFor(() => relay.received.some((frame) => frame.id === "cmd-b" && frame.type === "ack"));
      assert.equal(facade.creates, 1);
      assert.equal(facade.tasks.length, 1);
      const ack = relay.received.find((frame) => frame.id === "cmd-b");
      assert.equal((ack?.payload.task as { id: string }).id, facade.tasks[0]?.id);
    } finally {
      await dialer.close();
      await relay.close();
    }
  });

  it("joins an in-flight create across a dropped socket", async () => {
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
    const dialer = startEmbeddedRelay({
      config: enabledConfig(relay.url, { reconnectMinMs: 20, reconnectMaxMs: 40 }),
      facade,
      log: () => {},
    });
    try {
      await dialer.ready;
      const payload = {
        boardId: "thinkbook",
        idempotencyKey: "create-key-1",
        title: "Race",
        prompt: "hold",
        agent: "pi",
        cwd: "/tmp/repo",
      };
      relay.send(relay.clients[0]!, "cmd.create", payload, "cmd-a");
      await waitFor(() => facade.creates === 1);
      relay.drop();
      await waitFor(() => relay.clients.length === 1 && relay.received.filter((frame) => frame.type === "evt.snapshot").length >= 2);
      relay.send(relay.clients[0]!, "cmd.create", payload, "cmd-b");
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(facade.creates, 1);
      gate.resolve(facade.tasks[0]!);
      await waitFor(() => relay.received.some((frame) => frame.id === "cmd-b" && frame.type === "ack"));
      const acks = relay.received.filter((frame) => frame.type === "ack" && frame.payload.stage === "executed");
      assert.ok(acks.length >= 1);
      assert.ok(acks.every((frame) => (frame.payload.task as { id: string }).id === "shared"));
      assert.equal(facade.creates, 1);
      assert.equal(facade.tasks.length, 1);
    } finally {
      await dialer.close();
      await relay.close();
    }
  });
});

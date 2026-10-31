import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardEvent } from "../types.js";
import { frame, type Envelope } from "./envelope.js";
import { CreateIdempotency } from "./idempotency.js";
import { RELAY_LIMITS } from "./limits.js";
import { ConnectorSession, type RelaySender } from "./session.js";
import { defer, makeTask, makeWorkspace, memoryFacade, waitFor, type MemoryFacade } from "./harness.js";

function sentFrames(): { frames: Array<{ type: string; payload: Record<string, unknown>; id?: string }>; send: RelaySender } {
  const frames: Array<{ type: string; payload: Record<string, unknown>; id?: string }> = [];
  return {
    frames,
    send: (type, payload, id) => {
      frames.push({ type, payload, id });
    },
  };
}

function createCmd(extra: Record<string, unknown> = {}): Envelope {
  return frame("cmd.create", {
    boardId: "thinkbook",
    idempotencyKey: "create-key-1",
    title: "Ship",
    prompt: "do it",
    agent: "pi",
    cwd: "/tmp/repo",
    ...extra,
  }, "cmd-1");
}

describe("connector session", () => {
  it("emits the baseline snapshot before buffered terminal and delete events", async () => {
    const running = makeTask({ id: "live", status: "running", title: "Live" });
    const facade = memoryFacade({ tasks: [running], workspaces: [makeWorkspace()] });
    const gate = defer<{ ok: boolean }>();
    let eligibilityCalls = 0;
    facade.gitEligibility = () => {
      eligibilityCalls += 1;
      if (eligibilityCalls === 1) return gate.promise;
      return Promise.resolve({ ok: false });
    };
    const { frames, send } = sentFrames();
    const session = new ConnectorSession({
      generation: 5,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {},
      onFatal: () => {},
    });
    const boot = session.bootstrap();
    await waitFor(() => eligibilityCalls === 1);
    const terminal = makeTask({ id: "live", status: "succeeded", title: "Live", summary: "ok" });
    facade.publish({ type: "task_upsert", task: terminal });
    facade.publish({ type: "task_delete", taskIds: ["live"] });
    gate.resolve({ ok: true });
    await boot;

    assert.equal(frames[0]?.type, "evt.snapshot");
    assert.equal(frames[0]?.payload.generation, 5);
    const firstTasks = frames[0]?.payload.tasks as Array<{ id: string; status: string }>;
    assert.equal(firstTasks.some((task) => task.id === "live" && task.status === "running"), true);
    assert.ok(frames.findIndex((frame) => frame.type !== "evt.snapshot") > 0);

    const done = frames.filter((frame) => frame.type === "evt.task.done");
    assert.equal(done.length, 1);
    assert.equal(done[0]?.payload.taskId, "live");
    const lastSnapshot = [...frames].reverse().find((frame) => frame.type === "evt.snapshot");
    const lastTasks = lastSnapshot?.payload.tasks as Array<{ id: string }>;
    assert.equal(lastTasks.some((task) => task.id === "live"), false);

    const seqs = frames.map((frame) => frame.payload.seq as number);
    for (let i = 1; i < seqs.length; i += 1) assert.ok(seqs[i]! > seqs[i - 1]!);
    session.close();
    assert.equal(facade.listeners.size, 0);
  });

  it("suppresses done when the baseline task is already terminal", async () => {
    const doneTask = makeTask({ id: "old", status: "failed" });
    const facade = memoryFacade({ tasks: [doneTask], workspaces: [makeWorkspace()] });
    const { frames, send } = sentFrames();
    const session = new ConnectorSession({
      generation: 1,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {},
      onFatal: () => {},
    });
    const boot = session.bootstrap();
    facade.publish({ type: "task_upsert", task: { ...doneTask, summary: "same failure" } });
    facade.publish({ type: "task_delete", taskIds: ["old"] });
    await boot;
    assert.equal(frames.some((frame) => frame.type === "evt.task.done"), false);
    const last = [...frames].reverse().find((frame) => frame.type === "evt.snapshot");
    const ids = (last?.payload.tasks as Array<{ id: string }>).map((task) => task.id);
    assert.equal(ids.includes("old"), false);
    session.close();
  });

  it("emits done when a different task is deleted before a buffered terminal upsert", async () => {
    const taskA = makeTask({ id: "A", status: "running", title: "A" });
    const taskB = makeTask({ id: "B", status: "running", title: "B" });
    const facade = memoryFacade({ tasks: [taskA, taskB], workspaces: [makeWorkspace()] });
    const gate = defer<{ ok: boolean }>();
    let eligibilityCalls = 0;
    facade.gitEligibility = () => {
      eligibilityCalls += 1;
      if (eligibilityCalls === 1) return gate.promise;
      return Promise.resolve({ ok: false });
    };
    const { frames, send } = sentFrames();
    const session = new ConnectorSession({
      generation: 2,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {},
      onFatal: () => {},
    });
    const boot = session.bootstrap();
    await waitFor(() => eligibilityCalls === 1);
    facade.publish({ type: "task_delete", taskIds: ["B"] });
    facade.publish({
      type: "task_upsert",
      task: makeTask({ id: "A", status: "succeeded", title: "A", summary: "done" }),
    });
    gate.resolve({ ok: false });
    await boot;

    const done = frames.filter((frame) => frame.type === "evt.task.done");
    assert.equal(done.length, 1);
    assert.equal(done[0]?.payload.taskId, "A");
    assert.equal(done[0]?.payload.status, "succeeded");
    const taskFrames = frames.filter((frame) => frame.type === "evt.task");
    assert.equal(taskFrames.length, 1);
    assert.equal((taskFrames[0]?.payload.task as { id: string }).id, "A");
    assert.equal(frames[0]?.type, "evt.snapshot");
    const doneAt = frames.findIndex((frame) => frame.type === "evt.task.done");
    assert.ok(doneAt > frames.findIndex((frame) => frame.type === "evt.snapshot"));
    session.close();
  });

  it("emits done when a workspace refresh is queued ahead of a terminal upsert", async () => {
    const taskA = makeTask({ id: "A", status: "running", title: "A" });
    const facade = memoryFacade({ tasks: [taskA], workspaces: [makeWorkspace()] });
    const { frames, send } = sentFrames();
    const session = openSession(facade, send, new CreateIdempotency());
    await session.bootstrap();
    facade.publish({ type: "workspace_upsert", workspace: makeWorkspace({ name: "renamed" }) });
    facade.publish({
      type: "task_upsert",
      task: makeTask({ id: "A", status: "succeeded", title: "A" }),
    });
    await waitFor(() => frames.some((frame) => frame.type === "evt.task.done"));
    const done = frames.filter((frame) => frame.type === "evt.task.done");
    assert.equal(done.length, 1);
    assert.equal(done[0]?.payload.taskId, "A");
    session.close();
    assert.equal(facade.listeners.size, 0);
  });

  it("rejects live commands past the queue cap without starting another create", async () => {
    const facade = memoryFacade();
    const gate = defer<Awaited<ReturnType<MemoryFacade["create"]>>>();
    facade.createImpl = async (input) => {
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
    const { frames, send } = sentFrames();
    let overflows = 0;
    const session = new ConnectorSession({
      generation: 1,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {
        overflows += 1;
      },
      onFatal: () => {},
    });
    await session.bootstrap();
    session.handleCommand(createCmd({ idempotencyKey: "create-key-1" }));
    await waitFor(() => facade.creates === 1);
    for (let i = 0; i < RELAY_LIMITS.maxLiveCommands + 5; i += 1) {
      session.handleCommand(createCmd({ idempotencyKey: `flood-key-${i}` }));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(facade.creates, 1);
    assert.equal(overflows, 1);
    const rejected = frames.filter((frame) => frame.type === "err" && frame.payload.code === "rate_limited");
    assert.ok(rejected.length >= 1);
    assert.equal(rejected.every((frame) => frame.payload.message === "relay command queue is full"), true);
    gate.resolve(facade.tasks[0]!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(facade.creates, 1);
    session.close();
    assert.equal(facade.listeners.size, 0);
  });

  it("does not rate-limit or close when non-commands arrive on a full live queue", async () => {
    const facade = memoryFacade();
    const gate = defer<Awaited<ReturnType<MemoryFacade["create"]>>>();
    facade.createImpl = async (input) => {
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
    const { frames, send } = sentFrames();
    const logs: string[] = [];
    let overflows = 0;
    const session = new ConnectorSession({
      generation: 1,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {
        overflows += 1;
      },
      onFatal: () => {},
      log: (_level, message) => logs.push(message),
    });
    await session.bootstrap();
    session.handleCommand(createCmd({ idempotencyKey: "create-key-1" }));
    await waitFor(() => facade.creates === 1);
    for (let i = 0; i < RELAY_LIMITS.maxLiveCommands - 1; i += 1) {
      session.handleCommand(createCmd({ idempotencyKey: `flood-key-${i}` }));
    }
    const queued = session.queuedCommandCount();
    assert.equal(queued, RELAY_LIMITS.maxLiveCommands - 1);
    const before = frames.length;
    session.handleCommand(frame("err", { code: "bad_request", message: "nope", ref: "upstream" }, "relay-err-1"));
    session.handleCommand(frame("ack", { ref: "upstream", stage: "executed" }, "relay-ack-1"));
    session.handleCommand(frame("evt.snapshot", { boardId: "thinkbook" }, "relay-evt-1"));
    session.handleCommand(frame("evt.task", { boardId: "thinkbook", taskId: "t1" }, "relay-evt-2"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(overflows, 0);
    assert.equal(session.queuedCommandCount(), queued);
    assert.equal(frames.slice(before).some((item) => item.type === "err"), false);
    assert.equal(logs.some((line) => line.includes("rate_limited") || line.includes("unsupported command")), false);

    session.handleCommand(frame("cmd.create", {
      boardId: "thinkbook",
      idempotencyKey: "overflow-key-1",
      title: "Too many",
      prompt: "do it",
      agent: "pi",
      cwd: "/tmp/repo",
    }, "cmd-overflow"));
    assert.equal(overflows, 1);
    const rejected = frames.filter((item) => item.type === "err" && item.payload.code === "rate_limited");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.payload.ref, "cmd-overflow");
    gate.resolve(facade.tasks[0]!);
    await waitFor(() => session.queuedCommandCount() === 0);
    assert.equal(facade.creates, 1);
    session.close();
    assert.equal(facade.listeners.size, 0);
  });

  it("drops queued commands on close across generations without a second create", async () => {
    const facade = memoryFacade();
    const gate = defer<Awaited<ReturnType<MemoryFacade["create"]>>>();
    facade.createImpl = async (input) => {
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
    const idem = new CreateIdempotency();
    const sessions: ConnectorSession[] = [];
    const generations = 24;
    for (let generation = 0; generation < generations; generation += 1) {
      const { send } = sentFrames();
      const session = new ConnectorSession({
        generation: generation + 1,
        boardId: "thinkbook",
        facade,
        idempotency: idem,
        send,
        onOverflow: () => {},
        onFatal: () => {},
      });
      await session.bootstrap();
      session.handleCommand(createCmd({ idempotencyKey: "create-key-1" }));
      if (generation === 0) await waitFor(() => facade.creates === 1);
      for (let i = 0; i < RELAY_LIMITS.maxLiveCommands; i += 1) {
        session.handleCommand(createCmd({ idempotencyKey: `queued-${generation}-${i}-key` }));
      }
      assert.ok(session.queuedCommandCount() > 0);
      session.close();
      assert.equal(session.queuedCommandCount(), 0);
      sessions.push(session);
    }
    assert.equal(sessions.length, generations);
    assert.equal(sessions.reduce((total, session) => total + session.queuedCommandCount(), 0), 0);
    assert.equal(facade.creates, 1);
    gate.resolve(facade.tasks[0]!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(facade.creates, 1);
    assert.equal(sessions.reduce((total, session) => total + session.queuedCommandCount(), 0), 0);

    const { frames, send } = sentFrames();
    const again = new ConnectorSession({
      generation: generations + 1,
      boardId: "thinkbook",
      facade,
      idempotency: idem,
      send,
      onOverflow: () => {},
      onFatal: () => {},
    });
    await again.bootstrap();
    again.handleCommand(createCmd({ idempotencyKey: "create-key-1" }));
    await waitFor(() => frames.some((frame) => frame.type === "ack"));
    assert.equal(facade.creates, 1);
    assert.equal((frames.find((frame) => frame.type === "ack")?.payload.task as { id: string }).id, "shared");
    again.close();
    assert.equal(again.queuedCommandCount(), 0);
    assert.equal(sessions.reduce((total, session) => total + session.queuedCommandCount(), 0), 0);
  });

  it("demotes isGit when enrichment fails", async () => {
    const facade = memoryFacade({ workspaces: [makeWorkspace({ path: "/tmp/repo" })] });
    facade.gitEligibility = async () => {
      throw new Error("git failed");
    };
    const { frames, send } = sentFrames();
    const session = new ConnectorSession({
      generation: 1,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {},
      onFatal: () => {},
    });
    await session.bootstrap();
    const spaces = frames[0]?.payload.workspaces as Array<{ isGit: boolean }>;
    assert.equal(spaces[0]?.isGit, false);
    session.close();
  });

  it("acks create once for a repeated key and rejects a mismatched board", async () => {
    const facade = memoryFacade();
    const idem = new CreateIdempotency();
    const { frames, send } = sentFrames();
    const session = openSession(facade, send, idem);
    await session.bootstrap();
    session.handleCommand(createCmd({ useGitWorktree: true }));
    await waitFor(() => frames.some((frame) => frame.type === "ack"));
    assert.equal(facade.creates, 1);
    assert.equal(frames.find((frame) => frame.type === "ack")?.payload.stage, "executed");
    session.handleCommand(createCmd({ useGitWorktree: true }));
    await waitFor(() => frames.filter((frame) => frame.type === "ack").length === 2);
    assert.equal(facade.creates, 1);

    session.handleCommand(createCmd({ boardId: "other-board", idempotencyKey: "create-key-2" }));
    await waitFor(() => frames.some((frame) => frame.type === "err"));
    const err = frames.find((frame) => frame.type === "err");
    assert.equal(err?.payload.code, "forbidden");
    assert.equal(facade.creates, 1);
    session.close();
  });

  it("joins an in-flight create after the first session is closed", async () => {
    const facade = memoryFacade();
    const gate = defer<Awaited<ReturnType<MemoryFacade["create"]>>>();
    facade.createImpl = async (input) => {
      facade.creates += 1;
      const task = makeTask({
        id: "only",
        title: input.title,
        kind: input.kind,
        cwd: input.cwd,
        prompt: input.prompt,
        status: "queued",
      });
      facade.tasks.push(task);
      return gate.promise.then(() => task);
    };
    const idem = new CreateIdempotency();
    const first = sentFrames();
    const sessionA = openSession(facade, first.send, idem);
    await sessionA.bootstrap();
    sessionA.handleCommand(createCmd());
    await waitFor(() => facade.creates === 1);
    sessionA.close();

    const second = sentFrames();
    const sessionB = openSession(facade, second.send, idem);
    await sessionB.bootstrap();
    sessionB.handleCommand(createCmd());
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(facade.creates, 1);
    gate.resolve(facade.tasks[0]!);
    await waitFor(() => second.frames.some((frame) => frame.type === "ack"));
    const ack = second.frames.find((frame) => frame.type === "ack");
    assert.equal((ack?.payload.task as { id: string }).id, "only");
    assert.equal(first.frames.some((frame) => frame.type === "ack" && frame.payload.stage === "executed"), false);
    sessionB.close();
    assert.equal(facade.listeners.size, 0);
  });

  it("clears a failed create so a later retry can run", async () => {
    const facade = memoryFacade();
    let fail = true;
    facade.createImpl = async (input) => {
      facade.creates += 1;
      if (fail) throw new Error("not found");
      return makeTask({ id: "later", title: input.title, status: "queued" });
    };
    const { frames, send } = sentFrames();
    const session = openSession(facade, send, new CreateIdempotency());
    await session.bootstrap();
    session.handleCommand(createCmd());
    await waitFor(() => frames.some((frame) => frame.type === "err"));
    assert.equal(frames.find((frame) => frame.type === "err")?.payload.code, "task_not_found");
    fail = false;
    session.handleCommand(createCmd({ idempotencyKey: "create-key-1" }));
    await waitFor(() => frames.some((frame) => frame.type === "ack"));
    assert.equal(facade.creates, 2);
    session.close();
  });

  it("ignores inbound err, ack, and evt frames instead of failing them as unsupported commands", async () => {
    const facade = memoryFacade();
    const logs: string[] = [];
    const { frames, send } = sentFrames();
    const session = new ConnectorSession({
      generation: 1,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {},
      onFatal: () => {},
      log: (_level, message) => logs.push(message),
    });
    await session.bootstrap();
    session.handleCommand(frame("err", { code: "bad_request", message: "nope", ref: "upstream" }, "relay-err-1"));
    session.handleCommand(frame("ack", { ref: "upstream", stage: "executed" }, "relay-ack-1"));
    session.handleCommand(frame("evt.snapshot", { boardId: "thinkbook" }, "relay-evt-1"));
    session.handleCommand(frame("evt.task", { boardId: "thinkbook", taskId: "t1" }, "relay-evt-2"));
    session.handleCommand(createCmd());
    await waitFor(() => frames.some((item) => item.type === "ack" && item.payload.ref === "cmd-1"));
    assert.equal(frames.some((item) => item.type === "err"), false);
    assert.equal(logs.some((line) => line.includes("unsupported command")), false);
    assert.equal(facade.creates, 1);
    session.close();
  });

  it("puts payload.ref on command ack and err", async () => {
    const facade = memoryFacade({ tasks: [makeTask({ id: "t1", status: "running" })] });
    const { frames, send } = sentFrames();
    const session = openSession(facade, send, new CreateIdempotency());
    await session.bootstrap();

    session.handleCommand(createCmd());
    await waitFor(() => frames.some((item) => item.type === "ack" && item.payload.idempotencyKey === "create-key-1"));
    const createAck = frames.find((item) => item.type === "ack" && item.payload.idempotencyKey === "create-key-1");
    assert.equal(createAck?.payload.ref, "cmd-1");

    session.handleCommand(frame("cmd.stop", {
      boardId: "thinkbook",
      idempotencyKey: "stop-key-01",
      taskId: "t1",
    }, "cmd-stop-1"));
    await waitFor(() => frames.some((item) => item.type === "ack" && item.payload.idempotencyKey === "stop-key-01"));
    const stopAck = frames.find((item) => item.type === "ack" && item.payload.idempotencyKey === "stop-key-01");
    assert.equal(stopAck?.payload.ref, "cmd-stop-1");

    session.handleCommand(frame("cmd.continue", {
      boardId: "thinkbook",
      idempotencyKey: "continue-bad",
    }, "cmd-continue-bad"));
    await waitFor(() => frames.some((item) => item.type === "err" && item.payload.ref === "cmd-continue-bad"));
    const err = frames.find((item) => item.type === "err" && item.payload.ref === "cmd-continue-bad");
    assert.equal(err?.payload.code, "bad_request");
    assert.equal(err?.id, "cmd-continue-bad");
    session.close();
  });

  it("does not call create for a bad cwd or a non-boolean worktree flag", async () => {
    const facade = memoryFacade();
    const { frames, send } = sentFrames();
    const session = openSession(facade, send, new CreateIdempotency());
    await session.bootstrap();
    session.handleCommand(createCmd({ cwd: "relative" }));
    session.handleCommand(createCmd({ idempotencyKey: "create-key-9", useGitWorktree: "x" }));
    await waitFor(() => frames.filter((frame) => frame.type === "err").length >= 2);
    assert.equal(facade.creates, 0);
    assert.ok(frames.filter((frame) => frame.type === "err").every((frame) => frame.payload.code === "bad_request"));
    session.close();
  });

  it("files a task by workspaceId and round-trips workspace create and delete", async () => {
    const facade = memoryFacade({
      tasks: [makeTask({ id: "t1", workspaceId: "w1" })],
      workspaces: [makeWorkspace({ id: "w1", name: "repo", path: "/tmp/repo" })],
    });
    let seenWorkspace: string | undefined;
    facade.createImpl = async (input) => {
      facade.creates += 1;
      seenWorkspace = input.workspaceId;
      const task = makeTask({
        id: "created",
        title: input.title,
        workspaceId: input.workspaceId ?? "w1",
        cwd: input.cwd,
        status: "queued",
        summary: undefined,
      });
      facade.tasks.push(task);
      return task;
    };
    const { frames, send } = sentFrames();
    const idem = new CreateIdempotency();
    const session = openSession(facade, send, idem);
    await session.bootstrap();
    const firstTasks = frames[0]?.payload.tasks as Array<{ id: string; workspaceId?: string }>;
    assert.equal(firstTasks[0]?.workspaceId, "w1");

    session.handleCommand(createCmd({ workspaceId: "w1", idempotencyKey: "create-ws-task" }));
    await waitFor(() => frames.some((frame) => frame.type === "ack" && frame.payload.idempotencyKey === "create-ws-task"));
    assert.equal(seenWorkspace, "w1");
    const created = frames.find((frame) => frame.payload.idempotencyKey === "create-ws-task")?.payload.task as { workspaceId?: string };
    assert.equal(created.workspaceId, "w1");

    session.handleCommand(frame("cmd.workspace.create", {
      boardId: "thinkbook",
      idempotencyKey: "ws-create-key",
      name: " Other ",
      path: "/tmp/other",
    }, "ws-create-1"));
    await waitFor(() => frames.some((item) => item.type === "ack" && item.payload.idempotencyKey === "ws-create-key"));
    const wsAck = frames.find((item) => item.type === "ack" && item.payload.idempotencyKey === "ws-create-key");
    const workspace = wsAck?.payload.workspace as { id: string; name: string; path: string; isGit: boolean };
    assert.equal(workspace.name, "Other");
    assert.equal(workspace.path, "/tmp/other");
    assert.equal(workspace.isGit, true);
    assert.equal(facade.workspaces.length, 2);
    await waitFor(() => frames.filter((item) => item.type === "evt.snapshot").length >= 2);
    const names = (frames.filter((item) => item.type === "evt.snapshot").at(-1)?.payload.workspaces as Array<{ name: string }>).map((item) => item.name);
    assert.deepEqual(names, ["repo", "Other"]);

    session.handleCommand(frame("cmd.workspace.create", {
      boardId: "thinkbook",
      idempotencyKey: "ws-create-key",
      name: "Other",
      path: "/tmp/other",
    }, "ws-create-2"));
    await waitFor(() => frames.filter((item) => item.type === "ack" && item.payload.idempotencyKey === "ws-create-key").length === 2);
    assert.equal(facade.workspaces.length, 2);

    session.handleCommand(frame("cmd.workspace.delete", {
      boardId: "thinkbook",
      idempotencyKey: "ws-del-default",
      workspaceId: "w1",
    }, "ws-del-default"));
    await waitFor(() => frames.some((item) => item.type === "err" && item.id === "ws-del-default"));
    const blocked = frames.find((item) => item.id === "ws-del-default");
    assert.equal(blocked?.payload.code, "bad_request");
    assert.equal(blocked?.payload.message, "cannot delete the default workspace");

    const extraId = workspace.id;
    facade.tasks.push(makeTask({ id: "owned", workspaceId: extraId }));
    session.handleCommand(frame("cmd.workspace.delete", {
      boardId: "thinkbook",
      idempotencyKey: "ws-del-busy",
      workspaceId: extraId,
    }, "ws-del-busy"));
    await waitFor(() => frames.some((item) => item.type === "err" && item.id === "ws-del-busy"));
    assert.equal(
      frames.find((item) => item.id === "ws-del-busy")?.payload.message,
      "workspace still has tasks; move or delete them first",
    );
    facade.tasks.splice(facade.tasks.findIndex((task) => task.id === "owned"), 1);

    session.handleCommand(frame("cmd.workspace.delete", {
      boardId: "thinkbook",
      idempotencyKey: "ws-del-ok",
      workspaceId: extraId,
    }, "ws-del-ok"));
    await waitFor(() => frames.some((item) => item.type === "ack" && item.payload.idempotencyKey === "ws-del-ok"));
    assert.equal(frames.find((item) => item.payload.idempotencyKey === "ws-del-ok")?.payload.deleted, extraId);
    await waitFor(() => facade.workspaces.length === 1);
    assert.equal(facade.workspaces.some((item) => item.id === extraId), false);
    session.close();
  });

  it("signals overflow when the bus buffer fills during enrich", async () => {
    const facade = memoryFacade({
      tasks: [makeTask()],
      workspaces: [makeWorkspace()],
    });
    const gate = defer<{ ok: boolean }>();
    facade.gitEligibility = () => gate.promise;
    let overflows = 0;
    const { send } = sentFrames();
    const session = new ConnectorSession({
      generation: 1,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {
        overflows += 1;
      },
      onFatal: () => {},
    });
    const boot = session.bootstrap();
    for (let i = 0; i < RELAY_LIMITS.maxBusBuffer + 5; i += 1) {
      const ev: BoardEvent = {
        type: "task_log",
        taskId: "t1",
        line: `line ${i}`,
        at: "2026-10-31T00:00:00.000Z",
      };
      facade.publish(ev);
    }
    assert.equal(overflows, 1);
    gate.resolve({ ok: false });
    await assert.rejects(boot);
    session.close();
    assert.equal(facade.listeners.size, 0);
  });

  it("drops an archived task from the active snapshot and lists it on cmd.archive.list", async () => {
    const running = makeTask({ id: "live", status: "running", title: "Live" });
    const facade = memoryFacade({ tasks: [running] });
    const { frames, send } = sentFrames();
    const session = new ConnectorSession({
      generation: 3,
      boardId: "thinkbook",
      facade,
      idempotency: new CreateIdempotency(),
      send,
      onOverflow: () => {},
      onFatal: () => {},
    });
    await session.bootstrap();
    facade.publish({
      type: "task_upsert",
      task: { ...running, status: "archived", updatedAt: "2026-10-31T02:00:00.000Z" },
    });
    await waitFor(() => frames.filter((frame) => frame.type === "evt.snapshot").length >= 2);
    const last = frames.filter((frame) => frame.type === "evt.snapshot").at(-1);
    const rows = last?.payload.tasks as Array<{ id: string }>;
    assert.equal(rows.some((task) => task.id === "live"), false);
    assert.equal(frames.some((frame) => frame.type === "evt.task.done"), false);
    session.handleCommand(frame("cmd.archive.list", {
      boardId: "thinkbook",
      idempotencyKey: "archive-key-1",
      limit: 20,
    }, "arch-1"));
    await waitFor(() => frames.some((item) => item.type === "ack" && item.payload.ref === "arch-1"));
    const ack = frames.find((item) => item.payload.ref === "arch-1");
    const archive = ack?.payload.archive as { tasks: Array<{ id: string; status: string }> };
    assert.equal(archive.tasks[0]?.id, "live");
    assert.equal(archive.tasks[0]?.status, "archived");
    session.handleCommand(frame("cmd.detail", {
      boardId: "thinkbook",
      idempotencyKey: "detail-arch-1",
      taskId: "live",
    }, "det-arch"));
    await waitFor(() => frames.some((item) => item.payload.ref === "det-arch" && item.payload.stage === "executed"));
    const detail = frames.find((item) => item.payload.ref === "det-arch");
    assert.equal((detail?.payload.task as { status?: string }).status, "archived");
    assert.equal((detail?.payload.task as { detail?: string }).detail, "full");
    session.close();
  });
});

function openSession(facade: MemoryFacade, send: RelaySender, idempotency: CreateIdempotency): ConnectorSession {
  return new ConnectorSession({
    generation: 1,
    boardId: "thinkbook",
    facade,
    idempotency,
    send,
    onOverflow: () => {},
    onFatal: () => {},
  });
}

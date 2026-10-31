import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pageArchivedTasks } from "./archive.js";
import { makeTask } from "./harness.js";

describe("archive pages", () => {
  it("pages newest archived tasks and omits active ones", () => {
    const tasks = [
      makeTask({ id: "run", status: "running", updatedAt: "2026-10-31T03:00:00.000Z" }),
      makeTask({ id: "a", status: "archived", updatedAt: "2026-10-31T01:00:00.000Z" }),
      makeTask({ id: "c", status: "archived", updatedAt: "2026-10-31T02:00:00.000Z" }),
      makeTask({ id: "b", status: "archived", updatedAt: "2026-10-31T02:00:00.000Z" }),
    ];
    const first = pageArchivedTasks(tasks, undefined, 2);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.page.tasks.map((task) => task.id), ["b", "c"]);
    assert.equal(first.page.tasks.every((task) => task.status === "archived"), true);
    assert.ok(first.page.nextCursor);
    const second = pageArchivedTasks(tasks, first.page.nextCursor, 2);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.page.restarted, undefined);
    assert.deepEqual(second.page.tasks.map((task) => task.id), ["a"]);
    assert.equal(second.page.nextCursor, undefined);

    const moved = tasks.map((task) => task.id === "b"
      ? { ...task, updatedAt: "2026-10-31T00:00:05.000Z" }
      : task);
    const restarted = pageArchivedTasks(moved, first.page.nextCursor, 2);
    assert.equal(restarted.ok, true);
    if (!restarted.ok) return;
    assert.equal(restarted.page.restarted, true);
    assert.deepEqual(restarted.page.tasks.map((task) => task.id), ["c", "a"]);
    assert.equal(pageArchivedTasks(tasks, "nope", 2).ok, false);
    assert.equal(pageArchivedTasks(tasks, `${first.page.nextCursor}`, 2).ok, true);
    const revisionCursor = first.page.nextCursor ?? "";
    assert.match(revisionCursor, /:[a-f0-9]{8}$/);
    assert.equal(pageArchivedTasks(tasks, revisionCursor, 2).ok, true);
  });

  it("filters a workspace before the limit and binds the cursor to that scope", () => {
    const tasks = [
      makeTask({ id: "a2", status: "archived", workspaceId: "wa", updatedAt: "2026-10-31T03:00:00.000Z" }),
      makeTask({ id: "b1", status: "archived", workspaceId: "wb", updatedAt: "2026-10-31T02:00:00.000Z" }),
      makeTask({ id: "a1", status: "archived", workspaceId: "wa", updatedAt: "2026-10-31T01:00:00.000Z" }),
    ];
    const first = pageArchivedTasks(tasks, undefined, 1, "wa");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.page.tasks.map((task) => task.id), ["a2"]);
    assert.ok(first.page.nextCursor);
    const second = pageArchivedTasks(tasks, first.page.nextCursor, 1, "wa");
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.page.restarted, undefined);
    assert.deepEqual(second.page.tasks.map((task) => task.id), ["a1"]);

    const other = pageArchivedTasks(tasks, first.page.nextCursor, 1, "wb");
    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(other.page.restarted, true);
    assert.deepEqual(other.page.tasks.map((task) => task.id), ["b1"]);

    const empty = pageArchivedTasks(tasks, undefined, 20, "missing");
    assert.equal(empty.ok, true);
    if (!empty.ok) return;
    assert.deepEqual(empty.page.tasks, []);
    assert.equal(empty.page.nextCursor, undefined);

    const wide = pageArchivedTasks(tasks, undefined, 1);
    assert.equal(wide.ok, true);
    if (!wide.ok) return;
    assert.equal(wide.page.tasks[0]?.id, "a2");
    assert.equal(wide.page.tasks.some((task) => task.id === "b1"), false);
  });
});

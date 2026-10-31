import assert from "node:assert/strict";
import test from "node:test";
import { pageArchiveRows, type ArchiveRow } from "../src/archive.js";

function row(id: string, updatedAt: number): ArchiveRow {
  return { id, title: id, status: "archived", updatedAt };
}

test("archive cursor restarts when a row's updatedAt changes between pages", () => {
  const first = pageArchiveRows([row("a", 30), row("b", 20), row("c", 10)], undefined, 2);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.tasks.map((task) => task.id), ["a", "b"]);
  assert.ok(first.nextCursor?.includes(":"));

  const stable = pageArchiveRows([row("a", 30), row("b", 20), row("c", 10)], first.nextCursor, 2);
  assert.equal(stable.ok, true);
  if (!stable.ok) return;
  assert.equal(stable.restarted, undefined);
  assert.deepEqual(stable.tasks.map((task) => task.id), ["c"]);

  const moved = pageArchiveRows([row("a", 30), row("b", 5), row("c", 10)], first.nextCursor, 2);
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.restarted, true);
  assert.deepEqual(moved.tasks.map((task) => task.id), ["a", "c"]);
  assert.notDeepEqual(moved.tasks.map((task) => task.id), ["c", "b"]);
});

test("workspace filter is applied before the page and the cursor stays in that scope", () => {
  const rows = [
    { ...row("a2", 30), workspaceId: "wa" },
    { ...row("b1", 20), workspaceId: "wb" },
    { ...row("a1", 10), workspaceId: "wa" },
  ];
  const first = pageArchiveRows(rows, undefined, 1, "wa");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.tasks.map((task) => task.id), ["a2"]);
  const second = pageArchiveRows(rows, first.nextCursor, 1, "wa");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.deepEqual(second.tasks.map((task) => task.id), ["a1"]);
  const other = pageArchiveRows(rows, first.nextCursor, 1, "wb");
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.equal(other.restarted, true);
  assert.deepEqual(other.tasks.map((task) => task.id), ["b1"]);
});

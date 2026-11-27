import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { _resetCliPathOverridesForTests } from "../cliPaths.js";
import type { Task } from "../types.js";
import { claudeRunner } from "./claude.js";
import { codexRunner } from "./codex.js";
import { piRunner } from "./pi.js";

const fixtures = [
  { kind: "claude", runner: claudeRunner, event: (n: number) => ({ type: "result", uuid: `r${n}`, usage: { output_tokens: n } }) },
  { kind: "codex", runner: codexRunner, event: (n: number) => ({ type: "turn.completed", turn_id: `t${n}`, usage: { output_tokens: n } }) },
  { kind: "pi", runner: piRunner, event: (n: number) => ({ type: "message_end", message: { role: "assistant", responseId: `m${n}`, usage: { output: n } } }) },
] as const;

for (const { kind, runner, event } of fixtures) {
  it(`${kind}: stdout usage precedes event and terminal statuses; stderr and replays never count`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), "board-usage-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const cli = join(cwd, kind);
    const line = (n: number) => JSON.stringify(event(n));
    // A duplicate, an unterminated stdout tail, and a distinct valid event on stderr.
    writeFileSync(cli, `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(line(9))});\nprocess.stdout.write(${JSON.stringify(`${line(1)}\n${line(1)}\n${line(2)}`)});\n`, { mode: 0o755 });
    _resetCliPathOverridesForTests({ [kind]: cli });
    t.after(() => _resetCliPathOverridesForTests({}));
    const task = { id: "test", workspaceId: "ws", kind, prompt: "test", status: "queued", cwd } as Task;
    const order: string[] = [];
    let stderr = false;
    const handle = runner.start(task, {
      onUsage: u => order.push(`usage:${u.output}`),
      onStatus: patch => {
        if (patch.lastEvent === event(1).type) order.push("event");
        if (patch.endedAt) order.push(`end:${patch.status}`);
      },
      onLog: (value, source) => { if (source === "stderr" && value === line(9)) stderr = true; },
    });
    await handle.settled;
    assert.equal(stderr, true);
    assert.deepEqual(order, ["usage:1", "event", "event", "usage:2", "event", "end:succeeded"]);
  });
}

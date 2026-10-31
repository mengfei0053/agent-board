import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskStatus } from "./types.js";
import { spawnCollect } from "./spawnCollect.js";
import { spawnLogged } from "./runners/common.js";

describe("spawnCollect deadlines", () => {
  it("settles when the signal aborts", async () => {
    const ac = new AbortController();
    const pending = spawnCollect(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    ac.abort();
    const result = await pending;
    assert.equal(result.timedOut, true);
  });

  it("settles after a short timeout even if the child traps SIGTERM", async () => {
    const started = Date.now();
    const result = await spawnCollect(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { timeoutMs: 200 },
    );
    assert.ok(Date.now() - started < 3_000);
    assert.equal(result.timedOut, true);
  });
});

describe("spawnLogged protocol stream", () => {
  it("classifies stdout and still records stderr", async () => {
    const script = [
      "process.stderr.write(JSON.stringify({ type: 'result', result: 'from-err' }) + '\\n');",
      "process.stdout.write(JSON.stringify({ type: 'result', result: 'from-out' }) + '\\n');",
    ].join("");
    const classified: string[] = [];
    const logged: string[] = [];
    let status: TaskStatus = "queued";
    const handle = spawnLogged(
      process.execPath,
      ["-e", script],
      process.cwd(),
      {
        onStatus: (patch) => {
          if (patch.status) status = patch.status;
        },
        onLog: (line) => logged.push(line),
      },
      {
        cliKind: "pi",
        getStatus: () => status,
        classifyLine: (line) => classified.push(line),
      },
    );
    await handle.settled;
    assert.ok(classified.some((line) => line.includes("from-out")));
    assert.equal(classified.some((line) => line.includes("from-err")), false);
    assert.ok(logged.some((line) => line.includes("from-err")));
  });

  it("stopAndWait returns after the child exits", async () => {
    const handle = spawnLogged(
      process.execPath,
      ["-e", "setInterval(() => {}, 500)"],
      process.cwd(),
      { onStatus: () => {}, onLog: () => {} },
      { cliKind: "pi", getStatus: () => "running" },
    );
    const started = Date.now();
    await Promise.race([
      handle.stopAndWait?.(2_000) ?? Promise.resolve(),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("stopAndWait hung")), 4_000);
      }),
    ]);
    assert.ok(Date.now() - started < 4_000);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnLogged } from "./common.js";
import { isAgentSettledLine } from "./pi.js";
import type { RunnerHooks } from "./types.js";
import type { TaskStatus } from "../types.js";

function collect() {
  const statuses: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const hooks: RunnerHooks = {
    onStatus: (p) => statuses.push(p as Record<string, unknown>),
    onLog: (line) => logs.push(line),
  };
  return { hooks, statuses, logs };
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("condition not reached in time");
}

describe("isAgentSettledLine", () => {
  it("matches pi's settled event only", () => {
    assert.equal(isAgentSettledLine('{"type":"agent_settled","aborted":false}'), true);
    assert.equal(isAgentSettledLine('  {"type":"agent_settled"}  '), true);
    assert.equal(isAgentSettledLine('{"aborted":false,"type":"agent_settled"}'), true);
    assert.equal(isAgentSettledLine('{"type":"agent_start"}'), false);
    assert.equal(
      isAgentSettledLine('{"type":"tool_result","output":"{\\"type\\":\\"agent_settled\\"}"}'),
      false,
    );
    assert.equal(isAgentSettledLine("not json"), false);
  });
});

describe("settle watchdog", () => {
  it("finishes the run and reaps a child that settles but never exits", async () => {
    const { hooks, statuses, logs } = collect();
    let status: TaskStatus = "queued";
    // Prints the settle line, then holds the event loop open forever (as a
    // lingering handle in the real CLI does).
    const script =
      'console.log(JSON.stringify({type:"agent_settled",aborted:false}));' +
      "setInterval(()=>{},1000);";
    const handle = spawnLogged(process.execPath, ["-e", script], process.cwd(), {
      onStatus: (p) => {
        if (p.status) status = p.status;
        hooks.onStatus(p);
      },
      onLog: hooks.onLog,
    }, {
      cliKind: "pi",
      getStatus: () => status,
      settleLine: isAgentSettledLine,
      settleExitGraceMs: 150,
    });

    await waitFor(() => status === "succeeded");
    const settled = statuses.find((s) => s.lastEvent === "settle_exit_watchdog");
    assert.ok(settled, "watchdog must own the terminal status");
    assert.equal(settled.status, "succeeded");
    assert.equal(settled.exitCode, 0);
    assert.ok(logs.some((l) => l.includes('"settle_exit_watchdog"')));

    await waitFor(() => !isAlive(handle.pid));
    await handle.settled;
  });

  it("does not reap a run that keeps producing output after settling", async () => {
    const { hooks, statuses } = collect();
    let status: TaskStatus = "queued";
    const script =
      'console.log(JSON.stringify({type:"agent_settled"}));' +
      "let n=0;const t=setInterval(()=>{console.log(JSON.stringify({type:\"message_delta\",n:++n}));" +
      "if(n>8){clearInterval(t);process.exit(0);}},40);";
    spawnLogged(process.execPath, ["-e", script], process.cwd(), {
      onStatus: (p) => {
        if (p.status) status = p.status;
        hooks.onStatus(p);
      },
      onLog: hooks.onLog,
    }, {
      cliKind: "pi",
      getStatus: () => status,
      settleLine: isAgentSettledLine,
      settleExitGraceMs: 150,
    });

    await waitFor(() => status === "succeeded");
    assert.equal(
      statuses.some((s) => s.lastEvent === "settle_exit_watchdog"),
      false,
      "later output must disarm the watchdog",
    );
  });
});

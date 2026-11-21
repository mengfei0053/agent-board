import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyGrokBotSettings } from "../grokBot.js";
import type { Task } from "../types.js";
import { cliEnv, grokRunner, resolveBdkCommand } from "./grok.js";
import { runners } from "./index.js";

const id = "ses_0123456789abcdef01234567";
const binding = `grok-prod:weather:${id}`;
const secret = "PRIVATE-TEST-VALUE";
const task: Task = { id: "local1", title: "test", kind: "grok", prompt: "--url https://untrusted.invalid/; $(touch nope)",
  cwd: "/not-a-real-workspace", workspaceId: "ws", iteration: 1, status: "queued", createdAt: "", updatedAt: "" };

// All task commands terminate in this local fixture; only --version/--help use the real BDK.
const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), dir = __dirname, id = '${id}', mode = fs.readFileSync(dir+'/mode','utf8');
const print = obj => console.log(JSON.stringify(obj));
console.error('${secret}');
fs.appendFileSync(dir+'/calls', JSON.stringify({args,cwd:process.cwd(),auth:process.env.CURSOR_API_KEY==='${secret}',boardSecret:!!process.env.AGENT_BOARD_WEBHOOK_SECRET,customHost:!!process.env.CURSOR_API_BASE_URL})+'\\n');
if(args[0]==='--version') print({name:'@grok/agent-sdk',version:mode==='version'?'1.0.0':'0.7.2'});
else if(args[1]==='create') {
  if (mode==='pending' || mode==='denied' || mode==='noDefault') { print({error:'${secret}'}); process.exit(mode==='pending'?3:mode==='denied'?5:1); }
  if (mode==='malformed') { console.log('broken ${secret}'); process.exit(0); }
  fs.writeFileSync(dir+'/wake', args.find(s=>s.startsWith('--message=')).slice(10));
  print({sessionId:mode==='mismatch'?'ses_aaaaaaaaaaaaaaaaaaaaaaaa':id,deliveryId:'platform-123', continuationToken:'${secret}'});
} else if(args[1]==='get') {
  if (mode==='notFound') { print({error:'${secret}'}); process.exit(4); }
  const wake=fs.readFileSync(dir+'/wake','utf8');
  const event=(type,turnId,data)=>({type,turnId,data});
  const events=[event('message.received','turn_1',{text:'old'}),event('turn.completed','turn_1',{result:'${secret}'})];
  if(mode==='hang') setInterval(()=>{},30000);
  else if(mode==='big') process.stdout.write('x'.repeat(9*1024*1024));
  else {
    if(mode!=='noevents') events.push(event('message.received','turn_2',{text:wake,deliveryIds:['sdk-send-456']}),
      event('message.completed','turn_2',{text:mode==='sensitive'?'${secret}':'new answer'}),
      event('message.completed','turn_2',{text:'${secret} nested',parentCallId:'tool'}),event('action.result','turn_2',{output:'${secret}'}),
      event(mode==='failure'?'turn.failed':'turn.completed','turn_2',{result:'fallback',message:'${secret}'}),event('turn.completed','turn_3',{result:'wrong turn'}));
    print({sessionId:id,events:events.map((e,index)=>({...e,index}))});
  }
} else process.exit(2);`;

describe("Grok hosted runner (offline)", () => {
  let dir: string;
  let restore: NodeJS.ProcessEnv;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "board-test-bdk-"));
    restore = { ...process.env };
    const bin = join(dir, "fake.cjs");
    await writeFile(bin, script, { mode: 0o700 });
    await writeFile(join(dir, "calls"), "");
    // Do not pass the operator's credential files or config directory to the fixture.
    Object.assign(process.env, { AGENT_BOARD_BDK_BIN: bin, HOME: dir, XDG_CONFIG_HOME: dir, AGENT_SERVE_CONFIG_DIR: dir,
      CURSOR_API_KEY: secret, CURSOR_API_KEY_FILE: "", CURSOR_SERVICE_ACCOUNT_KEY: "", CURSOR_API_BASE_URL: "https://untrusted.invalid/", AGENT_BOARD_WEBHOOK_SECRET: secret });
    await mode("ok");
    applyGrokBotSettings({ enabled: true, slug: "weather" });
  });
  afterEach(async () => {
    for (const k of ["AGENT_BOARD_BDK_BIN", "HOME", "XDG_CONFIG_HOME", "AGENT_SERVE_CONFIG_DIR", "CURSOR_API_KEY", "CURSOR_API_KEY_FILE", "CURSOR_SERVICE_ACCOUNT_KEY", "CURSOR_API_BASE_URL", "AGENT_BOARD_WEBHOOK_SECRET", "NODE_USE_ENV_PROXY", "HTTPS_PROXY"]) {
      if (restore[k] === undefined) delete process.env[k]; else process.env[k] = restore[k];
    }
    applyGrokBotSettings();
    await rm(dir, { recursive: true, force: true });
  });
  function configure(teamId?: string) {
    const settings = { enabled: true, slug: "weather", teamId };
    applyGrokBotSettings(settings);
  }
  function mode(value: string) { return writeFile(join(dir, "mode"), value); }
  async function calls(): Promise<{ args: string[]; cwd: string; auth: boolean; boardSecret: boolean; customHost: boolean }[]> {
    const lines = (await readFile(join(dir, "calls"), "utf8")).trim();
    return lines ? lines.split("\n").map(line => JSON.parse(line)) : [];
  }
  function start(patch: Partial<Task> = {}, continuePrompt?: string, afterStatus?: (p: Partial<Task>) => void) {
    const updates: Partial<Task>[] = [], logs: string[] = [];
    const handle = grokRunner.start({ ...task, ...patch }, {
      onLog: line => logs.push(line), onStatus: p => { updates.push(p); afterStatus?.(p); },
    }, { continuePrompt });
    return { handle, updates, logs };
  }
  it("uses a service proxy only when Node environment proxy support is explicitly enabled", () => {
    process.env.HTTPS_PROXY = "http://localhost:8900";
    delete process.env.NODE_USE_ENV_PROXY;
    assert.equal(cliEnv().HTTPS_PROXY, undefined);
    process.env.NODE_USE_ENV_PROXY = "1";
    assert.equal(cliEnv().HTTPS_PROXY, process.env.HTTPS_PROXY);
    assert.equal(cliEnv().NODE_USE_ENV_PROXY, "1");
    assert.equal(cliEnv().CURSOR_API_BASE_URL, undefined);
    assert.equal(cliEnv().AGENT_BOARD_WEBHOOK_SECRET, undefined);
  });
  it("resolves the bundled CLI outside the task cwd without a global bdk", () => {
    delete process.env.AGENT_BOARD_BDK_BIN;
    const [node, ...args] = resolveBdkCommand();
    assert.equal(node, process.execPath);
    const inspect = (...flags: string[]) => execFileSync(node, [...args, ...flags], {
      cwd: dir, env: { HOME: dir, PATH: "", CI: "1", AGENT_SERVE_NO_UPDATE_CHECK: "1" }, encoding: "utf8",
    });
    assert.equal(JSON.parse(inspect("--version", "--json")).version, "0.7.2");
    for (const command of ["create", "get"]) assert.match(inspect("session", command, "--help"), /--team <id>/);
    assert.throws(() => resolveBdkCommand("./bdk"), /absolute/);
  });
  it("uses an installed noninteractive CLI, fixed prod slug, one literal prompt; publishes only parent reply", async () => {
    assert.equal(runners.grok, grokRunner);
    const { handle, updates, logs } = start();
    await handle.settled;
    assert.equal(updates.at(-1)?.status, "succeeded");
    assert.equal(updates.at(-1)?.output, "new answer");
    assert.equal(updates.at(-1)?.outputs?.[0].iteration, 1);
    assert.ok(updates.some(p => p.sessionId === binding));
    assert.equal(JSON.stringify(updates).includes(secret), false);
    assert.deepEqual(logs, []);
    const [version, create, get] = await calls();
    assert.deepEqual(version.args, ["--version", "--json"]);
    assert.deepEqual(create.args, ["session", "create", "--prod", "--slug", "weather", create.args[5], "--wait", "--json"]);
    assert.ok(create.args[5].startsWith("--message=[Agent Board request:"));
    assert.ok(create.args[5].endsWith("\n" + task.prompt));
    assert.equal(create.cwd, "/"); assert.ok(create.auth); assert.ok(!create.boardSecret && !create.customHost);
    assert.deepEqual(get.args, ["session", "get", id, "--prod", "--slug", "weather", "--view", "events", "--json"]);
  });
  it("fresh start ignores an old binding; it never sends --session", async () => {
    const { handle, updates } = start({ iteration: 3, sessionId: `grok-prod:old-bot:${id}` });
    await handle.settled;
    const create = (await calls())[1].args;
    assert.ok(!create.includes("--session") && !create.includes(id) && !create.includes("old-bot"));
    assert.equal(updates.at(-1)?.status, "succeeded");
    assert.ok(updates.some(p => p.sessionId === binding));
  });
  it("continues only the bound deployment/session and retains earlier output", async () => {
    const { handle, updates } = start({ iteration: 2, sessionId: binding, outputs: [{ iteration: 1, text: "old answer" }] }, "follow up");
    await handle.settled;
    const create = (await calls())[1].args;
    assert.deepEqual(create.slice(3, 7), ["--slug", "weather", "--session", id]);
    assert.ok(create[7].endsWith("\nfollow up"));
    assert.deepEqual(updates.at(-1)?.outputs?.map(o => o.text), ["old answer", "new answer"]);
  });
  it("pins create, observation and continue to the explicitly configured team", async () => {
    const bound = `grok-prod:42:weather:${id}`;
    const target = ["--prod", "--slug", "weather", "--team", "42"];
    for (const followup of [false, true]) {
      configure("42");
      const before = (await calls()).length;
      const { handle, updates } = start({ sessionId: followup ? bound : binding }, followup ? "next" : undefined, p => {
        if (p.lastEvent === "grok_observing") configure("99"); // Don't redirect an accepted wake's observer.
      });
      await handle.settled;
      assert.equal(updates.at(-1)?.status, "succeeded");
      assert.ok(updates.some(p => p.sessionId === bound));
      const [, create, get] = (await calls()).slice(before);
      const message = create.args.find(arg => arg.startsWith("--message="));
      assert.ok(message);
      assert.deepEqual(create.args, ["session", "create", ...target, ...(followup ? ["--session", id] : []), message, "--wait", "--json"]);
      assert.deepEqual(get.args, ["session", "get", id, ...target, "--view", "events", "--json"]);
    }
  });
  it("never sends an existing session across teams or between automatic and explicit selection", async () => {
    const bound = `grok-prod:42:weather:${id}`;
    for (const [team, sessionId] of [["43", bound], [undefined, bound], ["42", binding], ["42", `grok-prod:42:other:${id}`]] as const) {
      configure(team);
      const r = start({ sessionId }, "next"); await r.handle.settled;
      assert.match(r.updates.at(-1)?.error ?? "", /restore the original Grok team.*No message sent/);
    }
    assert.deepEqual(await calls(), []);
    configure("42");
    const r = start({ sessionId: bound }, "next");
    configure("43"); // Change settings while the read-only version probe is in flight.
    await r.handle.settled;
    assert.match(r.updates.at(-1)?.error ?? "", /No message sent/);
    assert.deepEqual((await calls()).map(c => c.args), [["--version", "--json"]]);
  });
  it("rejects noncanonical or unsafe team IDs instead of using parseInt or automatic selection", async () => {
    for (const invalid of ["", "0", "-1", "01", "1.1", "1:2", "42abc", "9007199254740993", secret]) {
      configure(invalid);
      const r = start(); await r.handle.settled;
      assert.match(r.updates.at(-1)?.error ?? "", /positive decimal Team ID/);
      assert.ok(!JSON.stringify([...r.updates, ...r.logs]).includes(secret));
    }
    assert.deepEqual(await calls(), []);
  });
  it("refuses missing, foreign, malformed, disabled or changed bindings before invoking any CLI", async () => {
    for (const sessionId of [undefined, id, `grok-prod:other:${id}`, `grok-prod:weather:bad`, binding+":extra"]) {
      const r = start({ sessionId, iteration: 2 }, "next"); await r.handle.settled;
      assert.equal(r.updates.at(-1)?.status, "failed");
    }
    applyGrokBotSettings({ enabled: false, slug: "weather" });
    const r = start(); await r.handle.settled;
    assert.equal(r.updates.at(-1)?.status, "failed"); assert.deepEqual(await calls(), []);
  });
  it("fails closed on incompatible CLI, allocation/auth/parse failure, wrong session, remote failure, secret reply and oversized snapshot", async () => {
    for (const failure of ["version", "pending", "noDefault", "denied", "notFound", "malformed", "mismatch", "failure", "sensitive", "big"]) {
      await mode(failure);
      const before = (await calls()).length;
      const { handle, updates, logs } = start({ sessionId: binding, iteration: 2 }, "next");
      await handle.settled;
      assert.equal(updates.at(-1)?.status, "failed", failure);
      assert.equal(updates.at(-1)?.output, undefined);
      if (failure !== "version") assert.match(updates.at(-1)?.error ?? "", /Remote work may still be running/);
      if (["noDefault", "denied", "notFound"].includes(failure)) assert.match(updates.at(-1)?.error ?? "", /Team ID in Grok Bot settings/);
      assert.ok(!JSON.stringify([...updates, ...logs]).includes(secret));
      assert.equal((await calls()).slice(before).filter(c => c.args[1] === "create").length, failure === "version" ? 0 : 1);
    }
  });
  it("acceptance/old completion alone cannot succeed; stop detaches even while a CLI is hung", async () => {
    for (const scenario of ["noevents", "hang"]) {
      await mode(scenario);
      const before = (await calls()).length;
      const { handle, updates } = start();
      const deadline = Date.now() + 5000;
      try {
        while ((await calls()).length < before + 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
        assert.equal((await calls())[before + 2]?.args[1], "get");
        await new Promise(r => setTimeout(r, 100));
        assert.ok(!updates.some(p => p.status === "succeeded"));
      } finally { await handle.stopAndWait!(); }
      assert.equal(updates.at(-1)?.status, "stopped");
      assert.ok(!(await calls()).some(c => c.args.includes("cancel-runs")));
    }
  });
});

import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyGrokBotSettings } from "../grokBot.js";
import type { Task } from "../types.js";
import { grokRunner } from "./grok.js";
import { runners } from "./index.js";

const id = "ses_0123456789abcdef01234567";
const binding = `grok-prod:weather:${id}`;
const secret = "PRIVATE-TEST-VALUE";
const task: Task = { id: "local1", title: "test", kind: "grok", prompt: "--url https://untrusted.invalid/; $(touch nope)",
  cwd: "/not-a-real-workspace", workspaceId: "ws", iteration: 1, status: "queued", createdAt: "", updatedAt: "" };

// Real subprocess, but every command terminates here. No network or installed BDK.
const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), dir = __dirname, id = '${id}', mode = fs.readFileSync(dir+'/mode','utf8');
const print = obj => console.log(JSON.stringify(obj));
console.error('${secret}');
fs.appendFileSync(dir+'/calls', JSON.stringify({args,cwd:process.cwd(),auth:process.env.CURSOR_API_KEY==='${secret}',boardSecret:!!process.env.AGENT_BOARD_WEBHOOK_SECRET,customHost:!!process.env.CURSOR_API_BASE_URL})+'\\n');
if(args[0]==='--version') print({name:'@grok/agent-sdk',version:mode==='version'?'1.0.0':'0.7.2'});
else if(args[1]==='create') {
  if (mode==='pending' || mode==='denied') { print({error:'${secret}'}); process.exit(mode==='pending'?3:5); }
  if (mode==='malformed') { console.log('broken ${secret}'); process.exit(0); }
  fs.writeFileSync(dir+'/wake', args.find(s=>s.startsWith('--message=')).slice(10));
  print({sessionId:mode==='mismatch'?'ses_aaaaaaaaaaaaaaaaaaaaaaaa':id,deliveryId:'platform-123', continuationToken:'${secret}'});
} else if(args[1]==='get') {
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
    for (const k of ["AGENT_BOARD_BDK_BIN", "HOME", "XDG_CONFIG_HOME", "AGENT_SERVE_CONFIG_DIR", "CURSOR_API_KEY", "CURSOR_API_KEY_FILE", "CURSOR_SERVICE_ACCOUNT_KEY", "CURSOR_API_BASE_URL", "AGENT_BOARD_WEBHOOK_SECRET"]) {
      if (restore[k] === undefined) delete process.env[k]; else process.env[k] = restore[k];
    }
    applyGrokBotSettings();
    await rm(dir, { recursive: true, force: true });
  });
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
    for (const failure of ["version", "pending", "denied", "malformed", "mismatch", "failure", "sensitive", "big"]) {
      await mode(failure);
      const before = (await calls()).length;
      const { handle, updates, logs } = start({ sessionId: binding, iteration: 2 }, "next");
      await handle.settled;
      assert.equal(updates.at(-1)?.status, "failed", failure);
      assert.equal(updates.at(-1)?.output, undefined);
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

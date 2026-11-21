import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { grokWebAuth as auth } from "./grokWebAuth.js";

const link = `https://cursor.com/loginDeepControl?challenge=${"A".repeat(43)}&uuid=12345678-abcd-4abc-8abc-123456789012&mode=login&redirectTarget=cli`;
const secret = "PRIVATE_FIXTURE_SECRET";
const overrideKeys = ["CURSOR_API_KEY", "CURSOR_API_KEY_FILE", "CURSOR_SERVICE_ACCOUNT_KEY"];
const failed = { state: "failed", message: "BDK login failed. Please retry." };
const script = `#!${process.execPath}
const fs = require('node:fs');
const file = name => __dirname + '/' + name;
const mode = fs.readFileSync(file('mode'), 'utf8');
const args = process.argv.slice(2);
fs.appendFileSync(file('calls'), JSON.stringify(args) + '\\n');
console.error('${secret}');
if (process.cwd() !== require('node:path').parse(process.cwd()).root || process.env.CURSOR_WEBSITE_URL || process.env.AGENT_BOARD_WEBHOOK_SECRET || process.env.HOME !== __dirname) process.exit(9);
if (args[0] === 'login' && args.length === 1) {
  console.log('${secret}');
  if (mode === 'huge') process.stdout.write('x'.repeat(256*1024));
  else if (mode === 'invalid') process.stderr.write(fs.readFileSync(file('bad')));
  else if (mode === 'hold') {
    process.stderr.write('  ' + '${link}'.slice(0, 64));
    setTimeout(() => process.stderr.write('${link}'.slice(64) + '\\r\\n'), 20);
    const timer = setInterval(() => { if(fs.existsSync(file('finish'))) clearInterval(timer); }, 10);
  } else if (mode === 'exit1') { console.error('  ${link}'); process.exitCode = 1; }
} else if (args.slice(0,3).join(' ') === 'deployment list --json') {
  if (mode === 'bad-json') console.log('${secret}');
  else if (mode === 'shape') console.log('[]');
  else if (mode === 'exit1') process.exitCode = 1;
  else if (mode === 'huge') process.stderr.write('x'.repeat(300*1024));
  else if (mode === 'repeat' || !args.includes('--page-token=page2')) console.log(JSON.stringify({ items:[{slug:'alpha',owner:'${secret}'},{slug:'alpha'},{slug:'bad slug'}, {slug:'a-'} ,null, {slug:123}, {slug:'x'.repeat(64)}],nextPageToken:'page2'}));
  else console.log(JSON.stringify({items:[{slug:'beta-1'}],nextPageToken:null}));
} else process.exitCode = 2;`;

const realTimeout = setTimeout; // Poll real subprocesses even when the login deadline is mocked.
async function waitFor(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > end) assert.fail("mock CLI did not reach expected state");
    await new Promise<void>(resolve => realTimeout(resolve, 10));
  }
}

describe("Grok Web auth (offline BDK)", () => {
  let dir: string, restore: NodeJS.ProcessEnv;
  const mode = (value: string) => writeFile(join(dir, "mode"), value);
  const calls = () => readFile(join(dir, "calls"), "utf8");
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "board-bdk-login-"));
    restore = { ...process.env };
    for (const key of overrideKeys) delete process.env[key];
    const bin = join(dir, "fake.cjs");
    Object.assign(process.env, { HOME: dir, USERPROFILE: dir, AGENT_SERVE_CONFIG_DIR: dir, XDG_CONFIG_HOME: dir,
      AGENT_BOARD_BDK_BIN: bin, CURSOR_WEBSITE_URL: "https://invalid.example", AGENT_BOARD_WEBHOOK_SECRET: secret });
    await writeFile(bin, script, { mode: 0o700 });
    await writeFile(join(dir, "calls"), "");
    await mode("hold");
  });
  afterEach(async () => {
    await writeFile(join(dir, "finish"), "");
    if (auth.status().state === "pending") await waitFor(() => auth.status().state !== "pending");
    process.env = restore;
    await rm(dir, { recursive: true, force: true });
  });

  it("starts once, publishes only the complete PKCE URL and discards it on success", async () => {
    assert.deepEqual(auth.status(), { state: "idle" });
    assert.deepEqual(auth.start(), { state: "pending" });
    assert.deepEqual(auth.start(), { state: "pending" });
    await waitFor(() => auth.status().loginUrl !== undefined);
    assert.deepEqual(auth.start(), { state: "pending", loginUrl: link });
    auth.status().loginUrl = "mutated";
    assert.equal(auth.status().loginUrl, link);
    assert.equal(await calls(), '["login"]\n');
    await writeFile(join(dir, "finish"), "");
    await waitFor(() => auth.status().state !== "pending");
    assert.deepEqual(auth.status(), { state: "success" });
  });

  it("rejects lookalikes, non-PKCE values, extra params, fragments and unterminated links even on exit 0", async () => {
    const bad = [link.replace("cursor.com", "evil@cursor.com"), link.replace("cursor.com", "cursor.com.invalid"), link.replace("https:", "http:"),
      link.replace("/login", "/else/login"), link.replace("challenge=AAA", "challenge=+AA"), link.replace("4abc", "zzzz"),
      link.replace("mode=login", "mode=signup"), link.replace("Target=cli", "Target=web"), link + "&secret=" + secret,
      link + "&uuid=x", link + "#" + secret, "not-a-link: " + link, link];
    await mode("invalid");
    await writeFile(join(dir, "bad"), bad.join("\n"));
    auth.start();
    await waitFor(() => auth.status().state !== "pending");
    assert.deepEqual(auth.status(), failed);
  });

  it("does not launch for credential overrides or claim success if an override appears during login", async () => {
    for (const key of overrideKeys) {
      process.env[key] = secret;
      assert.deepEqual(auth.start(), { state: "failed", message: "Environment credentials take precedence. Remove them before using browser login." });
      delete process.env[key];
    }
    assert.equal(await calls(), "");
    auth.start();
    await waitFor(() => !!auth.status().loginUrl);
    process.env.CURSOR_API_KEY = secret;
    await writeFile(join(dir, "finish"), "");
    await waitFor(() => auth.status().state !== "pending");
    assert.equal(auth.status().state, "failed");
    assert.equal(auth.status().loginUrl, undefined);
    assert.ok(!JSON.stringify(auth.status()).includes(secret));
  });

  it("fails closed on spawn errors, bad exit or excessive output", async () => {
    for (const value of ["exit1", "huge", "missing"]) {
      await mode(value);
      if (value === "missing") process.env.AGENT_BOARD_BDK_BIN = join(dir, "missing");
      await waitFor(() => auth.start().state === "pending");
      await waitFor(() => auth.status().state !== "pending");
      assert.deepEqual(auth.status(), failed);
    }
    process.env.AGENT_BOARD_BDK_BIN = "relative";
    assert.deepEqual(auth.start(), failed);
  });

  it("kills the pending CLI at its deadline and removes the link", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    auth.start();
    await waitFor(() => !!auth.status().loginUrl);
    assert.equal(auth.status().loginUrl, link);
    t.mock.timers.tick(5 * 60_000);
    assert.deepEqual(auth.status(), { state: "failed", message: "BDK login timed out. Please retry." });
    t.mock.timers.reset();
    await mode("exit1");
    await waitFor(() => auth.start().state === "pending");
    await waitFor(() => auth.status().state === "failed");
    assert.deepEqual(auth.status(), failed);
  });

  it("coalesces deployment reads, filters only valid slugs and follows bounded pagination", async () => {
    process.env.CURSOR_API_KEY = secret; // Allowed for read-only listing.
    const [a, b] = await Promise.all([auth.deployments(), auth.deployments()]);
    assert.deepEqual(a, ["alpha", "beta-1"]);
    assert.deepEqual(b, a);
    assert.equal((await calls()).trim().split("\n").length, 2);
  });

  it("returns only a fixed list error for malformed output, bad exit, loops, overflows and spawn failure", async () => {
    for (const value of ["bad-json", "shape", "exit1", "repeat", "huge", "missing"]) {
      await mode(value);
      if (value === "missing") process.env.AGENT_BOARD_BDK_BIN = join(dir, "missing");
      await assert.rejects(auth.deployments(), { name: "Error", message: "Cannot list BDK deployments." });
    }
  });
});

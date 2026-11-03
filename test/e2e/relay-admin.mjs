// Real relay + browser; no production environment, database, board or phone is used.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { startServer } from '../../relay/dist/server.js';

const adminToken = 'admin-browser-test-token';
const boardToken = 'board-browser-test-token';
const server = await startServer({ adminToken, boardToken, log: () => {} });
let browser;
const sockets = [];

async function connect(type, payload) {
  const socket = new WebSocket(server.wsUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket response timed out')), 3000);
    socket.once('message', (raw) => { clearTimeout(timer); resolve(JSON.parse(raw.toString())); });
  });
  socket.send(JSON.stringify({ v: 1, id: `test-${sockets.length}`, type, ts: Date.now(), payload }));
  assert.equal((await reply).type, 'ack');
  return socket;
}

async function post(path, body, admin = false) {
  const response = await fetch(server.httpUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${adminToken}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

try {
  await connect('board.register', { boardId: 'thinkbook-main', token: boardToken, label: '<img src=x onerror=alert(1)>' });
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(server.httpUrl + '/admin', { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('.topbar-actions a', (element) => element.getAttribute('href')), '/docs/');
  assert.equal(await page.$eval('.topbar-actions a', (element) => element.textContent), '文档站');
  await page.type('#admin-token', 'wrong-token');
  await page.click('#login-form button');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('令牌无效'));
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);

  await page.type('#admin-token', adminToken);
  await page.click('#login-form button');
  await page.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await page.$eval('#boards-count', (element) => element.textContent), '1');
  assert.match(await page.$eval('#boards', (element) => element.textContent), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.$('#boards img'), null);
  assert.equal(await page.$eval('#admin-token', (element) => element.value), '');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, '']);

  // The row shortcut fills the scoped pairing form, then we exercise the real API.
  await page.click('#boards button.link');
  assert.equal(await page.$eval('#pair-boards', (element) => element.value), 'thinkbook-main');
  await page.click('#pair-form button');
  await page.waitForFunction(() => document.querySelector('#result-secret').value.startsWith('pc_'));
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  const pairCode = await page.$eval('#result-secret', (element) => element.value);
  const paired = await post('/auth/pair', { pairCode, deviceName: '<svg onload=alert(1)>' });
  await connect('client.hello', { token: paired.deviceToken });
  await page.click('#refresh');
  await page.waitForFunction(() => document.querySelector('#phones-count').textContent === '1');
  assert.equal(await page.$eval('#devices-count', (element) => element.textContent), '1');
  assert.equal(await page.$('#devices svg'), null);

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.click('#devices button.danger');
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(await page.$eval('#devices-count', (element) => element.textContent), '1');
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#devices button.danger');
  await page.waitForFunction(() => document.querySelector('#devices-count').textContent === '0');

  // Invalid IDs fail locally and do not send a destructive request.
  await page.type('#issue-boards', 'bad/id');
  await page.click('#issue-form button');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('有效看板 ID'));
  await page.$eval('#issue-boards', (element) => { element.value = 'thinkbook-main'; });
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#issue-form button');
  await page.waitForFunction(() => document.querySelector('#result-secret').value.startsWith('bt_'));
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  const issuedToken = await page.$eval('#result-secret', (element) => element.value);
  assert.equal(await page.$eval('#boards-count', (element) => element.textContent), '0');
  await connect('board.register', { boardId: 'thinkbook-main', token: issuedToken, label: 'ThinkBook' });
  await page.click('#refresh');
  await page.waitForFunction(() => document.querySelector('#boards-count').textContent === '1');

  await page.screenshot({ path: '/tmp/agent-board-relay-admin-desktop.png', fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/tmp/agent-board-relay-admin-mobile.png', fullPage: true });

  // Revoke a board using the existing API, with confirmation and immediate disconnect.
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#boards button.danger');
  await page.waitForFunction(() => document.querySelector('#boards').textContent.includes('已撤销'));
  assert.equal(await page.$eval('#boards-count', (element) => element.textContent), '0');
  assert.equal(await page.$eval('#result-secret', (element) => element.value), '');

  // Failed refresh is visible rather than silently showing stale state as fresh.
  await page.setOfflineMode(true);
  await page.click('#refresh');
  await page.waitForFunction(() => document.querySelector('#notice').classList.contains('error'));
  await page.setOfflineMode(false);
  await page.click('#logout');
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);
  assert.equal(await page.$eval('#result-secret', (element) => element.value), '');
  await page.type('#admin-token', adminToken);
  await page.click('#login-form button');
  await page.waitForSelector('#dashboard:not([hidden])');
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
  assert.deepEqual(errors, []);
  console.log('PASS relay admin browser: login/reject, live status, pairing, device revoke/cancel, board rotation/revoke, XSS escaping, offline errors, logout/reload, responsive layout, no storage, no runtime errors');
} finally {
  for (const socket of sockets) socket.terminate();
  await browser?.close();
  await server.close();
}

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

async function post(path, body, token) {
  const response = await fetch(server.httpUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}

// Hold one response after the request starts, so races do not depend on network timing.
async function holdLogResponse(page) {
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (path, init) => {
      if (!String(path).startsWith('/api/admin/device-logs?')) return fetch(path, init);
      window.fetch = fetch;
      return new Promise(resolve => {
        window.releaseLogResponse = (status, entries) => resolve(Response.json({ entries, nextCursor: null }, { status }));
      });
    };
  });
  await page.click('#log-filters button');
  await page.waitForFunction(() => typeof window.releaseLogResponse === 'function');
}

async function releaseLogResponse(page, status, entries = []) {
  await page.evaluate(async (status, entries) => {
    window.releaseLogResponse(status, entries);
    delete window.releaseLogResponse;
    await new Promise(requestAnimationFrame);
  }, status, entries);
}

try {
  await connect('board.register', { boardId: 'thinkbook-main', token: boardToken, label: '<img src=x onerror=alert(1)>' });
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  const logRequests = [];
  page.on('request', req => {
    const url = new URL(req.url());
    if (url.pathname === '/api/admin/device-logs') logRequests.push({
      query: Object.fromEntries(url.searchParams), method: req.method(), auth: req.headers().authorization,
    });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 1100 });
  await page.goto(server.httpUrl + '/admin', { waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('.topbar-actions a', (element) => element.getAttribute('href')), '/docs/');
  assert.equal(await page.$eval('.topbar-actions a', (element) => element.textContent), '文档站');
  await page.type('#admin-token', 'wrong-token');
  await page.click('#login-form button');
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('令牌无效'));
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);

  assert.equal(logRequests.length, 0, 'no logs before successful admin login');
  await page.type('#admin-token', adminToken);
  await page.click('#login-form button');
  await page.waitForSelector('#dashboard:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#log-status').textContent.includes('暂无'));
  assert.equal(await page.$eval('#boards-count', (element) => element.textContent), '1');
  assert.match(await page.$eval('#boards', (element) => element.textContent), /<img src=x onerror=alert\(1\)>/);
  assert.equal(await page.$('#boards img'), null);
  assert.equal(await page.$eval('#admin-token', (element) => element.value), '');
  // The token lives in this tab's sessionStorage only: never localStorage or cookies.
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 1, '']);

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
  assert.match(await page.$eval('#devices', el => el.textContent), /长期有效，直至撤销/);

  const labels = {
    info: { app_started: '应用已启动', board_online: '看板已上线', sync_waiting: '等待同步', sync_recovered: '同步已恢复',
      reconnecting: '正在重新连接', lookup_result: '查询结果' },
    error: { command_failed: '命令失败', board_offline: '看板已离线', board_unavailable: '看板不可用', network_failed: '网络请求失败',
      protocol_invalid: '协议无效', pair_failed: '配对失败', storage_failed: '存储失败', attachment_failed: '附件处理失败',
      notification_failed: '通知失败', app_exit_abnormal: '应用异常退出' },
  };
  const entries = Array.from({ length: 40 }, (_, i) => {
    const level = i % 2 ? 'error' : 'info';
    const events = Object.keys(labels[level]);
    const event = events[Math.floor(i / 2) % events.length];
    return { id: crypto.randomUUID(), ts: Date.now() + i, level, event,
      ...(event === 'lookup_result' && { op: 'lookup', reason: 'executed', count: 65535 }),
      ...(event === 'notification_failed' && { reason: 'permission' }) };
  });
  await post('/api/device/logs', { entries }, paired.deviceToken);
  const refreshLogs = () => page.click('#log-filters button');
  const waitRows = count => page.waitForFunction(n => document.querySelector('#device-logs').rows.length === n &&
    !document.querySelector('#log-status').textContent.includes('正在'), {}, count);
  const shownDetails = () => page.$$eval('#device-logs tr', rows => rows.map(row => Array.from(row.cells).slice(4).map(td => td.textContent)));
  const details = e => [labels[e.level][e.event], e.op ? '查询命令结果' : '—',
    ({ executed: '已执行', permission: '权限不足' })[e.reason] ?? '—', String(e.count ?? 1)];
  await page.type('#log-device', paired.deviceId);
  const [firstPage] = await Promise.all([
    page.waitForResponse(res => new URL(res.url()).pathname === '/api/admin/device-logs'), refreshLogs(),
  ]);
  const { nextCursor } = await firstPage.json();
  assert.equal(typeof nextCursor, 'string');
  await page.waitForSelector('#log-more:not([hidden])');
  const query = logRequests.at(-1).query;
  assert.deepEqual(query, { deviceId: paired.deviceId, limit: query.limit });
  const pageSize = Number(query.limit);
  assert.ok(pageSize > 0 && pageSize < entries.length);
  await waitRows(pageSize);
  await page.click('#log-more');
  await waitRows(40);
  assert.deepEqual(logRequests.at(-1).query, { ...query, before: nextCursor });
  const newest = entries.toReversed();
  assert.deepEqual(await shownDetails(), newest.map(details));
  assert.equal(await page.$eval('#log-more', el => el.hidden), true);
  await refreshLogs();
  await waitRows(pageSize);
  assert.deepEqual(logRequests.at(-1).query, query, 'refresh returns to the latest page');
  for (const level of ['info', 'error']) {
    await page.select('#log-level', level);
    await refreshLogs();
    await waitRows(20);
    assert.deepEqual(logRequests.at(-1).query, { ...query, level });
    assert.deepEqual(await shownDetails(), newest.filter(e => e.level === level).map(details));
  }
  await page.$eval('#log-device', el => { el.value = 'absent-device'; });
  await refreshLogs();
  await page.waitForFunction(() => document.querySelector('#log-status').textContent.includes('暂无'));
  assert.equal(await page.$$eval('#device-logs tr', rows => rows.length), 0);
  await page.$eval('#log-device', el => { el.value = ''; });
  await holdLogResponse(page);
  await refreshLogs();
  await waitRows(20);
  await releaseLogResponse(page, 401);
  assert.equal(await page.$eval('#dashboard', el => el.hidden), false, 'stale 401 must not log out');
  assert.deepEqual(await shownDetails(), newest.filter(e => e.level === 'error').map(details));
  await holdLogResponse(page);
  await releaseLogResponse(page, 503);
  await page.waitForFunction(() => document.querySelector('#log-status').textContent.includes('读取失败'));
  const unsafe = '<svg onload=alert(1)>';
  await holdLogResponse(page);
  await releaseLogResponse(page, 200, [{ ...entries[0], deviceId: unsafe, receivedAt: Date.now() }]);
  await waitRows(1);
  assert.equal(await page.$eval('#device-logs td', el => el.textContent), unsafe);
  assert.equal(await page.$('#device-logs svg'), null);

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

  // An online board can be unregistered, but not deleted; cancelling the confirm changes nothing.
  assert.equal(await page.$$eval('#boards button', (buttons) => buttons.some((b) => b.textContent === '删除')), false);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.click('#boards button.danger');
  await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.equal(await page.$eval('#boards-count', (element) => element.textContent), '1');

  // Unregister: disconnects that board only and marks it blocked.
  page.once('dialog', (dialog) => dialog.accept());
  await page.click('#boards button.danger');
  await page.waitForFunction(() => document.querySelector('#boards').textContent.includes('已解除注册'));
  assert.equal(await page.$eval('#boards-count', (element) => element.textContent), '0');
  assert.equal(await page.$eval('#result-secret', (element) => element.value), '');

  // Delete: now offline, so the row can be removed completely.
  const deleteButton = await page.evaluateHandle(() => [...document.querySelectorAll('#boards button')].find((b) => b.textContent === '删除'));
  page.once('dialog', (dialog) => dialog.accept());
  await deleteButton.asElement().click();
  await page.waitForFunction(() => document.querySelector('#boards').textContent.includes('暂无看板'));
  assert.equal(await page.$eval('#notice', (element) => element.textContent.includes('已删除')), true);

  // Failed refresh is visible rather than silently showing stale state as fresh.
  await page.setOfflineMode(true);
  await page.click('#refresh');
  await page.waitForFunction(() => document.querySelector('#notice').classList.contains('error'));
  await page.setOfflineMode(false);
  await holdLogResponse(page);
  await page.click('#logout');
  await releaseLogResponse(page, 200, [{ ...entries[0], deviceId: 'stale', receivedAt: Date.now() }]);
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#device-logs').rows.length,
    document.querySelector('#log-level').value, document.querySelector('#log-device').value,
    document.querySelector('#log-status').textContent, document.querySelector('#log-more').hidden]), [0, '', '', '', true]);
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);
  assert.equal(await page.$eval('#result-secret', (element) => element.value), '');
  await page.type('#admin-token', adminToken);
  await page.click('#login-form button');
  await page.waitForSelector('#dashboard:not([hidden])');
  // Refresh keeps the session without ever showing the login form, even for one frame.
  await page.evaluateOnNewDocument(() => {
    window.__loginShown = false;
    const check = () => {
      const login = document.getElementById('login');
      if (login && !login.hidden) window.__loginShown = true;
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
    const tick = () => { check(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.evaluate(() => window.__loginShown), false, 'login form must never flash on refresh');
  await page.waitForSelector('#dashboard:not([hidden])');
  assert.equal(await page.$eval('#login', (element) => element.hidden), true);
  assert.equal(await page.$eval('#result-secret', (element) => element.value), '');
  assert.equal(await page.$eval('#logout', (element) => element.hidden), false);
  assert.deepEqual(await page.evaluate(() => [localStorage.length, document.cookie]), [0, '']);

  // Logout drops the stored token, so a refresh lands on the login page.
  const authenticatedReads = logRequests.length;
  await page.click('#logout');
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  await page.reload({ waitUntil: 'networkidle0' });
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);

  // A stored token the relay rejects is discarded instead of looping.
  await page.evaluate(() => sessionStorage.setItem('relay-admin-token', 'stale-token'));
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('令牌无效'));
  assert.equal(await page.$eval('#dashboard', (element) => element.hidden), true);
  assert.equal(await page.evaluate(() => sessionStorage.length), 0);
  assert.equal(logRequests.length, authenticatedReads, 'no log reads after logout or failed restore');
  assert.ok(logRequests.every(req => req.method === 'GET' && req.auth === `Bearer ${adminToken}`));
  assert.deepEqual(errors, []);
  console.log('PASS relay admin browser: login/reject, live status, device log filters/pagination/refresh/session races, pairing, device revoke/cancel, board rotation/unregister/delete, XSS escaping, offline errors, logout, refresh keeps session, stale token discarded, responsive layout, no localStorage/cookies, no runtime errors');
} finally {
  for (const socket of sockets) socket.terminate();
  await browser?.close();
  await server.close();
}

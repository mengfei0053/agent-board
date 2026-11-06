(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Kept in sessionStorage so a page refresh does not log you out. It is per-tab, never shared
  // across tabs, never written to cookies/localStorage, and is dropped when the tab is closed or on logout.
  const STORAGE_KEY = 'relay-admin-token';
  const store = (() => {
    try { return window.sessionStorage; } catch { return null; }
  })();
  let adminToken = store?.getItem(STORAGE_KEY) || '';
  let busy = false;
  let knownBoards = new Map();

  function notice(message, error = false) {
    $('notice').textContent = message;
    $('notice').className = error ? 'notice error' : 'notice';
    $('notice').hidden = !message;
  }

  function clearResult() {
    $('result-secret').value = '';
    $('result-snippet').value = '';
    $('result-snippet-box').hidden = true;
    $('result').hidden = true;
  }

  let waitTimer = null;
  function stopWaiting() {
    if (waitTimer) clearInterval(waitTimer);
    waitTimer = null;
    $('add-wait').hidden = true;
  }

  // After adding a board, poll until it connects (max 3 minutes) so the user sees it appear.
  function waitForBoard(boardId) {
    stopWaiting();
    const deadline = Date.now() + 180000;
    $('add-wait').textContent = `等待看板 ${boardId} 连接…（请在看板机器上配置并重启看板）`;
    $('add-wait').hidden = false;
    waitTimer = setInterval(async () => {
      if (busy) return;
      try {
        const state = await request('/api/admin/state');
        renderState(state);
        if (state.boards.some((board) => board.boardId === boardId && board.online)) {
          stopWaiting();
          notice(`看板 ${boardId} 已连接。`);
        } else if (Date.now() > deadline) {
          stopWaiting();
          notice(`等待看板 ${boardId} 超时。请检查 RELAY_WS_URL / BOARD_ID / BOARD_TOKEN 后点“刷新状态”。`, true);
        }
      } catch { stopWaiting(); }
    }, 3000);
  }

  function logout() {
    adminToken = '';
    try { store?.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ }
    $('admin-token').value = '';
    $('dashboard').hidden = true;
    $('login').hidden = false;
    $('logout').hidden = true;
    $('boards').replaceChildren();
    $('devices').replaceChildren();
    stopWaiting();
    clearResult();
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 401) {
      logout();
      throw new Error('管理员令牌无效，请重新输入 ADMIN_TOKEN。');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(response.status === 429 ? '请求过于频繁，请稍后再试。' : result.error?.message || `请求失败 (${response.status})`);
    return result;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    notice('');
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      await action();
    } catch (error) {
      notice(error.name === 'TimeoutError' ? '请求超时，请检查服务连接后重试。' : error.message || '请求失败，请检查网络连接。', true);
    } finally {
      busy = false;
      document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  function text(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function cell(row, value, sub) {
    const element = document.createElement('td');
    if (value instanceof Node) element.append(value);
    else element.textContent = value;
    if (sub) element.append(text('span', sub, 'sub'));
    row.append(element);
    return element;
  }

  function badge(label, style = '') {
    return text('span', label, `badge ${style}`);
  }

  function button(label, className, action) {
    const element = text('button', label, className);
    element.type = 'button';
    element.disabled = busy;
    element.addEventListener('click', () => { void run(action); });
    return element;
  }

  function empty(tbody, message) {
    const row = document.createElement('tr');
    const element = cell(row, message);
    element.colSpan = 5;
    element.className = 'empty';
    tbody.append(row);
  }

  function date(value) {
    return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
  }

  function boardRows(boards) {
    const tbody = $('boards');
    tbody.replaceChildren();
    const sorted = [...boards].sort((a, b) => Number(b.online) - Number(a.online));
    for (const board of sorted) {
      const row = document.createElement('tr');
      cell(row, board.label || board.boardId, board.online
        ? `${board.label ? board.boardId + ' · ' : ''}代次 ${board.generation} · 序号 ${board.lastSeq}`
        : (board.label ? board.boardId : '尚未连接'));
      cell(row, badge(board.online ? '在线' : '离线', board.online ? 'live' : ''));
      cell(row, badge(board.revoked ? '已解除注册' : board.credentialActive ? '可用' : '需新令牌', board.revoked ? 'danger' : ''));
      cell(row, date(board.connectedAt));
      const actions = cell(row, '');
      actions.append(button('生成配对码', 'link', async () => {
        $('pair-boards').value = board.boardId;
        $('pair-boards').focus();
        $('pair-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
      if (!board.revoked) actions.append(button('解除注册', 'danger', async () => {
        if (!confirm(`解除看板 ${board.boardId} 的注册？\n• 立即断开该看板，并禁止此 ID 再次注册\n• 只影响这一个看板，其他看板和通用令牌不受影响\n• 不会停止看板机器上的任务\n之后可通过“添加看板”重新添加。`)) return;
        await request('/auth/board/unregister', { boardId: board.boardId });
        clearResult();
        await refreshAfterAction(`看板 ${board.boardId} 已解除注册。`);
      }));
      if (!board.online) actions.append(button('删除', 'danger', async () => {
        if (!confirm(`删除看板 ${board.boardId}？\n• 从列表中彻底移除，并作废它的令牌和未使用的配对码\n• 只能访问该看板的手机将被撤销授权\n• 不可恢复；以后需要重新“添加看板”`)) return;
        const result = await request('/auth/board/delete', { boardId: board.boardId });
        clearResult();
        const extra = result.revokedDevices ? `，同时撤销了 ${result.revokedDevices} 台设备` : '';
        await refreshAfterAction(`看板 ${board.boardId} 已删除${extra}。`);
      }));
      tbody.append(row);
    }
    if (!boards.length) empty(tbody, '暂无看板。使用下方“添加看板”签发令牌并连接。');
  }

  function deviceRows(devices) {
    const tbody = $('devices');
    tbody.replaceChildren();
    for (const device of devices) {
      const row = document.createElement('tr');
      cell(row, device.deviceName, device.deviceId);
      cell(row, badge(device.online ? `在线 · ${device.connections} 连接` : '离线', device.online ? 'live' : ''));
      cell(row, device.boardIds.join(', '));
      cell(row, date(device.expiresAt));
      cell(row, button('撤销设备', 'danger', async () => {
        if (!confirm(`撤销设备 ${device.deviceName} (${device.deviceId})？\n会立即断开手机连接，之后需要重新配对。`)) return;
        await request('/auth/revoke/device', { deviceId: device.deviceId });
        await refreshAfterAction('设备权限已撤销。');
      }));
      tbody.append(row);
    }
    if (!devices.length) empty(tbody, '暂无有效的配对设备。生成配对码后，可在手机上完成配对。');
  }

  async function refresh() {
    renderState(await request('/api/admin/state'));
  }

  function renderState(state) {
    boardRows(state.boards);
    deviceRows(state.devices);
    $('boards-count').textContent = state.boards.filter((board) => board.online).length;
    $('phones-count').textContent = state.devices.reduce((sum, device) => sum + device.connections, 0);
    $('devices-count').textContent = state.devices.length;
    const minutes = Math.floor(state.uptimeSec / 60);
    $('uptime').textContent = minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
    $('protocol').textContent = `协议 v${state.protocol}`;
    $('boards-total').textContent = `${state.boards.length} 个看板`;
    $('devices-total').textContent = `${state.devices.length} 台设备`;
    $('pair-count').textContent = `当前有效待使用配对码：${state.activePairCodes} 个`;
    $('updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    knownBoards = new Map(state.boards.map((board) => [board.boardId, board]));
  }

  async function refreshAfterAction(message) {
    try {
      await refresh();
      notice(message);
    } catch (error) {
      notice(`${message} 列表刷新失败：${error.message}`, true);
    }
  }

  function boardIds(id) {
    const ids = [...new Set($(id).value.split(',').map((value) => value.trim()).filter(Boolean))];
    if (!ids.length || ids.length > 20 || ids.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))) {
      throw new Error('请输入 1–20 个有效看板 ID：以字母或数字开头，只能包含字母、数字、点、下划线和短横线，最长 64 字符。');
    }
    return ids;
  }

  function showResult(title, secret, description) {
    $('result-title').textContent = title;
    $('result-secret').value = secret;
    $('result-description').textContent = description;
    $('result').hidden = false;
    $('result').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function showDashboard() {
    $('login').hidden = true;
    $('dashboard').hidden = false;
    $('logout').hidden = false;
  }

  $('login-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      adminToken = $('admin-token').value.trim();
      $('admin-token').value = '';
      try { await refresh(); } catch (error) { logout(); throw error; }
      try { store?.setItem(STORAGE_KEY, adminToken); } catch { /* keep working in memory */ }
      showDashboard();
    });
  });
  $('logout').addEventListener('click', () => { logout(); notice('已退出管理。'); });
  $('refresh').addEventListener('click', () => { void run(refresh); });
  $('clear-result').addEventListener('click', clearResult);
  $('pair-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const ids = boardIds('pair-boards');
      clearResult();
      const result = await request('/auth/pair/create', { boardIds: ids });
      showResult('手机配对码', result.pairCode, `授权 ${result.boardIds.join(', ')} · 到期 ${date(result.expiresAt)} · 仅可使用一次`);
      await refreshAfterAction('配对码已生成，请通过可信渠道发送到手机。');
    });
  });
  $('issue-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const ids = boardIds('issue-boards');
      if (!confirm(`为 ${ids.join(', ')} 签发新令牌？\n将撤销通用初始令牌和与这些 ID 有交集的旧令牌，相关看板会立即断线（包括令牌上其他 ID 的看板）。\n需要更新看板配置 BOARD_TOKEN，且中继重启后该动态令牌将失效。`)) return;
      clearResult();
      const result = await request('/auth/board/issue', { boardIds: ids });
      showResult('新的看板令牌', result.boardToken, `授权 ${result.boardIds.join(', ')} · 请更新对应看板进程的 BOARD_TOKEN。仅在本次中继运行期间有效。`);
      await refreshAfterAction('新令牌已签发，请妥善保存并更新看板配置。');
    });
  });
  $('goto-add').addEventListener('click', () => {
    $('add-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('add-board-id').focus();
  });
  $('add-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const [boardId] = boardIds('add-board-id');
      if (boardId.includes(',')) throw new Error('一次只能添加一个看板。');
      const existing = knownBoards.get(boardId);
      if (existing && !existing.revoked) {
        throw new Error(`看板 ${boardId} 已存在。如需更换令牌，请使用“轮换看板令牌”。`);
      }
      clearResult();
      const result = await request('/auth/board/issue', { boardIds: [boardId], rotate: false });
      const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/ws`;
      $('result-snippet').value = [
        `export RELAY_WS_URL='${wsUrl}'`,
        `export BOARD_ID='${boardId}'`,
        `export BOARD_TOKEN='${result.boardToken}'`,
        `export BOARD_LABEL='${boardId}'`,
        'pnpm start   # 重启前请确认没有运行中的任务',
      ].join('\n');
      $('result-snippet-box').hidden = false;
      showResult('新看板令牌', result.boardToken, `看板 ${boardId} · 仅显示一次。已有看板不受影响。把下方配置设置到看板进程后重启。`);
      $('add-board-id').value = '';
      await refreshAfterAction('看板已添加，等待连接。');
      waitForBoard(boardId);
    });
  });
  $('copy-snippet').addEventListener('click', () => {
    void run(async () => {
      try {
        await navigator.clipboard.writeText($('result-snippet').value);
        notice('配置已复制，其中包含令牌，请勿提交到仓库。');
      } catch {
        $('result-snippet').select();
        notice('无法自动复制，请手动复制已选中的配置。', true);
      }
    });
  });
  $('copy-result').addEventListener('click', () => {
    void run(async () => {
      try {
        await navigator.clipboard.writeText($('result-secret').value);
        notice('已复制到剪贴板，请勿发送到不可信渠道。');
      } catch {
        $('result-secret').select();
        notice('无法自动复制，请手动复制已选中的凭证。', true);
      }
    });
  });

  // Restore the session after a refresh. An invalid/expired token (401) logs out; a network
  // error keeps the token so the next refresh can retry.
  if (adminToken) {
    void run(async () => {
      await refresh();
      showDashboard();
    });
  }
})();

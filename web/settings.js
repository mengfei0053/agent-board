const tabsEl = document.getElementById("agent-tabs");
const panelsEl = document.getElementById("agent-panels");
const form = document.getElementById("settings-form");
const statusEl = document.getElementById("settings-status");
const btnClear = document.getElementById("btn-clear-settings");
const quickListEl = document.getElementById("quick-prompts-list");
const btnAddQuick = document.getElementById("btn-add-quick-prompt");
const pairToken = document.getElementById("pair-admin-token");
const pairButton = document.getElementById("btn-create-pair-code");
const pairStatus = document.getElementById("pair-code-status");
const pairResult = document.getElementById("pair-code-result");
const pairValue = document.getElementById("pair-code-value");

const relayEls = {
  form: document.getElementById("relay-form"),
  url: document.getElementById("relay-url"),
  boardId: document.getElementById("relay-board-id"),
  label: document.getElementById("relay-board-label"),
  admin: document.getElementById("relay-admin-token"),
  token: document.getElementById("relay-board-token"),
  save: document.getElementById("btn-relay-save"),
  disconnect: document.getElementById("btn-relay-disconnect"),
  status: document.getElementById("relay-status"),
  pill: document.getElementById("relay-status-pill"),
};
const RELAY_STATUS_TEXT = { off: "未连接", connecting: "连接中…", connected: "已连接", reconnecting: "重连中…" };
let relayPoll = null;

function renderRelay(data, { fill = false } = {}) {
  if (fill) {
    relayEls.url.value = data.relayWsUrl || "";
    relayEls.boardId.value = data.boardId || "";
    relayEls.label.value = data.boardLabel && data.boardLabel !== data.boardId ? data.boardLabel : "";
  }
  relayEls.pill.textContent = data.enabled ? RELAY_STATUS_TEXT[data.status] || data.status : "未连接";
  relayEls.disconnect.hidden = !(data.enabled && data.source !== "none");
  const parts = [];
  if (data.source === "env") parts.push("当前配置来自环境变量；在此保存后将改用这里的配置。");
  if (data.source === "settings" && !data.enabled) parts.push("已保存配置，当前处于断开状态。");
  if (data.enabled && data.status === "connected") parts.push(`已作为「${data.boardId}」连接到中继。`);
  if (data.lastError && data.status !== "connected") parts.push(data.lastError);
  relayEls.status.textContent = parts.join(" ");
  const waiting = data.enabled && (data.status === "connecting" || data.status === "reconnecting");
  if (waiting && !relayPoll) relayPoll = setInterval(loadRelay, 3000);
  if (!waiting && relayPoll) { clearInterval(relayPoll); relayPoll = null; }
}

async function loadRelay(fill = false) {
  try {
    const response = await fetch("/api/settings/relay", { cache: "no-store" });
    if (!response.ok) return;
    renderRelay(await response.json(), { fill: fill === true });
  } catch { /* keep the previous status */ }
}

async function relayRequest(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "操作失败，请重试。");
  return data;
}

async function saveRelay() {
  const body = {
    relayWsUrl: relayEls.url.value,
    boardId: relayEls.boardId.value,
    boardLabel: relayEls.label.value,
    adminToken: relayEls.admin.value,
    boardToken: relayEls.token.value,
  };
  relayEls.admin.value = "";
  relayEls.token.value = "";
  relayEls.save.disabled = true;
  relayEls.status.textContent = "正在注册并连接…";
  try {
    const data = await relayRequest("/api/settings/relay", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    renderRelay(data, { fill: true });
    if (data.status === "connected") relayEls.status.textContent = `已注册并连接为「${data.boardId}」。`;
  } catch (err) {
    relayEls.status.textContent = err instanceof Error ? err.message : "保存失败，请重试。";
  } finally {
    relayEls.save.disabled = false;
  }
}

relayEls.save.addEventListener("click", () => void saveRelay());
relayEls.form.addEventListener("keydown", (event) => {
  // The relay block sits inside the settings form: Enter must not submit that form.
  if (event.key !== "Enter" || event.target.tagName !== "INPUT") return;
  event.preventDefault();
  if (!relayEls.save.disabled) void saveRelay();
});

relayEls.disconnect.addEventListener("click", async () => {
  if (!confirm("断开与中继的连接？手机将无法远程操控此看板，已保存的配置会保留。")) return;
  relayEls.disconnect.disabled = true;
  try {
    renderRelay(await relayRequest("/api/settings/relay/disconnect", { method: "POST" }));
  } catch (err) {
    relayEls.status.textContent = err instanceof Error ? err.message : "操作失败，请重试。";
  } finally {
    relayEls.disconnect.disabled = false;
  }
});

void loadRelay(true);

pairButton.addEventListener("click", async () => {
  const adminToken = pairToken.value;
  pairToken.value = "";
  pairResult.hidden = true;
  pairValue.value = "";
  pairButton.disabled = true;
  pairStatus.textContent = "正在生成…";
  try {
    const response = await fetch("/api/settings/pair-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminToken }),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 404) throw new Error("看板服务尚未加载配对功能，请在任务结束后重启看板服务。");
    if (!response.ok) throw new Error(data.error || "生成失败，请重试。");
    pairValue.value = data.pairCode;
    document.getElementById("pair-code-expiry").textContent = `看板：${data.boardId}；有效期至 ${new Date(data.expiresAt).toLocaleString()}。成功配对后失效。`;
    pairResult.hidden = false;
    pairStatus.textContent = "配对码已生成。";
  } catch (err) {
    pairStatus.textContent = err instanceof Error ? err.message : "生成失败，请重试。";
  } finally {
    pairButton.disabled = false;
  }
});

document.getElementById("btn-copy-pair-code").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pairValue.value);
    pairStatus.textContent = "配对码已复制。";
  } catch {
    pairValue.select();
    pairStatus.textContent = "无法自动复制，请手动复制选中的配对码。";
  }
});

const CLI_ORDER = ["pi", "claude", "agent", "devin", "codex", "kimi"];
const AGENT_KIND_BY_CLI = {
  pi: "pi",
  claude: "claude",
  agent: "cursor",
  devin: "devin",
  codex: "codex",
  kimi: "kimi",
};
const EFFORT_CANONICAL_ORDER = [
  "none",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const DEFAULT_EFFORTS_BY_KIND = {
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  cursor: ["low", "medium", "high", "xhigh", "max"],
  devin: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
  kimi: [],
};
const PROXY_ORDER = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

const KIND_LABELS = {
  pi: "pi",
  claude: "Claude",
  agent: "Cursor",
  devin: "Devin",
  codex: "Codex",
  kimi: "Kimi Code",
};

const PROXY_LABELS = {
  HTTP_PROXY: "HTTP 代理",
  HTTPS_PROXY: "HTTPS 代理",
  NO_PROXY: "不走代理",
  ALL_PROXY: "全局代理",
};

let activeKind = "pi";
/** @type {Record<string, any>} */
let lastCli = {};
/** @type {Record<string, any>} */
let lastProxy = {};
/** @type {{ id: string, label: string, content: string }[]} */
let lastQuick = [];
/** @type {Record<string, { key: string, value: string }[]>} */
let lastProcessEnv = {};
/** @type {boolean} default ON */
let lastCodexSandbox = true;
/** @type {Record<string, { model: string, thinkingEffort: string }>} */
let lastAgentDefaults = {};
/** @type {Record<string, { model: string, thinkingEfforts: string[] }[]>} */
let lastAgentModels = { pi: [], claude: [], cursor: [], devin: [], codex: [], kimi: [] };
/** @type {Record<string, string[]>} */
let lastThinkingEfforts = { pi: [], claude: [], cursor: [], devin: [], codex: [], kimi: [] };

function agentKindOf(cliKey) {
  return AGENT_KIND_BY_CLI[cliKey] || cliKey;
}

function extractModelName(item) {
  if (typeof item === "string") return item.trim();
  if (item && typeof item.model === "string") return item.model.trim();
  return "";
}

function normalizeModelList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const model = extractModelName(item);
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const thinkingEfforts = Array.isArray(item?.thinkingEfforts)
      ? item.thinkingEfforts.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim())
      : [];
    out.push({ model, thinkingEfforts });
  }
  return out;
}

function aggregatedModelEfforts(models) {
  const aggregated = new Set();
  for (const item of models) {
    for (const effort of item.thinkingEfforts || []) aggregated.add(effort);
  }
  if (!aggregated.size) return null;
  const ordered = EFFORT_CANONICAL_ORDER.filter((e) => aggregated.has(e));
  for (const e of aggregated) {
    if (!ordered.includes(e)) ordered.push(e);
  }
  return ordered;
}

function getEffortsForAgentModel(agentKind, modelName) {
  const models = lastAgentModels[agentKind] || [];
  const lower = String(modelName || "").trim().toLowerCase();
  const matched = lower ? models.find((m) => m.model.toLowerCase() === lower) : null;
  if (matched?.thinkingEfforts?.length) return matched.thinkingEfforts;
  const aggregated = aggregatedModelEfforts(models);
  if (aggregated) return aggregated;
  const fromCatalog = lastThinkingEfforts[agentKind];
  return (Array.isArray(fromCatalog) && fromCatalog.length ? fromCatalog : DEFAULT_EFFORTS_BY_KIND[agentKind]) || [];
}

function renderEffortOptionsHtml(agentKind, modelName, selectedEffort) {
  const efforts = getEffortsForAgentModel(agentKind, modelName);
  const current = String(selectedEffort || "").trim();
  const validCurrent = current && (!efforts.length || efforts.includes(current)) ? current : "";
  const defaultOpt = `<option value=""${!validCurrent ? " selected" : ""}>默认（自动）</option>`;
  const items = efforts.map(
    (effort) => `<option value="${escapeHtml(effort)}"${effort === validCurrent ? " selected" : ""}>${escapeHtml(effort)}</option>`,
  );
  return [defaultOpt, ...items].join("");
}

function renderAgentDefaultsBlock(kind) {
  const agentKind = agentKindOf(kind);
  const label = KIND_LABELS[kind] || kind;
  const cur = lastAgentDefaults[agentKind] || { model: "", thinkingEffort: "" };
  const modelVal = cur.model || "";
  const effortVal = cur.thinkingEffort || "";
  return `
    <section class="settings-block" aria-labelledby="defaults-title-${escapeHtml(kind)}">
      <header class="settings-block-head">
        <h3 id="defaults-title-${escapeHtml(kind)}" class="settings-sub-title">默认模型与思考强度</h3>
        <p class="settings-block-desc">设置 ${escapeHtml(label)} 的默认模型与思考强度；打开新建任务弹框或切换到该 Agent 时自动选中。</p>
      </header>
      <div class="settings-grid-2">
        <label class="settings-row">
          <span class="settings-label">
            <strong>默认模型</strong>
            <span class="muted settings-default">留空则不预设模型</span>
          </span>
          <div class="model-select" data-settings-model-select="${escapeHtml(agentKind)}">
            <input
              type="text"
              name="default-model-${escapeHtml(agentKind)}"
              data-default-model="${escapeHtml(agentKind)}"
              class="model-select-input"
              value="${escapeHtml(modelVal)}"
              data-selected-model="${escapeHtml(modelVal)}"
              placeholder="搜索或选择默认模型（留空不指定）"
              autocomplete="off"
              spellcheck="false"
            />
            <button
              type="button"
              class="model-select-clear"
              data-default-model-clear="${escapeHtml(agentKind)}"
              aria-label="清空默认模型"
              title="清空"
              ${modelVal ? "" : "hidden"}
            >×</button>
            <span class="model-select-caret" aria-hidden="true">▾</span>
            <div
              class="model-select-dropdown hidden"
              data-default-model-dropdown="${escapeHtml(agentKind)}"
              role="listbox"
            ></div>
          </div>
        </label>
        <label class="settings-row">
          <span class="settings-label">
            <strong>默认思考强度</strong>
            <span class="muted settings-default">留空则使用默认强度</span>
          </span>
          <select
            name="default-effort-${escapeHtml(agentKind)}"
            data-default-effort="${escapeHtml(agentKind)}"
            class="settings-select"
          >
            ${renderEffortOptionsHtml(agentKind, modelVal, effortVal)}
          </select>
        </label>
      </div>
    </section>`;
}

function newQuickId() {
  return `qp_${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Parse HTML in the element's context without assigning innerHTML. */
function setElementHtml(el, html) {
  const range = document.createRange();
  range.selectNodeContents(el);
  el.replaceChildren(range.createContextualFragment(html));
}

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("ok", ok === true);
  statusEl.classList.toggle("bad", ok === false);
  statusEl.classList.toggle("muted", ok !== true && ok !== false);
}

function proxyHint(row) {
  if (row?.hasCredential) {
    return `<span class="settings-hint muted">已保存凭据（显示为 ***）。不改此框则保持原密码；要更换请整段重填。</span>`;
  }
  if (row?.override || row?.configured) {
    return `<span class="settings-hint muted">已为本 Agent 单独设置</span>`;
  }
  if (row?.inherited && row.effective) {
    return `<span class="settings-hint muted">当前沿用看板：<code>${escapeHtml(row.effective)}</code></span>`;
  }
  return `<span class="settings-hint muted">留空则沿用看板环境</span>`;
}

function renderTabs() {
  const html = CLI_ORDER.map((kind) => {
    const selected = kind === activeKind;
    return `<button
      type="button"
      class="settings-kind-tab${selected ? " active" : ""}"
      role="tab"
      aria-selected="${selected ? "true" : "false"}"
      aria-controls="agent-panel-${escapeHtml(kind)}"
      data-agent-kind="${escapeHtml(kind)}"
      id="agent-tab-${escapeHtml(kind)}"
    >${escapeHtml(KIND_LABELS[kind] || kind)}</button>`;
  }).join("");
  setElementHtml(tabsEl, html);
}

function renderCliBlock(kind, cliRow) {
  const row = cliRow || {
    default: kind,
    override: "",
    resolved: "",
    label: KIND_LABELS[kind] || kind,
  };
  const resolvedBadge = row.resolved
    ? `<span class="settings-badge" title="${escapeHtml(row.resolved)}">已找到</span>
       <span class="settings-resolved muted" title="${escapeHtml(row.resolved)}">${escapeHtml(row.resolved)}</span>`
    : `<span class="settings-badge settings-badge-warn">未找到</span>`;

  return `
    <section class="settings-block" aria-labelledby="cli-title-${escapeHtml(kind)}">
      <div class="settings-block-inline-head">
        <div>
          <h3 id="cli-title-${escapeHtml(kind)}" class="settings-sub-title">CLI 可执行文件</h3>
          <p class="settings-block-desc">指定 ${escapeHtml(row.label || KIND_LABELS[kind] || kind)} 命令路径；留空则从系统 PATH 查找默认命令 <code>${escapeHtml(row.default || kind)}</code>。</p>
        </div>
        <span class="settings-resolved-line">${resolvedBadge}</span>
      </div>
      <label class="settings-row settings-row-cli">
        <input
          type="text"
          name="cli-${escapeHtml(kind)}"
          data-cli-key="${escapeHtml(kind)}"
          value="${escapeHtml(row.override || "")}"
          placeholder="默认：${escapeHtml(row.default || kind)}"
          spellcheck="false"
        />
      </label>
    </section>`;
}

function renderProxyBlock(kind, kindMap) {
  const map = kindMap || {};
  const cells = PROXY_ORDER.map((key) => {
    const row = map[key] || { override: "", effective: "", inherited: false };
    const fillBtn =
      key === "HTTP_PROXY" || key === "HTTPS_PROXY"
        ? `<button type="button" class="settings-mini-btn" data-fill-both="${escapeHtml(kind)}" data-from-key="${escapeHtml(key)}">同步到 HTTP/HTTPS</button>`
        : "";
    return `
      <label class="settings-row settings-proxy-cell">
        <span class="settings-label settings-proxy-label">
          <span>
            <strong>${escapeHtml(PROXY_LABELS[key] || key)}</strong>
            <span class="muted settings-default"><code>${escapeHtml(key)}</code></span>
          </span>
          ${fillBtn}
        </span>
        <input
          type="text"
          name="proxy-${escapeHtml(kind)}-${escapeHtml(key)}"
          data-proxy-kind="${escapeHtml(kind)}"
          data-proxy-key="${escapeHtml(key)}"
          data-initial="${escapeHtml(row.override || "")}"
          value="${escapeHtml(row.override || "")}"
          placeholder="${row.hasCredential ? "已配置，留空保持不变" : "留空则沿用看板"}"
          spellcheck="false"
          autocomplete="off"
        />
        <span class="settings-cell-foot">
          ${proxyHint(row)}
        </span>
      </label>`;
  }).join("");

  return `
    <section class="settings-block" aria-labelledby="proxy-title-${escapeHtml(kind)}">
      <header class="settings-block-head">
        <h3 id="proxy-title-${escapeHtml(kind)}" class="settings-sub-title">进程网络代理</h3>
        <p class="settings-block-desc">仅作用于本 Agent 新启动的任务子进程；留空则继承看板服务环境。</p>
      </header>
      <div class="settings-proxy-grid">${cells}</div>
    </section>`;
}

function processEnvRowHtml(row, idx) {
  return `
      <div class="process-env-row settings-row" data-process-env-row>
        <div class="process-env-inline">
          <span class="process-env-index muted">#${idx + 1}</span>
          <input
            type="text"
            data-process-env-key
            value="${escapeHtml(row.key || "")}"
            placeholder="变量名（如 OPENAI_BASE_URL）"
            spellcheck="false"
            autocomplete="off"
          />
          <input
            type="text"
            data-process-env-value
            value="${escapeHtml(row.value || "")}"
            placeholder="变量值（留空保存将移除）"
            spellcheck="false"
            autocomplete="off"
          />
          <button type="button" class="settings-mini-btn danger-ish" data-remove-process-env>删除</button>
        </div>
      </div>`;
}

function processEnvListHtml(kind) {
  const rows = lastProcessEnv[kind] || [];
  return rows.length
    ? rows.map(processEnvRowHtml).join("")
    : `<p class="muted process-env-empty">暂无自定义环境变量。</p>`;
}

function processEnvListEl(kind) {
  return panelsEl.querySelector(`[data-process-env-list="${CSS.escape(kind)}"]`);
}

function syncProcessEnvListFromDom(kind) {
  const list = processEnvListEl(kind);
  if (!list) return lastProcessEnv[kind] || [];
  const rows = [];
  for (const row of list.querySelectorAll("[data-process-env-row]")) {
    rows.push({
      key: row.querySelector("[data-process-env-key]")?.value || "",
      value: row.querySelector("[data-process-env-value]")?.value || "",
    });
  }
  lastProcessEnv[kind] = rows;
  return rows;
}

function renderProcessEnvList(kind) {
  const list = processEnvListEl(kind);
  if (!list) return;
  setElementHtml(list, processEnvListHtml(kind));
}

function renderProcessEnvBlock(kind) {
  const label = KIND_LABELS[kind] || kind;
  const body = processEnvListHtml(kind);
  return `
    <section class="settings-block" aria-labelledby="process-env-title-${escapeHtml(kind)}">
      <div class="settings-block-inline-head">
        <div>
          <h3 id="process-env-title-${escapeHtml(kind)}" class="settings-sub-title">自定义环境变量</h3>
          <p class="settings-block-desc">为 ${escapeHtml(label)} 任务进程注入额外变量（同名覆盖继承值，控制面密钥不可设置）。</p>
        </div>
        <button type="button" class="secondary settings-compact-btn" data-add-process-env="${escapeHtml(kind)}">＋ 添加环境变量</button>
      </div>
      <div class="process-env-list" data-process-env-list="${escapeHtml(kind)}">${body}</div>
    </section>`;
}

function renderCodexSandboxBlock() {
  const on = lastCodexSandbox !== false;
  return `
    <section class="settings-block" aria-labelledby="codex-sandbox-title">
      <header class="settings-block-head">
        <h3 id="codex-sandbox-title" class="settings-sub-title">Codex 沙箱策略</h3>
        <p class="settings-block-desc">控制 Codex 执行命令时是否启用沙箱。关闭后可访问内网 GitLab（如 192.168.x），仅影响新开任务。</p>
      </header>
      <label class="settings-row settings-row-toggle">
        <span class="settings-label">
          <strong>启用沙箱</strong>
          <span class="muted settings-default">默认开启（<code>--approve-for-me</code>）</span>
        </span>
        <span class="settings-toggle-line">
          <input
            type="checkbox"
            id="codex-sandbox-enabled"
            name="codexSandbox"
            data-codex-sandbox="1"
            ${on ? "checked" : ""}
          />
          <span class="settings-toggle-hint muted" id="codex-sandbox-hint">${
            on
              ? "开：workspace-write 沙箱（可能无法推送到内网 GitLab）"
              : "关：-s danger-full-access（可访问内网；hook 拦截取决于本机 Codex 配置）"
          }</span>
        </span>
      </label>
    </section>`;
}

function renderPanels() {
  const html = CLI_ORDER.map((kind) => {
    const hidden = kind !== activeKind;
    const extra = kind === "codex" ? renderCodexSandboxBlock() : "";
    return `
      <div
        class="settings-agent-panel${hidden ? " hidden" : ""}"
        role="tabpanel"
        id="agent-panel-${escapeHtml(kind)}"
        data-agent-panel="${escapeHtml(kind)}"
        aria-labelledby="agent-tab-${escapeHtml(kind)}"
        ${hidden ? "hidden" : ""}
      >
        <div class="settings-agent-card">
          ${renderAgentDefaultsBlock(kind)}
          ${renderCliBlock(kind, lastCli[kind])}
          ${renderProxyBlock(kind, lastProxy[kind])}
          ${renderProcessEnvBlock(kind)}
          ${extra}
        </div>
      </div>`;
  }).join("");
  setElementHtml(panelsEl, html);
}

function showKind(kind) {
  if (!CLI_ORDER.includes(kind)) return;
  activeKind = kind;
  for (const btn of tabsEl.querySelectorAll(".settings-kind-tab")) {
    const on = btn.dataset.agentKind === kind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const panel of panelsEl.querySelectorAll(".settings-agent-panel")) {
    const on = panel.dataset.agentPanel === kind;
    panel.classList.toggle("hidden", !on);
    if (on) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
}

function renderQuickPrompts() {
  if (!quickListEl) return;
  if (!lastQuick.length) {
    setElementHtml(quickListEl, `<p class="muted quick-prompt-empty">暂无快捷输入。点击右上角「＋ 添加快捷输入」即可创建常用提示词模板。</p>`);
    return;
  }
  const html = lastQuick.map((item, idx) => `
    <div class="quick-prompt-item settings-row" data-quick-idx="${idx}">
      <div class="quick-prompt-meta">
        <div class="quick-prompt-item-head">
          <span class="settings-label">
            <strong>按钮名称</strong>
            <span class="muted settings-default">#${idx + 1}</span>
          </span>
          <button type="button" class="settings-mini-btn danger-ish" data-remove-quick="${idx}">删除</button>
        </div>
        <input
          type="text"
          data-quick-field="label"
          data-quick-idx="${idx}"
          value="${escapeHtml(item.label || "")}"
          placeholder="如：分析禅道 Bug"
          maxlength="40"
          spellcheck="false"
        />
      </div>
      <div class="quick-prompt-body">
        <label class="settings-label"><strong>提示词内容</strong></label>
        <textarea
          data-quick-field="content"
          data-quick-idx="${idx}"
          rows="2"
          placeholder="点击快捷按钮后填入输入框的完整内容"
          spellcheck="false"
        >${escapeHtml(item.content || "")}</textarea>
      </div>
    </div>
  `).join("");
  setElementHtml(quickListEl, html);
}

function syncQuickFromDom() {
  if (!quickListEl) return lastQuick;
  const next = [];
  for (const item of quickListEl.querySelectorAll(".quick-prompt-item")) {
    const idx = Number(item.dataset.quickIdx);
    const labelInput = item.querySelector('[data-quick-field="label"]');
    const contentInput = item.querySelector('[data-quick-field="content"]');
    const prev = lastQuick[idx] || {};
    next.push({
      id: prev.id || newQuickId(),
      label: (labelInput?.value || "").trim(),
      content: contentInput?.value || "",
    });
  }
  lastQuick = next;
  return lastQuick;
}

function syncProcessEnvFromDom() {
  const next = {};
  for (const list of panelsEl.querySelectorAll("[data-process-env-list]")) {
    const kind = list.dataset.processEnvList;
    if (!kind) continue;
    const rows = [];
    for (const row of list.querySelectorAll("[data-process-env-row]")) {
      const key = row.querySelector("[data-process-env-key]")?.value || "";
      const value = row.querySelector("[data-process-env-value]")?.value || "";
      rows.push({ key, value });
    }
    next[kind] = rows;
  }
  lastProcessEnv = next;
  return lastProcessEnv;
}

function applyAgentDefaultsFromData(data) {
  lastAgentDefaults = {};
  for (const kind of CLI_ORDER) {
    const agentKind = agentKindOf(kind);
    const rawDef = data.agentDefaults?.[agentKind] || data.agentDefaults?.[kind] || {};
    lastAgentDefaults[agentKind] = {
      model: typeof rawDef.model === "string" ? rawDef.model.trim() : "",
      thinkingEffort: typeof rawDef.thinkingEffort === "string" ? rawDef.thinkingEffort.trim() : "",
    };
    if (Array.isArray(data.agentModels?.[agentKind])) {
      lastAgentModels[agentKind] = normalizeModelList(data.agentModels[agentKind]);
    }
    if (Array.isArray(data.thinkingEfforts?.[agentKind])) {
      lastThinkingEfforts[agentKind] = data.thinkingEfforts[agentKind].filter(Boolean);
    }
  }
}

function renderAll(data) {
  lastCli = data.cliPaths || {};
  lastProxy = data.proxyEnv || {};
  lastProcessEnv = {};
  for (const kind of CLI_ORDER) {
    const map = data.processEnv && typeof data.processEnv === "object" ? data.processEnv[kind] : null;
    const isObj = Boolean(map && typeof map === "object" && !Array.isArray(map));
    lastProcessEnv[kind] = isObj
      ? Object.entries(map).map(([key, value]) => ({ key, value: String(value ?? "") }))
      : [];
  }
  lastQuick = Array.isArray(data.quickPrompts)
    ? data.quickPrompts.map((x) => ({
        id: x.id || newQuickId(),
        label: x.label || "",
        content: x.content || "",
      }))
    : [];
  lastCodexSandbox = data.codexSandbox !== false;
  applyAgentDefaultsFromData(data);
  renderQuickPrompts();
  renderTabs();
  renderPanels();
  showKind(activeKind);
}

function collectAgentDefaultsFromDom() {
  const agentDefaults = {};
  for (const kind of CLI_ORDER) {
    const agentKind = agentKindOf(kind);
    const modelInput = panelsEl.querySelector(`input[data-default-model="${CSS.escape(agentKind)}"]`);
    const effortSelect = panelsEl.querySelector(`select[data-default-effort="${CSS.escape(agentKind)}"]`);
    const model = (modelInput ? modelInput.value : lastAgentDefaults[agentKind]?.model || "").trim();
    const thinkingEffort = (effortSelect ? effortSelect.value : lastAgentDefaults[agentKind]?.thinkingEffort || "").trim();
    agentDefaults[agentKind] = { model, thinkingEffort };
  }
  lastAgentDefaults = agentDefaults;
  return agentDefaults;
}

function collectPayload() {
  syncProcessEnvFromDom();
  const agentDefaults = collectAgentDefaultsFromDom();
  const cliPaths = {};
  for (const input of panelsEl.querySelectorAll("input[data-cli-key]")) {
    cliPaths[input.dataset.cliKey] = input.value;
  }
  const proxyEnv = {};
  for (const kind of CLI_ORDER) proxyEnv[kind] = {};
  for (const input of panelsEl.querySelectorAll("input[data-proxy-kind][data-proxy-key]")) {
    const kind = input.dataset.proxyKind;
    const key = input.dataset.proxyKey;
    if (input.value === (input.dataset.initial || "")) continue;
    if (!proxyEnv[kind]) proxyEnv[kind] = {};
    proxyEnv[kind][key] = input.value;
  }
  const quickPrompts = syncQuickFromDom()
    .map((x) => ({
      id: x.id || newQuickId(),
      label: (x.label || "").trim(),
      content: x.content || "",
    }))
    .filter((x) => x.label && x.content.trim());
  const sandboxEl = panelsEl.querySelector("input[data-codex-sandbox]");
  const codexSandbox = sandboxEl ? Boolean(sandboxEl.checked) : lastCodexSandbox !== false;
  const processEnv = {};
  for (const kind of CLI_ORDER) {
    const map = {};
    for (const row of lastProcessEnv[kind] || []) {
      const key = (row.key || "").trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) {
        throw new Error(`环境变量名不合法：${key}（仅字母、数字、下划线，且不能以数字开头）`);
      }
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        throw new Error(`环境变量重复：${key}`);
      }
      map[key] = row.value || "";
    }
    processEnv[kind] = map;
  }
  return { cliPaths, proxyEnv, processEnv, quickPrompts, codexSandbox, agentDefaults };
}

function syncEffortSelectForAgent(agentKind, modelValue) {
  const effortSelect = panelsEl.querySelector(`select[data-default-effort="${CSS.escape(agentKind)}"]`);
  if (!effortSelect) return;
  const prevEffort = effortSelect.value || "";
  setElementHtml(effortSelect, renderEffortOptionsHtml(agentKind, modelValue, prevEffort));
}

function filterSettingsModels(agentKind, queryText) {
  const list = lastAgentModels[agentKind] || [];
  const q = String(queryText || "").trim().toLowerCase();
  if (!q) return list;
  const tokens = q.split(/\s+/).filter(Boolean);
  return list.filter((item) => {
    const lower = item.model.toLowerCase();
    return tokens.every((t) => lower.includes(t));
  });
}

function renderSettingsModelDropdown(agentKind, filterQuery = "") {
  const dropdown = panelsEl.querySelector(`[data-default-model-dropdown="${CSS.escape(agentKind)}"]`);
  const input = panelsEl.querySelector(`input[data-default-model="${CSS.escape(agentKind)}"]`);
  if (!dropdown || !input) return;
  const current = input.value.trim();
  const filtered = filterSettingsModels(agentKind, filterQuery);
  const defaultBtn = `<button type="button" class="model-option model-option-default${!current ? " is-selected" : ""}" role="option" data-model-value="">默认模型（不指定）</button>`;
  const body = filtered.length
    ? filtered.map((item) => {
        const sel = item.model === current;
        return `<button type="button" class="model-option${sel ? " is-selected" : ""}" role="option" data-model-value="${escapeHtml(item.model)}"><span class="model-option-name">${escapeHtml(item.model)}</span></button>`;
      }).join("")
    : `<div class="model-option-empty muted">${(lastAgentModels[agentKind] || []).length ? "无匹配模型" : "暂无可用模型"}</div>`;
  setElementHtml(dropdown, defaultBtn + body);
}

function setSettingsModelValue(agentKind, value) {
  const input = panelsEl.querySelector(`input[data-default-model="${CSS.escape(agentKind)}"]`);
  const clearBtn = panelsEl.querySelector(`button[data-default-model-clear="${CSS.escape(agentKind)}"]`);
  const dropdown = panelsEl.querySelector(`[data-default-model-dropdown="${CSS.escape(agentKind)}"]`);
  const nextVal = String(value || "").trim();
  if (input) {
    input.value = nextVal;
    input.dataset.selectedModel = nextVal;
  }
  if (clearBtn) clearBtn.hidden = !nextVal;
  dropdown?.classList.add("hidden");
  syncEffortSelectForAgent(agentKind, nextVal);
  setStatus("已修改默认模型（尚未保存）。");
}

tabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-agent-kind]");
  if (!btn) return;
  showKind(btn.dataset.agentKind);
});

panelsEl.addEventListener("change", (e) => {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.dataset.defaultEffort) {
    setStatus("已修改默认思考强度（尚未保存）。");
    return;
  }
  if (!(t instanceof HTMLInputElement) || !t.matches("input[data-codex-sandbox]")) return;
  const hint = document.getElementById("codex-sandbox-hint");
  if (hint) {
    hint.textContent = t.checked
      ? "开：workspace-write 沙箱（可能无法推送到内网 GitLab）"
      : "关：-s danger-full-access（可访问内网；hook 拦截取决于本机 Codex 配置）";
  }
  setStatus(t.checked ? "已勾选启用沙箱（尚未保存）。" : "已取消沙箱（尚未保存）。");
});

panelsEl.addEventListener("focusin", (e) => {
  const input = e.target instanceof HTMLInputElement ? e.target.closest("input[data-default-model]") : null;
  if (!input) return;
  const agentKind = input.dataset.defaultModel;
  if (!agentKind) return;
  for (const openEl of panelsEl.querySelectorAll("[data-default-model-dropdown]")) {
    if (openEl.dataset.defaultModelDropdown !== agentKind) openEl.classList.add("hidden");
  }
  renderSettingsModelDropdown(agentKind, "");
  const dropdown = panelsEl.querySelector(`[data-default-model-dropdown="${CSS.escape(agentKind)}"]`);
  dropdown?.classList.remove("hidden");
});

panelsEl.addEventListener("input", (e) => {
  const input = e.target instanceof HTMLInputElement ? e.target.closest("input[data-default-model]") : null;
  if (!input) return;
  const agentKind = input.dataset.defaultModel;
  if (!agentKind) return;
  const clearBtn = panelsEl.querySelector(`button[data-default-model-clear="${CSS.escape(agentKind)}"]`);
  if (clearBtn) clearBtn.hidden = !input.value.trim();
  renderSettingsModelDropdown(agentKind, input.value);
  const dropdown = panelsEl.querySelector(`[data-default-model-dropdown="${CSS.escape(agentKind)}"]`);
  dropdown?.classList.remove("hidden");
  syncEffortSelectForAgent(agentKind, input.value.trim());
});

panelsEl.addEventListener("mousedown", (e) => {
  const opt = e.target instanceof Element ? e.target.closest("[data-default-model-dropdown] .model-option") : null;
  if (opt) {
    e.preventDefault();
    const dropdown = opt.closest("[data-default-model-dropdown]");
    const agentKind = dropdown?.dataset.defaultModelDropdown;
    if (agentKind) setSettingsModelValue(agentKind, opt.dataset.modelValue || "");
    return;
  }
  const clearBtn = e.target instanceof Element ? e.target.closest("button[data-default-model-clear]") : null;
  if (clearBtn) {
    e.preventDefault();
    const agentKind = clearBtn.dataset.defaultModelClear;
    if (!agentKind) return;
    setSettingsModelValue(agentKind, "");
    const input = panelsEl.querySelector(`input[data-default-model="${CSS.escape(agentKind)}"]`);
    input?.focus();
  }
});

document.addEventListener("mousedown", (e) => {
  if (e.target instanceof Element && e.target.closest("[data-settings-model-select]")) return;
  for (const openEl of panelsEl.querySelectorAll("[data-default-model-dropdown]")) {
    openEl.classList.add("hidden");
  }
});

panelsEl.addEventListener("click", (e) => {
  const addBtn = e.target.closest("[data-add-process-env]");
  if (addBtn) {
    e.preventDefault();
    const kind = addBtn.dataset.addProcessEnv;
    if (!CLI_ORDER.includes(kind)) return;
    syncProcessEnvListFromDom(kind);
    if (!lastProcessEnv[kind]) lastProcessEnv[kind] = [];
    lastProcessEnv[kind].push({ key: "", value: "" });
    renderProcessEnvList(kind);
    const keys = processEnvListEl(kind)?.querySelectorAll("[data-process-env-key]");
    keys?.item(keys.length - 1)?.focus();
    setStatus("已添加一个环境变量（尚未保存）。");
    return;
  }
  const removeBtn = e.target.closest("[data-remove-process-env]");
  if (removeBtn) {
    e.preventDefault();
    const list = removeBtn.closest("[data-process-env-list]");
    const kind = list?.dataset.processEnvList;
    const row = removeBtn.closest("[data-process-env-row]");
    if (!list || !kind) return;
    const rows = syncProcessEnvListFromDom(kind);
    const idx = row ? Array.prototype.indexOf.call(list.querySelectorAll("[data-process-env-row]"), row) : -1;
    if (idx < 0) return;
    rows.splice(idx, 1);
    renderProcessEnvList(kind);
    setStatus("已删除（尚未保存）。");
  }
});

panelsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-fill-both]");
  if (!btn) return;
  e.preventDefault();
  const kind = btn.dataset.fillBoth;
  const fromKey = btn.dataset.fromKey;
  const from = panelsEl.querySelector(
    `input[data-proxy-kind="${CSS.escape(kind)}"][data-proxy-key="${CSS.escape(fromKey)}"]`
  );
  if (!from) return;
  const val = from.value.trim();
  if (!val) {
    setStatus("请先填写一个代理地址，再点「填到 HTTP & HTTPS」。", false);
    return;
  }
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY"]) {
    const input = panelsEl.querySelector(
      `input[data-proxy-kind="${CSS.escape(kind)}"][data-proxy-key="${CSS.escape(key)}"]`
    );
    if (input) input.value = val;
  }
  setStatus("已填入 HTTP 与 HTTPS 代理（尚未保存）。");
});

btnAddQuick?.addEventListener("click", () => {
  syncQuickFromDom();
  lastQuick.push({ id: newQuickId(), label: "", content: "" });
  renderQuickPrompts();
  setStatus("已添加一条（尚未保存）。");
});

quickListEl?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-remove-quick]");
  if (!btn) return;
  e.preventDefault();
  syncQuickFromDom();
  const idx = Number(btn.dataset.removeQuick);
  if (!Number.isFinite(idx) || idx < 0 || idx >= lastQuick.length) return;
  lastQuick.splice(idx, 1);
  renderQuickPrompts();
  setStatus("已删除（尚未保存）。");
});

async function load() {
  setStatus("加载中…");
  const [res, modelsRes] = await Promise.all([
    fetch("/api/settings"),
    fetch("/api/agent-models").catch(() => null),
  ]);
  if (!res.ok) {
    setStatus(`加载失败：HTTP ${res.status}`, false);
    return;
  }
  const data = await res.json();
  if (!data.agentModels && modelsRes?.ok) {
    const modelsData = await modelsRes.json().catch(() => ({}));
    if (modelsData?.models) data.agentModels = modelsData.models;
  }
  renderAll(data);
  setStatus("已加载。修改后点保存即可。", true);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  let body;
  try {
    body = collectPayload();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), false);
    return;
  }
  setStatus("保存中…");
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `保存失败：HTTP ${res.status}`, false);
      return;
    }
    renderAll(data);
    setStatus("已保存，对新任务生效。", true);
  } catch (err) {
    setStatus(`保存失败：${err}`, false);
  }
});

btnClear.addEventListener("click", async () => {
  if (!confirm("确定清除全部默认模型与思考强度、CLI 路径、代理覆盖、自定义环境变量，并将 Codex 沙箱恢复为开启？")) return;
  setStatus("恢复中…");
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `恢复失败：HTTP ${res.status}`, false);
      return;
    }
    renderAll(data);
    setStatus("已恢复默认。", true);
  } catch (err) {
    setStatus(`恢复失败：${err}`, false);
  }
});

for (const navLink of document.querySelectorAll(".settings-nav-item")) {
  navLink.addEventListener("click", () => {
    for (const item of document.querySelectorAll(".settings-nav-item")) {
      item.classList.toggle("active", item === navLink);
    }
  });
}

load().catch((err) => setStatus(`加载失败：${err}`, false));

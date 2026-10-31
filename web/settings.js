const tabsEl = document.getElementById("agent-tabs");
const panelsEl = document.getElementById("agent-panels");
const form = document.getElementById("settings-form");
const statusEl = document.getElementById("settings-status");
const btnClear = document.getElementById("btn-clear-settings");
const quickListEl = document.getElementById("quick-prompts-list");
const btnAddQuick = document.getElementById("btn-add-quick-prompt");

const CLI_ORDER = ["pi", "claude", "agent", "devin", "codex"];
const PROXY_ORDER = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

const KIND_LABELS = {
  pi: "pi",
  claude: "Claude",
  agent: "Cursor",
  devin: "Devin",
  codex: "Codex",
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
/** @type {boolean} default ON */
let lastCodexSandbox = true;

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
  tabsEl.innerHTML = CLI_ORDER.map((kind) => {
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
      <header class="settings-block-head">
        <h2 id="cli-title-${escapeHtml(kind)}">CLI 路径</h2>
        <p class="settings-block-desc">填写可执行文件路径；留空则使用默认命令名（系统 PATH）。</p>
      </header>
      <label class="settings-row settings-row-cli">
        <span class="settings-label">
          <strong>${escapeHtml(row.label || KIND_LABELS[kind] || kind)}</strong>
          <span class="muted settings-default">默认 <code>${escapeHtml(row.default || kind)}</code></span>
        </span>
        <input
          type="text"
          name="cli-${escapeHtml(kind)}"
          data-cli-key="${escapeHtml(kind)}"
          value="${escapeHtml(row.override || "")}"
          placeholder="${escapeHtml(row.default || kind)}"
          spellcheck="false"
        />
        <span class="settings-resolved-line">${resolvedBadge}</span>
      </label>
    </section>`;
}

function renderProxyBlock(kind, kindMap) {
  const map = kindMap || {};
  const cells = PROXY_ORDER.map((key) => {
    const row = map[key] || { override: "", effective: "", inherited: false };
    const fillBtn =
      key === "HTTP_PROXY" || key === "HTTPS_PROXY"
        ? `<button type="button" class="settings-mini-btn" data-fill-both="${escapeHtml(kind)}" data-from-key="${escapeHtml(key)}">填到 HTTP &amp; HTTPS</button>`
        : "";
    return `
      <label class="settings-row settings-proxy-cell">
        <span class="settings-label">
          <strong>${escapeHtml(PROXY_LABELS[key] || key)}</strong>
          <span class="muted settings-default"><code>${escapeHtml(key)}</code></span>
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
          ${fillBtn}
        </span>
      </label>`;
  }).join("");

  return `
    <section class="settings-block" aria-labelledby="proxy-title-${escapeHtml(kind)}">
      <header class="settings-block-head">
        <h2 id="proxy-title-${escapeHtml(kind)}">进程代理</h2>
        <p class="settings-block-desc">仅影响本 Agent 新开的任务进程；留空不覆盖看板环境。</p>
      </header>
      <div class="settings-proxy-grid">${cells}</div>
    </section>`;
}

function renderCodexSandboxBlock() {
  const on = lastCodexSandbox !== false;
  return `
    <section class="settings-block" aria-labelledby="codex-sandbox-title">
      <header class="settings-block-head">
        <h2 id="codex-sandbox-title">Codex 沙箱</h2>
        <p class="settings-block-desc">控制 Codex 执行命令时是否启用沙箱。关闭后可访问内网 GitLab（如 192.168.x），权限更大；仅影响新开任务（含无 session 的续跑），resume 沿用会话策略。关沙箱时，若本机 <code>~/.codex/hooks</code> 已配置危险删除拦截，<code>rm -rf</code> / <code>git clean -fdx</code> 可能被拒绝。看板不检查 hook 是否存在，提示词前缀和关沙箱都不是执行安全边界。</p>
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
  panelsEl.innerHTML = CLI_ORDER.map((kind) => {
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
        <div class="settings-card settings-agent-card">
          ${renderCliBlock(kind, lastCli[kind])}
          ${renderProxyBlock(kind, lastProxy[kind])}
          ${extra}
        </div>
      </div>`;
  }).join("");
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
    quickListEl.innerHTML = `<p class="muted quick-prompt-empty">暂无快捷输入。点击下方添加后，会出现在新建任务与续跑输入框上方。</p>`;
    return;
  }
  quickListEl.innerHTML = lastQuick.map((item, idx) => `
    <div class="quick-prompt-item settings-row" data-quick-idx="${idx}">
      <div class="quick-prompt-item-head">
        <label class="settings-label">
          <strong>按钮名称</strong>
          <span class="muted settings-default">第 ${idx + 1} 条</span>
        </label>
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
      <label class="settings-label" style="margin-top:4px"><strong>提示词内容</strong></label>
      <textarea
        data-quick-field="content"
        data-quick-idx="${idx}"
        rows="3"
        placeholder="点击快捷按钮后填入输入框的完整内容"
        spellcheck="false"
      >${escapeHtml(item.content || "")}</textarea>
    </div>
  `).join("");
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

function renderAll(data) {
  lastCli = data.cliPaths || {};
  lastProxy = data.proxyEnv || {};
  lastQuick = Array.isArray(data.quickPrompts)
    ? data.quickPrompts.map((x) => ({
        id: x.id || newQuickId(),
        label: x.label || "",
        content: x.content || "",
      }))
    : [];
  lastCodexSandbox = data.codexSandbox !== false;
  renderQuickPrompts();
  renderTabs();
  renderPanels();
  showKind(activeKind);
}

function collectPayload() {
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
  return { cliPaths, proxyEnv, quickPrompts, codexSandbox };
}

tabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-agent-kind]");
  if (!btn) return;
  showKind(btn.dataset.agentKind);
});

panelsEl.addEventListener("change", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.matches("input[data-codex-sandbox]")) return;
  const hint = document.getElementById("codex-sandbox-hint");
  if (hint) {
    hint.textContent = t.checked
      ? "开：workspace-write 沙箱（可能无法推送到内网 GitLab）"
      : "关：-s danger-full-access（可访问内网；hook 拦截取决于本机 Codex 配置）";
  }
  setStatus(t.checked ? "已勾选启用沙箱（尚未保存）。" : "已取消沙箱（尚未保存）。");
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
  const res = await fetch("/api/settings");
  if (!res.ok) {
    setStatus(`加载失败：HTTP ${res.status}`, false);
    return;
  }
  const data = await res.json();
  renderAll(data);
  setStatus("已加载。修改后点保存即可。", true);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = collectPayload();
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
  if (!confirm("确定清除全部 CLI 路径、各 Agent 代理覆盖，并将 Codex 沙箱恢复为开启？")) return;
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

load().catch((err) => setStatus(`加载失败：${err}`, false));

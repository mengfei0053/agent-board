const fieldsEl = document.getElementById("settings-fields");
const proxyEl = document.getElementById("proxy-fields");
const proxyTabsEl = document.getElementById("proxy-kind-tabs");
const form = document.getElementById("settings-form");
const statusEl = document.getElementById("settings-status");
const btnClear = document.getElementById("btn-clear-settings");

const CLI_ORDER = ["pi", "claude", "agent", "devin", "codex"];
const PROXY_ORDER = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

const KIND_LABELS = {
  pi: "pi",
  claude: "Claude",
  agent: "Cursor",
  devin: "Devin",
  codex: "Codex",
};

let activeProxyKind = "pi";

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
}

function renderCli(cliPaths) {
  fieldsEl.innerHTML = CLI_ORDER.map((key) => {
    const row = cliPaths[key];
    if (!row) return "";
    const resolved = row.resolved
      ? `<span class="settings-hint muted">解析到 <code>${escapeHtml(row.resolved)}</code></span>`
      : `<span class="settings-hint muted">未在 PATH / 磁盘上找到</span>`;
    return `
      <label class="settings-row">
        <span class="settings-label">
          <strong>${escapeHtml(row.label || key)}</strong>
          <span class="muted settings-default">默认 <code>${escapeHtml(row.default)}</code></span>
        </span>
        <input
          type="text"
          name="cli-${escapeHtml(key)}"
          data-cli-key="${escapeHtml(key)}"
          value="${escapeHtml(row.override || "")}"
          placeholder="${escapeHtml(row.default)}"
          spellcheck="false"
        />
        ${resolved}
      </label>`;
  }).join("");
}

function proxyHint(row) {
  if (row?.override) {
    return `<span class="settings-hint muted">将注入该 Agent 子进程（日志只记键名）</span>`;
  }
  if (row?.inherited && row.effective) {
    return `<span class="settings-hint muted">继承看板：<code>${escapeHtml(row.effective)}</code></span>`;
  }
  return `<span class="settings-hint muted">空 = 不注入，继承看板进程环境</span>`;
}

function renderProxyTabs() {
  proxyTabsEl.innerHTML = CLI_ORDER.map((kind) => {
    const selected = kind === activeProxyKind;
    return `<button
      type="button"
      class="settings-kind-tab${selected ? " active" : ""}"
      role="tab"
      aria-selected="${selected ? "true" : "false"}"
      data-proxy-kind="${escapeHtml(kind)}"
      id="proxy-tab-${escapeHtml(kind)}"
    >${escapeHtml(KIND_LABELS[kind] || kind)}</button>`;
  }).join("");
}

function renderProxy(proxyEnv) {
  renderProxyTabs();
  proxyEl.innerHTML = CLI_ORDER.map((kind) => {
    const kindMap = proxyEnv[kind] || {};
    const hidden = kind !== activeProxyKind;
    const rows = PROXY_ORDER.map((key) => {
      const row = kindMap[key] || { override: "", effective: "", inherited: false };
      return `
        <label class="settings-row">
          <span class="settings-label">
            <strong><code>${escapeHtml(key)}</code></strong>
          </span>
          <input
            type="text"
            name="proxy-${escapeHtml(kind)}-${escapeHtml(key)}"
            data-proxy-kind="${escapeHtml(kind)}"
            data-proxy-key="${escapeHtml(key)}"
            value="${escapeHtml(row.override || "")}"
            placeholder="留空则继承"
            spellcheck="false"
            autocomplete="off"
          />
          ${proxyHint(row)}
        </label>`;
    }).join("");
    return `
      <div
        class="settings-proxy-panel${hidden ? " hidden" : ""}"
        role="tabpanel"
        data-proxy-panel="${escapeHtml(kind)}"
        aria-labelledby="proxy-tab-${escapeHtml(kind)}"
        ${hidden ? "hidden" : ""}
      >
        <p class="settings-panel-caption muted">
          仅影响 <strong>${escapeHtml(KIND_LABELS[kind] || kind)}</strong>
          （kind=<code>${escapeHtml(kind)}</code>）的 spawn。
        </p>
        <div class="settings-fields">${rows}</div>
      </div>`;
  }).join("");
}

function showProxyKind(kind) {
  if (!CLI_ORDER.includes(kind)) return;
  activeProxyKind = kind;
  for (const btn of proxyTabsEl.querySelectorAll(".settings-kind-tab")) {
    const on = btn.dataset.proxyKind === kind;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  for (const panel of proxyEl.querySelectorAll(".settings-proxy-panel")) {
    const on = panel.dataset.proxyPanel === kind;
    panel.classList.toggle("hidden", !on);
    if (on) panel.removeAttribute("hidden");
    else panel.setAttribute("hidden", "");
  }
}

function renderAll(data) {
  renderCli(data.cliPaths || {});
  renderProxy(data.proxyEnv || {});
}

proxyTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-proxy-kind]");
  if (!btn) return;
  showProxyKind(btn.dataset.proxyKind);
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
  setStatus("已加载。保存后对新 spawn 生效。", true);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cliPaths = {};
  for (const input of fieldsEl.querySelectorAll("input[data-cli-key]")) {
    cliPaths[input.dataset.cliKey] = input.value;
  }
  const proxyEnv = {};
  for (const kind of CLI_ORDER) {
    proxyEnv[kind] = {};
  }
  for (const input of proxyEl.querySelectorAll("input[data-proxy-kind][data-proxy-key]")) {
    const kind = input.dataset.proxyKind;
    const key = input.dataset.proxyKey;
    if (!proxyEnv[kind]) proxyEnv[kind] = {};
    proxyEnv[kind][key] = input.value;
  }
  setStatus("保存中…");
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPaths, proxyEnv }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `保存失败：HTTP ${res.status}`, false);
      return;
    }
    renderAll(data);
    setStatus("已保存。", true);
  } catch (err) {
    setStatus(`保存失败：${err}`, false);
  }
});

btnClear.addEventListener("click", async () => {
  if (!confirm("确定清除全部 CLI 路径与各 Agent 代理覆盖？")) return;
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

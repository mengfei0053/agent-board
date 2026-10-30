const fieldsEl = document.getElementById("settings-fields");
const proxyEl = document.getElementById("proxy-fields");
const form = document.getElementById("settings-form");
const statusEl = document.getElementById("settings-status");
const btnClear = document.getElementById("btn-clear-settings");

const CLI_ORDER = ["pi", "claude", "agent", "devin", "codex"];
const PROXY_ORDER = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY"];

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
      ? `<span class="settings-resolved muted">解析到 <code>${escapeHtml(row.resolved)}</code></span>`
      : `<span class="settings-resolved muted">未在 PATH / 磁盘上找到</span>`;
    return `
      <label class="settings-row">
        <span class="settings-label">
          <strong>${escapeHtml(row.label || key)}</strong>
          <span class="muted">默认 <code>${escapeHtml(row.default)}</code></span>
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

function renderProxy(proxyEnv) {
  proxyEl.innerHTML = PROXY_ORDER.map((key) => {
    const row = proxyEnv[key] || { override: "", effective: "", inherited: false };
    let hint = `<span class="settings-resolved muted">空 = 不注入，继承看板进程环境</span>`;
    if (row.override) {
      hint = `<span class="settings-resolved muted">将注入子进程（日志只记键名）</span>`;
    } else if (row.inherited && row.effective) {
      hint = `<span class="settings-resolved muted">继承中：<code>${escapeHtml(row.effective)}</code></span>`;
    }
    return `
      <label class="settings-row">
        <span class="settings-label">
          <strong><code>${escapeHtml(key)}</code></strong>
        </span>
        <input
          type="text"
          name="proxy-${escapeHtml(key)}"
          data-proxy-key="${escapeHtml(key)}"
          value="${escapeHtml(row.override || "")}"
          placeholder="${escapeHtml(key)}"
          spellcheck="false"
          autocomplete="off"
        />
        ${hint}
      </label>`;
  }).join("");
}

function renderAll(data) {
  renderCli(data.cliPaths || {});
  renderProxy(data.proxyEnv || {});
}

async function load() {
  setStatus("加载中…");
  const res = await fetch("/api/settings");
  if (!res.ok) {
    setStatus(`加载失败：HTTP ${res.status}`, false);
    return;
  }
  const data = await res.json();
  renderAll(data);
  setStatus("已加载当前设置。保存后对新 spawn 生效。", true);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cliPaths = {};
  for (const input of fieldsEl.querySelectorAll("input[data-cli-key]")) {
    cliPaths[input.dataset.cliKey] = input.value;
  }
  const proxyEnv = {};
  for (const input of proxyEl.querySelectorAll("input[data-proxy-key]")) {
    proxyEnv[input.dataset.proxyKey] = input.value;
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
  if (!confirm("确定清除全部 CLI 路径与代理覆盖？")) return;
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

const fieldsEl = document.getElementById("settings-fields");
const form = document.getElementById("settings-form");
const statusEl = document.getElementById("settings-status");
const btnClear = document.getElementById("btn-clear-settings");

const ORDER = ["pi", "claude", "agent", "devin", "codex"];

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

function render(cliPaths) {
  fieldsEl.innerHTML = ORDER.map((key) => {
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
          name="${escapeHtml(key)}"
          data-key="${escapeHtml(key)}"
          value="${escapeHtml(row.override || "")}"
          placeholder="${escapeHtml(row.default)}"
          spellcheck="false"
        />
        ${resolved}
      </label>`;
  }).join("");
}

async function load() {
  setStatus("加载中…");
  const res = await fetch("/api/settings");
  if (!res.ok) {
    setStatus(`加载失败：HTTP ${res.status}`, false);
    return;
  }
  const data = await res.json();
  render(data.cliPaths || {});
  setStatus("已加载当前设置。保存后对新 spawn 生效。", true);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const cliPaths = {};
  for (const input of fieldsEl.querySelectorAll("input[data-key]")) {
    cliPaths[input.dataset.key] = input.value;
  }
  setStatus("保存中…");
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliPaths }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `保存失败：HTTP ${res.status}`, false);
      return;
    }
    render(data.cliPaths || {});
    setStatus("已保存。", true);
  } catch (err) {
    setStatus(`保存失败：${err}`, false);
  }
});

btnClear.addEventListener("click", async () => {
  if (!confirm("确定清除全部 CLI 路径覆盖，恢复默认命令名？")) return;
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
    render(data.cliPaths || {});
    setStatus("已恢复默认。", true);
  } catch (err) {
    setStatus(`恢复失败：${err}`, false);
  }
});

load().catch((err) => setStatus(`加载失败：${err}`, false));

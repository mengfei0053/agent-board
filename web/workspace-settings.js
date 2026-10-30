const form = document.getElementById("ws-settings-form");
const statusEl = document.getElementById("ws-settings-status");
const subtitleEl = document.getElementById("ws-subtitle");
const nameInput = document.getElementById("ws-name");
const pathInput = document.getElementById("ws-path");
const promptInput = document.getElementById("ws-system-prompt");
const skillsInput = document.getElementById("ws-skills");
const mcpInput = document.getElementById("ws-mcp");
const btnClear = document.getElementById("btn-clear-ws-settings");

function workspaceIdFromPath() {
  const m = location.pathname.match(/^\/workspaces\/([^/]+)\/settings\/?$/);
  return m ? decodeURIComponent(m[1]) : "";
}

const workspaceId = workspaceIdFromPath();

function setStatus(msg, ok) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("ok", ok === true);
  statusEl.classList.toggle("bad", ok === false);
  statusEl.classList.toggle("muted", ok !== true && ok !== false);
}

function fillForm(ws) {
  nameInput.value = ws.name || "";
  pathInput.value = ws.path || "";
  const s = ws.settings || {};
  promptInput.value = s.systemPrompt || "";
  skillsInput.value = Array.isArray(s.skills) ? s.skills.join("\n") : "";
  mcpInput.value = s.mcp || "";
  subtitleEl.textContent = `${ws.name} · ${ws.path}`;
  document.title = `空间设置 · ${ws.name} · agent-board`;
}

async function load() {
  if (!workspaceId) {
    setStatus("无效的工作区 ID", false);
    form.querySelectorAll("input,textarea,button").forEach((el) => {
      el.disabled = true;
    });
    return;
  }
  setStatus("加载中…");
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    fillForm(data.workspace);
    setStatus("已加载，修改后点保存", null);
  } catch (err) {
    setStatus(String(err.message || err), false);
  }
}

function collectSettings() {
  const systemPrompt = promptInput.value;
  const skills = skillsInput.value
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const mcp = mcpInput.value;
  return { systemPrompt, skills, mcp };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("保存中…");
  try {
    const body = {
      name: nameInput.value.trim(),
      path: pathInput.value.trim(),
      settings: collectSettings(),
    };
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    fillForm(data.workspace);
    setStatus("已保存", true);
  } catch (err) {
    setStatus(String(err.message || err), false);
  }
});

btnClear.addEventListener("click", async () => {
  if (!window.confirm("清空本空间的提示词、Skills、MCP？名称与路径保留。")) return;
  promptInput.value = "";
  skillsInput.value = "";
  mcpInput.value = "";
  setStatus("保存中…");
  try {
    const body = {
      name: nameInput.value.trim(),
      path: pathInput.value.trim(),
      settings: { systemPrompt: "", skills: [], mcp: "" },
    };
    const res = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    fillForm(data.workspace);
    setStatus("空间配置已清空", true);
  } catch (err) {
    setStatus(String(err.message || err), false);
  }
});

load();

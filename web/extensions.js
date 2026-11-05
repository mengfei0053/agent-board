const labels = { pi: "pi", claude: "Claude", cursor: "Cursor", devin: "Devin", codex: "Codex" };
const agents = Object.keys(labels);
const el = id => document.getElementById(id);
let documentState;
let resource = "mcp";
let busy = false;
const editor = el("extension-editor");

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function status(text, bad = false) {
  el("extensions-status").textContent = text;
  el("extensions-status").classList.toggle("bad", bad);
}

async function request(path, body) {
  const response = await fetch(`/api/settings/extensions${path}`, {
    method: body ? "POST" : "GET",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `请求失败：HTTP ${response.status}`);
  return result;
}

function showResults(prefix) {
  const failed = (documentState.syncResults || []).filter(result => !result.ok);
  status(failed.length ? `${prefix}；部分分发失败：${failed.map(result => `${labels[result.agent]} ${result.resource}：${result.error}`).join("；")}。处理后可重新同步。` : prefix, failed.length > 0);
}

function setBusy(value) {
  busy = value;
  el("extensions-manager").querySelectorAll("button, input, select").forEach(control => { control.disabled = value || (!documentState && control.id !== "extensions-reload"); });
  el("extension-editor-save").disabled = value;
  el("extension-editor-cancel").disabled = value;
}

async function mutate(action, body) {
  if (busy || !documentState) return false;
  setBusy(true);
  status("正在保存并分发…");
  try {
    documentState = await request(`/${action}`, { ...body, revision: documentState.revision });
    render();
    showResults("已保存");
    return true;
  } catch (error) {
    status(error.message, true);
    throw error;
  } finally { setBusy(false); }
}

function render() {
  const query = el("extensions-search").value.trim().toLowerCase();
  const rows = documentState[resource].filter(entry => `${entry.name} ${entry.source || ""} ${entry.description || ""} ${entry.config?.command || entry.config?.url || ""}`.toLowerCase().includes(query));
  const table = node("table", undefined, "extensions-table");
  const head = node("tr");
  [resource === "mcp" ? "MCP 服务器" : "Skill", ...Object.values(labels), "操作"].forEach(title => head.append(node("th", title)));
  table.append(node("thead"));
  table.tHead.append(head);
  const tbody = node("tbody");
  for (const entry of rows) {
    const row = node("tr");
    const info = node("td");
    info.append(node("strong", entry.name));
    const description = resource === "mcp" ? entry.config.url || entry.config.command : entry.description;
    const descriptionEl = node("div", description, "muted extension-description");
    descriptionEl.title = description || "";
    info.append(descriptionEl);
    if (entry.source) {
      const sourceEl = node("div", entry.source, "muted extension-description");
      sourceEl.title = entry.source;
      info.append(sourceEl);
    }
    row.append(info);
    for (const agent of agents) {
      const cell = node("td");
      const toggle = node("input");
      toggle.type = "checkbox";
      toggle.checked = entry.apps.includes(agent);
      toggle.setAttribute("aria-label", `${entry.name} 启用到 ${labels[agent]}`);
      toggle.dataset.extensionName = entry.name;
      toggle.dataset.extensionAgent = agent;
      const failure = (documentState.syncResults || []).find(result => result.agent === agent && result.resource === resource && !result.ok);
      if (failure) { cell.classList.add("extension-sync-failed"); cell.title = failure.error; }
      toggle.addEventListener("change", async () => {
        const apps = toggle.checked ? [...entry.apps, agent] : entry.apps.filter(item => item !== agent);
        try { await mutate("set-apps", { resource, name: entry.name, apps, agent, enabled: toggle.checked }); }
        catch { toggle.checked = entry.apps.includes(agent); }
      });
      cell.append(toggle);
      row.append(cell);
    }
    const actions = node("td");
    if (resource === "mcp") {
      const edit = node("button", "编辑", "settings-mini-btn secondary");
      edit.type = "button";
      edit.addEventListener("click", () => openEditor(entry));
      actions.append(edit);
    }
    const remove = node("button", resource === "mcp" ? "删除" : "卸载", "settings-mini-btn danger-ish");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      if (!confirm(`确定${resource === "mcp" ? "删除" : "卸载"} ${entry.name} 并从目标 Agent 移除？${resource === "skills" ? "主副本保留，可用于恢复。" : ""}`)) return;
      try { await mutate("delete", { resource, name: entry.name }); } catch { /* Status already displays the error. */ }
    });
    actions.append(remove);
    row.append(actions);
    tbody.append(row);
  }
  table.append(tbody);
  el("extensions-list").replaceChildren(rows.length ? table : node("p", query ? "没有匹配的扩展。" : `暂无${resource === "mcp" ? " MCP，添加或从应用导入即可统一管理。" : " Skill，可从本机或 GitHub 安装。"}`, "muted"));
  el("extensions-add").textContent = resource === "mcp" ? "＋ 添加 MCP" : "＋ 安装 Skill";
  el("extensions-import").textContent = resource === "mcp" ? "从应用导入 MCP" : "导入本机 Skill";
  el("extensions-import-agent").hidden = resource !== "mcp";
  for (const key of ["mcp", "skills"]) {
    el(`extensions-tab-${key}`).classList.toggle("active", resource === key);
    el(`extensions-tab-${key}`).setAttribute("aria-selected", String(resource === key));
  }
  el("extensions-list").setAttribute("aria-labelledby", `extensions-tab-${resource}`);
}

function openEditor(entry, localPath) {
  el("extension-editor-form").reset();
  el("extension-editor-title").textContent = resource === "mcp" ? (entry ? "编辑 MCP" : "添加 MCP") : "安装 Skill";
  el("extension-name").value = entry?.name || "";
  el("extension-name").readOnly = resource === "mcp" && Boolean(entry);
  el("extension-mcp-fields").hidden = resource !== "mcp";
  el("extension-skill-fields").hidden = resource !== "skills";
  el("extension-config").value = JSON.stringify(entry?.config || { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }, null, 2);
  el("extension-skill-path").value = localPath || "";
  el("extension-editor-status").textContent = "";
  el("extension-apps").replaceChildren(...agents.map(agent => {
    const label = node("label");
    const input = node("input");
    input.type = "checkbox";
    input.value = agent;
    input.checked = entry?.apps?.includes(agent) || false;
    label.append(input, document.createTextNode(labels[agent]));
    return label;
  }));
  editor.showModal();
  el("extension-name").focus();
}

el("extension-editor-form").addEventListener("submit", async event => {
  event.preventDefault();
  el("extension-editor-status").textContent = "";
  try {
    const apps = [...el("extension-apps").querySelectorAll("input:checked")].map(input => input.value);
    const body = { name: el("extension-name").value.trim(), apps };
    if (resource === "mcp" && !el("extension-name").readOnly && documentState.mcp.some(entry => entry.name === body.name)) throw new Error("MCP 名称已存在，请关闭窗口后编辑已有条目。");
    if (resource === "mcp") body.config = JSON.parse(el("extension-config").value);
    else Object.assign(body, { path: el("extension-skill-path").value.trim(), url: el("extension-skill-url").value.trim(), ref: el("extension-skill-ref").value.trim(), subdir: el("extension-skill-subdir").value.trim() });
    if (await mutate(resource === "mcp" ? "save-mcp" : "install-skill", body)) editor.close();
  } catch (error) { el("extension-editor-status").textContent = error instanceof SyntaxError ? "JSON 格式不正确，请检查后重试。" : error.message; }
});
el("extension-editor-cancel").addEventListener("click", () => editor.close());
editor.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
el("extensions-add").addEventListener("click", () => openEditor());
el("extensions-sync").addEventListener("click", async () => { try { await mutate("sync", {}); } catch { /* Reported above. */ } });
el("extensions-search").addEventListener("input", () => { if (documentState) render(); });
for (const kind of ["mcp", "skills"]) el(`extensions-tab-${kind}`).addEventListener("click", () => { resource = kind; if (documentState) render(); });
el("extension-local-close").addEventListener("click", () => el("extension-local-skills").close());
el("extensions-import").addEventListener("click", async () => {
  try {
    if (resource === "mcp") { await mutate("import-mcp", { agent: el("extensions-import-agent").value }); return; }
    const { skills } = await request("/local-skills");
    el("extension-local-list").replaceChildren(...(skills.length ? skills.map(skill => {
      const button = node("button", `${skill.name} · ${labels[skill.agent] || "管理中心（已卸载）"}`, "secondary");
      button.type = "button";
      button.title = skill.path;
      button.addEventListener("click", () => { el("extension-local-skills").close(); openEditor({ name: skill.name, apps: [] }, skill.path); });
      return button;
    }) : [node("p", "未发现可导入的本机技能；可通过安装 Skill 填写其他目录。", "muted")]));
    el("extension-local-skills").showModal();
  } catch (error) { status(error.message, true); }
});

async function load() {
  setBusy(true);
  try {
    documentState = await request("");
    render();
    el("extensions-paths").replaceChildren(...documentState.agents.map(agent => node("p", `${labels[agent.id]}：MCP ${agent.mcp}；Skills ${agent.skills}`)), node("p", `Skill 主副本：${documentState.skillStore}`));
    showResults("已加载");
  } catch (error) { status(`扩展配置加载失败：${error.message}`, true); }
  finally { setBusy(false); }
}
el("extensions-reload").addEventListener("click", load);
load();

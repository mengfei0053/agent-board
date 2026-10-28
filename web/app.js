import { renderMarkdown } from "./markdown.js";

const emptyEl = document.getElementById("empty");
const form = document.getElementById("create-form");
const formError = document.getElementById("form-error");
const searchEl = document.getElementById("search");
const createModal = document.getElementById("create-modal");
const detailModal = document.getElementById("detail-modal");
const detailTitle = document.getElementById("detail-title");
const detailSub = document.getElementById("detail-sub");
const detailMeta = document.getElementById("detail-meta");
const detailMetaGrid = document.getElementById("detail-meta-grid");
const detailOutput = document.getElementById("detail-output");
const detailError = document.getElementById("detail-error");
const outputHint = document.getElementById("output-hint");
const detailSidejobsSection = document.getElementById("detail-sidejobs-section");
const detailSidejobs = document.getElementById("detail-sidejobs");
const sidejobsHint = document.getElementById("sidejobs-hint");
const logEl = document.getElementById("log");
const logCount = document.getElementById("log-count");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const deleteBtn = document.getElementById("delete-btn");
const continueRow = document.getElementById("continue-row");
const continueBtn = document.getElementById("continue-btn");
const continuePrompt = document.getElementById("continue-prompt");
const continueHint = document.getElementById("continue-hint");
const continueError = document.getElementById("continue-error");
const bulkBar = document.getElementById("bulk-bar");
const wsListEl = document.getElementById("ws-list");
const wsEmptyEl = document.getElementById("ws-empty");
const wsBannerName = document.getElementById("ws-banner-name");
const wsBannerPath = document.getElementById("ws-banner-path");
const wsModal = document.getElementById("ws-modal");
const wsForm = document.getElementById("ws-form");
const wsFormError = document.getElementById("ws-form-error");
const wsNameInput = document.getElementById("ws-name");
const wsPathInput = document.getElementById("ws-path");
const createWsHint = document.getElementById("create-ws-hint");
const bulkCount = document.getElementById("bulk-count");

/** @type {Map<string, any>} */
const tasks = new Map();
/** @type {Map<string, any>} */
const workspaces = new Map();
/** @type {Set<string>} */
const selected = new Set();
let selectedId = null;
/** @type {string|null} */
let selectedWorkspaceId = localStorage.getItem("agent-board.workspaceId") || null;
let query = "";
let dragTaskId = null;
/** @type {string|null} */
let editingWorkspaceId = null;
/** @type {(path: string) => void} */
let folderPickTarget = null;
/** @type {"draft"|"todo"} */
let createMode = "draft";
const createTitle = document.getElementById("create-title");
const createHint = document.getElementById("create-hint");
const createSubmit = document.getElementById("create-submit");

const LANES = ["draft", "todo", "running", "done"];

const TAB_STATUSES = {
  draft: ["draft"],
  todo: ["queued"],
  running: ["running", "blocked"],
  done: ["succeeded", "failed", "stopped"],
};

const STATUS_LABEL = {
  draft: "草稿",
  queued: "Todo",
  running: "进行中",
  blocked: "等待确认",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function iterationOf(t) {
  return typeof t?.iteration === "number" && t.iteration >= 1 ? t.iteration : 1;
}

function tabOf(status) {
  for (const lane of LANES) {
    if (TAB_STATUSES[lane].includes(status)) return lane;
  }
  return "done";
}

function isUndeletable(task) {
  return task?.status === "queued" || task?.status === "running";
}

function previewText(t) {
  if (t.status === "failed" || t.status === "stopped") {
    const err = t.error || (t.status === "stopped" ? "已停止" : "失败");
    return { text: err, error: true };
  }
  if (t.summary && !["starting", "agent settled", "continuing"].some((x) => String(t.summary).startsWith(x))) {
    return { text: t.summary, error: false };
  }
  const latest =
    (Array.isArray(t.outputs) && t.outputs.length
      ? t.outputs[t.outputs.length - 1]?.text
      : null) || t.output;
  if (latest) return { text: String(latest).replace(/\s+/g, " ").trim(), error: false };
  return { text: "", error: false };
}

function matchesQuery(t) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t.title, t.cwd, t.prompt, t.kind, t.model, t.status, t.summary, t.output, STATUS_LABEL[t.status], `迭代${iterationOf(t)}`]
    .filter(Boolean)
    .some((x) => String(x).toLowerCase().includes(q));
}


const DISPLAY_TZ = "Asia/Shanghai";

/** @param {string|undefined|null} iso */
function formatLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: DISPLAY_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}

/** @param {any} t */
function timeRowsHtml(t) {
  const start = formatLocal(t.startedAt);
  const end = formatLocal(t.endedAt);
  const bits = [];
  if (start) bits.push(`<span class="time-start" title="开始时间">开始 ${escapeHtml(start)}</span>`);
  if (end) bits.push(`<span class="time-end" title="结束时间">结束 ${escapeHtml(end)}</span>`);
  if (!bits.length) return "";
  return `<div class="card-times">${bits.join("")}</div>`;
}

function visibleTaskIds() {
  return tasksInCurrentWorkspace().filter(matchesQuery).map((t) => t.id);
}

function updateCounts() {
  const all = tasksInCurrentWorkspace().filter(matchesQuery);
  const c = { draft: 0, todo: 0, running: 0, done: 0 };
  for (const t of all) c[tabOf(t.status)]++;
  for (const key of LANES) {
    const el = document.getElementById(`count-${key}`);
    if (el) el.textContent = String(c[key]);
  }
}

function updateBulkBar() {
  for (const id of [...selected]) {
    if (!tasks.has(id)) selected.delete(id);
  }
  const n = selected.size;
  bulkCount.textContent = `已选 ${n}`;
  bulkBar.classList.toggle("hidden", n === 0);
}

function setSelected(id, on) {
  if (on) selected.add(id);
  else selected.delete(id);
  updateBulkBar();
}

function makeCard(t) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "card has-check" + (selected.has(t.id) ? " selected" : "");
  btn.dataset.id = t.id;
  btn.draggable = true;
  const iter = iterationOf(t);
  const statusText = STATUS_LABEL[t.status] || t.status;
  const preview = previewText(t);
  const summaryHtml = preview.text
    ? `<div class="card-summary ${preview.error ? "is-error" : "has-output"}">${escapeHtml(preview.text)}</div>`
    : "";
  const timesHtml = timeRowsHtml(t);
  btn.innerHTML = `
      <input type="checkbox" class="card-check" ${selected.has(t.id) ? "checked" : ""} aria-label="选择任务" />
      <div class="card-top">
        <p class="card-title">${escapeHtml(t.title)}</p>
        <span class="badge ${t.status}">${escapeHtml(statusText)}</span>
      </div>
      <div class="card-meta">${escapeHtml(t.cwd)}</div>
      ${timesHtml}
      <div class="card-prompt">${escapeHtml(t.prompt)}</div>
      ${summaryHtml}
      <div class="card-footer">
        <span class="kind-pill">${escapeHtml(t.kind)}</span>
        <span class="iter-pill" title="迭代次数">迭代 ${iter}</span>
        ${(t.sideJobs && t.sideJobs.length) ? `<span class="sidejob-pill" title="后台 / Monitor / 子代理">${t.sideJobs.length} 后台</span>` : ""}
        <span class="model-pill" title="${escapeHtml(t.model || "")}">${escapeHtml(t.model || "解析中…")}</span>
      </div>`;
  const check = btn.querySelector(".card-check");
  check.addEventListener("click", (e) => e.stopPropagation());
  check.addEventListener("change", (e) => {
    e.stopPropagation();
    setSelected(t.id, check.checked);
    btn.classList.toggle("selected", check.checked);
  });
  btn.addEventListener("dragstart", (e) => {
    dragTaskId = t.id;
    btn.classList.add("dragging");
    e.dataTransfer.setData("text/plain", t.id);
    e.dataTransfer.effectAllowed = "move";
  });
  btn.addEventListener("dragend", () => {
    dragTaskId = null;
    btn.classList.remove("dragging");
    document.querySelectorAll(".lane.drag-over, .lane-body.drag-over").forEach((el) => {
      el.classList.remove("drag-over");
    });
  });
  btn.onclick = (e) => {
    if (e.target === check) return;
    openDetail(t.id);
  };
  return btn;
}

function ensureLaneSelectButtons() {
  for (const key of LANES) {
    const head = document.querySelector(`.lane[data-tab="${key}"] .lane-head`);
    if (!head || head.querySelector(".lane-select")) continue;
    const actions = document.createElement("div");
    actions.className = "lane-head-actions";
    const count = head.querySelector(".count");
    if (count) count.remove();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lane-select";
    btn.textContent = "全选";
    btn.title = "全选本泳道（当前筛选）";
    btn.onclick = (e) => {
      e.stopPropagation();
      const ids = tasksInCurrentWorkspace()
        .filter((t) => matchesQuery(t) && tabOf(t.status) === key)
        .map((t) => t.id);
      for (const id of ids) selected.add(id);
      updateBulkBar();
      renderList();
    };
    actions.appendChild(btn);
    if (count) actions.appendChild(count);
    head.appendChild(actions);
  }
}

function bindLaneDropTargets() {
  for (const key of LANES) {
    const lane = document.querySelector(`.lane[data-tab="${key}"]`);
    const body = document.getElementById(`list-${key}`);
    if (!lane || lane.dataset.dropBound) continue;
    lane.dataset.dropBound = "1";
    const onDragOver = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      lane.classList.add("drag-over");
      body?.classList.add("drag-over");
    };
    const onDragLeave = (e) => {
      if (lane.contains(e.relatedTarget)) return;
      lane.classList.remove("drag-over");
      body?.classList.remove("drag-over");
    };
    const onDrop = async (e) => {
      e.preventDefault();
      lane.classList.remove("drag-over");
      body?.classList.remove("drag-over");
      const id = e.dataTransfer.getData("text/plain") || dragTaskId;
      if (!id) return;
      const t = tasks.get(id);
      if (!t) return;
      if (tabOf(t.status) === key) return;
      await moveToLane(id, key);
    };
    lane.addEventListener("dragover", onDragOver);
    lane.addEventListener("dragleave", onDragLeave);
    lane.addEventListener("drop", onDrop);
  }
}

async function moveToLane(id, lane) {
  const res = await fetch(`/api/tasks/${id}/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.alert(data.error || res.statusText);
    return;
  }
  if (data.task) {
    tasks.set(data.task.id, data.task);
    renderList();
    if (selectedId === id && !detailModal.classList.contains("hidden")) {
      paintDetail(data.task, logEl.textContent ? logEl.textContent.split("\n").filter(Boolean) : []);
    }
  }
}

function tasksInCurrentWorkspace() {
  const out = [];
  for (const t of tasks.values()) {
    if (selectedWorkspaceId && t.workspaceId !== selectedWorkspaceId) continue;
    out.push(t);
  }
  return out;
}

function renderList() {
  ensureLaneSelectButtons();
  bindLaneDropTargets();
  updateCounts();
  const buckets = { draft: [], todo: [], running: [], done: [] };
  for (const t of tasksInCurrentWorkspace()) {
    if (!matchesQuery(t)) continue;
    buckets[tabOf(t.status)].push(t);
  }
  let total = 0;
  for (const key of LANES) {
    const el = document.getElementById(`list-${key}`);
    el.innerHTML = "";
    const items = buckets[key].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    total += items.length;
    for (const t of items) el.appendChild(makeCard(t));
  }
  emptyEl.hidden = total > 0;
  updateBulkBar();
}

function openCreate(mode = "draft") {
  if (!selectedWorkspaceId || !workspaces.get(selectedWorkspaceId)) {
    window.alert("请先在左侧选择或新建一个工作区");
    return;
  }
  createMode = mode === "todo" ? "todo" : "draft";
  formError.hidden = true;
  const ws = workspaces.get(selectedWorkspaceId);
  if (createWsHint) {
    createWsHint.textContent = `工作区：${ws.name} · ${ws.path}`;
  }
  if (createMode === "todo") {
    createTitle.textContent = "新建 Todo";
    createHint.textContent = "创建后直接进入 Todo 并开始执行（使用当前工作区路径）。";
    createSubmit.textContent = "创建并开始";
  } else {
    createTitle.textContent = "新建草稿";
    createHint.textContent = "保存后进入「草稿」列；拖到 Todo 才会开始执行（使用当前工作区路径）。";
    createSubmit.textContent = "保存草稿";
  }
  createModal.classList.remove("hidden");
}
function closeCreate() {
  createModal.classList.add("hidden");
}

async function openDetail(id) {
  selectedId = id;
  detailModal.classList.remove("hidden");
  const res = await fetch(`/api/tasks/${id}`);
  if (!res.ok) return;
  const data = await res.json();
  tasks.set(id, data.task);
  paintDetail(data.task, data.log || []);
  renderList();
}

function canContinue(task) {
  return !["draft", "queued", "running"].includes(task.status);
}

function metaItem(k, v, wide = false) {
  return `<div class="meta-item${wide ? " meta-wide" : ""}"><span class="meta-k">${escapeHtml(k)}</span><span class="meta-v${k === "工作目录" ? " cwd" : ""}">${escapeHtml(v ?? "—")}</span></div>`;
}

function paintOutput(task) {
  const running = ["queued", "running", "blocked"].includes(task.status);
  const hasOutput = Boolean(task.output && task.output.trim()) ||
    (Array.isArray(task.outputs) && task.outputs.some((o) => o?.text?.trim()));
  if (task.status === "failed" || (task.status === "stopped" && !hasOutput)) {
    detailError.hidden = false;
    const bits = [];
    if (task.error) bits.push(task.error);
    if (task.exitCode != null && task.exitCode !== 0) bits.push(`退出码 ${task.exitCode}`);
    if (!bits.length) bits.push(task.status === "stopped" ? "已由用户停止" : "任务失败");
    detailError.textContent = bits.join("\n");
  } else {
    detailError.hidden = true;
    detailError.textContent = "";
  }

  let turns = Array.isArray(task.outputs) ? task.outputs.filter((o) => o && String(o.text || "").trim()) : [];
  if (!turns.length && task.output && task.output.trim()) {
    turns = [{ iteration: iterationOf(task), text: task.output, at: task.endedAt || task.updatedAt }];
  }

  if (turns.length) {
    detailOutput.classList.remove("empty-output");
    detailOutput.innerHTML = turns.map((o) => {
      const when = formatLocal(o.at) || "";
      const head = `迭代 ${o.iteration}${when ? " · " + when : ""}`;
      const live = running && o.iteration === iterationOf(task) ? ' <span class="turn-live">实时</span>' : "";
      return `<article class="output-turn">
        <header class="output-turn-head"><span>${escapeHtml(head)}</span>${live}</header>
        <div class="output-turn-body md-body">${renderMarkdown(o.text)}</div>
      </article>`;
    }).join("");
    outputHint.textContent = running
      ? `共 ${turns.length} 轮 · 当前迭代 ${iterationOf(task)} 更新中`
      : `共 ${turns.length} 轮`;
  } else if (running) {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "模型输出生成中…";
    outputHint.textContent = "等待助手回复";
  } else if (task.status === "draft") {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "草稿尚未执行。拖到 Todo 或点击「开始任务」。";
    outputHint.textContent = "";
  } else if (task.status === "failed") {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "没有可用的助手输出，请查看上方错误与原始日志。";
    outputHint.textContent = "";
  } else {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "暂无抽取到的模型输出。";
    outputHint.textContent = "";
  }
}


const SIDE_KIND_LABEL = {
  agent: "子代理",
  task: "Task",
  monitor: "Monitor",
  background: "后台",
  other: "其他",
};
const SIDE_STATUS_LABEL = {
  running: "进行中",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止",
  unknown: "未知",
};

function paintSideJobs(task) {
  const jobs = Array.isArray(task.sideJobs) ? task.sideJobs : [];
  if (!detailSidejobsSection || !detailSidejobs) return;
  if (!jobs.length) {
    detailSidejobsSection.hidden = true;
    detailSidejobs.innerHTML = "";
    if (sidejobsHint) sidejobsHint.textContent = "";
    return;
  }
  detailSidejobsSection.hidden = false;
  const running = jobs.filter((j) => j.status === "running").length;
  if (sidejobsHint) {
    sidejobsHint.textContent = running
      ? `${jobs.length} 项 · ${running} 进行中`
      : `${jobs.length} 项`;
  }
  detailSidejobs.innerHTML = jobs.map((j) => {
    const kind = SIDE_KIND_LABEL[j.kind] || j.kind || "其他";
    const st = SIDE_STATUS_LABEL[j.status] || j.status || "";
    const start = formatLocal(j.startedAt);
    const end = formatLocal(j.endedAt);
    const times = [
      start ? `开始 ${escapeHtml(start)}` : "",
      end ? `结束 ${escapeHtml(end)}` : "",
    ].filter(Boolean).join(" · ");
    return `<article class="sidejob-card status-${escapeHtml(j.status || "unknown")}">
      <div class="sidejob-top">
        <span class="sidejob-kind">${escapeHtml(kind)}</span>
        <span class="badge ${escapeHtml(j.status === "running" ? "running" : j.status === "succeeded" ? "succeeded" : j.status === "failed" ? "failed" : "stopped")}">${escapeHtml(st)}</span>
      </div>
      <p class="sidejob-title">${escapeHtml(j.title || j.toolName || j.id)}</p>
      ${j.summary ? `<p class="sidejob-summary">${escapeHtml(j.summary)}</p>` : ""}
      <div class="sidejob-meta">
        ${j.toolName ? `<span class="kind-pill">${escapeHtml(j.toolName)}</span>` : ""}
        ${times ? `<span class="sidejob-times">${times}</span>` : ""}
      </div>
    </article>`;
  }).join("");
}

function paintDetail(task, logLines) {
  const iter = iterationOf(task);
  const statusText = STATUS_LABEL[task.status] || task.status;
  detailTitle.textContent = task.title;
  detailSub.textContent = `${task.kind} · ${statusText} · 迭代 ${iter}`;

  const startLabel = formatLocal(task.startedAt) || "—";
  const endLabel = formatLocal(task.endedAt) || "—";
  detailMetaGrid.innerHTML = [
    metaItem("状态", statusText),
    metaItem("迭代", String(iter)),
    metaItem("开始时间", startLabel),
    metaItem("结束时间", endLabel),
    metaItem("Agent", task.kind),
    metaItem("模型", task.model || "—"),
    metaItem("PID", task.pid != null ? String(task.pid) : "—"),
    metaItem("退出码", task.exitCode != null ? String(task.exitCode) : "—"),
    metaItem("会话", task.sessionId || "—", true),
    metaItem("工作区", (task.workspaceId && workspaces.get(task.workspaceId)?.name) || task.workspaceId || "—"),
    metaItem("工作目录", task.cwd, true),
    metaItem("任务内容", task.prompt, true),
  ].join("");

  detailMeta.textContent = JSON.stringify(
    {
      id: task.id,
      kind: task.kind,
      status: task.status,
      iteration: iter,
      sessionId: task.sessionId,
      workspaceId: task.workspaceId,
      cwd: task.cwd,
      model: task.model,
      pid: task.pid,
      lastEvent: task.lastEvent,
      error: task.error,
      exitCode: task.exitCode,
      summary: task.summary,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      sideJobs: task.sideJobs,
      outputs: task.outputs,
    },
    null,
    2,
  );

  paintOutput(task);

  const lines = Array.isArray(logLines) ? logLines : [];
  logEl.textContent = lines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
  logCount.textContent = lines.length ? `（${lines.length} 行）` : "";

  startBtn.hidden = task.status !== "draft";
  stopBtn.hidden = !["queued", "running", "blocked"].includes(task.status);
  deleteBtn.hidden = isUndeletable(task);

  const showContinue = canContinue(task);
  continueRow.hidden = task.status === "draft";
  continueBtn.disabled = !showContinue;
  continueHint.textContent = task.status === "draft"
    ? ""
    : showContinue
      ? task.sessionId
        ? `将续会话 ${task.sessionId}`
        : "无 sessionId 时将尝试 CLI continue（同目录最近会话）"
      : "任务运行中，请先停止再继续";
  continueError.hidden = true;
}

function closeDetail() {
  detailModal.classList.add("hidden");
  selectedId = null;
}

document.getElementById("btn-new").onclick = () => openCreate("draft");
document.getElementById("btn-new-todo").onclick = () => openCreate("todo");
document.getElementById("create-close").onclick = closeCreate;
document.getElementById("create-cancel").onclick = closeCreate;
document.getElementById("detail-close").onclick = closeDetail;
createModal.addEventListener("click", (e) => { if (e.target === createModal) closeCreate(); });
detailModal.addEventListener("click", (e) => { if (e.target === detailModal) closeDetail(); });

searchEl.addEventListener("input", () => {
  query = searchEl.value;
  renderList();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  if (!selectedWorkspaceId) {
    formError.hidden = false;
    formError.textContent = "未选择工作区";
    return;
  }
  const fd = new FormData(form);
  const body = {
    kind: fd.get("kind"),
    title: fd.get("title") || undefined,
    workspaceId: selectedWorkspaceId,
    model: fd.get("model") || undefined,
    prompt: fd.get("prompt"),
    start: createMode === "todo",
  };
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    formError.hidden = false;
    formError.textContent = data.error || res.statusText;
    return;
  }
  tasks.set(data.task.id, data.task);
  closeCreate();
  renderWorkspaces();
  renderList();
  openDetail(data.task.id);
  form.reset();
});

startBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  await moveToLane(selectedId, "todo");
});

stopBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  const id = selectedId;
  stopBtn.disabled = true;
  const prev = tasks.get(id);
  if (prev && ["queued", "running", "blocked"].includes(prev.status)) {
    const optimistic = { ...prev, status: "stopped", pid: undefined };
    tasks.set(id, optimistic);
    scheduleRenderList();
    schedulePaintDetail(optimistic);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`/api/tasks/${id}/stop`, { method: "POST", signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.task) {
      tasks.set(data.task.id, data.task);
      scheduleRenderList();
      if (selectedId === id) schedulePaintDetail(data.task);
    } else if (!res.ok) {
      console.warn("stop failed", data.error || res.statusText);
    }
  } catch (err) {
    console.warn("stop request error", err);
  } finally {
    clearTimeout(timer);
    stopBtn.disabled = false;
  }
});

deleteBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  const t = tasks.get(selectedId);
  if (!t) return;
  if (isUndeletable(t)) {
    window.alert("Todo/进行中的任务不可删除，请先停止或等其结束");
    return;
  }
  if (!window.confirm(`确认删除任务「${t.title}」？`)) return;
  const res = await fetch("/api/tasks/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [selectedId] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(data.deleted || []).length) {
    window.alert(data.error || res.statusText);
    return;
  }
  for (const id of data.deleted || []) {
    tasks.delete(id);
    selected.delete(id);
  }
  closeDetail();
  renderList();
});

continueBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  continueError.hidden = true;
  continueBtn.disabled = true;
  const body = { prompt: continuePrompt.value.trim() || undefined };
  const res = await fetch(`/api/tasks/${selectedId}/continue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    continueError.hidden = false;
    continueError.textContent = data.error || res.statusText;
    const t = tasks.get(selectedId);
    continueBtn.disabled = t ? !canContinue(t) : false;
    return;
  }
  if (data.task) {
    tasks.set(data.task.id, data.task);
    paintDetail(data.task, logEl.textContent ? logEl.textContent.split("\n").filter(Boolean) : []);
    renderList();
  }
});

document.getElementById("bulk-clear").onclick = () => {
  selected.clear();
  updateBulkBar();
  renderList();
};

document.getElementById("bulk-select-visible").onclick = () => {
  for (const id of visibleTaskIds()) selected.add(id);
  updateBulkBar();
  renderList();
};

document.getElementById("bulk-delete").onclick = async () => {
  const ids = [...selected];
  if (!ids.length) return;
  const blocked = ids.filter((id) => {
    const t = tasks.get(id);
    return t && isUndeletable(t);
  });
  const allowed = ids.filter((id) => !blocked.includes(id));
  if (!allowed.length) {
    window.alert(`选中的 ${blocked.length} 个任务均在 Todo/进行中，不可删除。请先停止或等其结束。`);
    return;
  }
  let msg = `确认删除选中的 ${allowed.length} 个任务？`;
  if (blocked.length) msg += `\n将跳过 ${blocked.length} 个 Todo/进行中任务。`;
  if (!window.confirm(msg)) return;
  const res = await fetch("/api/tasks/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(data.deleted || []).length) {
    window.alert(data.error || res.statusText);
    return;
  }
  for (const id of data.deleted || []) {
    tasks.delete(id);
    selected.delete(id);
    if (selectedId === id) closeDetail();
  }
  const skipped = data.skipped || [];
  if (skipped.length) {
    window.alert(`已删除 ${data.deleted?.length || 0} 个；跳过 ${skipped.length} 个不可删任务（Todo/进行中）。`);
  }
  updateBulkBar();
  renderList();
};

function ensureFolderModal() {
  let modal = document.getElementById("folder-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "folder-modal";
  modal.className = "modal hidden";
  modal.innerHTML = `
    <div class="modal-card">
      <div class="modal-head">
        <strong>选择工作目录</strong>
        <button type="button" class="icon-btn" id="folder-close" aria-label="关闭">×</button>
      </div>
      <div class="folder-path" id="folder-path"></div>
      <div class="folder-actions">
        <button type="button" class="secondary" id="folder-up">上级</button>
        <button type="button" class="primary" id="folder-use">使用此目录</button>
      </div>
      <div class="folder-list" id="folder-list"></div>
      <p class="error" id="folder-error" hidden></p>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (ev) => {
    if (ev.target === modal) closeFolderModal();
  });
  document.getElementById("folder-close").onclick = closeFolderModal;
  document.getElementById("folder-up").onclick = () => {
    const parent = modal.dataset.parent;
    if (parent) loadFolder(parent);
  };
  document.getElementById("folder-use").onclick = () => {
    const path = modal.dataset.path || "";
    if (folderPickTarget) folderPickTarget(path);
    else if (wsPathInput) wsPathInput.value = path;
    closeFolderModal();
  };
  return modal;
}

function closeFolderModal() {
  document.getElementById("folder-modal")?.classList.add("hidden");
}

async function loadFolder(path) {
  const modal = ensureFolderModal();
  const err = document.getElementById("folder-error");
  err.hidden = true;
  const q = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/browse${q}`);
  const data = await res.json();
  if (!res.ok) {
    err.hidden = false;
    err.textContent = data.error || res.statusText;
    return;
  }
  modal.dataset.path = data.path;
  modal.dataset.parent = data.parent || "";
  document.getElementById("folder-path").textContent = data.path;
  document.getElementById("folder-up").disabled = !data.parent;
  const list = document.getElementById("folder-list");
  list.innerHTML = "";
  for (const name of data.entries) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "folder-item";
    b.textContent = name + "/";
    b.onclick = () => loadFolder(`${data.path.replace(/\/$/, "")}/${name}`);
    list.appendChild(b);
  }
}

document.getElementById("ws-path-pick")?.addEventListener("click", async () => {
  folderPickTarget = (path) => { wsPathInput.value = path; };
  const modal = ensureFolderModal();
  modal.classList.remove("hidden");
  await loadFolder(wsPathInput.value.trim() || undefined);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("folder-modal")?.classList.contains("hidden")) return closeFolderModal();
  if (!wsModal.classList.contains("hidden")) return closeWsModal();
  if (!createModal.classList.contains("hidden")) return closeCreate();
  if (!detailModal.classList.contains("hidden")) return closeDetail();
});



function ensureSelectedWorkspace(fallbackId) {
  if (selectedWorkspaceId && workspaces.has(selectedWorkspaceId)) return;
  const prefer = fallbackId && workspaces.has(fallbackId) ? fallbackId : null;
  selectedWorkspaceId = prefer || [...workspaces.keys()][0] || null;
  if (selectedWorkspaceId) localStorage.setItem("agent-board.workspaceId", selectedWorkspaceId);
}

function selectWorkspace(id) {
  if (!workspaces.has(id)) return;
  selectedWorkspaceId = id;
  localStorage.setItem("agent-board.workspaceId", id);
  selected.clear();
  if (selectedId) {
    const t = tasks.get(selectedId);
    if (t && t.workspaceId !== id) closeDetail();
  }
  renderWorkspaces();
  renderList();
}

function renderWorkspaces() {
  if (!wsListEl) return;
  wsListEl.innerHTML = "";
  const list = [...workspaces.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (wsEmptyEl) wsEmptyEl.hidden = list.length > 0;
  for (const w of list) {
    let count = 0;
    for (const t of tasks.values()) if (t.workspaceId === w.id) count++;
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-item" + (w.id === selectedWorkspaceId ? " active" : "");
    btn.innerHTML = `<span class="ws-item-name">${escapeHtml(w.name)}</span>
      <span class="ws-item-path">${escapeHtml(w.path)}</span>
      <span class="ws-item-count">${count} 个任务</span>`;
    btn.onclick = () => selectWorkspace(w.id);
    li.appendChild(btn);
    wsListEl.appendChild(li);
  }
  const cur = selectedWorkspaceId ? workspaces.get(selectedWorkspaceId) : null;
  if (wsBannerName) wsBannerName.textContent = cur ? cur.name : "未选择工作区";
  if (wsBannerPath) wsBannerPath.textContent = cur ? cur.path : "请在左侧新建或选择工作区";
  const canMutate = Boolean(cur);
  document.getElementById("ws-edit").disabled = !canMutate;
  document.getElementById("ws-delete").disabled = !canMutate;
}

function openWsModal(mode, ws) {
  editingWorkspaceId = mode === "edit" && ws ? ws.id : null;
  wsFormError.hidden = true;
  document.getElementById("ws-modal-title").textContent = editingWorkspaceId ? "编辑工作区" : "新建工作区";
  wsNameInput.value = ws?.name || "";
  wsPathInput.value = ws?.path || "";
  wsModal.classList.remove("hidden");
  wsNameInput.focus();
}

function closeWsModal() {
  wsModal.classList.add("hidden");
  editingWorkspaceId = null;
}

document.getElementById("ws-add").onclick = () => openWsModal("create");
document.getElementById("ws-edit").onclick = () => {
  const ws = selectedWorkspaceId ? workspaces.get(selectedWorkspaceId) : null;
  if (ws) openWsModal("edit", ws);
};
document.getElementById("ws-delete").onclick = async () => {
  const ws = selectedWorkspaceId ? workspaces.get(selectedWorkspaceId) : null;
  if (!ws) return;
  if (!window.confirm(`删除工作区「${ws.name}」？\n若仍有任务将无法删除。`)) return;
  const res = await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.alert(data.error || res.statusText);
    return;
  }
  workspaces.delete(ws.id);
  ensureSelectedWorkspace();
  renderWorkspaces();
  renderList();
};
document.getElementById("ws-modal-close").onclick = closeWsModal;
document.getElementById("ws-modal-cancel").onclick = closeWsModal;
wsModal.addEventListener("click", (e) => { if (e.target === wsModal) closeWsModal(); });

wsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  wsFormError.hidden = true;
  const body = {
    name: wsNameInput.value.trim(),
    path: wsPathInput.value.trim(),
  };
  const url = editingWorkspaceId ? `/api/workspaces/${editingWorkspaceId}` : "/api/workspaces";
  const method = editingWorkspaceId ? "PATCH" : "POST";
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    wsFormError.hidden = false;
    wsFormError.textContent = data.error || res.statusText;
    return;
  }
  workspaces.set(data.workspace.id, data.workspace);
  selectWorkspace(data.workspace.id);
  closeWsModal();
});

let renderListTimer = null;
let paintDetailTimer = null;

function scheduleRenderList() {
  if (renderListTimer) return;
  renderListTimer = setTimeout(() => {
    renderListTimer = null;
    renderList();
  }, 80);
}

function schedulePaintDetail(task) {
  if (paintDetailTimer) clearTimeout(paintDetailTimer);
  paintDetailTimer = setTimeout(() => {
    paintDetailTimer = null;
    if (task.id !== selectedId || detailModal.classList.contains("hidden")) return;
    const lines = logEl.textContent ? logEl.textContent.split("\n").filter(Boolean) : [];
    paintDetail(task, lines);
  }, 120);
}

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", (ev) => {
    const data = JSON.parse(ev.data);
    tasks.clear();
    for (const t of data.tasks || []) tasks.set(t.id, t);
    workspaces.clear();
    for (const w of data.workspaces || []) workspaces.set(w.id, w);
    ensureSelectedWorkspace();
    renderWorkspaces();
    renderList();
  });
  es.addEventListener("workspace_upsert", (ev) => {
    const data = JSON.parse(ev.data);
    if (data.workspace) {
      workspaces.set(data.workspace.id, data.workspace);
      renderWorkspaces();
    }
  });
  es.addEventListener("workspace_delete", (ev) => {
    const data = JSON.parse(ev.data);
    for (const id of data.workspaceIds || []) workspaces.delete(id);
    ensureSelectedWorkspace();
    renderWorkspaces();
    renderList();
  });
  es.addEventListener("task_upsert", (ev) => {
    const data = JSON.parse(ev.data);
    tasks.set(data.task.id, data.task);
    scheduleRenderList();
    if (data.task.id === selectedId && !detailModal.classList.contains("hidden")) {
      schedulePaintDetail(data.task);
    }
  });
  es.addEventListener("task_delete", (ev) => {
    const data = JSON.parse(ev.data);
    for (const id of data.taskIds || []) {
      tasks.delete(id);
      selected.delete(id);
      if (selectedId === id) closeDetail();
    }
    renderList();
  });
  let logBuf = [];
  let logFlushTimer = null;
  const flushLogBuf = () => {
    logFlushTimer = null;
    if (!logBuf.length) return;
    if (!selectedId || detailModal.classList.contains("hidden")) {
      logBuf = [];
      return;
    }
    const chunk = logBuf.join("\n");
    logBuf = [];
    logEl.textContent += (logEl.textContent ? "\n" : "") + chunk;
    // Cap DOM log size to keep UI responsive
    const maxChars = 400_000;
    if (logEl.textContent.length > maxChars) {
      logEl.textContent = logEl.textContent.slice(-maxChars);
    }
    logEl.scrollTop = logEl.scrollHeight;
    const n = logEl.textContent.split("\n").filter(Boolean).length;
    logCount.textContent = `（${n} 行）`;
  };
  es.addEventListener("task_log", (ev) => {
    const data = JSON.parse(ev.data);
    if (data.taskId !== selectedId || detailModal.classList.contains("hidden")) return;
    logBuf.push(data.line);
    if (logBuf.length > 200) {
      flushLogBuf();
      return;
    }
    if (!logFlushTimer) logFlushTimer = setTimeout(flushLogBuf, 100);
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 1500);
  };
}

connectEvents();
Promise.all([
  fetch("/api/workspaces").then((r) => r.json()),
  fetch("/api/tasks").then((r) => r.json()),
]).then(([wsData, taskData]) => {
  workspaces.clear();
  for (const w of wsData.workspaces || []) workspaces.set(w.id, w);
  for (const t of taskData.tasks || []) tasks.set(t.id, t);
  ensureSelectedWorkspace(wsData.defaultWorkspaceId);
  renderWorkspaces();
  renderList();
});

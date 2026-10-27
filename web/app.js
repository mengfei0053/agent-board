const emptyEl = document.getElementById("empty");
const form = document.getElementById("create-form");
const formError = document.getElementById("form-error");
const searchEl = document.getElementById("search");
const createModal = document.getElementById("create-modal");
const detailModal = document.getElementById("detail-modal");
const detailTitle = document.getElementById("detail-title");
const detailSub = document.getElementById("detail-sub");
const detailMeta = document.getElementById("detail-meta");
const logEl = document.getElementById("log");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const deleteBtn = document.getElementById("delete-btn");
const continueRow = document.getElementById("continue-row");
const continueBtn = document.getElementById("continue-btn");
const continuePrompt = document.getElementById("continue-prompt");
const continueHint = document.getElementById("continue-hint");
const continueError = document.getElementById("continue-error");
const cwdInput = document.getElementById("cwd-input");
const cwdPick = document.getElementById("cwd-pick");
const bulkBar = document.getElementById("bulk-bar");
const bulkCount = document.getElementById("bulk-count");

/** @type {Map<string, any>} */
const tasks = new Map();
/** @type {Set<string>} */
const selected = new Set();
let selectedId = null;
let query = "";
let dragTaskId = null;

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

/** Todo(queued) / 进行中(running) 不可删；blocked 在进行中泳道但可删（需先停也可直接删会 stop） */
function isUndeletable(task) {
  return task?.status === "queued" || task?.status === "running";
}

function matchesQuery(t) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t.title, t.cwd, t.prompt, t.kind, t.model, t.status, STATUS_LABEL[t.status], `迭代${iterationOf(t)}`]
    .filter(Boolean)
    .some((x) => String(x).toLowerCase().includes(q));
}

function visibleTaskIds() {
  return [...tasks.values()].filter(matchesQuery).map((t) => t.id);
}

function updateCounts() {
  const all = [...tasks.values()].filter(matchesQuery);
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
  btn.innerHTML = `
      <input type="checkbox" class="card-check" ${selected.has(t.id) ? "checked" : ""} aria-label="选择任务" />
      <div class="card-top">
        <p class="card-title">${escapeHtml(t.title)}</p>
        <span class="badge ${t.status}">${escapeHtml(statusText)}</span>
      </div>
      <div class="card-meta">${escapeHtml(t.cwd)}</div>
      <div class="card-prompt">${escapeHtml(t.prompt)}</div>
      <div class="card-footer">
        <span class="kind-pill">${escapeHtml(t.kind)}</span>
        <span class="iter-pill" title="迭代次数">迭代 ${iter}</span>
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
      const ids = [...tasks.values()]
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
      paintDetail(data.task, logEl.textContent ? logEl.textContent.split("\n") : []);
    }
  }
}

function renderList() {
  ensureLaneSelectButtons();
  bindLaneDropTargets();
  updateCounts();
  const buckets = { draft: [], todo: [], running: [], done: [] };
  for (const t of tasks.values()) {
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

function openCreate() {
  formError.hidden = true;
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

function paintDetail(task, logLines) {
  const iter = iterationOf(task);
  detailTitle.textContent = task.title;
  detailSub.textContent = `${task.kind} · ${STATUS_LABEL[task.status] || task.status} · 迭代 ${iter}`;
  detailMeta.textContent = JSON.stringify(
    {
      id: task.id,
      kind: task.kind,
      status: task.status,
      iteration: iter,
      sessionId: task.sessionId,
      cwd: task.cwd,
      model: task.model,
      pid: task.pid,
      lastEvent: task.lastEvent,
      error: task.error,
      exitCode: task.exitCode,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
    },
    null,
    2,
  );
  logEl.textContent = logLines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;
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
        : "无已存 sessionId 时将尝试 CLI 的 continue（同目录最近会话）"
      : "任务运行中，请先停止再继续";
  continueError.hidden = true;
}

function closeDetail() {
  detailModal.classList.add("hidden");
  selectedId = null;
}

document.getElementById("btn-new").onclick = openCreate;
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
  const fd = new FormData(form);
  const body = {
    kind: fd.get("kind"),
    title: fd.get("title") || undefined,
    cwd: fd.get("cwd"),
    model: fd.get("model") || undefined,
    prompt: fd.get("prompt"),
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
  renderList();
  openDetail(data.task.id);
  form.reset();
  cwdInput.value = "/home/menghongfei/projects/agent-board";
});

startBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  await moveToLane(selectedId, "todo");
});

stopBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  await fetch(`/api/tasks/${selectedId}/stop`, { method: "POST" });
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
    paintDetail(data.task, logEl.textContent ? logEl.textContent.split("\n") : []);
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
    cwdInput.value = modal.dataset.path || cwdInput.value;
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

cwdPick?.addEventListener("click", async () => {
  const modal = ensureFolderModal();
  modal.classList.remove("hidden");
  await loadFolder(cwdInput.value.trim() || undefined);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("folder-modal")?.classList.contains("hidden")) return closeFolderModal();
  if (!createModal.classList.contains("hidden")) return closeCreate();
  if (!detailModal.classList.contains("hidden")) return closeDetail();
});

function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", (ev) => {
    const data = JSON.parse(ev.data);
    tasks.clear();
    for (const t of data.tasks || []) tasks.set(t.id, t);
    renderList();
  });
  es.addEventListener("task_upsert", (ev) => {
    const data = JSON.parse(ev.data);
    tasks.set(data.task.id, data.task);
    renderList();
    if (data.task.id === selectedId && !detailModal.classList.contains("hidden")) {
      paintDetail(data.task, logEl.textContent ? logEl.textContent.split("\n") : []);
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
  es.addEventListener("task_log", (ev) => {
    const data = JSON.parse(ev.data);
    if (data.taskId !== selectedId || detailModal.classList.contains("hidden")) return;
    logEl.textContent += (logEl.textContent ? "\n" : "") + data.line;
    logEl.scrollTop = logEl.scrollHeight;
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 1500);
  };
}

connectEvents();
fetch("/api/tasks")
  .then((r) => r.json())
  .then((data) => {
    for (const t of data.tasks || []) tasks.set(t.id, t);
    renderList();
  });

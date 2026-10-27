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
const stopBtn = document.getElementById("stop-btn");
const cwdInput = document.getElementById("cwd-input");
const cwdPick = document.getElementById("cwd-pick");

/** @type {Map<string, any>} */
const tasks = new Map();
let selectedId = null;
let query = "";

const TAB_STATUSES = {
  todo: ["queued"],
  running: ["running", "blocked"],
  done: ["succeeded", "failed", "stopped"],
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

function tabOf(status) {
  if (TAB_STATUSES.todo.includes(status)) return "todo";
  if (TAB_STATUSES.running.includes(status)) return "running";
  return "done";
}

function matchesQuery(t) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [t.title, t.cwd, t.prompt, t.kind, t.model, t.status]
    .filter(Boolean)
    .some((x) => String(x).toLowerCase().includes(q));
}

function updateCounts() {
  const all = [...tasks.values()].filter(matchesQuery);
  const c = { todo: 0, running: 0, done: 0 };
  for (const t of all) c[tabOf(t.status)]++;
  document.getElementById("count-todo").textContent = String(c.todo);
  document.getElementById("count-running").textContent = String(c.running);
  document.getElementById("count-done").textContent = String(c.done);
}

function makeCard(t) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "card";
  btn.innerHTML = `
      <div class="card-top">
        <p class="card-title">${escapeHtml(t.title)}</p>
        <span class="badge ${t.status}">${t.status}</span>
      </div>
      <div class="card-meta">${escapeHtml(t.cwd)}</div>
      <div class="card-prompt">${escapeHtml(t.prompt)}</div>
      <div class="card-footer">
        <span class="kind-pill">${escapeHtml(t.kind)}</span>
        <span class="model-pill" title="${escapeHtml(t.model || "")}">${escapeHtml(t.model || "解析中…")}</span>
      </div>`;
  btn.onclick = () => openDetail(t.id);
  return btn;
}

function renderList() {
  updateCounts();
  const buckets = { todo: [], running: [], done: [] };
  for (const t of tasks.values()) {
    if (!matchesQuery(t)) continue;
    buckets[tabOf(t.status)].push(t);
  }
  let total = 0;
  for (const key of ["todo", "running", "done"]) {
    const el = document.getElementById(`list-${key}`);
    el.innerHTML = "";
    const items = buckets[key].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    total += items.length;
    for (const t of items) el.appendChild(makeCard(t));
  }
  emptyEl.hidden = total > 0;
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

function paintDetail(task, logLines) {
  detailTitle.textContent = task.title;
  detailSub.textContent = `${task.kind} · ${task.status}`;
  detailMeta.textContent = JSON.stringify(
    {
      id: task.id,
      kind: task.kind,
      status: task.status,
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
  stopBtn.hidden = !["queued", "running", "blocked"].includes(task.status);
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

stopBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  await fetch(`/api/tasks/${selectedId}/stop`, { method: "POST" });
});

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
      stopBtn.hidden = !["queued", "running", "blocked"].includes(data.task.status);
    }
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

const listEl = document.getElementById("task-list");
const form = document.getElementById("create-form");
const formError = document.getElementById("form-error");
const detailTitle = document.getElementById("detail-title");
const detailMeta = document.getElementById("detail-meta");
const logEl = document.getElementById("log");
const stopBtn = document.getElementById("stop-btn");

const cwdInput = document.getElementById("cwd-input");
const cwdPick = document.getElementById("cwd-pick");
const cwdDir = document.getElementById("cwd-dir");

cwdPick?.addEventListener("click", async () => {
  if (window.showDirectoryPicker) {
    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      // File System Access API has no absolute path; keep name and ask user to complete if needed
      const name = handle.name;
      const cur = cwdInput.value.trim();
      if (!cur || cur.endsWith("/" + name) || cur.endsWith(name)) {
        // if current path already ends with this folder, keep it; else append under projects heuristic
        if (cur && (cur.endsWith("/" + name) || cur === name)) {
          /* keep */
        } else if (cur.includes("/")) {
          const parent = cur.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
          cwdInput.value = `${parent}/${name}`;
        } else {
          cwdInput.value = `/home/menghongfei/projects/${name}`;
        }
      } else if (cur.includes("/")) {
        const parent = cur.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
        cwdInput.value = `${parent}/${name}`;
      } else {
        cwdInput.value = `/home/menghongfei/projects/${name}`;
      }
      cwdInput.focus();
      cwdInput.select();
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      // fall through to input[type=file]
    }
  }
  cwdDir.click();
});

cwdDir?.addEventListener("change", () => {
  const files = cwdDir.files;
  if (!files || !files.length) return;
  const rel = files[0].webkitRelativePath || "";
  const top = rel.split("/")[0] || "";
  if (!top) return;
  const cur = cwdInput.value.trim();
  if (cur.includes("/")) {
    const parent = cur.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
    cwdInput.value = `${parent}/${top}`;
  } else {
    cwdInput.value = `/home/menghongfei/projects/${top}`;
  }
  cwdInput.focus();
  cwdInput.select();
  cwdDir.value = "";
});


/** @type {Map<string, any>} */
const tasks = new Map();
let selectedId = null;

function renderList() {
  const items = [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  listEl.innerHTML = "";
  for (const t of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "task" + (t.id === selectedId ? " active" : "");
    btn.innerHTML = `<div class="row"><strong>${escapeHtml(t.title)}</strong><span class="badge ${t.status}">${t.status}</span></div>
      <div class="muted">${t.kind} · ${escapeHtml(t.cwd)}</div>`;
    btn.onclick = () => selectTask(t.id);
    listEl.appendChild(btn);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

async function selectTask(id) {
  selectedId = id;
  renderList();
  const res = await fetch(`/api/tasks/${id}`);
  if (!res.ok) return;
  const data = await res.json();
  tasks.set(id, data.task);
  detailTitle.textContent = data.task.title;
  detailMeta.textContent = JSON.stringify(
    {
      id: data.task.id,
      kind: data.task.kind,
      status: data.task.status,
      cwd: data.task.cwd,
      model: data.task.model,
      pid: data.task.pid,
      lastEvent: data.task.lastEvent,
      error: data.task.error,
      exitCode: data.task.exitCode,
    },
    null,
    2,
  );
  logEl.textContent = (data.log || []).join("\n");
  logEl.scrollTop = logEl.scrollHeight;
  const live = ["queued", "running", "blocked"].includes(data.task.status);
  stopBtn.hidden = !live;
}

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
  renderList();
  selectTask(data.task.id);
});

stopBtn.addEventListener("click", async () => {
  if (!selectedId) return;
  await fetch(`/api/tasks/${selectedId}/stop`, { method: "POST" });
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
    if (data.task.id === selectedId) selectTask(data.task.id);
  });
  es.addEventListener("task_log", (ev) => {
    const data = JSON.parse(ev.data);
    if (data.taskId !== selectedId) return;
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

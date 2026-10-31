import { renderMarkdown } from "./markdown.js";
import { mergeBoardTask } from "./boardTaskMerge.js";
import { cliKeyForKind, resumeCommandView } from "./resumeCommand.js";

const emptyEl = document.getElementById("empty");
const form = document.getElementById("create-form");
const formError = document.getElementById("form-error");
const searchEl = document.getElementById("search");
const createModal = document.getElementById("create-modal");
const detailModal = document.getElementById("detail-modal");
const detailTitle = document.getElementById("detail-title");
const detailSub = document.getElementById("detail-sub");
const detailMetaGrid = document.getElementById("detail-meta-grid");
const detailOutput = document.getElementById("detail-output");
const detailError = document.getElementById("detail-error");
const outputHint = document.getElementById("output-hint");
const detailSidejobsSection = document.getElementById("detail-sidejobs-section");
const detailSidejobs = document.getElementById("detail-sidejobs");
const sidejobsHint = document.getElementById("sidejobs-hint");
const logCount = document.getElementById("log-count");
const logViewerModal = document.getElementById("log-viewer-modal");
const logViewerBody = document.getElementById("log-viewer-body");
const logViewerHint = document.getElementById("log-viewer-hint");
const metaViewerModal = document.getElementById("meta-viewer-modal");
const metaViewerBody = document.getElementById("meta-viewer-body");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const deleteBtn = document.getElementById("delete-btn");
const archiveBtn = document.getElementById("archive-btn");
const continueRow = document.getElementById("continue-row");
const continueBtn = document.getElementById("continue-btn");
const continuePrompt = document.getElementById("continue-prompt");
const continueHint = document.getElementById("continue-hint");
const continueError = document.getElementById("continue-error");
const createQuickPromptsEl = document.getElementById("create-quick-prompts");
const continueQuickPromptsEl = document.getElementById("continue-quick-prompts");
/** @type {{ id: string, label: string, content: string }[]} */
let quickPrompts = [];
/** @type {Record<string, { effective?: string, override?: string, default?: string }>} */
let cliPathSettings = {};
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
/** In-memory log buffer for the open detail (not mounted in main detail DOM). */
let selectedLogLines = [];
let selectedLogCount = 0;
/** Cache last painted output signature to avoid re-markdown on identical SSE ticks. */
let lastOutputSig = "";
let lastPaintedTaskId = null;

let query = "";
let dragTaskId = null;
/** @type {string|null} */
let editingWorkspaceId = null;
/** @type {(path: string) => void} */
let folderPickTarget = null;
/** @type {"draft"|"todo"} */
let createMode = "draft";
/** @type {{name:string,originalName:string,url:string,mime:string,size:number}[]} */
let pendingAttachments = [];
const createTitle = document.getElementById("create-title");
const createHint = document.getElementById("create-hint");
const createSubmit = document.getElementById("create-submit");
const modelSuggestions = document.getElementById("model-suggestions");
const createKindSelect = form?.elements?.namedItem?.("kind") || form?.querySelector?.('select[name="kind"]');

/** 常用模型：按 Agent kind 过滤；未知 kind 用全局列表。 */
const COMMON_MODELS_BY_KIND = {
  pi: ["cn:deepseek-v4.1-flash", "cn:glm-5.3"],
  claude: ["sonnet", "opus", "haiku"],
  cursor: ["gpt-5.2", "sonnet-4.5", "composer-1"],
  devin: ["swe-2-high"],
  codex: ["gpt-6.1-terra"],
};
const COMMON_MODELS_ALL = [
  ...new Set(Object.values(COMMON_MODELS_BY_KIND).flat()),
];

function refreshModelSuggestions(kind) {
  if (!modelSuggestions) return;
  const k = String(kind || "").trim();
  const list = (k && COMMON_MODELS_BY_KIND[k]) ? COMMON_MODELS_BY_KIND[k] : COMMON_MODELS_ALL;
  modelSuggestions.innerHTML = list
    .map((m) => `<option value="${String(m).replace(/"/g, "&quot;")}"></option>`)
    .join("");
}



const THEME_KEY = "agent-board.theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABEL = {
  system: "主题：跟随系统（点击切换）",
  light: "主题：浅色（点击切换）",
  dark: "主题：深色（点击切换）",
};

function systemTheme() {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readThemePref() {
  const v = localStorage.getItem(THEME_KEY) || "system";
  return THEME_ORDER.includes(v) ? v : "system";
}

function resolveTheme(pref) {
  return pref === "system" ? systemTheme() : pref;
}

function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-pref", pref);
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.title = THEME_LABEL[pref] || THEME_LABEL.system;
    btn.setAttribute("aria-label", THEME_LABEL[pref] || THEME_LABEL.system);
  }
}

function initThemeToggle() {
  applyTheme(readThemePref());
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const cur = readThemePref();
    const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (readThemePref() === "system") applyTheme("system");
  };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else if (typeof mq.addListener === "function") mq.addListener(onChange);
}

initThemeToggle();


const LANES = ["draft", "todo", "running", "done", "archived"];

const TAB_STATUSES = {
  draft: ["draft"],
  todo: ["queued"],
  running: ["running", "blocked"],
  done: ["succeeded", "failed", "stopped"],
  archived: ["archived"],
};

const STATUS_LABEL = {
  draft: "草稿",
  queued: "Todo",
  running: "进行中",
  blocked: "等待确认",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止",
  archived: "已归档",
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

const UPLOAD_IMG_RE = /!\[[^\]]*\]\((\/uploads\/[A-Za-z0-9._-]+)\)/g;

function stripImageMarkdown(text) {
  return String(text || "").replace(/!\[[^\]]*\]\([^)]+\)/g, " ").replace(/\s+/g, " ").trim();
}

function collectPromptImages(prompt) {
  const out = [];
  const re = new RegExp(UPLOAD_IMG_RE.source, "g");
  let m;
  while ((m = re.exec(String(prompt || ""))) !== null) out.push(m[1]);
  return out;
}

function promptCardHtml(prompt) {
  const imgs = collectPromptImages(prompt).slice(0, 3);
  const text = stripImageMarkdown(prompt);
  const thumbs = imgs.length
    ? `<div class="card-prompt-thumbs">${imgs.map((src) =>
        `<img class="card-prompt-thumb" src="${escapeHtml(src)}" alt="" loading="lazy" />`
      ).join("")}</div>`
    : "";
  const body = text ? `<div class="card-prompt">${escapeHtml(text)}</div>` : (imgs.length ? "" : `<div class="card-prompt"></div>`);
  return thumbs + body;
}

async function uploadImageFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("请选择图片文件");
  }
  const fd = new FormData();
  fd.append("file", file, file.name || "paste.png");
  const res = await fetch("/api/uploads", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "上传失败");
  return data;
}

function insertAtCursor(textarea, snippet) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const before = textarea.value.slice(0, start);
  const after = textarea.value.slice(end);
  const needsNL = before.length && !before.endsWith("\n");
  const prefix = needsNL ? "\n" : "";
  const inserted = prefix + snippet + "\n";
  textarea.value = before + inserted + after;
  const caret = (before + inserted).length;
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function setPromptStatus(forId, msg, isError = false) {
  const el = document.querySelector(`.prompt-img-status[data-for="${forId}"]`);
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("is-error");
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("is-error", Boolean(isError));
}

async function handlePromptImageFile(forId, file) {
  const ta = document.getElementById(forId);
  if (!ta || !file) return;
  setPromptStatus(forId, "上传中…");
  try {
    const saved = await uploadImageFile(file);
    const alt = (file.name || "图片").replace(/\.[^.]+$/, "").slice(0, 40) || "图片";
    insertAtCursor(ta, `![${alt}](${saved.url})`);
    setPromptStatus(forId, "已插入图片");
    setTimeout(() => setPromptStatus(forId, ""), 1800);
  } catch (err) {
    setPromptStatus(forId, err?.message || String(err), true);
  }
}

function wirePromptImageSupport(forId) {
  const ta = document.getElementById(forId);
  if (!ta || ta.dataset.imgWired === "1") return;
  ta.dataset.imgWired = "1";
  ta.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.kind === "file" && String(item.type || "").startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        void handlePromptImageFile(forId, file);
        return;
      }
    }
  });
  const btn = document.querySelector(`.prompt-img-btn[data-for="${forId}"]`);
  const fileInput = document.querySelector(`.prompt-img-file[data-for="${forId}"]`);
  btn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    void handlePromptImageFile(forId, file);
  });
}

function displayTitleText(t) {
  const prompt = String(t?.prompt || "");
  const title = String(t?.title || "");
  // Empty title was stored as prompt.slice(0, 48) — show ellipsis when truncated.
  if (prompt.length > 48 && title === prompt.slice(0, 48)) return title + "...";
  return title;
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
  const c = { draft: 0, todo: 0, running: 0, done: 0, archived: 0 };
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
        <div class="card-heading">
          <span class="card-id" title="任务号">${escapeHtml(t.id)}</span>
          <p class="card-title" title="${escapeHtml(t.prompt || "")}">${escapeHtml(displayTitleText(t))}</p>
        </div>
        <span class="badge ${t.status}">${escapeHtml(statusText)}</span>
      </div>
      <div class="card-meta">${escapeHtml(t.cwd)}</div>
      ${timesHtml}
      ${promptCardHtml(t.prompt)}
      ${summaryHtml}
      <div class="card-footer">
        <span class="kind-pill">${escapeHtml(t.kind)}</span>
        <span class="iter-pill" title="迭代次数">迭代 ${iter}</span>
        ${(t.sideJobs && t.sideJobs.length) ? `<span class="sidejob-pill" title="后台 / Monitor / 子代理">${t.sideJobs.length} 后台</span>` : ""}
        <span class="model-pill" title="${escapeHtml(t.model || "")}">${escapeHtml(t.model || "解析中…")}</span>
        ${["succeeded", "failed", "stopped"].includes(t.status)
          ? `<span class="card-archive-btn" role="button" tabindex="0" title="归档到归档列" data-archive="${escapeHtml(t.id)}">归档</span>`
          : ""}
      </div>`;
  const check = btn.querySelector(".card-check");
  check.addEventListener("click", (e) => e.stopPropagation());
  check.addEventListener("change", (e) => {
    e.stopPropagation();
    setSelected(t.id, check.checked);
    btn.classList.toggle("selected", check.checked);
  });
  const archiveBtn = btn.querySelector(".card-archive-btn");
  if (archiveBtn) {
    const doArchive = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void moveToLane(t.id, "archived");
    };
    archiveBtn.addEventListener("click", doArchive);
    archiveBtn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") doArchive(e);
    });
  }
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
      paintDetail(data.task);
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
  const buckets = { draft: [], todo: [], running: [], done: [], archived: [] };
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
  if (!total) {
    emptyEl.textContent = query.trim()
      ? "没有匹配当前搜索的任务"
      : "当前工作区暂无任务，点击右上角「新建草稿」或「新建 Todo」开始";
  }
  updateBulkBar();
}

function clearCreatePrompt() {
  const ta = document.getElementById("create-prompt");
  if (ta) ta.value = "";
  formError.hidden = true;
  formError.textContent = "";
}

function clearContinuePrompt() {
  if (continuePrompt) continuePrompt.value = "";
  if (continueError) {
    continueError.hidden = true;
    continueError.textContent = "";
  }
}

function renderQuickPromptButtons(container, targetId) {
  if (!container) return;
  if (!quickPrompts.length) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = quickPrompts.map((item) => {
    const label = escapeHtml(item.label || "快捷");
    return `<button type="button" class="secondary quick-prompt-btn" data-quick-id="${escapeHtml(item.id)}" data-target="${escapeHtml(targetId)}" title="${label}">${label}</button>`;
  }).join("");
}

function applyQuickPromptsToUi() {
  renderQuickPromptButtons(createQuickPromptsEl, "create-prompt");
  renderQuickPromptButtons(continueQuickPromptsEl, "continue-prompt");
}

async function loadQuickPrompts() {
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = await res.json();
    quickPrompts = Array.isArray(data.quickPrompts) ? data.quickPrompts : [];
    cliPathSettings = data.cliPaths && typeof data.cliPaths === "object" ? data.cliPaths : {};
    applyQuickPromptsToUi();
    if (selectedId && detailModal && !detailModal.classList.contains("hidden")) {
      const open = tasks.get(selectedId);
      if (open) paintDetail(open);
    }
  } catch {
    /* ignore */
  }
}

function fillPromptFromQuick(targetId, content) {
  const ta = document.getElementById(targetId);
  if (!ta) return;
  ta.value = content || "";
  ta.focus();
  try {
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {
    /* ignore */
  }
}


function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
  return `${(x / (1024 * 1024)).toFixed(1)} MB`;
}

function setAttachStatus(msg, isError = false) {
  const el = document.getElementById("create-attach-status");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("is-error");
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("is-error", Boolean(isError));
}

function renderCreateAttachments() {
  const list = document.getElementById("create-attachments");
  if (!list) return;
  if (!pendingAttachments.length) {
    list.hidden = true;
    list.innerHTML = "";
    return;
  }
  list.hidden = false;
  list.innerHTML = pendingAttachments.map((a, idx) => `
    <li class="attach-item" data-idx="${idx}">
      <span class="attach-item-name" title="${escapeHtml(a.originalName)}">${escapeHtml(a.originalName)}</span>
      <span class="attach-item-size">${escapeHtml(formatBytes(a.size))}</span>
      <button type="button" class="secondary attach-item-remove" data-idx="${idx}">移除</button>
    </li>
  `).join("");
}

function clearPendingAttachments() {
  pendingAttachments = [];
  renderCreateAttachments();
  setAttachStatus("");
  const input = document.getElementById("create-attach-file");
  if (input) input.value = "";
}

async function uploadAttachmentFile(file) {
  if (!file) throw new Error("未选择文件");
  const fd = new FormData();
  fd.append("file", file, file.name || "file");
  const res = await fetch("/api/uploads?as=attachment", { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || "上传失败");
  return data;
}

async function handleCreateAttachmentFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  setAttachStatus(`上传中（${files.length}）…`);
  try {
    for (const file of files) {
      if (pendingAttachments.length >= 20) {
        throw new Error("附件过多（上限 20 个）");
      }
      const saved = await uploadAttachmentFile(file);
      pendingAttachments.push({
        name: saved.name,
        originalName: saved.originalName || file.name || saved.name,
        url: saved.url,
        mime: saved.mime || file.type || "application/octet-stream",
        size: saved.size || file.size || 0,
      });
    }
    renderCreateAttachments();
    setAttachStatus(`已添加 ${files.length} 个附件`);
    setTimeout(() => setAttachStatus(""), 1600);
  } catch (err) {
    setAttachStatus(err?.message || String(err), true);
  }
}

function attachmentDownloadUrl(a) {
  const name = encodeURIComponent(a.originalName || a.name || "file");
  return `${a.url}?download=1&filename=${name}`;
}

function attachmentsMetaHtml(task) {
  const list = Array.isArray(task.attachments) ? task.attachments : [];
  if (!list.length) return "";
  const items = list.map((a) => {
    const href = attachmentDownloadUrl(a);
    return `<li class="attach-item">
      <a class="attach-item-link attach-item-name" href="${escapeHtml(href)}" download="${escapeHtml(a.originalName || a.name)}" title="${escapeHtml(a.originalName || "")}">${escapeHtml(a.originalName || a.name)}</a>
      <span class="attach-item-size">${escapeHtml(formatBytes(a.size))}</span>
    </li>`;
  }).join("");
  return `<div class="meta-item meta-wide detail-attachments">
    <span class="meta-k">附件（${list.length}）</span>
    <ul class="attach-list">${items}</ul>
  </div>`;
}

function openCreate(mode = "draft") {
  if (!selectedWorkspaceId || !workspaces.get(selectedWorkspaceId)) {
    window.alert("请先在左侧选择或新建一个工作区");
    return;
  }
  createMode = mode === "todo" ? "todo" : "draft";
  clearCreatePrompt();
  clearPendingAttachments();
  applyQuickPromptsToUi();
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
  refreshModelSuggestions(createKindSelect?.value);
  createModal.classList.remove("hidden");
}
function closeCreate() {
  createModal.classList.add("hidden");
  clearCreatePrompt();
  clearPendingAttachments();
  try { form.reset(); } catch { /* ignore */ }
}

async function openDetail(id) {
  selectedId = id;
  selectedLogLines = [];
  selectedLogCount = 0;
  lastOutputSig = "";
  lastPaintedTaskId = null;
  clearContinuePrompt();
  applyQuickPromptsToUi();
  const metaFold = document.getElementById("detail-meta-fold");
  if (metaFold) metaFold.open = false;
  detailModal.classList.remove("hidden");
  const res = await fetch(`/api/tasks/${id}`);
  if (!res.ok) return;
  const data = await res.json();
  tasks.set(id, data.task);
  selectedLogCount = Number(data.logLineCount) || 0;
  // Intentionally ignore data.log — raw log stays out of the main detail DOM.
  paintDetail(data.task);
  renderList();
}

function canContinue(task) {
  return !["draft", "queued", "running"].includes(task.status);
}

function metaItem(k, v, wide = false, opts = {}) {
  let body;
  if (opts.markdown) {
    body = `<div class="meta-v md-body prompt-md">${v ? renderMarkdown(v) : "—"}</div>`;
  } else if (opts.code && v) {
    body = `<button type="button" class="meta-cmd-btn" data-copy-cmd="${escapeHtml(v)}" title="点击复制命令"><code class="meta-cmd">${escapeHtml(v)}</code></button>`;
  } else if (opts.muted) {
    body = `<span class="meta-v muted">${escapeHtml(v ?? "—")}</span>`;
  } else {
    body = `<span class="meta-v${k === "工作目录" ? " cwd" : ""}">${escapeHtml(v ?? "—")}</span>`;
  }
  return `<div class="meta-item${wide ? " meta-wide" : ""}"><span class="meta-k">${escapeHtml(k)}</span>${body}</div>`;
}

function resumeMetaItem(task) {
  const view = resumeCommandView({
    kind: task.kind,
    sessionId: task.sessionId,
    cwd: task.cwd,
    bin: cliPathSettings[cliKeyForKind(task.kind)],
  });
  if (!view.command) return metaItem("继续会话", view.emptyLabel, true, { muted: true });
  return metaItem("继续会话", view.command, true, { code: true });
}

function outputSignature(task) {
  const turns = Array.isArray(task.outputs) ? task.outputs : [];
  const parts = turns.map((o) => `${o.iteration}:${(o.text || "").length}:${o.at || ""}`);
  const prompts = Array.isArray(task.prompts) ? task.prompts : [];
  const promptParts = prompts.map((p) => `${p.iteration}:${(p.prompt || "").length}:${p.at || ""}`);
  return `${task.id}|${task.status}|${task.output?.length || 0}|${parts.join(";")}|${promptParts.join(";")}|${task.error || ""}|${task.exitCode ?? ""}`;
}

function promptsOf(task) {
  const list = Array.isArray(task.prompts) ? task.prompts.filter((p) => p && String(p.prompt || "").trim()) : [];
  if (list.length) return list.slice().sort((a, b) => a.iteration - b.iteration);
  // Fallback: at least show the initial task.prompt as round 1.
  if (task.prompt && String(task.prompt).trim()) {
    return [{ iteration: 1, prompt: task.prompt, at: task.createdAt }];
  }
  return [];
}

function paintOutput(task) {
  const sig = outputSignature(task);
  if (lastPaintedTaskId === task.id && lastOutputSig === sig && detailOutput.childNodes.length) {
    return;
  }
  lastPaintedTaskId = task.id;
  lastOutputSig = sig;

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
  const promptTurns = promptsOf(task);
  const byIter = new Map();
  for (const p of promptTurns) {
    const cur = byIter.get(p.iteration) || { iteration: p.iteration };
    cur.prompt = p.prompt;
    cur.promptAt = p.at;
    byIter.set(p.iteration, cur);
  }
  for (const o of turns) {
    const cur = byIter.get(o.iteration) || { iteration: o.iteration };
    cur.text = o.text;
    cur.at = o.at;
    byIter.set(o.iteration, cur);
  }
  // Ensure the live iteration appears even before first token / if prompt missing in array.
  const curIter = iterationOf(task);
  if (running && !byIter.has(curIter)) {
    byIter.set(curIter, { iteration: curIter });
  }
  const rounds = [...byIter.values()].sort((a, b) => a.iteration - b.iteration);

  if (rounds.length) {
    detailOutput.classList.remove("empty-output");
    detailOutput.innerHTML = rounds.map((r) => {
      const when = formatLocal(r.at || r.promptAt) || "";
      const kind = r.iteration <= 1 ? "初始" : "继续";
      const head = `第 ${r.iteration} 轮 · ${kind}${when ? " · " + when : ""}`;
      const live = running && r.iteration === curIter ? ' <span class="turn-live">实时</span>' : "";
      const promptBlock = r.prompt
        ? `<div class="output-turn-prompt">
            <div class="output-turn-prompt-label">提示词</div>
            <div class="output-turn-prompt-body md-body prompt-md">${renderMarkdown(r.prompt)}</div>
          </div>`
        : (r.iteration <= 1 && task.prompt
          ? `<div class="output-turn-prompt">
            <div class="output-turn-prompt-label">提示词</div>
            <div class="output-turn-prompt-body md-body prompt-md">${renderMarkdown(task.prompt)}</div>
          </div>`
          : `<div class="output-turn-prompt output-turn-prompt-empty"><div class="output-turn-prompt-label">提示词</div><div class="muted">（无记录）</div></div>`);
      let body;
      if (r.text && String(r.text).trim()) {
        body = `<div class="output-turn-body md-body">${renderMarkdown(r.text)}</div>`;
      } else if (running && r.iteration === curIter) {
        body = `<div class="output-turn-body output-turn-pending muted">回复生成中…</div>`;
      } else {
        body = `<div class="output-turn-body output-turn-pending muted">本轮暂无回复</div>`;
      }
      return `<article class="output-turn">
        <header class="output-turn-head"><span>${escapeHtml(head)}</span>${live}</header>
        ${promptBlock}
        <div class="output-turn-reply-label">回复</div>
        ${body}
      </article>`;
    }).join("");
    outputHint.textContent = running
      ? `共 ${rounds.length} 轮 · 当前第 ${curIter} 轮更新中`
      : `共 ${rounds.length} 轮`;
  } else if (running) {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "任务进行中，等待本轮回复…";
    outputHint.textContent = "等待助手回复";
  } else if (task.status === "draft") {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "草稿尚未执行。拖到 Todo 或点击「开始任务」。";
    outputHint.textContent = "";
  } else if (task.status === "failed") {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "没有可用的回复，请查看上方错误与原始日志。";
    outputHint.textContent = "";
  } else {
    detailOutput.classList.add("empty-output");
    detailOutput.textContent = "暂无本轮回复。";
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

function buildMetaJson(task) {
  const iter = iterationOf(task);
  return {
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
    attachments: task.attachments,
    // Omit full output texts here if huge; keep turn lengths for debugging.
    outputs: Array.isArray(task.outputs)
      ? task.outputs.map((o) => ({
          iteration: o.iteration,
          at: o.at,
          textLength: (o.text || "").length,
          textPreview: String(o.text || "").slice(0, 500),
        }))
      : undefined,
    prompts: Array.isArray(task.prompts)
      ? task.prompts.map((pr) => ({
          iteration: pr.iteration,
          at: pr.at,
          promptLength: (pr.prompt || "").length,
          promptPreview: String(pr.prompt || "").slice(0, 300),
        }))
      : undefined,
    outputLength: task.output ? task.output.length : 0,
  };
}

function paintDetail(task) {
  const iter = iterationOf(task);
  const statusText = STATUS_LABEL[task.status] || task.status;
  detailTitle.textContent = displayTitleText(task);
  detailTitle.title = task.prompt || "";
  detailSub.textContent = `${task.id} · ${task.kind} · ${statusText} · 迭代 ${iter}`;
  const taskIdEl = document.getElementById("detail-task-id");
  if (taskIdEl) taskIdEl.textContent = task.id || "";

  const startLabel = formatLocal(task.startedAt) || "—";
  const endLabel = formatLocal(task.endedAt) || "—";
  detailMetaGrid.innerHTML = [
    metaItem("任务 ID", task.id || "—"),
    metaItem("状态", statusText),
    metaItem("迭代", String(iter)),
    metaItem("开始时间", startLabel),
    metaItem("结束时间", endLabel),
    metaItem("Agent", task.kind),
    metaItem("模型", task.model || "—"),
    metaItem("PID", task.pid != null ? String(task.pid) : "—"),
    metaItem("退出码", task.exitCode != null ? String(task.exitCode) : "—"),
    metaItem("会话", task.sessionId || "—", true),
    resumeMetaItem(task),
    metaItem("工作区", (task.workspaceId && workspaces.get(task.workspaceId)?.name) || task.workspaceId || "—"),
    metaItem("工作目录", task.cwd, true),
    metaItem("初始提示词", task.prompt, true, { markdown: true }),
  ].join("");

  paintOutput(task);
  paintSideJobs(task);

  if (logCount) {
    logCount.textContent = selectedLogCount ? `（${selectedLogCount} 行）` : "";
  }

  startBtn.hidden = task.status !== "draft";
  stopBtn.hidden = !["queued", "running", "blocked"].includes(task.status);
  deleteBtn.hidden = isUndeletable(task);
  if (archiveBtn) {
    archiveBtn.hidden = !["succeeded", "failed", "stopped"].includes(task.status);
  }

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

function renderLogViewerFromCache() {
  if (!logViewerBody) return;
  const text = selectedLogLines.join("\n");
  logViewerBody.textContent = text || "（暂无日志）";
  logViewerBody.scrollTop = logViewerBody.scrollHeight;
  if (logViewerHint) {
    logViewerHint.textContent = selectedLogCount
      ? `已加载最近 ${selectedLogLines.length} 行（任务共约 ${selectedLogCount} 行；超长行已截断）`
      : `已加载 ${selectedLogLines.length} 行`;
  }
}

function closeLogViewer() {
  logViewerModal?.classList.add("hidden");
}

function closeMetaViewer() {
  metaViewerModal?.classList.add("hidden");
}

async function openLogViewer() {
  if (!selectedId) return;
  logViewerModal.classList.remove("hidden");
  if (logViewerHint) logViewerHint.textContent = "加载中…";
  if (logViewerBody) logViewerBody.textContent = "加载中…";
  try {
    const res = await fetch(`/api/tasks/${selectedId}/log?lines=500`);
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    selectedLogLines = Array.isArray(data.log) ? data.log : [];
    selectedLogCount = Number(data.logLineCount) || selectedLogLines.length;
    if (logCount) logCount.textContent = selectedLogCount ? `（${selectedLogCount} 行）` : "";
    renderLogViewerFromCache();
  } catch (err) {
    if (logViewerBody) logViewerBody.textContent = `加载失败：${err?.message || err}`;
    if (logViewerHint) logViewerHint.textContent = "";
  }
}

function openMetaViewer() {
  if (!selectedId) return;
  const task = tasks.get(selectedId);
  if (!task) return;
  metaViewerBody.textContent = JSON.stringify(buildMetaJson(task), null, 2);
  metaViewerModal.classList.remove("hidden");
}

function closeDetail() {
  closeLogViewer();
  closeMetaViewer();
  detailModal.classList.add("hidden");
  selectedId = null;
  selectedLogLines = [];
  selectedLogCount = 0;
  lastOutputSig = "";
  lastPaintedTaskId = null;
  clearContinuePrompt();
}

document.getElementById("btn-new").onclick = () => openCreate("draft");
document.getElementById("btn-new-todo").onclick = () => openCreate("todo");
if (createKindSelect) {
  createKindSelect.addEventListener("change", () => {
    refreshModelSuggestions(createKindSelect.value);
  });
}
refreshModelSuggestions(createKindSelect?.value);
document.getElementById("create-close").onclick = closeCreate;
document.getElementById("create-cancel").onclick = closeCreate;
document.getElementById("detail-close").onclick = closeDetail;
document.getElementById("btn-open-log").onclick = () => void openLogViewer();
document.getElementById("btn-open-meta").onclick = openMetaViewer;
document.getElementById("log-viewer-close").onclick = closeLogViewer;
document.getElementById("meta-viewer-close").onclick = closeMetaViewer;
createModal.addEventListener("click", (e) => { if (e.target === createModal) closeCreate(); });
wirePromptImageSupport("create-prompt");
wirePromptImageSupport("continue-prompt");

(function wireCreateAttachments() {
  const btn = document.getElementById("create-attach-btn");
  const input = document.getElementById("create-attach-file");
  const list = document.getElementById("create-attachments");
  if (!btn || !input) return;
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    void handleCreateAttachmentFiles(input.files);
    input.value = "";
  });
  list?.addEventListener("click", (e) => {
    const rm = e.target?.closest?.(".attach-item-remove");
    if (!rm) return;
    const idx = Number(rm.dataset.idx);
    if (!Number.isFinite(idx)) return;
    pendingAttachments.splice(idx, 1);
    renderCreateAttachments();
  });
})();

document.addEventListener("click", (e) => {
  const btn = e.target?.closest?.(".quick-prompt-btn");
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.quickId;
  const target = btn.dataset.target;
  const item = quickPrompts.find((x) => x.id === id);
  if (!item || !target) return;
  fillPromptFromQuick(target, item.content);
});
void loadQuickPrompts();

detailMetaGrid?.addEventListener("click", async (e) => {
  const btn = e.target?.closest?.("[data-copy-cmd]");
  if (!btn) return;
  const text = btn.getAttribute("data-copy-cmd") || "";
  if (!text) return;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    ta.remove();
  }
  if (!copied) return;
  btn.classList.add("is-copied");
  const prev = btn.getAttribute("title") || "点击复制命令";
  btn.setAttribute("title", "已复制");
  window.setTimeout(() => {
    btn.classList.remove("is-copied");
    if (btn.getAttribute("title") === "已复制") btn.setAttribute("title", prev);
  }, 1200);
});
document.addEventListener("click", (e) => {
  const img = e.target?.closest?.("img.md-img, img.card-prompt-thumb");
  if (!img?.src) return;
  e.preventDefault();
  e.stopPropagation();
  window.open(img.src, "_blank", "noopener");
});

detailModal.addEventListener("click", (e) => { if (e.target === detailModal) closeDetail(); });
logViewerModal?.addEventListener("click", (e) => { if (e.target === logViewerModal) closeLogViewer(); });
metaViewerModal?.addEventListener("click", (e) => { if (e.target === metaViewerModal) closeMetaViewer(); });

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
    attachments: pendingAttachments.length ? pendingAttachments : undefined,
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
  clearPendingAttachments();
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

archiveBtn?.addEventListener("click", async () => {
  if (!selectedId) return;
  await moveToLane(selectedId, "archived");
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
    clearContinuePrompt();
    paintDetail(data.task);
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
  if (logViewerModal && !logViewerModal.classList.contains("hidden")) return closeLogViewer();
  if (metaViewerModal && !metaViewerModal.classList.contains("hidden")) return closeMetaViewer();
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
    btn.dataset.workspaceId = w.id;
    btn.innerHTML = `<span class="ws-item-name">${escapeHtml(w.name)}</span>
      <span class="ws-item-path">${escapeHtml(w.path)}</span>
      <span class="ws-item-count">${count} 个任务</span>`;
    btn.onclick = () => selectWorkspace(w.id);
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWsContextMenu(e.clientX, e.clientY, w.id);
    });
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
async function deleteWorkspaceById(id) {
  const ws = workspaces.get(id);
  if (!ws) return false;
  if (!window.confirm(`删除工作区「${ws.name}」？\n若仍有任务将无法删除。`)) return false;
  const res = await fetch(`/api/workspaces/${ws.id}`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.alert(data.error || res.statusText);
    return false;
  }
  workspaces.delete(ws.id);
  ensureSelectedWorkspace();
  renderWorkspaces();
  renderList();
  return true;
}

document.getElementById("ws-delete").onclick = async () => {
  if (!selectedWorkspaceId) return;
  await deleteWorkspaceById(selectedWorkspaceId);
};

/** @type {HTMLDivElement | null} */
let wsCtxMenu = null;
/** @type {string | null} */
let wsCtxWorkspaceId = null;

function ensureWsContextMenu() {
  if (wsCtxMenu) return wsCtxMenu;
  const el = document.createElement("div");
  el.id = "ws-context-menu";
  el.className = "ws-context-menu hidden";
  el.setAttribute("role", "menu");
  el.innerHTML = `
    <button type="button" class="ws-ctx-item" data-action="settings" role="menuitem">设置</button>
    <button type="button" class="ws-ctx-item" data-action="edit" role="menuitem">编辑</button>
    <button type="button" class="ws-ctx-item ws-ctx-danger" data-action="delete" role="menuitem">删除</button>
  `;
  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !wsCtxWorkspaceId) return;
    const action = btn.getAttribute("data-action");
    const id = wsCtxWorkspaceId;
    closeWsContextMenu();
    const ws = workspaces.get(id);
    if (!ws) return;
    if (action === "settings") {
      location.href = `/workspaces/${encodeURIComponent(id)}/settings`;
      return;
    }
    if (action === "edit") {
      selectWorkspace(id);
      openWsModal("edit", ws);
      return;
    }
    if (action === "delete") {
      await deleteWorkspaceById(id);
    }
  });
  document.body.appendChild(el);
  wsCtxMenu = el;
  return el;
}

function closeWsContextMenu() {
  if (!wsCtxMenu) return;
  wsCtxMenu.classList.add("hidden");
  wsCtxWorkspaceId = null;
}

function openWsContextMenu(x, y, workspaceId) {
  const el = ensureWsContextMenu();
  wsCtxWorkspaceId = workspaceId;
  el.classList.remove("hidden");
  // Position then clamp into viewport
  el.style.left = "0px";
  el.style.top = "0px";
  const rect = el.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

document.addEventListener("click", () => closeWsContextMenu());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeWsContextMenu();
});
window.addEventListener("blur", () => closeWsContextMenu());
window.addEventListener("resize", () => closeWsContextMenu());
window.addEventListener("scroll", () => closeWsContextMenu(), true);
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
    paintDetail(task);
  }, 120);
}

let detailRefreshTimer = null;
function scheduleDetailRefresh(id) {
  if (detailRefreshTimer) clearTimeout(detailRefreshTimer);
  detailRefreshTimer = setTimeout(async () => {
    detailRefreshTimer = null;
    if (id !== selectedId || detailModal.classList.contains("hidden")) return;
    try {
      const res = await fetch(`/api/tasks/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.task || data.task.id !== selectedId) return;
      tasks.set(id, data.task);
      schedulePaintDetail(data.task);
    } catch {
      /* keep the last full detail */
    }
  }, 300);
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
    const prev = tasks.get(data.task.id);
    const merged = mergeBoardTask(prev, data.task);
    tasks.set(data.task.id, merged);
    scheduleRenderList();
    if (data.task.id === selectedId && !detailModal.classList.contains("hidden")) {
      schedulePaintDetail(merged);
      if (data.task.boardSummary && (data.task.outputTruncated || data.task.promptTruncated)) {
        scheduleDetailRefresh(data.task.id);
      }
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
    for (const line of logBuf) selectedLogLines.push(line);
    logBuf = [];
    // Keep memory buffer bounded (raw log is not in main detail DOM).
    const maxLines = 2_000;
    const maxChars = 240_000;
    if (selectedLogLines.length > maxLines) {
      selectedLogLines = selectedLogLines.slice(-maxLines);
    }
    let total = 0;
    for (let i = selectedLogLines.length - 1; i >= 0; i--) {
      total += selectedLogLines[i].length;
      if (total > maxChars) {
        selectedLogLines = selectedLogLines.slice(i + 1);
        break;
      }
    }
    selectedLogCount = Math.max(selectedLogCount, selectedLogLines.length);
    if (logCount) logCount.textContent = selectedLogCount ? `（${selectedLogCount} 行）` : "";
    if (logViewerModal && !logViewerModal.classList.contains("hidden")) {
      renderLogViewerFromCache();
    }
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

/* —— Brand menu (设置 / 文档) —— */
(function setupBrandMenu() {
  const btn = document.getElementById("brand-menu-btn");
  const menu = document.getElementById("brand-menu");
  if (!btn || !menu) return;
  const close = () => {
    menu.classList.add("hidden");
    btn.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    menu.classList.remove("hidden");
    btn.setAttribute("aria-expanded", "true");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("hidden")) open();
    else close();
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !menu.contains(e.target) && e.target !== btn) {
      close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();


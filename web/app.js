import { renderMarkdown } from "./markdown.js";
import { mergeBoardTask } from "./boardTaskMerge.js";
import { cliKeyForKind, resumeCommandView } from "./resumeCommand.js";
import { renderGitStatus } from "./git-status-view.js";
import { formatRoundDuration } from "./roundTime.js";

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
const sidejobsBtn = document.getElementById("btn-open-sidejobs");
const infoViewerModal = document.getElementById("info-viewer-modal");
const sidejobsViewerModal = document.getElementById("sidejobs-viewer-modal");
const detailSidejobs = document.getElementById("detail-sidejobs");
const sidejobsHint = document.getElementById("sidejobs-hint");
const logCount = document.getElementById("log-count");
const detailLastReplyAt = document.querySelector("#detail-last-reply-at");
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
const continueModel = document.getElementById("continue-model");
const continueModelHint = document.getElementById("continue-model-hint");
const continueModelDropdown = document.getElementById("continue-model-dropdown");
const continueModelClear = document.getElementById("continue-model-clear");
const continueThinkingEffort = document.getElementById("continue-thinking-effort");
let continuingTaskId = null;
const continueHint = document.getElementById("continue-hint");
const continueError = document.getElementById("continue-error");
const followupQueueEl = document.getElementById("followup-queue");
/** @type {Map<string, string[]>} Messages typed while a task is still running. */
const followupQueues = new Map();
/** @type {Set<string>} Tasks whose queued follow-up is being sent. */
const followupDraining = new Set();
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
const createUseWorktreeLabel = document.getElementById("create-use-worktree-label");
const createUseWorktree = document.getElementById("create-use-worktree");
const createWorktreeNote = document.getElementById("create-worktree-note");
let worktreeEligSeq = 0;
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
let pendingRenderList = false;
let pendingRenderWorkspaces = false;
let suppressClickUntil = 0;
/**
 * Active pointer-driven drag state (avoids buggy OS-level HTML5 DnD grabs on Linux).
 * @type {{
 *   kind: "card" | "ws",
 *   id: string,
 *   sourceEl: HTMLElement,
 *   title: string,
 *   startX: number,
 *   startY: number,
 *   started: boolean,
 *   ghostEl: HTMLDivElement | null,
 *   targetLane: string | null,
 *   targetWsId: string | null,
 * } | null}
 */
let activePointerDrag = null;
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
const createModelInput = document.getElementById("create-model");
const createModelDropdown = document.getElementById("create-model-dropdown");
const createModelClear = document.getElementById("create-model-clear");
const createThinkingEffortSelect = document.getElementById("create-thinking-effort");
const createKindSelect = form?.elements?.namedItem?.("kind") || form?.querySelector?.('select[name="kind"]');

const SUPPORTED_AGENT_KINDS = ["pi", "claude", "cursor", "devin", "codex"];
const EFFORT_CANONICAL_ORDER = [
  "none",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const DEFAULT_EFFORTS_BY_KIND = {
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  cursor: ["low", "medium", "high", "xhigh", "max"],
  devin: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max"],
};
/** @type {Record<string, { model: string, thinkingEfforts: string[] }[]>} */
let agentModelsByKind = {
  pi: [],
  claude: [],
  cursor: [],
  devin: [],
  codex: [],
};
let agentModelsLoad = null;
let agentModelsLoaded = false;

function normalizeModelItem(raw) {
  if (typeof raw === "string") {
    const m = raw.trim();
    return m ? { model: m, thinkingEfforts: [] } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const m = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!m) return null;
  const efforts = Array.isArray(raw.thinkingEfforts)
    ? raw.thinkingEfforts.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim())
    : [];
  return { model: m, thinkingEfforts: efforts };
}

function normalizeAgentModelsPayload(rawModels) {
  const next = { pi: [], claude: [], cursor: [], devin: [], codex: [] };
  if (!rawModels || typeof rawModels !== "object") return next;
  for (const kind of SUPPORTED_AGENT_KINDS) {
    const list = Array.isArray(rawModels[kind]) ? rawModels[kind] : [];
    const seen = new Set();
    for (const item of list) {
      const normalized = normalizeModelItem(item);
      if (!normalized || seen.has(normalized.model)) continue;
      seen.add(normalized.model);
      next[kind].push(normalized);
    }
  }
  return next;
}

function getAgentModelsForKind(kind) {
  const k = String(kind || "").trim();
  return (k && agentModelsByKind[k]) ? agentModelsByKind[k] : [];
}

function isSubsequenceMatch(target, token) {
  let ti = 0;
  for (let i = 0; i < target.length && ti < token.length; i++) {
    if (target[i] === token[ti]) ti++;
  }
  return ti === token.length;
}

function scoreModelMatch(modelLower, queryLower, tokens) {
  if (modelLower === queryLower) return 0;
  if (modelLower.startsWith(queryLower)) return 1;
  const segments = modelLower.split(/[/:]/);
  if (segments.some((seg) => seg.startsWith(queryLower))) return 1;
  if (tokens.every((t) => modelLower.includes(t))) return 2;
  if (tokens.every((t) => isSubsequenceMatch(modelLower, t))) return 3;
  return -1;
}

function fuzzyFilterAgentModels(models, queryText) {
  const q = String(queryText || "").trim().toLowerCase();
  if (!q) return models;
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const item of models) {
    const score = scoreModelMatch(item.model.toLowerCase(), q, tokens);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.model.localeCompare(b.item.model));
  return scored.map((s) => s.item);
}

function createModelOptionEl(item, isSelected, isActive) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "model-option"
    + (isSelected ? " is-selected" : "")
    + (isActive ? " is-active" : "");
  btn.setAttribute("role", "option");
  btn.setAttribute("aria-selected", isSelected ? "true" : "false");
  btn.dataset.value = item.model;
  const nameSpan = document.createElement("span");
  nameSpan.className = "model-option-name";
  nameSpan.textContent = item.model;
  btn.appendChild(nameSpan);
  return btn;
}

function getSupportedEffortsForSelection(kind, modelName) {
  const k = String(kind || "").trim();
  const list = getAgentModelsForKind(k);
  const trimmedModel = String(modelName || "").trim();
  if (trimmedModel) {
    const matched = list.find((m) => m.model === trimmedModel)
      || list.find((m) => m.model.toLowerCase() === trimmedModel.toLowerCase());
    if (matched && Array.isArray(matched.thinkingEfforts) && matched.thinkingEfforts.length) {
      return matched.thinkingEfforts;
    }
  }
  const aggregated = new Set();
  for (const item of list) {
    for (const e of item.thinkingEfforts || []) {
      aggregated.add(e);
    }
  }
  if (aggregated.size) {
    const ordered = EFFORT_CANONICAL_ORDER.filter((e) => aggregated.has(e));
    for (const e of aggregated) {
      if (!ordered.includes(e)) ordered.push(e);
    }
    return ordered;
  }
  return DEFAULT_EFFORTS_BY_KIND[k] || DEFAULT_EFFORTS_BY_KIND.claude;
}

function pickDefaultThinkingEffort(efforts, preferred = "") {
  if (!Array.isArray(efforts) || !efforts.length) return "medium";
  if (preferred && efforts.includes(preferred)) return preferred;
  if (efforts.includes("medium")) return "medium";
  if (efforts.includes("high")) return "high";
  const nonOff = efforts.find((e) => e !== "off" && e !== "none");
  return nonOff || efforts[0];
}

function syncThinkingEffortSelect(selectEl, kind, modelName, preferredEffort = "") {
  if (!selectEl) return;
  const efforts = getSupportedEffortsForSelection(kind, modelName);
  const chosen = pickDefaultThinkingEffort(efforts, preferredEffort);
  selectEl.replaceChildren(
    ...efforts.map((effort) => new Option(effort, effort, effort === chosen, effort === chosen)),
  );
  selectEl.value = chosen;
}

function createSearchableModelPicker({
  inputEl,
  dropdownEl,
  clearBtn,
  getKind,
  emptyLabel,
  onChange,
}) {
  let selectedModel = "";
  let isSearching = false;
  let filterQuery = "";
  let activeIndex = -1;
  let isOpen = false;

  const updateClearBtn = () => {
    if (!clearBtn || !inputEl) return;
    const hasText = Boolean(selectedModel || inputEl.value);
    clearBtn.hidden = !hasText || inputEl.disabled;
  };

  const findExactModel = (rawText) => {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) return "";
    const list = getAgentModelsForKind(getKind());
    const exact = list.find((m) => m.model === trimmed)
      || list.find((m) => m.model.toLowerCase() === trimmed.toLowerCase());
    return exact ? exact.model : null;
  };

  const renderDropdown = () => {
    if (!dropdownEl || !inputEl) return;
    const allModels = getAgentModelsForKind(getKind());
    const filtered = isSearching ? fuzzyFilterAgentModels(allModels, filterQuery) : allModels;
    dropdownEl.replaceChildren();

    const showDefaultOpt = !isSearching || !filterQuery.trim();
    const totalOptions = (showDefaultOpt ? 1 : 0) + filtered.length;
    if (activeIndex >= totalOptions) activeIndex = totalOptions - 1;

    let optIdx = 0;
    if (showDefaultOpt) {
      const defBtn = document.createElement("button");
      defBtn.type = "button";
      const isAct = optIdx === activeIndex;
      defBtn.className = "model-option model-option-default"
        + (!selectedModel ? " is-selected" : "")
        + (isAct ? " is-active" : "");
      defBtn.setAttribute("role", "option");
      defBtn.setAttribute("aria-selected", !selectedModel ? "true" : "false");
      defBtn.dataset.value = "";
      defBtn.textContent = emptyLabel;
      dropdownEl.appendChild(defBtn);
      optIdx++;
    }

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "model-option-empty muted";
      empty.textContent = allModels.length ? "无匹配模型" : "暂无可用模型";
      dropdownEl.appendChild(empty);
      return;
    }

    for (const item of filtered) {
      const isSel = item.model === selectedModel;
      const isAct = optIdx === activeIndex;
      dropdownEl.appendChild(createModelOptionEl(item, isSel, isAct));
      optIdx++;
    }
  };

  const openDropdown = () => {
    if (!inputEl || !dropdownEl || inputEl.disabled) return;
    isOpen = true;
    dropdownEl.classList.remove("hidden");
    inputEl.setAttribute("aria-expanded", "true");
    renderDropdown();
  };

  const closeDropdown = () => {
    if (!dropdownEl || !inputEl) return;
    isOpen = false;
    activeIndex = -1;
    dropdownEl.classList.add("hidden");
    inputEl.setAttribute("aria-expanded", "false");
  };

  const selectValue = (val) => {
    if (!inputEl) return;
    const matched = val ? findExactModel(val) : "";
    selectedModel = matched || "";
    isSearching = false;
    filterQuery = "";
    inputEl.value = selectedModel;
    inputEl.dataset.selectedModel = selectedModel;
    updateClearBtn();
    closeDropdown();
    onChange?.(selectedModel);
  };

  const commitOrRevert = () => {
    if (!inputEl) return "";
    const prev = selectedModel;
    if (isSearching) {
      const raw = inputEl.value.trim();
      if (!raw) {
        selectedModel = "";
      } else {
        const matched = findExactModel(raw);
        if (matched) selectedModel = matched;
      }
      isSearching = false;
      filterQuery = "";
      inputEl.value = selectedModel;
      inputEl.dataset.selectedModel = selectedModel;
    } else if (selectedModel && !findExactModel(selectedModel)) {
      selectedModel = "";
      inputEl.value = "";
      inputEl.dataset.selectedModel = "";
    }
    updateClearBtn();
    closeDropdown();
    if (selectedModel !== prev) onChange?.(selectedModel);
    return selectedModel;
  };

  const syncWithKind = () => {
    if (!inputEl) return;
    if (selectedModel && !findExactModel(selectedModel)) {
      selectedModel = "";
      if (!isSearching) inputEl.value = "";
      inputEl.dataset.selectedModel = "";
    } else if (isSearching && inputEl.value.trim()) {
      const matched = findExactModel(inputEl.value.trim());
      selectedModel = matched || "";
      inputEl.dataset.selectedModel = selectedModel;
    }
    updateClearBtn();
    renderDropdown();
  };

  const clear = () => {
    selectedModel = "";
    isSearching = false;
    filterQuery = "";
    if (inputEl) {
      inputEl.value = "";
      inputEl.dataset.selectedModel = "";
    }
    updateClearBtn();
    closeDropdown();
  };

  inputEl?.addEventListener("focus", () => {
    if (inputEl.disabled) return;
    void loadAgentModels();
    openDropdown();
  });

  inputEl?.addEventListener("click", () => {
    if (inputEl.disabled) return;
    if (!isOpen) openDropdown();
  });

  inputEl?.addEventListener("input", () => {
    if (inputEl.disabled) return;
    isSearching = true;
    filterQuery = inputEl.value;
    const raw = inputEl.value.trim();
    if (!raw) {
      selectedModel = "";
      inputEl.dataset.selectedModel = "";
    } else {
      const matched = findExactModel(raw);
      if (matched) {
        selectedModel = matched;
        inputEl.dataset.selectedModel = matched;
      }
    }
    activeIndex = filterQuery.trim() ? 0 : -1;
    updateClearBtn();
    openDropdown();
  });

  inputEl?.addEventListener("keydown", (e) => {
    if (inputEl.disabled) return;
    const options = dropdownEl ? [...dropdownEl.querySelectorAll(".model-option")] : [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!isOpen) openDropdown();
      if (options.length) {
        activeIndex = (activeIndex + 1) % options.length;
        renderDropdown();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen) openDropdown();
      if (options.length) {
        activeIndex = activeIndex <= 0 ? options.length - 1 : activeIndex - 1;
        renderDropdown();
      }
      return;
    }
    if (e.key === "Enter" && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      const targetOpt = activeIndex >= 0 && options[activeIndex]
        ? options[activeIndex]
        : (isSearching && options.length ? options[0] : null);
      if (targetOpt) {
        selectValue(targetOpt.dataset.value || "");
      } else {
        commitOrRevert();
      }
      return;
    }
    if (e.key === "Escape" && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      commitOrRevert();
    }
  });

  inputEl?.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement !== inputEl) {
        commitOrRevert();
      }
    }, 120);
  });

  dropdownEl?.addEventListener("mousedown", (e) => {
    const opt = e.target?.closest?.(".model-option");
    if (!opt) return;
    e.preventDefault();
    selectValue(opt.dataset.value || "");
  });

  clearBtn?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    clear();
    inputEl?.focus();
    openDropdown();
  });

  return {
    clear,
    syncWithKind,
    commitOrRevert,
    closeDropdown,
    getSelectedModel: () => selectedModel,
    isOpen: () => isOpen,
    refreshUi: () => {
      updateClearBtn();
      renderDropdown();
    },
  };
}

function syncCreateThinkingEffort(preferredEffort = createThinkingEffortSelect?.value || "") {
  const kind = createKindSelect?.value || "pi";
  const model = createModelPicker.getSelectedModel();
  syncThinkingEffortSelect(createThinkingEffortSelect, kind, model, preferredEffort);
}

function syncContinueThinkingEffort(preferredEffort = continueThinkingEffort?.value || "") {
  const task = tasks.get(selectedId);
  if (!task) return;
  const model = continueModelPicker.getSelectedModel() || task.model || "";
  syncThinkingEffortSelect(
    continueThinkingEffort,
    task.kind,
    model,
    preferredEffort || task.thinkingEffort || "",
  );
}

const createModelPicker = createSearchableModelPicker({
  inputEl: createModelInput,
  dropdownEl: createModelDropdown,
  clearBtn: createModelClear,
  getKind: () => createKindSelect?.value || "pi",
  emptyLabel: "默认模型（不指定）",
  onChange: () => syncCreateThinkingEffort(),
});

const continueModelPicker = createSearchableModelPicker({
  inputEl: continueModel,
  dropdownEl: continueModelDropdown,
  clearBtn: continueModelClear,
  getKind: () => tasks.get(selectedId)?.kind || "",
  emptyLabel: "沿用当前模型",
  onChange: () => syncContinueThinkingEffort(),
});

function loadAgentModels(force = false) {
  if (agentModelsLoaded && !force) return Promise.resolve();
  if (agentModelsLoad) return agentModelsLoad;
  agentModelsLoad = (async () => {
    const res = await fetch("/api/agent-models");
    if (!res.ok) throw new Error("读取模型列表失败");
    const data = await res.json();
    agentModelsByKind = normalizeAgentModelsPayload(data.models);
    agentModelsLoaded = true;
    createModelPicker.syncWithKind();
    syncCreateThinkingEffort();
    continueModelPicker.syncWithKind();
    syncContinueThinkingEffort();
  })().catch((err) => {
    console.warn("加载模型列表失败，将在下次打开时重试", err);
  }).finally(() => {
    agentModelsLoad = null;
  });
  return agentModelsLoad;
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
const LANE_LABEL = { draft: "草稿", todo: "Todo", running: "进行中", done: "已完成", archived: "归档" };

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

function appendPromptCard(parent, prompt) {
  const imgs = collectPromptImages(prompt).slice(0, 3);
  const text = stripImageMarkdown(prompt);
  if (imgs.length) {
    const thumbs = document.createElement("div");
    thumbs.className = "card-prompt-thumbs";
    for (const src of imgs) {
      if (!src.startsWith("/uploads/")) continue;
      const img = document.createElement("img");
      img.className = "card-prompt-thumb";
      img.src = src;
      img.alt = "";
      img.loading = "lazy";
      img.draggable = false;
      thumbs.appendChild(img);
    }
    parent.appendChild(thumbs);
  }
  if (text || !imgs.length) {
    const body = document.createElement("div");
    body.className = "card-prompt";
    body.textContent = text;
    parent.appendChild(body);
  }
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

const BOARD_LIFECYCLE_EVENTS = new Set([
  "start",
  "continue",
  "move_draft",
  "move_done",
  "spawn_error",
  "launch_failed",
  "rate_limit_kill",
  "settle_exit_watchdog",
  "interrupted",
]);
/** @type {Map<string, string>} Latest agent stdout timestamp observed over SSE per task. */
const lastAgentLogAt = new Map();

function isAgentStdoutLogLine(line) {
  const s = String(line || "").trim();
  if (!s.startsWith("{")) return false;
  if (s.includes('"type":"agent_stream"') && s.includes('"stream":"stdout"')) return true;
  if (s.includes('\\"type\\":\\"agent_stream\\"') && s.includes('\\"stream\\":\\"stdout\\"')) return true;
  return false;
}

function isAgentEventName(lastEvent) {
  const ev = String(lastEvent || "").trim();
  if (!ev) return false;
  if (ev.startsWith("archive:")) return false;
  return !BOARD_LIFECYCLE_EVENTS.has(ev);
}

/**
 * Latest agent return / model reply time.
 * Uses the newest outputs[].at, plus live agent stdout event timestamps while
 * a run is active (or before prose output is extracted).
 * @param {any} t
 * @returns {string}
 */
function lastReplyAt(t) {
  if (!t) return "";
  const turns = Array.isArray(t.outputs) ? t.outputs : [];
  let latest = "";
  let iteration = -1;
  for (const turn of turns) {
    if (!turn?.at || !String(turn.text || "").trim()) continue;
    const n = Number(turn.iteration);
    if (!Number.isFinite(n) || n < iteration) continue;
    if (n === iteration && String(turn.at) <= latest) continue;
    iteration = n;
    latest = String(turn.at);
  }
  const liveLogAt = t.id ? lastAgentLogAt.get(t.id) : "";
  if (liveLogAt && (!latest || liveLogAt > latest)) {
    latest = liveLogAt;
  }
  if (
    ["running", "blocked"].includes(t.status) &&
    t.updatedAt &&
    isAgentEventName(t.lastEvent) &&
    (!latest || String(t.updatedAt) > latest)
  ) {
    latest = String(t.updatedAt);
  }
  if (!latest && isAgentEventName(t.lastEvent)) {
    latest = String(t.endedAt || t.updatedAt || "");
  }
  return latest;
}

function paintLastReply(task) {
  if (!detailLastReplyAt) return;
  detailLastReplyAt.textContent = formatLocal(lastReplyAt(task)) || "—";
}

function updateCardReplyTime(taskId) {
  const t = tasks.get(taskId);
  if (!t) return;
  const val = formatLocal(lastReplyAt(t));
  if (!val) return;
  let card = null;
  for (const el of document.querySelectorAll(".card[data-id]")) {
    if (el.dataset.id === taskId) {
      card = el;
      break;
    }
  }
  if (!card) return;
  let timesBox = card.querySelector(".card-times");
  if (!timesBox) {
    appendCardTimes(card, t);
    return;
  }
  let replySpan = timesBox.querySelector(".time-reply");
  if (!replySpan) {
    replySpan = document.createElement("span");
    replySpan.className = "time-reply";
    replySpan.title = "最近一次模型输出的时间";
    timesBox.append(replySpan);
  }
  replySpan.textContent = `最后回复 ${val}`;
  card.dataset.cardSig = cardRenderSig(t);
}

/** @param {HTMLElement} parent @param {any} t */
function appendCardTimes(parent, t) {
  const rows = [
    ["time-start", "开始时间", "开始", formatLocal(t.startedAt)],
    ["time-end", "结束时间", "结束", formatLocal(t.endedAt)],
    ["time-reply", "最近一次模型输出的时间", "最后回复", formatLocal(lastReplyAt(t))],
  ].filter((row) => row[3]);
  if (!rows.length) return;
  const box = document.createElement("div");
  box.className = "card-times";
  for (const [className, title, label, value] of rows) {
    const span = document.createElement("span");
    span.className = className;
    span.title = title;
    span.textContent = `${label} ${value}`;
    box.appendChild(span);
  }
  parent.appendChild(box);
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
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "card-check";
  check.checked = selected.has(t.id);
  check.setAttribute("aria-label", "选择任务");
  const top = document.createElement("div");
  top.className = "card-top";
  const heading = document.createElement("div");
  heading.className = "card-heading";
  const idEl = document.createElement("span");
  idEl.className = "card-id";
  idEl.title = "任务号";
  idEl.textContent = t.id || "";
  const title = document.createElement("p");
  title.className = "card-title";
  title.title = t.prompt || "";
  title.textContent = displayTitleText(t);
  heading.append(idEl, title);
  const badge = document.createElement("span");
  badge.className = `badge ${t.status}`;
  badge.textContent = statusText;
  top.append(heading, badge);
  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = t.cwd || "";
  const footer = document.createElement("div");
  footer.className = "card-footer";
  const kind = document.createElement("span");
  kind.className = "kind-pill";
  kind.textContent = t.kind || "";
  const iteration = document.createElement("span");
  iteration.className = "iter-pill";
  iteration.title = "迭代次数";
  iteration.textContent = `迭代 ${iter}`;
  footer.append(kind, iteration);
  if (t.sideJobs?.length) {
    const jobs = document.createElement("span");
    jobs.className = "sidejob-pill";
    jobs.title = "后台 / Monitor / 子代理";
    jobs.textContent = `${t.sideJobs.length} 后台`;
    footer.appendChild(jobs);
  }
  const model = document.createElement("span");
  model.className = "model-pill";
  model.title = t.model || "";
  model.textContent = t.model || "解析中…";
  footer.appendChild(model);
  let archive = null;
  if (["succeeded", "failed", "stopped"].includes(t.status)) {
    archive = document.createElement("span");
    archive.className = "card-archive-btn";
    archive.setAttribute("role", "button");
    archive.tabIndex = 0;
    archive.title = "归档到归档列";
    archive.dataset.archive = t.id;
    archive.textContent = "归档";
    footer.appendChild(archive);
  }
  btn.append(check, top, meta);
  appendCardTimes(btn, t);
  appendPromptCard(btn, t.prompt);
  if (preview.text) {
    const summary = document.createElement("div");
    summary.className = `card-summary ${preview.error ? "is-error" : "has-output"}`;
    summary.textContent = preview.text;
    btn.appendChild(summary);
  }
  btn.appendChild(footer);
  check.addEventListener("click", (e) => e.stopPropagation());
  check.addEventListener("change", (e) => {
    e.stopPropagation();
    setSelected(t.id, check.checked);
    btn.classList.toggle("selected", check.checked);
    btn.dataset.cardSig = cardRenderSig(t);
  });
  if (archive) {
    const doArchive = (e) => {
      e.preventDefault();
      e.stopPropagation();
      void moveToLane(t.id, "archived");
    };
    archive.addEventListener("click", doArchive);
    archive.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") doArchive(e);
    });
  }
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest(".card-check, .card-archive-btn")) return;
    startPointerDrag("card", t.id, btn, displayTitleText(t) || t.id, e.clientX, e.clientY);
  });
  btn.addEventListener("dragstart", (e) => {
    if (e.isTrusted) {
      e.preventDefault();
      return;
    }
    dragTaskId = t.id;
    btn.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", t.id);
      e.dataTransfer.effectAllowed = "move";
    }
  });
  btn.addEventListener("dragend", () => {
    dragTaskId = null;
    btn.classList.remove("dragging");
    clearLaneDragIndicators();
    flushPendingRenders();
  });
  btn.onclick = (e) => {
    if (e.target === check) return;
    if (Date.now() < suppressClickUntil) return;
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

function clearLaneDragIndicators() {
  for (const el of document.querySelectorAll(".lane.drag-over, .lane-body.drag-over")) {
    el.classList.remove("drag-over");
  }
}

function bindLaneDropTargets() {
  for (const key of LANES) {
    const lane = document.querySelector(`.lane[data-tab="${key}"]`);
    const body = document.getElementById(`list-${key}`);
    if (!lane || lane.dataset.dropBound) continue;
    lane.dataset.dropBound = "1";
    const onDragOver = (e) => {
      if (dragWorkspaceId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      lane.classList.add("drag-over");
      body?.classList.add("drag-over");
    };
    const onDragLeave = (e) => {
      if (lane.contains(e.relatedTarget)) return;
      lane.classList.remove("drag-over");
      body?.classList.remove("drag-over");
    };
    const onDrop = async (e) => {
      if (dragWorkspaceId) return;
      e.preventDefault();
      lane.classList.remove("drag-over");
      body?.classList.remove("drag-over");
      const id = e.dataTransfer?.getData("text/plain") || dragTaskId;
      dragTaskId = null;
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

const VIRTUAL_ESTIMATED_CARD_HEIGHT = 210;
const VIRTUAL_CARD_GAP = 8;
const VIRTUAL_OVERSCAN = 4;
const VIRTUAL_MIN_WINDOW = 10;
/** @type {Map<string, number>} Measured card heights by task id. */
const cardHeightCache = new Map();
/** @type {Map<string, { items: any[], lastSig: string, rafId: number }>} */
const laneVirtualState = new Map();

function cardRenderSig(t) {
  const preview = previewText(t);
  return [
    t.id,
    t.status,
    selected.has(t.id) ? "1" : "0",
    t.title || "",
    t.cwd || "",
    t.startedAt || "",
    t.endedAt || "",
    lastReplyAt(t),
    t.prompt || "",
    preview.error ? "E" : "O",
    preview.text || "",
    iterationOf(t),
    t.kind || "",
    t.model || "",
    t.sideJobs?.length || 0,
  ].join("\x1f");
}

function computeVirtualSlice(el, items) {
  const n = items.length;
  if (n <= VIRTUAL_MIN_WINDOW) {
    return { startIdx: 0, endIdx: n - 1, topSpacer: 0, bottomSpacer: 0 };
  }
  const heights = [];
  const offsets = [];
  let runningTop = 0;
  for (let i = 0; i < n; i++) {
    offsets.push(runningTop);
    const h = cardHeightCache.get(items[i].id) || VIRTUAL_ESTIMATED_CARD_HEIGHT;
    heights.push(h);
    runningTop += h + VIRTUAL_CARD_GAP;
  }
  const totalHeight = runningTop - VIRTUAL_CARD_GAP;
  const scrollTop = Math.max(0, el.scrollTop || 0);
  const viewportH = Math.max(el.clientHeight || 0, 640);
  const viewBottom = scrollTop + viewportH;

  let firstVisible = 0;
  while (firstVisible < n - 1 && offsets[firstVisible] + heights[firstVisible] < scrollTop) {
    firstVisible++;
  }
  let lastVisible = firstVisible;
  while (lastVisible < n - 1 && offsets[lastVisible] <= viewBottom) {
    lastVisible++;
  }
  let startIdx = Math.max(0, firstVisible - VIRTUAL_OVERSCAN);
  const endIdx = Math.min(
    n - 1,
    Math.max(lastVisible + VIRTUAL_OVERSCAN, startIdx + VIRTUAL_MIN_WINDOW - 1),
  );
  if (endIdx - startIdx + 1 < VIRTUAL_MIN_WINDOW) {
    startIdx = Math.max(0, endIdx - VIRTUAL_MIN_WINDOW + 1);
  }
  const topSpacer = startIdx > 0 ? Math.max(0, offsets[startIdx] - VIRTUAL_CARD_GAP) : 0;
  const endBottom = offsets[endIdx] + heights[endIdx];
  const bottomSpacer =
    endIdx < n - 1 ? Math.max(0, totalHeight - endBottom - VIRTUAL_CARD_GAP) : 0;
  return { startIdx, endIdx, topSpacer, bottomSpacer };
}

function makeLaneSpacer(pos, heightPx) {
  const div = document.createElement("div");
  div.className = `lane-spacer lane-spacer-${pos}`;
  div.setAttribute("aria-hidden", "true");
  div.style.height = `${Math.round(heightPx)}px`;
  return div;
}

function renderLaneVirtual(key) {
  const el = document.querySelector(`#list-${key}`);
  const state = laneVirtualState.get(key);
  if (!el || !state) return;
  const items = state.items;
  const { startIdx, endIdx, topSpacer, bottomSpacer } = computeVirtualSlice(el, items);
  const slice = items.length ? items.slice(startIdx, endIdx + 1) : [];
  const cardSigs = slice.map(cardRenderSig);
  const laneSig = `${items.length}|${startIdx}:${endIdx}|${Math.round(topSpacer)}:${Math.round(bottomSpacer)}|${cardSigs.join("\x1e")}`;
  if (state.lastSig === laneSig) return;
  state.lastSig = laneSig;

  const existingById = new Map();
  for (const child of el.querySelectorAll(".card[data-id]")) {
    existingById.set(child.dataset.id, child);
  }
  const nodes = [];
  if (topSpacer > 0) {
    nodes.push(makeLaneSpacer("top", topSpacer));
  }
  for (let i = 0; i < slice.length; i++) {
    const t = slice[i];
    const sig = cardSigs[i];
    const prev = existingById.get(t.id);
    if (prev && prev.dataset.cardSig === sig) {
      nodes.push(prev);
    } else {
      const card = makeCard(t);
      card.dataset.cardSig = sig;
      nodes.push(card);
    }
  }
  if (bottomSpacer > 0) {
    nodes.push(makeLaneSpacer("bottom", bottomSpacer));
  }
  const prevScrollTop = el.scrollTop;
  el.replaceChildren(...nodes);
  if (items.length > VIRTUAL_MIN_WINDOW && el.scrollTop !== prevScrollTop) {
    el.scrollTop = prevScrollTop;
  }
  for (const child of nodes) {
    const id = child.dataset?.id;
    if (!id) continue;
    const h = child.offsetHeight;
    if (h > 40) cardHeightCache.set(id, h);
  }
}

function bindLaneVirtualScroll() {
  for (const key of LANES) {
    const body = document.querySelector(`#list-${key}`);
    if (!body || body.dataset.virtualBound) continue;
    body.dataset.virtualBound = "1";
    body.addEventListener(
      "scroll",
      () => {
        const state = laneVirtualState.get(key);
        if (!state || state.items.length <= VIRTUAL_MIN_WINDOW) return;
        if (state.rafId) return;
        state.rafId = window.requestAnimationFrame(() => {
          state.rafId = 0;
          renderLaneVirtual(key);
        });
      },
      { passive: true },
    );
  }
}

function renderList() {
  if (isDragBusy()) {
    pendingRenderList = true;
    return;
  }
  ensureLaneSelectButtons();
  bindLaneDropTargets();
  bindLaneVirtualScroll();
  updateCounts();
  updateWorkspaceCounts();
  const buckets = { draft: [], todo: [], running: [], done: [], archived: [] };
  for (const t of tasksInCurrentWorkspace()) {
    if (!matchesQuery(t)) continue;
    buckets[tabOf(t.status)].push(t);
  }
  let total = 0;
  for (const key of LANES) {
    const items = buckets[key].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    total += items.length;
    let state = laneVirtualState.get(key);
    if (!state) {
      state = { items: [], lastSig: "", rafId: 0 };
      laneVirtualState.set(key, state);
    }
    state.items = items;
    renderLaneVirtual(key);
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
  createModelPicker.clear();
  syncCreateThinkingEffort("");
  formError.hidden = true;
  formError.textContent = "";
}

function clearContinuePrompt() {
  if (continuePrompt) continuePrompt.value = "";
  continueModelPicker.clear();
  const task = tasks.get(selectedId);
  if (task) {
    syncContinueThinkingEffort(task.thinkingEffort || "");
  }
  if (continueError) {
    continueError.hidden = true;
    continueError.textContent = "";
  }
}

function taskIsActive(task) {
  return Boolean(task && ["queued", "running", "blocked"].includes(task.status));
}

function followupsOf(taskId) {
  return followupQueues.get(taskId) || [];
}

function renderFollowupQueue(taskId) {
  if (!followupQueueEl) return;
  const items = taskId ? followupsOf(taskId) : [];
  followupQueueEl.replaceChildren();
  if (!items.length) {
    followupQueueEl.hidden = true;
    return;
  }
  followupQueueEl.hidden = false;
  for (const [index, text] of items.entries()) {
    const item = document.createElement("li");
    item.className = "followup-item";
    const order = document.createElement("span");
    order.className = "followup-index";
    order.textContent = String(index + 1);
    const body = document.createElement("span");
    body.className = "followup-text";
    body.textContent = text;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "followup-remove";
    remove.dataset.followupIndex = String(index);
    remove.setAttribute("aria-label", "移除排队消息");
    remove.title = "移除";
    remove.textContent = "×";
    item.append(order, body, remove);
    followupQueueEl.appendChild(item);
  }
}

function queueFollowup(taskId, text) {
  const prompt = String(text || "").trim();
  if (!taskId || !prompt) return false;
  const next = followupsOf(taskId).concat(prompt);
  followupQueues.set(taskId, next);
  if (selectedId === taskId) renderFollowupQueue(taskId);
  return true;
}

function removeFollowup(taskId, index) {
  const next = followupsOf(taskId).filter((_, i) => i !== index);
  if (next.length) followupQueues.set(taskId, next);
  else followupQueues.delete(taskId);
  if (selectedId === taskId) renderFollowupQueue(taskId);
}

function renderQuickPromptButtons(container, targetId) {
  if (!container) return;
  container.replaceChildren();
  if (!quickPrompts.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const item of quickPrompts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary quick-prompt-btn";
    button.dataset.quickId = item.id;
    button.dataset.target = targetId;
    button.title = item.label || "快捷";
    button.textContent = item.label || "快捷";
    container.appendChild(button);
  }
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
  list.replaceChildren();
  if (!pendingAttachments.length) {
    list.hidden = true;
    return;
  }
  list.hidden = false;
  pendingAttachments.forEach((file, index) => {
    const item = document.createElement("li");
    item.className = "attach-item";
    item.dataset.idx = String(index);
    const name = document.createElement("span");
    name.className = "attach-item-name";
    name.title = file.originalName || "";
    name.textContent = file.originalName || "";
    const size = document.createElement("span");
    size.className = "attach-item-size";
    size.textContent = formatBytes(file.size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary attach-item-remove";
    remove.dataset.idx = String(index);
    remove.textContent = "移除";
    item.append(name, size, remove);
    list.appendChild(item);
  });
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

function appendAttachmentsMeta(grid, task) {
  const list = Array.isArray(task.attachments) ? task.attachments : [];
  if (!list.length || !grid) return;
  const item = document.createElement("div");
  item.className = "meta-item meta-wide detail-attachments";
  const label = document.createElement("span");
  label.className = "meta-k";
  label.textContent = `附件（${list.length}）`;
  const ul = document.createElement("ul");
  ul.className = "attach-list";
  for (const file of list) {
    const li = document.createElement("li");
    li.className = "attach-item";
    const link = document.createElement("a");
    link.className = "attach-item-link attach-item-name";
    link.href = attachmentDownloadUrl(file);
    link.download = file.originalName || file.name || "file";
    link.title = file.originalName || "";
    link.textContent = file.originalName || file.name || "file";
    const size = document.createElement("span");
    size.className = "attach-item-size";
    size.textContent = formatBytes(file.size);
    li.append(link, size);
    ul.appendChild(li);
  }
  item.append(label, ul);
  grid.appendChild(item);
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
  createModelPicker.syncWithKind();
  syncCreateThinkingEffort("");
  void loadAgentModels();
  createModal.classList.remove("hidden");
  if (createUseWorktree) createUseWorktree.checked = false;
  void refreshCreateWorktreeEligibility();
}
function hideCreateWorktree() {
  if (createUseWorktree) createUseWorktree.checked = false;
  if (createUseWorktreeLabel) createUseWorktreeLabel.hidden = true;
  if (createWorktreeNote) createWorktreeNote.hidden = true;
}
async function refreshCreateWorktreeEligibility() {
  const seq = ++worktreeEligSeq;
  const wsId = selectedWorkspaceId;
  hideCreateWorktree();
  if (createUseWorktreeLabel) createUseWorktreeLabel.dataset.elig = "pending";
  if (!wsId || createModal.classList.contains("hidden")) {
    if (seq === worktreeEligSeq && createUseWorktreeLabel) createUseWorktreeLabel.dataset.elig = "no";
    return;
  }
  try {
    const res = await fetch(`/api/workspaces/${encodeURIComponent(wsId)}/git-worktree-eligibility`);
    if (seq !== worktreeEligSeq || selectedWorkspaceId !== wsId || createModal.classList.contains("hidden")) return;
    if (!res.ok) {
      hideCreateWorktree();
      createUseWorktreeLabel.dataset.elig = "no";
      return;
    }
    const data = await res.json();
    if (seq !== worktreeEligSeq || selectedWorkspaceId !== wsId || createModal.classList.contains("hidden")) return;
    if (data && data.ok === true) {
      if (createUseWorktree) createUseWorktree.checked = false;
      createUseWorktreeLabel.hidden = false;
      if (createWorktreeNote) createWorktreeNote.hidden = false;
      createUseWorktreeLabel.dataset.elig = "yes";
    } else {
      hideCreateWorktree();
      createUseWorktreeLabel.dataset.elig = "no";
    }
  } catch {
    if (seq !== worktreeEligSeq) return;
    hideCreateWorktree();
    if (createUseWorktreeLabel) createUseWorktreeLabel.dataset.elig = "no";
  }
}
function closeCreate() {
  worktreeEligSeq += 1;
  createModelPicker.closeDropdown();
  createModal.classList.add("hidden");
  hideCreateWorktree();
  clearCreatePrompt();
  clearPendingAttachments();
  try { form.reset(); } catch { /* ignore */ }
  createModelPicker.clear();
}

let shouldScrollOutputToLastTurn = false;
let lastPaintedRoundCount = 0;

function scrollOutputToLastTurn() {
  if (!detailOutput) return;
  const turns = detailOutput.querySelectorAll(".output-turn");
  const lastTurn = turns.length ? turns[turns.length - 1] : null;
  if (!lastTurn || turns.length <= 1) {
    detailOutput.scrollTop = 0;
    return;
  }
  const containerRect = detailOutput.getBoundingClientRect();
  const turnRect = lastTurn.getBoundingClientRect();
  const targetTop = detailOutput.scrollTop + (turnRect.top - containerRect.top) - 12;
  detailOutput.scrollTop = Math.max(0, Math.round(targetTop));
}

async function openDetail(id) {
  selectedId = id;
  selectedLogLines = [];
  selectedLogCount = 0;
  lastOutputSig = "";
  lastPaintedTaskId = null;
  lastPaintedRoundCount = 0;
  shouldScrollOutputToLastTurn = true;
  clearContinuePrompt();
  applyQuickPromptsToUi();
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
  const item = document.createElement("div");
  item.className = wide ? "meta-item meta-wide" : "meta-item";
  const label = document.createElement("span");
  label.className = "meta-k";
  label.textContent = k;
  let body;
  if (opts.markdown) {
    body = document.createElement("div");
    body.className = "meta-v md-body prompt-md";
    const rendered = v ? renderMarkdown(v) : "—";
    const parsed = new DOMParser().parseFromString(rendered, "text/html");
    body.append(...parsed.body.childNodes);
  } else if (opts.code && v) {
    body = document.createElement("button");
    body.type = "button";
    body.className = "meta-cmd-btn";
    body.dataset.copyCmd = String(v);
    body.title = "点击复制命令";
    const code = document.createElement("code");
    code.className = "meta-cmd";
    code.textContent = String(v);
    body.appendChild(code);
  } else {
    body = document.createElement("span");
    body.className = `meta-v${opts.muted ? " muted" : ""}${k === "工作目录" ? " cwd" : ""}`;
    body.textContent = v || "—";
  }
  item.append(label, body);
  return item;
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
  return `${task.id}|${task.status}|${task.startedAt || ""}|${task.endedAt || ""}|${task.output?.length || 0}|${parts.join(";")}|${promptParts.join(";")}|${task.error || ""}|${task.exitCode ?? ""}`;
}

function promptsOf(task) {
  const list = Array.isArray(task.prompts) ? task.prompts.filter((p) => p && String(p.prompt || "").trim()) : [];
  if (list.length) return list.slice().sort((a, b) => a.iteration - b.iteration);
  // Fallback: at least show the initial task.prompt as round 1.
  if (task.prompt && String(task.prompt).trim()) {
    return [{ iteration: 1, prompt: task.prompt, at: task.startedAt || task.createdAt }];
  }
  return [];
}

function paintOutput(task) {
  const sig = outputSignature(task);
  if (lastPaintedTaskId === task.id && lastOutputSig === sig && detailOutput.childNodes.length) {
    if (shouldScrollOutputToLastTurn) {
      shouldScrollOutputToLastTurn = false;
      scrollOutputToLastTurn();
      window.requestAnimationFrame(() => scrollOutputToLastTurn());
    }
    return;
  }
  const prevTaskId = lastPaintedTaskId;
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
    const prevScrollTop = detailOutput.scrollTop;
    const isNewRound = prevTaskId === task.id && rounds.length > lastPaintedRoundCount;
    const shouldScrollToLast = shouldScrollOutputToLastTurn || prevTaskId !== task.id || isNewRound;
    shouldScrollOutputToLastTurn = false;
    lastPaintedRoundCount = rounds.length;
    detailOutput.classList.remove("empty-output");
    detailOutput.replaceChildren();
    for (const round of rounds) {
      const roundRunning = running && round.iteration === curIter;
      const roundDone = task.status !== "draft" && !roundRunning;
      const fallbackStartIso = round.iteration <= 1 ? task.startedAt || task.createdAt || "" : "";
      const startIso = round.promptAt || fallbackStartIso;
      const fallbackEndIso = round.iteration === curIter ? task.endedAt || task.updatedAt || "" : "";
      const endIso = roundDone ? round.at || fallbackEndIso : "";
      const when = formatLocal(startIso || round.at) || "";
      const kind = round.iteration <= 1 ? "初始" : "继续";
      const article = document.createElement("article");
      article.className = "output-turn";
      article.dataset.iteration = String(round.iteration);
      const header = document.createElement("header");
      header.className = "output-turn-head";
      const heading = document.createElement("span");
      heading.textContent = `第 ${round.iteration} 轮 · ${kind}${when ? " · " + when : ""}`;
      header.append(heading);
      if (roundRunning) {
        const live = document.createElement("span");
        live.className = "turn-live";
        live.textContent = "实时";
        header.append(live);
      }
      if (roundDone && endIso) {
        const endWhen = formatLocal(endIso);
        const duration = formatRoundDuration(startIso, endIso);
        const endParts = [];
        if (endWhen) endParts.push(`结束时间 ${endWhen}`);
        if (duration) endParts.push(`时长 ${duration}`);
        if (endParts.length) {
          const endMeta = document.createElement("span");
          endMeta.className = "output-turn-end";
          endMeta.textContent = endParts.join(" · ");
          header.append(endMeta);
        }
      }
      const promptText = round.prompt || (round.iteration <= 1 ? task.prompt : "");
      const promptBox = document.createElement("div");
      promptBox.className = promptText ? "output-turn-prompt" : "output-turn-prompt output-turn-prompt-empty";
      const promptLabel = document.createElement("div");
      promptLabel.className = "output-turn-prompt-label";
      promptLabel.textContent = "提示词";
      promptBox.appendChild(promptLabel);
      if (promptText) {
        const promptBody = document.createElement("div");
        promptBody.className = "output-turn-prompt-body md-body prompt-md";
        const parsed = new DOMParser().parseFromString(promptText ? renderMarkdown(promptText) : "—", "text/html");
    promptBody.append(...parsed.body.childNodes);
        promptBox.appendChild(promptBody);
      } else {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = "（无记录）";
        promptBox.appendChild(empty);
      }
      const replyLabel = document.createElement("div");
      replyLabel.className = "output-turn-reply-label";
      replyLabel.textContent = "回复";
      const reply = document.createElement("div");
      reply.className = "output-turn-body";
      if (String(round.text || "").trim()) {
        reply.classList.add("md-body");
        const parsed = new DOMParser().parseFromString(round.text ? renderMarkdown(round.text) : "—", "text/html");
    reply.append(...parsed.body.childNodes);
      } else {
        reply.classList.add("output-turn-pending", "muted");
        reply.textContent = running && round.iteration === curIter ? "回复生成中…" : "本轮暂无回复";
      }
      article.append(header, promptBox, replyLabel, reply);
      detailOutput.appendChild(article);
    }
    if (shouldScrollToLast) {
      scrollOutputToLastTurn();
      window.requestAnimationFrame(() => scrollOutputToLastTurn());
    } else {
      detailOutput.scrollTop = prevScrollTop;
    }
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

function sideJobBadgeClass(status) {
  if (status === "running" || status === "succeeded" || status === "failed") return status;
  return "stopped";
}

function paintSideJobs(task) {
  const jobs = Array.isArray(task.sideJobs) ? task.sideJobs : [];
  if (!detailSidejobs) return;
  detailSidejobs.replaceChildren();
  if (!jobs.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "暂无后台任务";
    detailSidejobs.appendChild(empty);
    if (sidejobsHint) sidejobsHint.textContent = "无";
    return;
  }
  const running = jobs.filter((job) => job.status === "running").length;
  if (sidejobsHint) {
    sidejobsHint.textContent = running
      ? `${jobs.length} 项 · ${running} 进行中`
      : `${jobs.length} 项`;
  }
  for (const job of jobs) {
    const card = document.createElement("article");
    card.className = `sidejob-card status-${job.status || "unknown"}`;
    const top = document.createElement("div");
    top.className = "sidejob-top";
    const kind = document.createElement("span");
    kind.className = "sidejob-kind";
    kind.textContent = SIDE_KIND_LABEL[job.kind] || job.kind || "其他";
    const badge = document.createElement("span");
    badge.className = `badge ${sideJobBadgeClass(job.status)}`;
    badge.textContent = SIDE_STATUS_LABEL[job.status] || job.status || "";
    top.append(kind, badge);
    const title = document.createElement("p");
    title.className = "sidejob-title";
    title.textContent = job.title || job.toolName || job.id || "";
    card.append(top, title);
    if (job.summary) {
      const summary = document.createElement("p");
      summary.className = "sidejob-summary";
      summary.textContent = job.summary;
      card.appendChild(summary);
    }
    const meta = document.createElement("div");
    meta.className = "sidejob-meta";
    if (job.toolName) {
      const tool = document.createElement("span");
      tool.className = "kind-pill";
      tool.textContent = job.toolName;
      meta.appendChild(tool);
    }
    const start = formatLocal(job.startedAt);
    const end = formatLocal(job.endedAt);
    const times = [start ? `开始 ${start}` : "", end ? `结束 ${end}` : ""].filter(Boolean).join(" · ");
    if (times) {
      const time = document.createElement("span");
      time.className = "sidejob-times";
      time.textContent = times;
      meta.appendChild(time);
    }
    if (meta.childNodes.length) card.appendChild(meta);
    detailSidejobs.appendChild(card);
  }
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
    thinkingEffort: task.thinkingEffort,
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
  const replyLabel = formatLocal(lastReplyAt(task)) || "—";
  paintLastReply(task);
  detailMetaGrid.replaceChildren(
    metaItem("任务 ID", task.id || "—"),
    metaItem("状态", statusText),
    metaItem("迭代", String(iter)),
    metaItem("开始时间", startLabel),
    metaItem("结束时间", endLabel),
    metaItem("最后回复", replyLabel),
    metaItem("Agent", task.kind),
    metaItem("模型", task.model || "—"),
    metaItem("思考强度", task.thinkingEffort || "—"),
    metaItem("PID", task.pid != null ? String(task.pid) : "—"),
    metaItem("退出码", task.exitCode != null ? String(task.exitCode) : "—"),
    metaItem("会话", task.sessionId || "—", true),
    resumeMetaItem(task),
    metaItem("工作区", (task.workspaceId && workspaces.get(task.workspaceId)?.name) || task.workspaceId || "—"),
    metaItem("工作目录", task.cwd, true),
    ...(task.worktree?.branch ? [metaItem("Git 分支", task.worktree.branch, true)] : []),
    metaItem("初始提示词", task.prompt, true, { markdown: true }),
  );
  appendAttachmentsMeta(detailMetaGrid, task);

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
  const submitting = continuingTaskId === task.id;
  const queued = followupsOf(task.id);
  continueBtn.hidden = task.status === "draft";
  continueBtn.disabled = !showContinue || submitting;
  continueBtn.textContent = queued.length ? `继续任务（排队 ${queued.length}）` : "继续任务";
  continueModel.disabled = !canContinue(task) || !task.sessionId || submitting;
  if (continueThinkingEffort) {
    continueThinkingEffort.disabled = !canContinue(task) || submitting;
  }
  if (continueModel.disabled) continueModelPicker.closeDropdown();
  renderFollowupQueue(task.id);
  continueModel.placeholder = task.model ? `留空沿用 ${task.model}` : "留空沿用当前模型";
  continueModelHint.textContent = !task.sessionId
    ? "缺少原会话，不能在保留上下文的情况下切换模型。"
    : !canContinue(task)
      ? "请先停止任务，再选择下一轮模型。"
      : `仅切换 ${task.kind} 内兼容的模型，保留原会话历史；不更换执行器、不新建会话。上下文窗口和自动压缩仍受 CLI 限制。`;
  continueModelPicker.syncWithKind();
  syncContinueThinkingEffort(continueThinkingEffort?.value || task.thinkingEffort || "");
  continueHint.textContent = task.status === "draft"
    ? ""
    : showContinue
      ? task.sessionId
        ? `将续会话 ${task.sessionId}`
        : "无原会话：仅携带初始提示词和本轮指令重新执行，不恢复历史上下文"
      : queued.length
        ? `任务运行中。已排队 ${queued.length} 条，结束后会按顺序继续`
        : "任务运行中。输入内容后按回车，会加入排队";
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
  infoViewerModal?.classList.add("hidden");
  sidejobsViewerModal?.classList.add("hidden");
  closeLogViewer();
  closeMetaViewer();
  detailModal.classList.add("hidden");
  selectedId = null;
  selectedLogLines = [];
  selectedLogCount = 0;
  lastOutputSig = "";
  lastPaintedTaskId = null;
  clearContinuePrompt();
  renderFollowupQueue(null);
}

document.getElementById("btn-new").onclick = () => openCreate("draft");
document.getElementById("btn-new-todo").onclick = () => openCreate("todo");
if (createKindSelect) {
  createKindSelect.addEventListener("change", () => {
    createModelPicker.clear();
    createModelPicker.syncWithKind();
    syncCreateThinkingEffort("");
  });
}
createModelPicker.syncWithKind();
syncCreateThinkingEffort("");
document.getElementById("create-close").onclick = closeCreate;
document.getElementById("create-cancel").onclick = closeCreate;
document.getElementById("detail-close").onclick = closeDetail;
document.getElementById("btn-open-log").onclick = () => void openLogViewer();
document.getElementById("btn-open-meta").onclick = openMetaViewer;
document.getElementById("btn-open-info").onclick = () => infoViewerModal.classList.remove("hidden");
sidejobsBtn.onclick = () => sidejobsViewerModal.classList.remove("hidden");
document.getElementById("info-viewer-close").onclick = () => infoViewerModal.classList.add("hidden");
document.getElementById("sidejobs-viewer-close").onclick = () => sidejobsViewerModal.classList.add("hidden");
for (const m of [infoViewerModal, sidejobsViewerModal]) {
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); });
}
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
  const target = new URL(img.src, location.origin);
  if (!["http:", "https:"].includes(target.protocol)) return;
  window.open(target.href, "_blank", "noopener");
});

detailModal.addEventListener("click", (e) => { if (e.target === detailModal) closeDetail(); });
logViewerModal?.addEventListener("click", (e) => { if (e.target === logViewerModal) closeLogViewer(); });
metaViewerModal?.addEventListener("click", (e) => { if (e.target === metaViewerModal) closeMetaViewer(); });

searchEl.addEventListener("input", () => {
  query = searchEl.value;
  renderList();
});

async function submitCreateTask() {
  formError.hidden = true;
  if (!selectedWorkspaceId) {
    formError.hidden = false;
    formError.textContent = "未选择工作区";
    return;
  }
  const fd = new FormData(form);
  const worktreeOn = Boolean(
    createUseWorktreeLabel &&
    !createUseWorktreeLabel.hidden &&
    createUseWorktree &&
    createUseWorktree.checked
  );
  const selectedCreateModel = createModelPicker.commitOrRevert();
  const selectedThinkingEffort = createThinkingEffortSelect?.value?.trim() || undefined;
  const body = {
    kind: fd.get("kind"),
    title: fd.get("title") || undefined,
    workspaceId: selectedWorkspaceId,
    model: selectedCreateModel || undefined,
    thinkingEffort: selectedThinkingEffort,
    prompt: fd.get("prompt"),
    start: createMode === "todo",
    attachments: pendingAttachments.length ? pendingAttachments : undefined,
    ...(worktreeOn ? { useGitWorktree: true } : {}),
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
  createModelPicker.clear();
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await submitCreateTask();
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
  if (!window.confirm(`确认删除任务「${t.title}」？${worktreeDeleteNotice([t])}`)) return;
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
    lastAgentLogAt.delete(id);
    selected.delete(id);
  }
  closeDetail();
  renderList();
  const warn = worktreeWarningText(data);
  if (warn) window.alert(warn);
});

/** @param {{ prompt?: string, model?: string }} body */
async function postContinue(id, body) {
  const res = await fetch(`/api/tasks/${id}/continue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showContinueError(id, err) {
  if (selectedId !== id || !continueError) return;
  continueError.hidden = false;
  continueError.textContent = err?.message || "继续任务失败，请重试";
}

/**
 * Send the oldest queued follow-up once the task is idle.
 * One message per finished run, so later replies stay in order.
 * @param {string} id
 */
async function drainFollowup(id) {
  if (followupDraining.has(id) || continuingTaskId === id) return;
  const task = tasks.get(id);
  const queued = followupsOf(id);
  if (!task || !queued.length || !canContinue(task)) return;
  const prompt = queued[0];
  followupDraining.add(id);
  continuingTaskId = id;
  if (selectedId === id) {
    continueError.hidden = true;
    continueBtn.disabled = true;
  }
  try {
    const data = await postContinue(id, { prompt });
    removeFollowup(id, 0);
    if (data.task) {
      tasks.set(data.task.id, data.task);
      renderList();
    }
  } catch (err) {
    showContinueError(id, err);
  } finally {
    followupDraining.delete(id);
    continuingTaskId = null;
    const latest = tasks.get(selectedId);
    if (latest) paintDetail(latest);
  }
}

continueBtn.addEventListener("click", async () => {
  if (!selectedId || continuingTaskId) return;
  const id = selectedId;
  const task = tasks.get(id);
  const typed = continuePrompt.value.trim();
  if (task && taskIsActive(task)) {
    if (!queueFollowup(id, typed)) return;
    continuePrompt.value = "";
    paintDetail(tasks.get(id) || task);
    return;
  }
  const model = continueModel.disabled ? "" : continueModelPicker.commitOrRevert();
  const effort = continueThinkingEffort && !continueThinkingEffort.disabled
    ? continueThinkingEffort.value.trim()
    : "";
  const body = {
    prompt: typed || undefined,
    model: model || undefined,
    thinkingEffort: effort || undefined,
  };
  continuingTaskId = id;
  continueError.hidden = true;
  continueBtn.disabled = true;
  continueModel.disabled = true;
  if (continueThinkingEffort) continueThinkingEffort.disabled = true;
  try {
    const data = await postContinue(id, body);
    if (data.task) {
      tasks.set(data.task.id, data.task);
      if (selectedId === id) clearContinuePrompt();
      renderList();
    }
  } catch (err) {
    showContinueError(id, err);
  } finally {
    continuingTaskId = null;
    const task = tasks.get(selectedId);
    if (task) paintDetail(task);
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
  msg += worktreeDeleteNotice(allowed.map((id) => tasks.get(id)));
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
    lastAgentLogAt.delete(id);
    selected.delete(id);
    if (selectedId === id) closeDetail();
  }
  const skipped = data.skipped || [];
  const warn = worktreeWarningText(data);
  if (skipped.length) {
    window.alert(`已删除 ${data.deleted?.length || 0} 个；跳过 ${skipped.length} 个不可删任务（Todo/进行中）。${warn ? `\n${warn}` : ""}`);
  } else if (warn) {
    window.alert(warn);
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

function promptEnterSubmits(e) {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

document.getElementById("create-prompt")?.addEventListener("keydown", (e) => {
  if (!promptEnterSubmits(e)) return;
  if (createModal.classList.contains("hidden")) return;
  e.preventDefault();
  if (!form.reportValidity()) return;
  void submitCreateTask();
});

continuePrompt?.addEventListener("keydown", (e) => {
  if (!promptEnterSubmits(e)) return;
  if (!selectedId || detailModal.classList.contains("hidden")) return;
  e.preventDefault();
  continueBtn.click();
});

followupQueueEl?.addEventListener("click", (e) => {
  const btn = e.target?.closest?.(".followup-remove");
  if (!btn || !selectedId) return;
  const index = Number(btn.dataset.followupIndex);
  if (!Number.isInteger(index)) return;
  removeFollowup(selectedId, index);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!document.getElementById("folder-modal")?.classList.contains("hidden")) return closeFolderModal();
  for (const m of [infoViewerModal, sidejobsViewerModal]) {
    if (!m.classList.contains("hidden")) return m.classList.add("hidden");
  }
  if (logViewerModal && !logViewerModal.classList.contains("hidden")) return closeLogViewer();
  if (metaViewerModal && !metaViewerModal.classList.contains("hidden")) return closeMetaViewer();
  if (!wsModal.classList.contains("hidden")) return closeWsModal();
  if (!createModal.classList.contains("hidden")) return closeCreate();
  if (!detailModal.classList.contains("hidden")) return closeDetail();
});



const WS_ORDER_KEY = "agent-board.workspaceOrder";
let dragWorkspaceId = null;

function readWorkspaceOrder() {
  try {
    const raw = localStorage.getItem(WS_ORDER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeWorkspaceOrder(ids) {
  try {
    localStorage.setItem(WS_ORDER_KEY, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

function workspaceOrderRank(ws, savedIndex) {
  if (typeof ws.sortOrder === "number" && Number.isFinite(ws.sortOrder)) {
    return ws.sortOrder;
  }
  if (savedIndex.has(ws.id)) {
    return savedIndex.get(ws.id);
  }
  return Number.MAX_SAFE_INTEGER;
}

function orderedWorkspaces() {
  const savedOrder = readWorkspaceOrder();
  const savedIndex = new Map(savedOrder.map((id, idx) => [id, idx]));
  return [...workspaces.values()].sort((a, b) => {
    const ao = workspaceOrderRank(a, savedIndex);
    const bo = workspaceOrderRank(b, savedIndex);
    if (ao !== bo) return ao - bo;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

function clearWsDragIndicators() {
  if (!wsListEl) return;
  for (const el of wsListEl.querySelectorAll(".ws-item.drag-over, .ws-item.drag-over-above, .ws-item.drag-over-below")) {
    el.classList.remove("drag-over", "drag-over-above", "drag-over-below");
  }
}

function isDragBusy() {
  return Boolean(activePointerDrag || dragTaskId || dragWorkspaceId);
}

function flushPendingRenders() {
  if (isDragBusy()) return;
  if (pendingRenderWorkspaces) {
    pendingRenderWorkspaces = false;
    renderWorkspaces();
  }
  if (pendingRenderList) {
    pendingRenderList = false;
    renderList();
  }
}

function startPointerDrag(kind, id, sourceEl, title, startX, startY) {
  cancelPointerDrag();
  activePointerDrag = {
    kind,
    id,
    sourceEl,
    title: String(title || id),
    startX,
    startY,
    started: false,
    ghostEl: null,
    targetLane: null,
    targetWsId: null,
  };
}

function findClosestWsButton(clientY) {
  if (!wsListEl) return null;
  const buttons = [...wsListEl.querySelectorAll(".ws-item")];
  if (!buttons.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const btn of buttons) {
    const r = btn.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const d = Math.abs(clientY - mid);
    if (d < bestDist) {
      bestDist = d;
      best = btn;
    }
  }
  return best;
}

function highlightWsDropTarget(sourceId, targetBtn) {
  clearWsDragIndicators();
  if (!targetBtn) return null;
  const targetId = targetBtn.dataset.workspaceId || null;
  if (!targetId || targetId === sourceId) return null;
  const ids = orderedWorkspaces().map((w) => w.id);
  const fromIdx = ids.indexOf(sourceId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return null;
  const placeAfter = fromIdx < toIdx;
  targetBtn.classList.add("drag-over", placeAfter ? "drag-over-below" : "drag-over-above");
  return targetId;
}

function cleanupPointerDragVisuals(drag) {
  if (drag?.ghostEl) {
    drag.ghostEl.remove();
    drag.ghostEl = null;
  }
  if (drag?.sourceEl) {
    drag.sourceEl.classList.remove("dragging");
  }
  document.body.classList.remove("is-dragging");
  clearLaneDragIndicators();
  clearWsDragIndicators();
}

function cancelPointerDrag() {
  if (!activePointerDrag) return;
  const drag = activePointerDrag;
  activePointerDrag = null;
  dragTaskId = null;
  dragWorkspaceId = null;
  cleanupPointerDragVisuals(drag);
  flushPendingRenders();
}

window.addEventListener("pointermove", (e) => {
  if (!activePointerDrag) return;
  const drag = activePointerDrag;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.started) {
    if (Math.hypot(dx, dy) < 5) return;
    drag.started = true;
    if (drag.kind === "card") {
      dragTaskId = drag.id;
    } else {
      dragWorkspaceId = drag.id;
    }
    drag.sourceEl.classList.add("dragging");
    document.body.classList.add("is-dragging");
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = drag.title;
    document.body.append(ghost);
    drag.ghostEl = ghost;
  }
  if (drag.ghostEl) {
    drag.ghostEl.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY + 12}px, 0)`;
  }
  const under = document.elementFromPoint(e.clientX, e.clientY);
  if (drag.kind === "card") {
    clearLaneDragIndicators();
    const laneEl = under instanceof Element ? under.closest(".lane[data-tab]") : null;
    if (laneEl) {
      const key = laneEl.getAttribute("data-tab");
      laneEl.classList.add("drag-over");
      if (key) document.getElementById(`list-${key}`)?.classList.add("drag-over");
      drag.targetLane = key;
    } else {
      drag.targetLane = null;
    }
  } else if (drag.kind === "ws") {
    let targetBtn = under instanceof Element ? under.closest("#ws-list .ws-item") : null;
    if (!targetBtn && under instanceof Element && wsListEl?.contains(under)) {
      targetBtn = findClosestWsButton(e.clientY);
    }
    drag.targetWsId = highlightWsDropTarget(drag.id, targetBtn);
  }
});

window.addEventListener("pointerup", () => {
  if (!activePointerDrag) return;
  const drag = activePointerDrag;
  activePointerDrag = null;
  dragTaskId = null;
  dragWorkspaceId = null;
  cleanupPointerDragVisuals(drag);
  if (drag.started) {
    suppressClickUntil = Date.now() + 220;
    if (drag.kind === "card" && drag.targetLane) {
      const t = tasks.get(drag.id);
      if (t && tabOf(t.status) !== drag.targetLane) {
        void moveToLane(drag.id, drag.targetLane);
      }
    } else if (drag.kind === "ws" && drag.targetWsId && drag.targetWsId !== drag.id) {
      void reorderWorkspacesTo(drag.id, drag.targetWsId);
    }
  }
  flushPendingRenders();
});

window.addEventListener("pointercancel", () => cancelPointerDrag());
window.addEventListener("blur", () => cancelPointerDrag());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && activePointerDrag) {
    cancelPointerDrag();
  }
});

async function reorderWorkspacesTo(sourceId, targetId) {
  if (!sourceId || !workspaces.has(sourceId)) return;
  const ids = orderedWorkspaces().map((w) => w.id);
  const fromIdx = ids.indexOf(sourceId);
  if (fromIdx === -1) return;
  const toIdx = targetId ? ids.indexOf(targetId) : ids.length - 1;
  if (toIdx === -1 || fromIdx === toIdx) return;
  const nextIds = ids.filter((id) => id !== sourceId);
  nextIds.splice(toIdx, 0, sourceId);
  nextIds.forEach((id, idx) => {
    const ws = workspaces.get(id);
    if (ws) ws.sortOrder = idx;
  });
  writeWorkspaceOrder(nextIds);
  if (wsListEl) {
    const byId = new Map();
    for (const li of wsListEl.children) {
      const btn = li.querySelector(".ws-item");
      if (btn?.dataset.workspaceId) byId.set(btn.dataset.workspaceId, li);
    }
    if (byId.size === nextIds.length && nextIds.every((id) => byId.has(id))) {
      for (const id of nextIds) {
        wsListEl.append(byId.get(id));
      }
    } else {
      renderWorkspaces();
    }
  }
  try {
    await fetch("/api/workspaces/reorder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: nextIds }),
    });
  } catch {
    /* keep local order */
  }
}

function ensureSelectedWorkspace(fallbackId) {
  if (selectedWorkspaceId && workspaces.has(selectedWorkspaceId)) return;
  const prefer = fallbackId && workspaces.has(fallbackId) ? fallbackId : null;
  selectedWorkspaceId = prefer || orderedWorkspaces()[0]?.id || null;
  if (selectedWorkspaceId) localStorage.setItem("agent-board.workspaceId", selectedWorkspaceId);
}

function taskOwnsWorktree(task) {
  return Boolean(task && task.worktree && task.worktree.owned === true);
}

function worktreeDeleteNotice(list) {
  const owned = list.filter(taskOwnsWorktree);
  if (!owned.length) return "";
  return `\n\n其中 ${owned.length} 个任务使用了 git worktree。删除时会移除对应的 worktree 目录。若目录里有未提交改动，则保留该目录，并在删除后提示。`;
}

function worktreeWarningText(data) {
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  if (!warnings.length) return "";
  return warnings.map((w) => w.message || w.code || "worktree 清理未完成").join("\n");
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
  if (createModal && !createModal.classList.contains("hidden")) {
    const ws = workspaces.get(id);
    if (createWsHint && ws) createWsHint.textContent = `工作区：${ws.name} · ${ws.path}`;
    if (createUseWorktree) createUseWorktree.checked = false;
    void refreshCreateWorktreeEligibility();
  }
}

function updateWorkspaceCounts() {
  if (!wsListEl) return;
  const counts = new Map();
  for (const task of tasks.values()) {
    if (!counts.has(task.workspaceId)) {
      counts.set(task.workspaceId, { draft: 0, todo: 0, running: 0, done: 0, archived: 0 });
    }
    counts.get(task.workspaceId)[tabOf(task.status)]++;
  }
  for (const btn of wsListEl.querySelectorAll(".ws-item")) {
    const lanes = counts.get(btn.dataset.workspaceId);
    const total = lanes ? Object.values(lanes).reduce((sum, count) => sum + count, 0) : 0;
    btn.querySelector(".ws-item-count").textContent = `${total} 个任务`;
    for (const countEl of btn.querySelectorAll(".ws-lane-count")) {
      countEl.textContent = lanes?.[countEl.dataset.lane] || 0;
    }
  }
}

function renderWorkspaces() {
  if (!wsListEl) return;
  wsListEl.replaceChildren();
  const list = orderedWorkspaces();
  if (wsEmptyEl) wsEmptyEl.hidden = list.length > 0;
  for (const workspace of list) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ws-item" + (workspace.id === selectedWorkspaceId ? " active" : "");
    btn.dataset.workspaceId = workspace.id;
    btn.draggable = true;
    const name = document.createElement("span");
    name.className = "ws-item-name";
    name.textContent = workspace.name;
    const path = document.createElement("span");
    path.className = "ws-item-path";
    path.textContent = workspace.path;
    const count = document.createElement("span");
    count.className = "ws-item-count";
    count.textContent = "0 个任务";
    const stats = document.createElement("span");
    stats.className = "ws-item-stats";
    for (const lane of LANES) {
      const stat = document.createElement("span");
      stat.className = "ws-lane-stat";
      stat.dataset.lane = lane;
      stat.append(document.createTextNode(`${LANE_LABEL[lane]} `));
      const value = document.createElement("b");
      value.className = "ws-lane-count";
      value.dataset.lane = lane;
      value.textContent = "0";
      stat.appendChild(value);
      stats.appendChild(stat);
    }
    btn.append(name, path, count, stats);
    btn.onclick = () => {
      if (Date.now() < suppressClickUntil) return;
      selectWorkspace(workspace.id);
    };
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWsContextMenu(e.clientX, e.clientY, workspace.id);
    });
    btn.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      closeWsContextMenu();
      startPointerDrag("ws", workspace.id, btn, workspace.name, e.clientX, e.clientY);
    });
    btn.addEventListener("dragstart", (e) => {
      if (e.isTrusted) {
        e.preventDefault();
        return;
      }
      closeWsContextMenu();
      dragWorkspaceId = workspace.id;
      btn.classList.add("dragging");
      if (e.dataTransfer) {
        e.dataTransfer.setData("text/plain", workspace.id);
        e.dataTransfer.effectAllowed = "move";
      }
    });
    btn.addEventListener("dragend", () => {
      dragWorkspaceId = null;
      btn.classList.remove("dragging");
      clearWsDragIndicators();
      flushPendingRenders();
    });
    btn.addEventListener("dragover", (e) => {
      const sourceId = dragWorkspaceId || e.dataTransfer?.getData("text/plain");
      if (!sourceId || !workspaces.has(sourceId)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      highlightWsDropTarget(sourceId, btn);
    });
    btn.addEventListener("dragleave", (e) => {
      if (btn.contains(e.relatedTarget)) return;
      btn.classList.remove("drag-over", "drag-over-above", "drag-over-below");
    });
    btn.addEventListener("drop", (e) => {
      const sourceId = dragWorkspaceId || e.dataTransfer?.getData("text/plain");
      if (!sourceId || !workspaces.has(sourceId)) return;
      e.preventDefault();
      e.stopPropagation();
      dragWorkspaceId = null;
      clearWsDragIndicators();
      void reorderWorkspacesTo(sourceId, workspace.id);
      flushPendingRenders();
    });
    li.appendChild(btn);
    wsListEl.appendChild(li);
  }
  updateWorkspaceCounts();
  const current = selectedWorkspaceId ? workspaces.get(selectedWorkspaceId) : null;
  if (wsBannerName) wsBannerName.textContent = current ? current.name : "未选择工作区";
  if (wsBannerPath) wsBannerPath.textContent = current ? current.path : "请在左侧新建或选择工作区";
  const canMutate = Boolean(current);
  document.getElementById("ws-edit").disabled = !canMutate;
  document.getElementById("ws-delete").disabled = !canMutate;
  void loadGitStatus(false);
}

const gitPanel = document.getElementById("git-panel");
const gitPanelBody = document.getElementById("git-panel-body");
const gitPanelSummary = document.getElementById("git-panel-summary");
const gitToggle = document.getElementById("git-toggle");
const GIT_COLLAPSE_KEY = "agent-board.gitPanelCollapsed";

function applyGitCollapsed() {
  if (!gitPanel || !gitToggle) return;
  const collapsed = localStorage.getItem(GIT_COLLAPSE_KEY) === "1";
  gitPanel.classList.toggle("is-collapsed", collapsed);
  gitToggle.textContent = collapsed ? "展开" : "收起";
  gitToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

applyGitCollapsed();
gitToggle?.addEventListener("click", () => {
  const collapsed = gitPanel?.classList.contains("is-collapsed");
  localStorage.setItem(GIT_COLLAPSE_KEY, collapsed ? "0" : "1");
  applyGitCollapsed();
});
document.getElementById("git-refresh")?.addEventListener("click", () => {
  void loadGitStatus(true);
});

let gitShownKey = "";
let gitLoadSeq = 0;

async function loadGitStatus(force) {
  if (!gitPanel) return;
  const id = selectedWorkspaceId;
  const ws = id ? workspaces.get(id) : null;
  if (!ws || ws.settings?.gitStatusEnabled === false) {
    gitPanel.hidden = true;
    gitShownKey = "";
    gitLoadSeq += 1;
    return;
  }
  const key = `${ws.id}\0${ws.path}`;
  if (!force && key === gitShownKey) return;
  gitShownKey = key;
  const seq = ++gitLoadSeq;
  gitPanel.hidden = false;
  if (gitPanelSummary) {
    gitPanelSummary.textContent = "加载中…";
    gitPanelSummary.classList.remove("bad");
  }
  if (gitPanelBody) gitPanelBody.replaceChildren();
  try {
    const q = force ? "?refresh=1" : "";
    const res = await fetch(`/api/workspaces/${encodeURIComponent(ws.id)}/git-status${q}`);
    const data = await res.json().catch(() => ({}));
    if (seq !== gitLoadSeq) return;
    if (!res.ok) {
      renderGitStatus(gitPanelBody, gitPanelSummary, null, data.error || res.statusText || "加载失败");
      return;
    }
    renderGitStatus(gitPanelBody, gitPanelSummary, data, null);
  } catch (err) {
    if (seq !== gitLoadSeq) return;
    renderGitStatus(gitPanelBody, gitPanelSummary, null, String(err?.message || err));
  }
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
      const target = new URL(`/workspaces/${encodeURIComponent(id)}/settings`, location.origin);
      if (target.origin !== location.origin) return;
      location.assign(target.pathname);
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
let renderWorkspacesTimer = null;
let paintDetailTimer = null;

function scheduleRenderList() {
  if (isDragBusy()) {
    pendingRenderList = true;
    return;
  }
  if (renderListTimer) return;
  renderListTimer = setTimeout(() => {
    renderListTimer = null;
    if (isDragBusy()) {
      pendingRenderList = true;
      return;
    }
    pendingRenderList = false;
    renderList();
  }, 80);
}

function scheduleRenderWorkspaces() {
  if (isDragBusy()) {
    pendingRenderWorkspaces = true;
    return;
  }
  if (renderWorkspacesTimer) return;
  renderWorkspacesTimer = setTimeout(() => {
    renderWorkspacesTimer = null;
    if (isDragBusy()) {
      pendingRenderWorkspaces = true;
      return;
    }
    pendingRenderWorkspaces = false;
    renderWorkspaces();
  }, 60);
}

function schedulePaintDetail(task) {
  if (paintDetailTimer) clearTimeout(paintDetailTimer);
  paintDetailTimer = setTimeout(() => {
    paintDetailTimer = null;
    if (task.id !== selectedId || detailModal.classList.contains("hidden")) return;
    // A continue response may already have changed the model/iteration since this SSE tick.
    const latest = tasks.get(task.id);
    if (latest) paintDetail(latest);
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
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    tasks.clear();
    for (const t of data.tasks || []) tasks.set(t.id, t);
    workspaces.clear();
    for (const w of data.workspaces || []) workspaces.set(w.id, w);
    ensureSelectedWorkspace();
    renderWorkspaces();
    renderList();
  });
  es.addEventListener("workspace_upsert", (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.workspace) {
      workspaces.set(data.workspace.id, data.workspace);
      scheduleRenderWorkspaces();
    }
  });
  es.addEventListener("workspace_delete", (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    for (const id of data.workspaceIds || []) workspaces.delete(id);
    ensureSelectedWorkspace();
    renderWorkspaces();
    renderList();
  });
  es.addEventListener("task_upsert", (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const prev = tasks.get(data.task.id);
    const merged = mergeBoardTask(prev, data.task);
    tasks.set(data.task.id, merged);
    scheduleRenderList();
    if (canContinue(merged) && followupsOf(data.task.id).length) {
      void drainFollowup(data.task.id);
    }
    if (data.task.id === selectedId && !detailModal.classList.contains("hidden")) {
      schedulePaintDetail(merged);
      if (data.task.boardSummary && (data.task.outputTruncated || data.task.promptTruncated)) {
        scheduleDetailRefresh(data.task.id);
      }
    }
  });
  es.addEventListener("task_delete", (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    for (const id of data.taskIds || []) {
      tasks.delete(id);
      lastAgentLogAt.delete(id);
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
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data.taskId && data.at && isAgentStdoutLogLine(data.line)) {
      lastAgentLogAt.set(data.taskId, String(data.at));
      updateCardReplyTime(data.taskId);
      if (data.taskId === selectedId && !detailModal.classList.contains("hidden")) {
        paintLastReply(tasks.get(selectedId));
      }
    }
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
void loadAgentModels();
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


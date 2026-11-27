import {
  $,
  button,
  covered,
  display,
  el,
  exact,
  heatRange,
  inputTime,
  metrics,
  names,
  parts,
  pref,
  remember,
  tokens,
} from "./usageView.js";
import { drawChart } from "./usageChart.js";
import { usageSettings } from "./usageSettings.js";
import { usageTables } from "./usageTables.js";

const DAY = 86400000;
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { agent: "", provider: "", model: "", metric: "requests", back: 0, page: 1, pageSize: 25 };
let data = null,
  spec,
  controller,
  timer,
  activeRequest = 0;
const renderTables = usageTables(
  (page, size) => {
    state.page = page;
    state.pageSize = size;
    remember("pageSize", size);
    load();
  },
  (dim, name) => {
    if (dim === "agent") selectAgent(name);
    else {
      state[dim] = choiceValue(name);
      if (dim === "provider") state.model = "";
      reset();
    }
  },
);
function choiceValue(value) {
  return value === null ? "?" : `=${value}`;
}
function restore(id, fallback) {
  const control = $(id),
    saved = pref(id, fallback);
  control.value = [...control.options].some((o) => o.value === saved) ? saved : fallback;
}
function selectAgent(value) {
  state.agent = value;
  state.model = state.provider = "";
  reset();
}
function reset() {
  state.page = 1;
  state.back = 0;
  load();
}
function filters() {
  const now = new Date(),
    range = $("range").value;
  let to = +now + 1,
    from;
  if (range === "custom") {
    // datetime-local is local wall time, not UTC.
    from = new Date($("from").value).getTime();
    if (!$("live").checked) to = new Date($("to").value).getTime() + 60000;
  } else if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    from = +d;
  } else if (range === "all") from = 0;
  else from = +now - { "24h": 1, "7d": 7, "14d": 14, "30d": 30 }[range] * DAY;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= to)
    throw new Error("请选择有效时段，结束不能早于开始。");
  const isHeat = range === "all";
  let bucket = $("granularity").value;
  if (bucket === "auto") bucket = to - from <= DAY + 1 ? "hour" : "day";
  if (isHeat) bucket = "day";
  if (!isHeat && to - from > (bucket === "hour" ? 32 : 372) * DAY)
    throw new Error("按小时最多 32 天，按日最多 372 天；跨年分布请选「全部历史」。");
  const query = new URLSearchParams({
    from,
    to,
    bucket,
    timezone,
    offset: -now.getTimezoneOffset(),
    page: state.page,
    pageSize: state.pageSize,
  });
  if (isHeat) {
    const { start, end } = heatRange(now, state.back);
    query.set("chartFrom", Math.max(0, start));
    query.set("chartTo", end);
  }
  if (state.agent) query.set("agent", state.agent);
  if ($("status").value) query.set("status", $("status").value);
  for (const dim of ["provider", "model"]) {
    const v = state[dim];
    if (v === "?") query.set(`${dim}Unknown`, "1");
    else if (v) query.set(dim, v.slice(1));
  }
  return { query, bucket, isHeat };
}
function choices(dim, values) {
  const select = $(dim),
    label = dim === "provider" ? "供应商" : "模型";
  select.replaceChildren(new Option(`全部${label}`, ""));
  for (const v of values) select.add(new Option(v ?? `未知${label}`, choiceValue(v)));
  const selected = state[dim];
  if (selected && ![...select.options].some((o) => o.value === selected)) {
    const name = selected === "?" ? `未知${label}` : selected.slice(1);
    select.add(new Option(`${name}（无记录）`, selected));
  }
  select.value = selected;
}
function notice(text, isError = false) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
  $("notice").dataset.error = String(isError);
}
function renderCards() {
  const row = data.summary;
  for (const [k, m] of Object.entries(metrics)) {
    const b = $(`card-${k}`);
    b.setAttribute("aria-pressed", String(k === state.metric));
    b.lastElementChild.replaceChildren(covered(m.format(row[k]), row[m.count], row.records));
    b.title = `${m.help}\n原值 ${exact(row[k])} · 覆盖 ${exact(row[m.count])}/${exact(row.records)} 条`;
  }
  $("parts").replaceChildren();
  for (const [k, label] of Object.entries(parts)) {
    const d = el("div"),
      v = el("strong");
    v.append(covered(tokens(row[k]), row[`${k}Records`], row.records));
    d.append(el("span", label, "u-label"), v);
    d.title = exact(row[k]);
    $("parts").append(d);
  }
}
function plot() {
  if (data && !$("results").hidden)
    drawChart(data, {
      metric: state.metric,
      bucket: spec.bucket,
      isHeat: spec.isHeat,
      style: $("chart-style").value,
      back: state.back,
    });
}
function render() {
  $("results").hidden = false;
  renderCards();
  plot();
  renderTables(data);
  choices("provider", data.choices.providers);
  choices("model", data.choices.models);
  const r = data.summary;
  const incomplete = Object.values(metrics).some((m) => r[m.count] < r.records);
  $("coverage").textContent =
    `${timezone} · 本 Board 共筛出 ${exact(r.records)} 条用量记录，其中 ${exact(r.requestRecords)} 条可确认调用，${exact(r.legacyRecords)} 条旧版。${incomplete ? "部分覆盖：只汇总有证据的数值。" : ""}— 表示未知或无分母，显示币种 ${display.currency}（原始 USD）；日志条数包括轮次。`;
  const hint =
    state.agent && !["pi", "claude", "codex"].includes(state.agent)
      ? "此 Agent 尚未接入用量采集。"
      : "可调整筛选，或在「数据来源与设置」查看覆盖范围。";
  notice(r.records ? "" : `此范围没有用量记录。${hint}`);
}
function schedule() {
  clearTimeout(timer);
  const secs = +$("interval").value;
  if (!secs || document.hidden) return;
  timer = setTimeout(() => {
    if (
      !document.hidden &&
      !controller &&
      state.page === 1 &&
      !document.querySelector("dialog[open]") &&
      !$("cols").open
    )
      load(true);
    else schedule();
  }, secs * 1000);
}
async function load(quiet = false) {
  const seq = ++activeRequest;
  controller?.abort();
  controller = new AbortController();
  clearTimeout(timer);
  $("sync").disabled = true;
  $("results").setAttribute("aria-busy", "true");
  $("plot-tip").hidden = true;
  for (const b of $("agents").children)
    b.setAttribute("aria-pressed", String(b.dataset.agent === state.agent));
  if (!quiet) {
    $("results").hidden = true;
    notice("正在读取 Board 用量…");
  }
  try {
    const request = filters();
    const res = await fetch(`/api/usage?${request.query}`, { signal: controller.signal, cache: "no-store" });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status} · ${error.error ?? "查询失败"}`);
    }
    const next = await res.json();
    if (seq !== activeRequest) return;
    // Static files may update before the running Board process is upgraded.
    if (!Array.isArray(next.logs) || !Array.isArray(next.models) || !Array.isArray(next.providers)) {
      throw new Error("当前看板仍是旧版用量接口；请在任务结束后按正常部署流程载入新版本。");
    }
    data = next;
    spec = request;
    state.page = next.page;
    render();
    $("last-sync").textContent = `上次刷新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } catch (err) {
    if (seq !== activeRequest) return;
    data = null;
    $("results").hidden = true;
    notice(`查询失败：${err.message} 请调整条件或点「立即刷新」重试。`, true);
  } finally {
    if (seq === activeRequest) {
      controller = null;
      $("sync").disabled = false;
      $("results").setAttribute("aria-busy", "false");
      schedule();
    }
  }
}
for (const [key, name] of [["", "全部"], ...Object.entries(names)]) {
  const b = button(name, () => selectAgent(key));
  b.dataset.agent = key;
  b.title = `筛选 ${name} Agent`;
  if (key && !["pi", "claude", "codex"].includes(key)) b.title += "（尚未采集）";
  $("agents").append(b);
}
for (const [k, m] of Object.entries(metrics)) {
  const b = button("", () => {
    state.metric = k;
    remember("metric", k);
    renderCards();
    plot();
  });
  b.id = `card-${k}`;
  b.append(el("span", `${m.label} ⓘ`, "u-label"), el("strong", "—"));
  $("cards").append(b);
}
state.metric = Object.hasOwn(metrics, pref("metric", "")) ? pref("metric", "requests") : "requests";
state.pageSize = [10, 25, 50, 100].includes(+pref("pageSize", 25)) ? +pref("pageSize", 25) : 25;
restore("range", "today");
restore("chart-style", "bar");
restore("interval", "60");
$("from").value = inputTime(new Date(new Date().setHours(0, 0, 0, 0)));
$("to").value = inputTime(new Date());
$("custom").hidden = $("range").value !== "custom";
$("range").onchange = () => {
  remember("range", $("range").value);
  $("custom").hidden = $("range").value !== "custom";
  $("granularity").value = "auto";
  reset();
};
$("custom").onsubmit = (e) => {
  e.preventDefault();
  reset();
};
$("live").onchange = () => {
  $("to").disabled = $("live").checked;
  reset();
};
$("provider").onchange = () => {
  state.provider = $("provider").value;
  state.model = "";
  reset();
};
$("model").onchange = () => {
  state.model = $("model").value;
  reset();
};
$("granularity").onchange = reset;
$("status").onchange = reset;
$("chart-style").onchange = () => {
  remember("chart-style", $("chart-style").value);
  plot();
};
$("more").onclick = () => {
  const open = $("parts").hidden;
  $("parts").hidden = !open;
  $("more").setAttribute("aria-expanded", String(open));
  $("more").textContent = open ? "⌃ 收起分项" : "⌄ 更多指标";
};
$("earlier").onclick = () => {
  state.back++;
  load();
};
$("later").onclick = () => {
  state.back = Math.max(0, state.back - 1);
  load();
};
$("sync").onclick = () => load();
$("interval").onchange = () => {
  remember("interval", $("interval").value);
  schedule();
};
usageSettings(() => load());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else if (+$("interval").value && state.page === 1 && !document.querySelector("dialog[open]")) load(true);
  else schedule();
});
let frame;
window.addEventListener("resize", () => {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(plot);
});
window.addEventListener(
  "scroll",
  () => {
    $("plot-tip").hidden = true;
  },
  { passive: true },
);
function theme() {
  let p;
  try {
    p = localStorage.getItem("agent-board.theme");
  } catch {
    /* unavailable storage */
  }
  const systemTheme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = ["light", "dark"].includes(p) ? p : systemTheme;
}
matchMedia("(prefers-color-scheme: light)").addEventListener("change", theme);
window.addEventListener("storage", (e) => {
  if (e.key === "agent-board.theme") theme();
});
load();

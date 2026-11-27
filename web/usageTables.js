import {
  $,
  button,
  costs,
  covered,
  dateTime,
  display,
  el,
  exact,
  kind,
  metrics,
  money,
  ms,
  names,
  parts,
  pct,
  perfHelp,
  pref,
  remember,
  sorted,
  sources,
  speed,
  statuses,
  tokens,
} from "./usageView.js";

const groupCols = [
  ["name", "名称"],
  ["requests", "请求数", metrics.requests.help],
  ["costUsd", "成本", metrics.costUsd.help],
  ["tokens", "Tokens", metrics.tokens.help],
  ["successRate", "成功率", perfHelp.successRate],
  ["speed", "速度 ⓘ", perfHelp.speed],
  ["firstTokenMs", "首字 ⓘ", perfHelp.firstTokenMs],
];
const totalFormat = { requests: exact, costUsd: money, tokens, successRate: pct, firstTokenMs: ms };
const coverageKeys = {
  requests: "requestRecords",
  costUsd: "costRecords",
  tokens: "tokenRecords",
  successRate: "statusRecords",
  firstTokenMs: "firstTokenRecords",
};
const logCols = [
  ["at", "时间 ↓"],
  ["agent", "Agent"],
  ["provider", "供应商"],
  ["model", "模型"],
  ["status", "状态"],
  ["input", "新增输入"],
  ["output", "输出"],
  ["cacheRead", "缓存命中"],
  ["cacheWrite", "缓存写入"],
  ["costUsd", "成本"],
  ["durationMs", "耗时"],
  ["firstTokenMs", "首字"],
  ["speed", "速度"],
  ["source", "来源"],
];
const logFormat = {
  at: dateTime,
  agent: (x) => names[x],
  status: (x) => statuses[x],
  input: tokens,
  output: tokens,
  cacheRead: tokens,
  cacheWrite: tokens,
  costUsd: money,
  durationMs: ms,
  firstTokenMs: ms,
  source: (x) => sources[x] ?? "旧版记录",
};
const defaults = [
  "at",
  "agent",
  "provider",
  "model",
  "status",
  "input",
  "output",
  "cacheRead",
  "costUsd",
  "speed",
];
const tabNames = { logs: "请求日志", providers: "供应商", models: "模型" };
const groupSort = () => ({ key: "requests", direction: "desc" });
function heads(table) {
  table.replaceChildren();
  return table.createTHead().insertRow();
}
function empty(body, count, msg = "此筛选范围暂无记录") {
  const td = body.insertRow().insertCell();
  td.colSpan = count;
  td.className = "u-empty";
  td.textContent = msg;
}
function dimensionLabel(dim, name) {
  return name ?? `未知${{ provider: "供应商", model: "模型", agent: " Agent" }[dim]}`;
}
function detail(r) {
  const dl = el("dl");
  const fields = [
    ["时间（记录完成）", dateTime(r.at)],
    ["Agent", names[r.agent]],
    ["供应商", r.provider],
    ["模型", r.model],
    ["统计单位", kind(r)],
    ["可确认请求数", exact(r.requests)],
    ["状态", statuses[r.status]],
    ...Object.entries(parts).map(([k, label]) => [label, exact(r[k])]),
    ["总 Tokens", exact(r.tokens)],
    [`费用（${display.currency}）`, money(r.costUsd)],
    ["原始费用（USD）", exact(r.costUsd)],
    ["费用来源", costs[r.costSource]],
    ["耗时", ms(r.durationMs)],
    ["首字延迟", ms(r.firstTokenMs)],
    ["速度", speed(r)],
    ["记录来源", sources[r.source] ?? "旧版 Board 记录"],
  ];
  for (const [label, value] of fields) dl.append(el("dt", label), el("dd", value ?? "—（未知）"));
  const note =
    r.requests === 1
      ? "成功率只统计状态已知的调用；首字为 Board 看见首个文本增量的延迟。"
      : "此记录不等于一个已确认请求；轮次的结束状态、耗时不用于调用成功率或速度。";
  $("detail-body").replaceChildren(dl, el("p", note), el("p", perfHelp.speed));
  $("detail").showModal();
}
function logValue(r, k) {
  if (k === "speed") return speed(r);
  return logFormat[k] ? (logFormat[k](r[k]) ?? "—") : (r[k] ?? "—");
}
export function usageTables(onPage, onFilter) {
  let data,
    active = pref("tab", "logs");
  if (!Object.hasOwn(tabNames, active)) active = "logs";
  const sorts = { providers: groupSort(), models: groupSort(), comparison: groupSort() };
  const cols = new Set(pref("logCols", defaults.join(",")).split(","));
  cols.add("at");
  for (const [k, label] of logCols.filter(([k]) => k !== "at")) {
    const l = el("label"),
      cb = el("input");
    cb.type = "checkbox";
    cb.checked = cols.has(k);
    cb.onchange = () => {
      if (cb.checked) cols.add(k);
      else cols.delete(k);
      remember("logCols", [...cols].join(","));
      render();
    };
    l.append(cb, label);
    $("col-options").append(l);
  }
  function groupTable(table, rows, dim, sort) {
    const header = heads(table),
      list = rows.map((r) => ({ ...r, name: r[dim] }));
    for (const [key, base, help] of groupCols) {
      const label = key === "name" ? { agent: "Agent", provider: "供应商", model: "模型" }[dim] : base;
      const th = el("th");
      th.scope = "col";
      if (sort.key === key)
        th.setAttribute("aria-sort", sort.direction === "asc" ? "ascending" : "descending");
      const b = button(
        label + (sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : ""),
        () => {
          const asc = sort.key === key ? sort.direction === "desc" : key === "name";
          sort.key = key;
          sort.direction = asc ? "asc" : "desc";
          render();
        },
        (help ?? "名称") + " · 点击排序",
      );
      th.append(b);
      header.append(th);
    }
    const body = table.createTBody();
    for (const r of sorted(list, sort.key, sort.direction)) {
      const tr = body.insertRow();
      const name = dimensionLabel(dim, dim === "agent" ? names[r.name] : r.name);
      const link = button(name, () => onFilter(dim, r.name), "按此项筛选全部指标和列表");
      link.className = "u-link";
      tr.insertCell().append(link);
      for (const [k] of groupCols.slice(1)) {
        const td = tr.insertCell(),
          count = k === "speed" ? r.measuredSamples || r.estimatedSamples : r[coverageKeys[k]];
        const value = k === "speed" ? speed(r) : totalFormat[k](r[k]);
        td.append(covered(value, count, r.records));
        td.title =
          `${value} · 已知 ${exact(count)} / ${exact(r.records)} 条` +
          (k === "tokens" ? ` · ${exact(r.tokens)} Tokens` : "");
        if (r[k] == null) td.className = "u-unknown";
      }
    }
    if (!list.length) empty(body, groupCols.length);
  }
  function renderLogs() {
    const table = $("table"),
      header = heads(table),
      visible = logCols.filter(([k]) => cols.has(k));
    for (const [k, label] of visible) {
      const th = el("th", label);
      th.scope = "col";
      th.title = perfHelp[k] ?? metrics[k]?.help ?? label;
      if (k === "at") th.setAttribute("aria-sort", "descending");
      header.append(th);
    }
    const body = table.createTBody();
    for (const r of data.logs) {
      const tr = body.insertRow();
      tr.className = "u-log-row";
      tr.onclick = () => detail(r);
      tr.title = `${kind(r)} · ${sources[r.source] ?? "旧版记录"} · 耗时 ${ms(r.durationMs)} · 首字 ${ms(r.firstTokenMs)} · 缓存写入 ${exact(r.cacheWrite)}`;
      for (const [k] of visible) {
        const td = tr.insertCell(),
          v = logValue(r, k);
        if (k === "at") {
          const b = button(
            v,
            (e) => {
              e.stopPropagation();
              detail(r);
            },
            "查看记录明细",
          );
          b.className = "u-link";
          td.append(b, el("small", r.source ? kind(r) : "旧版", "u-badge"));
        } else {
          td.textContent = v;
          if (k === "status") td.className = "u-" + (r.status ?? "unknown");
          if (r[k] == null) td.className = "u-unknown";
        }
        if (k === "costUsd") td.title = costs[r.costSource] ?? "费用未知";
      }
    }
    if (!data.logs.length) empty(body, visible.length);
    const pageCount = Math.max(1, Math.ceil(data.summary.records / data.pageSize)),
      pager = $("pager");
    const prev = button("上一页", () => onPage(data.page - 1, data.pageSize)),
      next = button("下一页", () => onPage(data.page + 1, data.pageSize));
    prev.disabled = data.page <= 1;
    next.disabled = data.page >= pageCount;
    const size = el("select");
    size.setAttribute("aria-label", "每页日志条数");
    for (const n of [10, 25, 50, 100]) size.add(new Option(`${n} 条 / 页`, n));
    size.value = String(data.pageSize);
    size.onchange = () => onPage(1, +size.value);
    pager.replaceChildren(
      el("span", `第 ${data.page} / ${pageCount} 页 · 共 ${exact(data.summary.records)} 条记录`),
      size,
      prev,
      next,
    );
  }
  function render() {
    if (!data) return;
    for (const [key, label] of Object.entries(tabNames)) {
      const b = $("tab-" + key);
      b.setAttribute("aria-selected", String(key === active));
      b.tabIndex = key === active ? 0 : -1;
      const n = key === "logs" ? data.summary.records : data[key].length;
      b.replaceChildren(label, el("span", exact(n), "u-badge"));
      b.title = key === "logs" ? "日志条数（含轮次），不等于可确认请求数" : `${label}独立分组数，含未知组`;
    }
    $("table-panel").setAttribute("aria-labelledby", "tab-" + active);
    $("table").setAttribute("aria-label", tabNames[active]);
    $("cols").hidden = active !== "logs";
    $("pager").replaceChildren();
    if (active === "logs") renderLogs();
    else groupTable($("table"), data[active], active === "providers" ? "provider" : "model", sorts[active]);
    groupTable($("comparison"), data.byAgent, "agent", sorts.comparison);
  }
  const keys = Object.keys(tabNames);
  for (const [i, key] of keys.entries()) {
    const b = button(tabNames[key], () => {
      active = key;
      remember("tab", key);
      render();
    });
    b.id = "tab-" + key;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", "table-panel");
    $("tabs").append(b);
    b.onkeydown = (e) => {
      const j = { ArrowRight: (i + 1) % 3, ArrowLeft: (i + 2) % 3, Home: 0, End: 2 }[e.key];
      if (j === undefined) return;
      e.preventDefault();
      const tab = $("tab-" + keys[j]);
      tab.click();
      tab.focus();
    };
  }
  return (next) => {
    data = next;
    render();
  };
}

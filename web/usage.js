const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("zh-CN");
const cost = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumSignificantDigits: 8 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumSignificantDigits: 4 });
const metrics = {
  costUsd: { label: "费用（美元）", count: "costRecords", format: cost.format },
  requests: { label: "可确认请求数", count: "requestRecords", format: number.format },
  tokens: { label: "Token", count: "tokenRecords", format: number.format },
  cacheRate: { label: "缓存命中率", count: "cacheRecords", format: percent.format },
};
const agentNames = new Map(Array.from($("agent").options, (option) => [option.value, option.text]));
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
let trendSlots = [];
let hourlyTrend = true;
const trendHint = $("trend-detail").textContent;
let activeQuery;

function dateInputValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function updateDates() {
  const custom = $("range").value === "custom";
  for (const id of ["from", "to"]) $(id).parentElement.hidden = !custom;
  if (custom) return;
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - Number($("range").value) + 1);
  $("from").value = dateInputValue(start);
  $("to").value = dateInputValue(today);
}

function queryParams() {
  updateDates();
  const from = new Date(`${$("from").value}T00:00:00`);
  const to = new Date(`${$("to").value}T00:00:00`);
  if (!(from <= to)) throw new Error("请选择有效日期，结束日期不能早于开始日期。");
  to.setDate(to.getDate() + 1); // Exclusive local midnight, including on DST transitions.
  const bucket = $("bucket").value;
  const limit = bucket === "hour" ? 32 : 366;
  if (to - from > limit * 86400000) throw new Error(`按${bucket === "hour" ? "小时" : "日"}查询最多支持 ${limit} 天，请缩短范围或调整粒度。`);
  const params = new URLSearchParams({ from: from.getTime(), to: to.getTime(), bucket, offset: -from.getTimezoneOffset() });
  if (timezone) params.set("timezone", timezone);
  if ($("agent").value) params.set("agent", $("agent").value);
  return params;
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function known(row, key) {
  return row.records > 0 && row[metrics[key].count] > 0 && Number.isFinite(row[key]);
}

function metricCell(row, key, tag) {
  const cell = element(tag);
  const metric = metrics[key];
  cell.append(element("strong", known(row, key) ? metric.format(row[key]) : "—"));
  if (row[metric.count] > 0 && row[metric.count] < row.records) {
    const coverage = element("small", `部分 · ${row[metric.count]}/${row.records} 条记录`);
    coverage.className = "usage-coverage";
    cell.append(coverage);
  }
  return cell;
}

function renderRows(id, rows, columns, makeRow) {
  const body = $(id);
  body.replaceChildren(...rows.map(makeRow));
  if (!rows.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = columns;
    cell.textContent = "此范围内无记录";
  }
}

function renderTrend() {
  const key = $("metric").value;
  const metric = metrics[key];
  const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit",
    ...(hourlyTrend && { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }) });
  const max = key === "cacheRate" ? 1 : Math.max(0, ...trendSlots.map(({ row }) => row && known(row, key) ? row[key] : 0));
  $("trend-max").textContent = max > 0 ? metric.format(max) : "";
  $("trend-detail").textContent = trendHint;
  $("trend").replaceChildren(...trendSlots.map(({ start, row }, i) => {
    const slot = element("div");
    slot.className = "usage-slot";
    const point = element("button");
    point.className = "usage-point";
    point.type = "button";
    point.tabIndex = i === 0 ? 0 : -1;
    let detail = "无记录";
    if (row && row.records > 0) {
      if (known(row, key)) {
        const bar = element("span");
        bar.className = "usage-bar";
        detail = metric.format(row[key]);
        if (row[key] === 0) bar.classList.add("zero");
        else bar.style.height = `${100 * row[key] / max}%`;
        if (row[metric.count] < row.records) {
          bar.classList.add("partial");
          detail += `（部分 · ${row[metric.count]}/${row.records} 条记录）`;
        }
        point.append(bar);
      } else {
        point.textContent = "?";
        detail = "有记录，指标未知";
      }
    }
    point.title = `${date.format(start)} · ${metric.label}：${detail}`;
    point.setAttribute("aria-label", point.title);
    slot.append(point);
    const d = new Date(start);
    if (i % 4 === 0) {
      const tick = element("span", hourlyTrend && d.getHours() !== 0 ? `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : `${d.getMonth() + 1}/${d.getDate()}`);
      tick.className = "usage-tick";
      tick.setAttribute("aria-hidden", "true");
      slot.append(tick);
    }
    return slot;
  }));
}

const chart = $("trend");
for (const event of ["pointerover", "focusin", "click"]) chart.addEventListener(event, (e) => {
  const point = e.target.closest(".usage-point");
  if (!point) return;
  $("trend-detail").textContent = point.title;
  if (event === "focusin") {
    chart.querySelector('[tabindex="0"]').tabIndex = -1;
    point.tabIndex = 0;
  }
});
chart.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  e.preventDefault();
  const slot = e.target.parentElement;
  (e.key === "ArrowRight" ? slot.nextElementSibling : slot.previousElementSibling)?.firstElementChild.focus();
});

function render({ summary, byAgent, trend, slots }, params) {
  $("summary").replaceChildren(...Object.keys(metrics).map((key) => {
    const card = metricCell(summary, key, "div");
    card.prepend(element("h3", metrics[key].label));
    return card;
  }));
  renderRows("agents", byAgent, 5, (row) => {
    const tr = element("tr");
    tr.append(element("td", agentNames.get(row.agent) || row.agent), ...Object.keys(metrics).map((key) => metricCell(row, key, "td")));
    return tr;
  });
  hourlyTrend = params.get("bucket") === "hour";
  const byStart = new Map(trend.map((row) => [row.start, row]));
  trendSlots = slots.map((start) => ({ start, row: byStart.get(start) }));
  renderTrend();
}

async function load() {
  activeQuery?.abort();
  const controller = new AbortController();
  activeQuery = controller;
  $("results").hidden = true;
  $("status").textContent = "正在查询…";
  try {
    const params = queryParams();
    const response = await fetch(`/api/usage?${params}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (response.status === 401 || response.status === 403) throw new Error("无权访问，请确认看板登录状态后重试。");
    if (!response.ok) throw new Error(`查询失败（HTTP ${response.status}），请稍后重试。`);
    const data = await response.json();
    if (controller.signal.aborted) return;
    render(data, params);
    $("results").hidden = false;
    $("status").textContent = `${$("from").value} 至 ${$("to").value}（含） · ${data.summary.records ? `共 ${data.summary.records} 条记录` : "没有用量记录"}`;
  } catch (err) {
    if (!controller.signal.aborted) $("status").textContent = err instanceof TypeError || err instanceof SyntaxError ? "无法读取用量数据，请稍后重试。" : err.message;
  }
}

for (const [key, metric] of Object.entries(metrics)) $("metric").add(new Option(metric.label, key));
$("metric").value = "tokens";
$("metric").addEventListener("change", renderTrend);
$("filters").addEventListener("submit", (event) => { event.preventDefault(); void load(); });
$("filters").addEventListener("change", (event) => {
  if (event.target === $("range")) $("bucket").value = $("range").value === "1" ? "hour" : "day";
  void load();
});
void load();

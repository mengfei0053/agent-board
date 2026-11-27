import { $, dateTime, el, exact, metrics } from "./usageView.js";

function svg(tag, attrs, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}
const colors = [
  "var(--panel-2)",
  "color-mix(in srgb,var(--ink-chart) 24%,var(--surface))",
  "color-mix(in srgb,var(--ink-chart) 45%,var(--surface))",
  "color-mix(in srgb,var(--ink-chart) 70%,var(--surface))",
  "var(--ink-chart)",
];
function defs(root) {
  const pattern = svg("pattern", { id: "partial-bar", width: 5, height: 5, patternUnits: "userSpaceOnUse" });
  pattern.append(
    svg("rect", { width: 5, height: 5, fill: "var(--ink-chart)" }),
    svg("path", { d: "M0 5L5 0", stroke: "var(--surface)", opacity: 0.55 }),
  );
  const d = svg("defs", {});
  d.append(pattern);
  root.append(d);
}
function axis(root, x, y, text, anchor = "start") {
  root.append(svg("text", { x, y, class: "u-axis", "text-anchor": anchor }, text));
}
function describe(p, key) {
  const m = metrics[key];
  if (!p.row) return `${dateTime(p.start)}\n无记录`;
  return `${dateTime(p.start)}\n${m.label}：${m.format(p.value)}${p.value == null ? "（未知或无分母）" : ""}\n${exact(p.row.records)} 条记录 · 指标覆盖 ${exact(p.row[m.count])} 条`;
}
function trend(root, pts, key, bucket, style, width) {
  const left = 56,
    right = width - 9,
    top = 13,
    bottom = 128,
    step = (right - left) / pts.length;
  const max = key === "cacheRate" ? 1 : Math.max(0, ...pts.map((p) => p.value ?? 0)) || 1;
  const y = (n) => bottom - ((bottom - top) * n) / max;
  for (const v of [max, max / 2, 0]) {
    const at = y(v);
    root.append(svg("line", { x1: left, x2: right, y1: at, y2: at, class: "u-grid" }));
    axis(root, left - 6, at + 3, metrics[key].format(v), "end");
  }
  let path = "",
    adjacent = false;
  const labelEvery = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor((right - left) / 61))));
  for (const [i, p] of pts.entries()) {
    const x = left + (i + 0.5) * step,
      v = p.value;
    if (v != null && style === "bar")
      root.append(
        svg("rect", {
          x: x - step * 0.31,
          y: Math.min(bottom - 1.6, y(v)),
          width: Math.max(0.7, step * 0.62),
          height: Math.max(1.6, bottom - y(v)),
          rx: 1.3,
          fill: p.partial ? "url(#partial-bar)" : "var(--ink-chart)",
        }),
      );
    if (style === "line" && v != null) {
      path += `${adjacent ? "L" : "M"}${x} ${y(v)} `;
      root.append(
        svg("circle", {
          cx: x,
          cy: y(v),
          r: p.partial ? 3.2 : 2,
          fill: p.partial ? "var(--surface)" : "var(--ink-chart)",
          stroke: "var(--ink-chart)",
        }),
      );
    }
    if (v == null && p.row) axis(root, x, bottom - 2, "?", "middle");
    adjacent = v != null;
    if (i % labelEvery === 0) {
      const d = new Date(p.start);
      axis(
        root,
        x,
        146,
        bucket === "hour"
          ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
          : `${d.getMonth() + 1}/${d.getDate()}`,
        "middle",
      );
    }
  }
  if (path)
    root.append(svg("path", { d: path, fill: "none", stroke: "var(--ink-chart)", "stroke-width": 2 }));
  const hitWidth = Math.max(0.5, step);
  pts.forEach((p, i) => {
    p.node = svg("rect", {
      x: left + i * step,
      y: top,
      width: hitWidth,
      height: bottom - top,
      fill: "transparent",
      "data-point": i,
    });
    root.append(p.node);
  });
}
function heat(root, pts, key, width) {
  const max = key === "cacheRate" ? 1 : Math.max(1, ...pts.map((p) => p.value ?? 0));
  const step = (width - 45) / 53,
    cell = Math.min(16, step - 2),
    left = 33,
    top = 22;
  for (const [i, p] of pts.entries()) {
    const week = Math.floor(i / 7),
      day = i % 7,
      x = left + week * step,
      y = top + day * 19,
      d = new Date(p.start);
    if (!day && (!week || d.getDate() < 8)) axis(root, x, 14, `${d.getMonth() + 1}月`);
    if (!week && day % 2 === 0)
      axis(root, left - 5, y + cell - 1, ["一", "二", "三", "四", "五", "六", "日"][day], "end");
    const level = p.value > 0 ? Math.min(4, Math.ceil(4 * Math.sqrt(p.value / max))) : 0;
    p.node = svg("rect", {
      x,
      y,
      width: cell,
      height: cell,
      rx: 2,
      fill: colors[level],
      stroke: p.row ? "var(--muted)" : "none",
      "stroke-width": p.partial ? 1.3 : 0.5,
      "stroke-dasharray": p.partial ? "2 1" : "none",
      "data-point": i,
    });
    root.append(p.node);
    if (p.row && p.value == null) {
      const mark = svg(
        "text",
        {
          x: x + cell / 2,
          y: y + cell * 0.82,
          class: "u-axis",
          "text-anchor": "middle",
          "pointer-events": "none",
        },
        "?",
      );
      root.append(mark);
    }
  }
}
function interaction(pts, key) {
  const chart = $("chart"),
    tip = $("plot-tip");
  let index = 0;
  function show(i, x, y) {
    const p = pts[i];
    if (!p) return;
    index = i;
    const r = p.node.getBoundingClientRect();
    tip.textContent = describe(p, key);
    tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(innerWidth - tip.offsetWidth - 5, (x ?? r.left) + 10)) + "px";
    tip.style.top =
      Math.max(4, Math.min(innerHeight - tip.offsetHeight - 5, (y ?? r.top) - tip.offsetHeight - 7)) + "px";
  }
  chart.onpointermove = chart.onclick = (e) => {
    const i = e.target.dataset.point;
    if (i !== undefined) show(+i, e.clientX, e.clientY);
    else tip.hidden = true;
  };
  chart.onpointerleave = chart.onblur = () => {
    tip.hidden = true;
  };
  chart.onfocus = () => show(index);
  chart.onkeydown = (e) => {
    if (e.key === "Escape") {
      tip.hidden = true;
      return;
    }
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (!step) return;
    e.preventDefault();
    show(Math.min(pts.length - 1, Math.max(0, index + step)));
  };
}
export function drawChart(data, { metric, bucket, isHeat, style, back }) {
  const chart = $("chart"),
    m = metrics[metric];
  chart.classList.toggle("heat", isHeat);
  const width = Math.max(isHeat ? 650 : 260, chart.clientWidth);
  const root = svg("svg", {
    viewBox: `0 0 ${width} ${isHeat ? 166 : 154}`,
    "aria-hidden": "true",
    preserveAspectRatio: "none",
  });
  const rows = new Map(data.trend.map((r) => [r.start, r]));
  const pts = data.slots.map((start) => {
    const row = rows.get(start);
    return {
      start,
      row,
      value: row?.[metric],
      partial: row && row[m.count] > 0 && row[m.count] < row.records,
    };
  });
  defs(root);
  if (isHeat) heat(root, pts, metric, width);
  else trend(root, pts, metric, bucket, style, width);
  chart.replaceChildren(root);
  $("plot-tip").hidden = true;
  interaction(pts, metric);
  $("chart-title").textContent = isHeat
    ? `${m.label} · 53 周热力图`
    : `${m.label} · 按${bucket === "hour" ? "小时" : "日"}`;
  $("trend-controls").hidden = isHeat;
  $("heat-controls").hidden = !isHeat;
  $("earlier").disabled = data.summary.oldest == null || data.summary.oldest >= pts[0].start;
  $("later").disabled = !back;
  const dot = el("i", undefined, "u-dot");
  const legend = $("legend");
  legend.replaceChildren(dot, document.createTextNode(m.label));
  if (isHeat) {
    legend.append("少");
    for (const c of colors) {
      const square = el("i", undefined, "u-level");
      square.style.background = c;
      legend.append(square);
    }
    legend.append(
      "多",
      `${new Date(pts[0].start).toLocaleDateString()} – ${new Date(pts.at(-1).start).toLocaleDateString()}`,
    );
  }
  if (isHeat)
    legend.append(
      el(
        "span",
        `本段 ${exact(data.trend.reduce((n, r) => n + r.records, 0))} 条 / 全历史 ${exact(data.summary.records)} 条`,
      ),
    );
  legend.append(
    el(
      "span",
      isHeat
        ? "空格：无记录 · ? 未知 · 虚线：部分"
        : "空槽：无记录 · ? 未知 · 基线短线：零 · 斜纹 / 空心点：部分",
    ),
  );
}

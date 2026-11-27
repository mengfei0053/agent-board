export const $ = (id) => document.getElementById(id);
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function button(label, action, title) {
  const b = el("button", label);
  b.type = "button";
  b.onclick = action;
  if (title) b.title = title;
  return b;
}
export function pref(key, fallback) {
  try {
    return localStorage.getItem(`agent-board.usage.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
export function remember(key, value) {
  try {
    localStorage.setItem(`agent-board.usage.${key}`, value);
  } catch {
    /* optional */
  }
}
export const names = {
  pi: "Pi",
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  devin: "Devin",
  kimi: "Kimi",
  grok: "Grok",
};
export const statuses = { success: "成功", failed: "失败", aborted: "中止" };
export const costs = {
  provider: "供应商上报",
  "pi-catalog": "Pi 模型目录估算",
  "claude-cli": "Claude CLI 上报估算",
  "local-price": "Board 本地单价估算",
  "legacy-cli": "旧版 CLI 金额（估算来源未细分）",
};
export const sources = {
  "pi.message_end": "Pi · message_end",
  "claude.result": "Claude Code · result（轮次）",
  "codex.turn": "Codex · turn（轮次）",
};
export function kind(r) {
  if (r.requests === 1) return "调用";
  return ["claude.result", "codex.turn"].includes(r.source) ? "轮次" : "未确认调用";
}
export const exact = (n) => (n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 8 }));
export function tokens(n) {
  if (n == null) return "—";
  for (const [div, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ])
    if (n >= div) return `${+(n / div).toFixed(2)}${suffix}`;
  return exact(n);
}
export const display = { currency: "USD", rate: 1 };
export function setDisplay(currency, rate) {
  if (!["USD", "CNY", "EUR", "GBP", "JPY"].includes(currency) || !(rate > 0 && rate <= 1e6)) return false;
  Object.assign(display, { currency, rate: currency === "USD" ? 1 : rate });
  return true;
}
export function money(n) {
  if (n == null) return "—";
  const v = n * display.rate,
    symbol = { USD: "$", CNY: "CN¥", EUR: "€", GBP: "£", JPY: "JP¥" }[display.currency];
  if (v > 0 && v < 0.000001) return `<${symbol}0.000001`;
  return `${symbol}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.01 ? 6 : 2 })}`;
}
export const pct = (n) => (n == null ? "—" : `${+(n * 100).toFixed(1)}%`);
export function ms(n) {
  if (n == null) return "—";
  return n < 1000 ? `${exact(n)} ms` : `${+(n / 1000).toFixed(2)} s`;
}
export function speed(r) {
  if (r.speed == null) return "—";
  return `${r.speedEstimated ? "≈ " : ""}${+r.speed.toFixed(1)} tok/s`;
}
export const metrics = {
  costUsd: {
    label: "总成本",
    count: "costRecords",
    format: money,
    help: "USD；供应商上报、CLI 或本地单价估算的已知金额之和，不代表账单。",
  },
  requests: {
    label: "总请求数",
    count: "requestRecords",
    format: exact,
    help: "只计可确认的模型调用。轮次、旧数据中未确认的请求不计入。",
  },
  tokens: {
    label: "真实消耗 Tokens",
    count: "tokenRecords",
    format: tokens,
    help: "来源报告的总量，或新增输入 + 输出 + 缓存读 + 缓存写；不重复计算缓存。",
  },
  cacheRate: {
    label: "缓存命中率",
    count: "cacheRecords",
    format: pct,
    help: "Σ缓存读 ÷ Σ(新增输入 + 缓存读 + 缓存写)，仅计分母已知的记录。Codex 输入已含缓存读，无独立写桶。",
  },
};
export const parts = { input: "新增输入", output: "输出", cacheWrite: "缓存写入", cacheRead: "缓存命中" };
export const perfHelp = {
  successRate: "成功 ÷ 状态已知的已确认调用。失败与中止计入分母，轮次及未知状态不计。",
  speed:
    "成功调用：Σ输出 ÷ Σ生成秒数（首字至结束，≥100 Tokens）。缺首字才用 ≥200 Tokens 的全程耗时估算（≈），两类不混算；>10,000 tok/s 不计。",
  firstTokenMs:
    "成功调用从开始到首个非空文本增量的 Board 观测延迟；分组为已知样本的中位数。非 HTTP 首包；无计时为 —。",
};
export function covered(value, count, records) {
  const span = el("span", value);
  if (count != null && count > 0 && count < records) {
    const mark = el("small", "部分", "u-partial");
    mark.title = `覆盖 ${exact(count)} / ${exact(records)} 条记录`;
    span.append(mark);
  }
  return span;
}
export function dateTime(at) {
  return new Date(at).toLocaleString("zh-CN", {
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
export function sorted(rows, key, direction) {
  return [...rows].sort((a, b) => {
    const x = a[key],
      y = b[key];
    if (x == null || y == null)
      return (
        Number(x == null) - Number(y == null) ||
        String(a.name ?? "\uffff").localeCompare(String(b.name ?? "\uffff"))
      );
    const cmp = typeof x === "string" ? x.localeCompare(y) : x - y;
    return (
      (direction === "desc" ? -cmp : cmp) ||
      String(a.name ?? "\uffff").localeCompare(String(b.name ?? "\uffff"))
    );
  });
}
export function inputTime(date) {
  return new Date(+date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function heatRange(now, back) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 52 * 7 - 371 * back);
  const end = new Date(monday);
  end.setDate(end.getDate() + 371);
  return { start: +monday, end: Math.min(+end, +now + 1) };
}

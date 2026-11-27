import assert from "node:assert/strict";
import { it } from "node:test";
import { sorted, tokens, pct, money, setDisplay, kind, ms, speed, heatRange } from "../../web/usageView.js";

it("sorts raw metrics both ways, keeps unknown last, and does not mutate the independent table", () => {
  const rows = [
    { name: "z", requests: 2 },
    { name: "x", requests: null },
    { name: "a", requests: 2 },
    { name: "q", requests: 0 },
  ];
  const order = (key, dir) => sorted(rows, key, dir).map((r) => r.name);
  assert.deepEqual(order("requests", "desc"), ["a", "z", "q", "x"]);
  assert.deepEqual(order("requests", "asc"), ["q", "a", "z", "x"]);
  assert.deepEqual(order("name", "desc"), ["z", "x", "q", "a"]);
  assert.equal(rows[0].name, "z");
});

it("formats known zero, unpriced, small costs, fractional latency and estimated speed distinctly", () => {
  assert.equal(tokens(null), "—");
  assert.equal(tokens(0), "0");
  assert.equal(tokens(581000000), "581M");
  assert.equal(pct(0), "0%");
  assert.equal(ms(242.5), "242.5 ms");
  assert.equal(ms(2100), "2.1 s");
  assert.equal(speed({ speed: 40, speedEstimated: true }), "≈ 40 tok/s");
  assert.equal(kind({ requests: null, source: "codex.turn" }), "轮次");
  assert.equal(kind({ requests: null }), "未确认调用");
  assert.equal(money(null), "—");
  assert.equal(money(0), "$0.00");
  assert.equal(money(0.000002), "$0.000002");
  assert.equal(setDisplay("CNY", 0), false);
  assert.equal(setDisplay("CNY", 7), true);
  assert.equal(money(1), "CN¥7.00");
  setDisplay("USD", 1);
});

it("pages calendar heatmaps backwards in adjacent Monday-aligned 53-week spans", () => {
  const now = new Date(2026, 10, 1, 9, 32),
    current = heatRange(now, 0),
    old = heatRange(now, 1);
  assert.equal(old.end, current.start);
  assert.equal(new Date(current.start).getDay(), 1);
  assert.equal(new Date(old.start).getHours(), 0);
  const end = new Date(old.start);
  end.setDate(end.getDate() + 371);
  assert.equal(+end, old.end);
});

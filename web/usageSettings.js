import { $, button, display, el, exact, parts, pref, remember, setDisplay } from "./usageView.js";

function currencySettings(refresh) {
  const saved = pref("currency", "USD");
  setDisplay(saved, +pref(`fx.${saved}`, saved === "USD" ? "1" : ""));
  $("currency").value = display.currency;
  function rateInput() {
    const currency = $("currency").value;
    $("fx-label").hidden = $("fx").disabled = currency === "USD";
    $("fx").value = pref(`fx.${currency}`, currency === "USD" ? "1" : "");
  }
  rateInput();
  $("currency").onchange = rateInput;
  $("display-form").onsubmit = (e) => {
    e.preventDefault();
    const currency = $("currency").value,
      rate = currency === "USD" ? 1 : $("fx").valueAsNumber;
    if (setDisplay(currency, rate)) {
      remember("currency", currency);
      remember(`fx.${currency}`, rate);
      refresh();
    }
  };
}

export function usageSettings(refresh) {
  currencySettings(refresh);
  const keys = ["input", "output", "cacheRead", "cacheWrite"];
  for (const k of keys) {
    const label = el("label", parts[k]);
    const inp = el("input");
    inp.type = "number";
    inp.step = "any";
    inp.min = "0";
    inp.max = "1000000";
    inp.required = true;
    inp.id = `rate-${k}`;
    label.append(inp);
    $("rate-inputs").append(label);
  }
  function render(prices) {
    const table = $("prices");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    for (const l of ["模型", ...keys.map((k) => parts[k]), "操作"]) head.append(el("th", l));
    const body = table.createTBody();
    for (const p of prices) {
      const row = body.insertRow();
      row.insertCell().textContent = p.model;
      for (const k of keys) row.insertCell().textContent = exact(p[k]);
      row.insertCell().append(
        button("编辑", () => {
          $("price-model").value = p.model;
          for (const k of keys) $(`rate-${k}`).value = p[k];
          $("price-model").focus();
        }),
        button("删除", () => {
          if (confirm(`删除 ${p.model} 的本地定价？仅影响查询估值。`))
            void sync("DELETE", { model: p.model });
        }),
      );
    }
    if (!prices.length) {
      const td = body.insertRow().insertCell();
      td.colSpan = 6;
      td.textContent = "尚无本地定价；已上报金额不受影响。";
    }
  }
  async function sync(method = "GET", body) {
    $("price-msg").textContent = method === "GET" ? "读取定价…" : "保存中…";
    try {
      const res = await fetch("/api/usage/prices", {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      render(data.prices);
      $("price-msg").textContent = method === "GET" ? "" : "已更新估值。";
      if (method !== "GET") {
        $("price-form").reset();
        refresh();
      }
    } catch (err) {
      $("price-msg").textContent = `定价操作失败：${err.message}`;
    }
  }
  $("settings").onclick = () => {
    $("config").showModal();
    void sync();
  };
  $("price-form").onsubmit = (e) => {
    e.preventDefault();
    const body = { model: $("price-model").value.trim() };
    for (const k of keys) body[k] = $(`rate-${k}`).valueAsNumber;
    void sync("PUT", body);
  };
}

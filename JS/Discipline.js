(function () {
  const PLAN_KEY = "discipline_reentry_plans_v1";
  const LOSS_SELL_CACHE = {};

  function n(v, d = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  }

  function money(v) {
    return "\u20B9" + n(v).toFixed(2);
  }

  function pct(v) {
    return n(v).toFixed(2) + "%";
  }

  function dLocal(s) {
    const p = String(s || "").split("-");
    if (p.length === 3) return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return new Date(s);
  }

  function normStock(v) {
    return String(v || "").trim().replace(/\s+/g, " ").toUpperCase();
  }

  function hoursFromNow(h) {
    return new Date(Date.now() + Math.max(1, n(h, 48)) * 3600000).toISOString();
  }

  function readPlans() {
    try {
      const raw = localStorage.getItem(PLAN_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function savePlans(rows) {
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(rows || []));
    } catch (e) {}
  }

  function readStoreAll(name) {
    return new Promise((resolve) => {
      try {
        db.transaction(name, "readonly").objectStore(name).getAll().onsuccess = (e) => resolve(e.target.result || []);
      } catch (e) {
        resolve([]);
      }
    });
  }

  function buildSellOutcomes(txns) {
    const sorted = (txns || []).slice().sort((a, b) => dLocal(a.date) - dLocal(b.date));
    const lotsMap = {};
    const sells = [];
    sorted.forEach((t) => {
      const stock = normStock(t.stock);
      if (!stock) return;
      const type = String(t.type || "").toUpperCase();
      const qty = n(t.qty);
      const price = n(t.price);
      const brkg = n(t.brokerage);
      lotsMap[stock] = lotsMap[stock] || [];
      if (type === "BUY") {
        lotsMap[stock].push({ qty, price, date: t.date, brkgPerUnit: qty > 0 ? brkg / qty : 0 });
        return;
      }
      if (type !== "SELL") return;
      let rem = qty;
      let cost = 0;
      let firstBuyDate = null;
      while (rem > 0 && lotsMap[stock].length) {
        const lot = lotsMap[stock][0];
        const used = Math.min(rem, n(lot.qty));
        if (!firstBuyDate) firstBuyDate = lot.date;
        cost += used * (n(lot.price) + n(lot.brkgPerUnit));
        lot.qty = n(lot.qty) - used;
        rem -= used;
        if (lot.qty <= 0) lotsMap[stock].shift();
      }
      const sellValue = qty * price - brkg;
      const net = sellValue - cost;
      const holdDays = firstBuyDate ? Math.max(0, Math.floor((dLocal(t.date).getTime() - dLocal(firstBuyDate).getTime()) / 86400000)) : 0;
      sells.push({ stock, date: t.date, qty, price, net, holdDays, reason: String(t.reason || "").trim() });
    });
    return sells;
  }

  function buildActiveHoldings(txns) {
    const sorted = (txns || []).slice().sort((a, b) => dLocal(a.date) - dLocal(b.date));
    const map = {};
    sorted.forEach((t) => {
      const stock = normStock(t.stock);
      if (!stock) return;
      map[stock] = map[stock] || { lots: [] };
      const type = String(t.type || "").toUpperCase();
      const qty = n(t.qty);
      const price = n(t.price);
      const brkg = n(t.brokerage);
      if (type === "BUY") {
        map[stock].lots.push({ qty, price, brkgPerUnit: qty > 0 ? brkg / qty : 0, date: t.date });
      } else if (type === "SELL") {
        let rem = qty;
        while (rem > 0 && map[stock].lots.length) {
          const lot = map[stock].lots[0];
          const used = Math.min(rem, n(lot.qty));
          lot.qty = n(lot.qty) - used;
          rem -= used;
          if (lot.qty <= 0) map[stock].lots.shift();
        }
      }
    });

    const out = {};
    Object.keys(map).forEach((stock) => {
      const lots = map[stock].lots || [];
      const qty = lots.reduce((a, l) => a + n(l.qty), 0);
      const invested = lots.reduce((a, l) => a + n(l.qty) * (n(l.price) + n(l.brkgPerUnit)), 0);
      out[stock] = {
        qty,
        avg: qty > 0 ? invested / qty : 0,
        firstDate: lots[0] ? lots[0].date : null
      };
    });
    return out;
  }

  function computeMetrics(txns, sells) {
    const lossSells = sells.filter(s => n(s.net) < 0);
    const sellSorted = (sells || []).slice().sort((a, b) => dLocal(a.date) - dLocal(b.date));
    const buyTxns = (txns || [])
      .filter(t => String(t.type || "").toUpperCase() === "BUY")
      .map(t => ({ stock: normStock(t.stock), date: t.date, price: n(t.price), qty: n(t.qty) }))
      .sort((a, b) => dLocal(a.date) - dLocal(b.date));

    let rebuyHigher = 0;
    lossSells.forEach((s) => {
      const b = buyTxns.find(x => x.stock === s.stock && dLocal(x.date) > dLocal(s.date) && n(x.price) > n(s.price));
      if (b) rebuyHigher += 1;
    });

    const avgLoss = lossSells.length ? (lossSells.reduce((a, s) => a + Math.abs(n(s.net)), 0) / lossSells.length) : 0;
    const earlyLossExits = lossSells.filter(s => n(s.holdDays) < 10).length;

    return {
      totalSells: sellSorted.length,
      lossSellCount: lossSells.length,
      rebuyHigherCount: rebuyHigher,
      earlyLossExits,
      avgLoss,
      regretRate: lossSells.length ? (rebuyHigher / lossSells.length) * 100 : 0
    };
  }

  function renderScore(metrics) {
    const el = document.getElementById("guardScoreGrid");
    if (!el) return;
    el.innerHTML = [
      { k: "Loss Sells", v: String(metrics.lossSellCount), c: metrics.lossSellCount > 0 ? "loss" : "profit" },
      { k: "Rebuy Higher", v: String(metrics.rebuyHigherCount), c: metrics.rebuyHigherCount > 0 ? "loss" : "profit" },
      { k: "Early Loss Exits", v: String(metrics.earlyLossExits), c: metrics.earlyLossExits > 0 ? "loss" : "profit" },
      { k: "Avg Loss / Exit", v: money(metrics.avgLoss), c: metrics.avgLoss > 0 ? "loss" : "" },
      { k: "Regret Pattern Rate", v: pct(metrics.regretRate), c: metrics.regretRate > 35 ? "loss" : "profit" },
      { k: "Total Sell Cycles", v: String(metrics.totalSells), c: "" }
    ].map(x => `<div class="stat-card"><div class="stat-label">${x.k}</div><div class="stat-value ${x.c}">${x.v}</div></div>`).join("");
  }

  function renderRegretList(sells) {
    const el = document.getElementById("guardRegretList");
    if (!el) return;
    try {
      Object.keys(LOSS_SELL_CACHE).forEach((k) => { delete LOSS_SELL_CACHE[k]; });
    } catch (e) {}
    const liveFn = typeof window.getLivePriceForStock === "function" ? window.getLivePriceForStock : null;
    const rows = (sells || []).filter(s => n(s.net) < 0).slice(-12).reverse();
    if (!rows.length) {
      el.innerHTML = '<div class="txn-card text-muted">No loss sells found yet.</div>';
      return;
    }
    el.innerHTML = rows.map((r) => {
      const rowId = `${r.stock}__${r.date}__${n(r.qty)}__${n(r.price).toFixed(2)}`;
      LOSS_SELL_CACHE[rowId] = r;
      const ltp = liveFn ? n((liveFn(r.stock) || {}).ltp, 0) : 0;
      const missed = ltp > 0 ? Math.max(0, (ltp - n(r.price)) * n(r.qty)) : 0;
      return `
        <div class="txn-card">
          <div class="split-row">
            <div class="left-col"><strong>${r.stock}</strong> <span class="tiny-label">(${r.date})</span></div>
            <div class="right-col loss"><strong>${money(r.net)}</strong></div>
          </div>
          <div class="tiny-label mt-1">Sold ${n(r.qty)} @ ${money(r.price)} | Hold Days: ${n(r.holdDays)} | Reason: ${r.reason || "-"}</div>
          <div class="tiny-label ${missed > 0 ? "loss" : "text-muted"}">Current regret snapshot: ${ltp > 0 ? `LTP ${money(ltp)} | Missed bounce ${money(missed)}` : "LTP unavailable"}</div>
          <div class="d-flex gap-2 mt-2">
            <button type="button" class="btn btn-sm btn-outline-primary" data-regret-action="create-plan" data-regret-id="${rowId}">Create Re-entry Plan</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function fillStockOptions(holdings) {
    const dl = document.getElementById("guardStockOptions");
    if (!dl) return;
    const names = Object.keys(holdings || {}).sort();
    dl.innerHTML = names.map(s => `<option value="${s}"></option>`).join("");
  }

  function renderAdvice(payload) {
    const el = document.getElementById("guardAdvice");
    if (!el) return;
    el.innerHTML = payload;
  }

  function renderPlans(plans) {
    const host = document.getElementById("guardPlanList");
    if (!host) return;
    const liveFn = typeof window.getLivePriceForStock === "function" ? window.getLivePriceForStock : null;
    if (!plans.length) {
      host.innerHTML = '<div class="txn-card text-muted">No re-entry plans yet. Use Pre-Sell Guard to create one.</div>';
      return;
    }
    const now = Date.now();
    host.innerHTML = plans.map((p) => {
      const ltp = liveFn ? n((liveFn(p.stock) || {}).ltp, 0) : 0;
      const coolMs = Date.parse(p.cooldownUntil || "");
      const cooling = Number.isFinite(coolMs) && coolMs > now;
      let signal = "Waiting";
      let signalCls = "info";
      if (cooling) {
        signal = "Cooldown Active";
      } else if (ltp > 0 && n(p.l2) > 0 && ltp <= n(p.l2)) {
        signal = "L2 Trigger";
        signalCls = "ok";
      } else if (ltp > 0 && n(p.l1) > 0 && ltp <= n(p.l1)) {
        signal = "L1 Trigger";
        signalCls = "ok";
      }

      return `
        <div class="txn-card">
          <div class="split-row">
            <div class="left-col"><strong>${p.stock}</strong> <span class="tiny-label">Created ${String(p.createdAt || "").slice(0, 10)}</span></div>
            <div class="right-col"><span class="status-pill-mini ${signalCls}">${signal}</span></div>
          </div>
          <div class="tiny-label mt-1">Sold @ ${money(p.sellPrice)} | Re-entry L1 ${money(p.l1)} | L2 ${money(p.l2)}</div>
          <div class="tiny-label">Cooldown until: ${p.cooldownUntil ? new Date(p.cooldownUntil).toLocaleString() : "-"} | Live: ${ltp > 0 ? money(ltp) : "-"}</div>
          <div class="d-flex gap-2 mt-2">
            <button type="button" class="btn btn-sm btn-outline-secondary" data-plan-action="done" data-plan-id="${p.id}">Mark Done</button>
            <button type="button" class="btn btn-sm btn-outline-danger" data-plan-action="delete" data-plan-id="${p.id}">Delete</button>
          </div>
        </div>
      `;
    }).join("");
  }

  function wirePlanActions() {
    const host = document.getElementById("guardPlanList");
    if (!host || host.dataset.wired === "1") return;
    host.dataset.wired = "1";
    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-plan-action]");
      if (!btn) return;
      const action = btn.dataset.planAction;
      const id = btn.dataset.planId;
      const plans = readPlans();
      if (action === "delete") {
        savePlans(plans.filter(p => p.id !== id));
      } else if (action === "done") {
        savePlans(plans.map(p => p.id === id ? { ...p, status: "done" } : p));
      }
      loadDisciplineCoach().catch(() => {});
    });
  }

  function createPlanFromSellRow(sellRow) {
    if (!sellRow) return;
    const plan = {
      id: "plan_" + Date.now(),
      stock: sellRow.stock,
      sellPrice: n(sellRow.price),
      l1: Math.max(0, n(sellRow.price) * 0.97),
      l2: Math.max(0, n(sellRow.price) * 0.93),
      cooldownUntil: hoursFromNow(48),
      createdAt: new Date().toISOString(),
      source: "sell_txn",
      sourceDate: sellRow.date,
      status: "active"
    };
    const plans = readPlans();
    plans.unshift(plan);
    savePlans(plans.slice(0, 100));
    if (typeof showToast === "function") {
      showToast(`Re-entry plan created for ${plan.stock} (L1 ${money(plan.l1)}, L2 ${money(plan.l2)})`, "success", 3500);
    }
  }

  function wireRegretActions() {
    const host = document.getElementById("guardRegretList");
    if (!host || host.dataset.wired === "1") return;
    host.dataset.wired = "1";
    host.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-regret-action='create-plan']");
      if (!btn) return;
      const id = String(btn.dataset.regretId || "");
      const row = LOSS_SELL_CACHE[id];
      if (!row) return;
      createPlanFromSellRow(row);
      loadDisciplineCoach().catch(() => {});
    });
  }

  function wireGuardForm(holdings) {
    const form = document.getElementById("guardForm");
    if (!form || form.dataset.wired === "1") return;
    form.dataset.wired = "1";
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const stock = normStock(document.getElementById("guardStock")?.value || "");
      const qty = Math.floor(n(document.getElementById("guardQty")?.value, 0));
      const sellPrice = n(document.getElementById("guardSellPrice")?.value, 0);
      const reason = String(document.getElementById("guardReason")?.value || "");
      const cooldownHours = Math.max(1, Math.floor(n(document.getElementById("guardCooldownHours")?.value, 48)));
      const l1 = n(document.getElementById("guardReentryL1")?.value, 0);
      const l2 = n(document.getElementById("guardReentryL2")?.value, 0);
      const thesisBroken = !!document.getElementById("guardThesisBroken")?.checked;

      if (!stock || qty <= 0 || sellPrice <= 0) {
        renderAdvice('<div class="txn-card text-danger">Please fill valid stock, qty, and sell price.</div>');
        return;
      }

      const h = holdings[stock] || { qty: 0, avg: 0, firstDate: null };
      if (qty > n(h.qty)) {
        renderAdvice(`<div class="txn-card text-danger">Qty exceeds current holding. Available for ${stock}: ${Math.floor(n(h.qty))}</div>`);
        return;
      }

      const est = (sellPrice - n(h.avg)) * qty;
      let risk = 0;
      if (est < 0) risk += 40;
      if (reason.toLowerCase().includes("emotional")) risk += 30;
      if (!thesisBroken) risk += 20;
      if (n(h.avg) > 0 && sellPrice < n(h.avg) * 0.98) risk += 10;
      risk = Math.max(0, Math.min(100, risk));

      const tone = risk >= 65 ? "loss" : (risk >= 40 ? "warn" : "profit");
      const advice = risk >= 65
        ? "High panic-exit risk. Avoid immediate sell. Define strict re-entry ladder and cooldown first."
        : (risk >= 40
            ? "Moderate risk. Sell only if rule-based (thesis broken / risk control)."
            : "Low emotional risk. Decision appears rule-based.");

      const newPlan = {
        id: "plan_" + Date.now(),
        stock,
        sellPrice,
        l1: l1 > 0 ? l1 : Math.max(0, sellPrice * 0.97),
        l2: l2 > 0 ? l2 : Math.max(0, sellPrice * 0.93),
        cooldownUntil: hoursFromNow(cooldownHours),
        createdAt: new Date().toISOString(),
        status: "active"
      };
      const plans = readPlans();
      plans.unshift(newPlan);
      savePlans(plans.slice(0, 80));

      renderAdvice(`
        <div class="txn-card">
          <div class="split-row">
            <div class="left-col"><strong>${stock}</strong> | Est. P/L on sell ${money(est)}</div>
            <div class="right-col"><span class="status-pill-mini ${tone}">Risk ${risk}/100</span></div>
          </div>
          <div class="tiny-label mt-1">${advice}</div>
          <div class="tiny-label">Created re-entry plan: L1 ${money(newPlan.l1)} | L2 ${money(newPlan.l2)} | Cooldown ${cooldownHours}h</div>
        </div>
      `);
      if (typeof showToast === "function") showToast("Pre-sell analysis done and plan saved", "success");
      loadDisciplineCoach().catch(() => {});
    });
  }

  async function loadDisciplineCoach() {
    const txns = await readStoreAll("transactions");
    const sells = buildSellOutcomes(txns);
    const holdings = buildActiveHoldings(txns);
    const metrics = computeMetrics(txns, sells);
    const plans = readPlans().filter(p => String(p.status || "active") !== "done");

    fillStockOptions(holdings);
    renderScore(metrics);
    renderRegretList(sells);
    renderPlans(plans);
    wirePlanActions();
    wireRegretActions();
    wireGuardForm(holdings);
  }

  window.loadDisciplineCoach = loadDisciplineCoach;
  if (typeof window !== "undefined") {
    window.addEventListener("live-prices-updated", () => {
      loadDisciplineCoach().catch(() => {});
    });
  }
})();






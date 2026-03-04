function advNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function advPct(value) {
  return `${advNum(value, 0).toFixed(2)}%`;
}

function advMoney(value) {
  return `₹${advNum(value, 0).toFixed(2)}`;
}

function advDays(fromDate) {
  const d = new Date(fromDate || "");
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function advisorBuildRows(txns, settings) {
  const map = (typeof buildPositionHoldingsMap === "function")
    ? buildPositionHoldingsMap(txns || [], settings || {}, { captureCycleTxns: true })
    : {};
  const rows = [];
  Object.keys(map).forEach(stock => {
    const lots = map[stock]?.lots || [];
    if (!lots.length) return;
    const qty = lots.reduce((a, l) => a + advNum(l.qty, 0), 0);
    if (qty <= 0) return;
    const invested = lots.reduce((a, l) => a + advNum(l.qty, 0) * (advNum(l.price, 0) + advNum(l.brokeragePerUnit, 0)), 0);
    const avg = qty > 0 ? invested / qty : 0;
    const live = (typeof window !== "undefined" && typeof window.getLivePriceForStock === "function")
      ? window.getLivePriceForStock(stock)
      : null;
    const ltp = advNum(live?.ltp, 0);
    const hasLive = ltp > 0;
    const current = hasLive ? qty * ltp : invested;
    const unreal = current - invested;
    const unrealPct = invested > 0 ? (unreal / invested) * 100 : 0;
    const first = map[stock]?.cycleFirstBuy || lots[0]?.date;
    const cycleBuys = (map[stock]?.cycleTxns || []).filter(ct => String(ct.type || "").toUpperCase() === "BUY");
    const lastBuyPrice = cycleBuys.length ? advNum(cycleBuys[cycleBuys.length - 1]?.price, 0) : advNum(lots[lots.length - 1]?.price, 0);
    rows.push({
      stock,
      qty,
      invested,
      avg,
      lastBuyPrice,
      ltp,
      hasLive,
      current,
      unreal,
      unrealPct,
      days: advDays(first)
    });
  });
  const totalCurrent = rows.reduce((a, r) => a + advNum(r.current, 0), 0);
  rows.forEach(r => {
    r.allocPct = totalCurrent > 0 ? (r.current / totalCurrent) * 100 : 0;
  });
  return { rows, totalCurrent };
}

function advisorAnalyze(rows, settings) {
  const maxAlloc = advNum(settings?.maxAllocationPct, 25);
  const avgL1 = advNum(settings?.avgLevel1Pct, 7);
  const avgL2 = advNum(settings?.avgLevel2Pct, 12);
  const stopLoss = advNum(settings?.stopLossPct, 8);
  const minHold = advNum(settings?.minHoldDaysTrim, 20);
  const fdRateAnnual = advNum(settings?.fdRatePct, 6.5) / 100;
  const sellBrkgPct = advNum(settings?.brokerageSellPct, 0.15) / 100;
  const dpCharge = advNum(settings?.dpCharge, 50);

  const trim = [];
  const add = [];
  const watch = [];

  rows.forEach(r => {
    const trimQtyBase = Math.max(1, Math.floor(r.qty * 0.25));
    const lBase = advNum(r.lastBuyPrice, 0) > 0 ? advNum(r.lastBuyPrice, 0) : advNum(r.avg, 0);
    const level1 = lBase * (1 - avgL1 / 100);
    const level2 = lBase * (1 - avgL2 / 100);
    const stopLine = r.avg * (1 - stopLoss / 100);
    const allocBreach = r.allocPct > maxAlloc;
    const weakLongHold = r.unrealPct < -3 && r.days > (minHold * 1.4);
    const fdReturnFactor = 1 + (fdRateAnnual * Math.max(0, r.days) / 365);
    const denom = trimQtyBase * Math.max(0.0001, (1 - sellBrkgPct));

    const targetNetAvg = (r.avg * trimQtyBase) * fdReturnFactor;
    const minGoodSellPriceAvg = (targetNetAvg + dpCharge) / denom;
    const fdOnlyTargetAvg = Math.max(0, targetNetAvg - (r.avg * trimQtyBase));

    const basisLastBuy = Math.max(0, advNum(r.lastBuyPrice, 0));
    const targetNetLastBuy = (basisLastBuy * trimQtyBase) * fdReturnFactor;
    const minGoodSellPriceLastBuy = basisLastBuy > 0 ? ((targetNetLastBuy + dpCharge) / denom) : 0;
    const fdOnlyTargetLastBuy = Math.max(0, targetNetLastBuy - (basisLastBuy * trimQtyBase));

    if (allocBreach || weakLongHold) {
      const urgency = Math.min(100, Math.max(20, (allocBreach ? (r.allocPct - maxAlloc) * 8 : 0) + (weakLongHold ? Math.abs(r.unrealPct) * 2 : 0) + (r.days > minHold ? 20 : 0)));
      trim.push({
        stock: r.stock,
        qty: trimQtyBase,
        urgency,
        reason: allocBreach
          ? `Allocation high (${advPct(r.allocPct)} > ${advPct(maxAlloc)}).`
          : `Weak hold (${advPct(r.unrealPct)}) for ${r.days} days.`,
        note: `Suggested partial sell: ${trimQtyBase} qty near LTP ${r.hasLive ? advMoney(r.ltp) : "-"}`,
        compare: `Min good-profit (Avg ${advMoney(r.avg)}): ${advMoney(minGoodSellPriceAvg)} | Min good-profit (Last Buy ${basisLastBuy > 0 ? advMoney(basisLastBuy) : "-"}): ${basisLastBuy > 0 ? advMoney(minGoodSellPriceLastBuy) : "-"} | FD ${advPct(fdRateAnnual * 100)} for ${r.days}d + brokerage + DP.`,
        fdTargetLine: `FD-equivalent target gain: Avg basis ${advMoney(fdOnlyTargetAvg)}${basisLastBuy > 0 ? ` | Last-buy basis ${advMoney(fdOnlyTargetLastBuy)}` : ""}`
      });
    }

    if (r.hasLive && r.ltp <= level1 && r.allocPct < maxAlloc) {
      add.push({
        stock: r.stock,
        urgency: Math.min(100, Math.max(20, Math.abs(((level1 - r.ltp) / Math.max(1, level1)) * 100) * 10)),
        reason: `Price in averaging zone (${advMoney(r.ltp)} <= L1 ${advMoney(level1)}).`,
        note: `L2 deeper zone: ${advMoney(level2)} | Current allocation: ${advPct(r.allocPct)}`
      });
    }

    if (r.hasLive && r.ltp <= stopLine) {
      watch.push({
        stock: r.stock,
        urgency: Math.min(100, Math.max(25, Math.abs(r.unrealPct) * 2.8)),
        reason: `Near/below stop-loss line (${advMoney(stopLine)}).`,
        note: `Unrealized: ${advMoney(r.unreal)} (${advPct(r.unrealPct)})`
      });
    }
  });

  trim.sort((a, b) => b.qty - a.qty);
  add.sort((a, b) => a.stock.localeCompare(b.stock));
  watch.sort((a, b) => a.stock.localeCompare(b.stock));
  return { trim, add, watch };
}

function advisorListHtml(items, emptyText) {
  if (!Array.isArray(items) || !items.length) {
    return `<div class="txn-card text-center text-muted">${emptyText}</div>`;
  }
  return items.map((x, idx) => `
    <div class="txn-card">
      <div class="split-row">
        <div class="left-col">
          <div class="txn-name">${idx + 1}. ${x.stock}</div>
          <div class="txn-sub">${x.reason}</div>
        </div>
        <div class="right-col">
          <span class="status-pill-mini ${Number(x.urgency || 0) >= 70 ? "bad" : (Number(x.urgency || 0) >= 40 ? "warn" : "ok")}">Urgency ${Math.round(Number(x.urgency || 0))}/100</span>
        </div>
      </div>
      <div class="tiny-label mt-1">${x.note || ""}</div>
      ${x.compare ? `<div class="tiny-label mt-1">${x.compare}</div>` : ""}
      ${x.fdTargetLine ? `<div class="tiny-label mt-1">${x.fdTargetLine}</div>` : ""}
      ${x.qty ? `<div class="suggestion-row mt-1"><span>Suggested Qty</span><span>${x.qty}</span></div>` : ""}
    </div>
  `).join("");
}

function advisorRenderSignalDonut(analysis) {
  const donut = document.getElementById("advisorSignalDonut");
  const legend = document.getElementById("advisorSignalLegend");
  if (!donut || !legend) return;
  const trim = Number(analysis?.trim?.length || 0);
  const add = Number(analysis?.add?.length || 0);
  const watch = Number(analysis?.watch?.length || 0);
  const total = trim + add + watch;
  if (!total) {
    donut.innerHTML = `<div class="text-muted">No action signals</div>`;
    legend.innerHTML = "";
    return;
  }
  const tPct = (trim / total) * 100;
  const aPct = (add / total) * 100;
  const wPct = (watch / total) * 100;
  donut.innerHTML = `
    <div class="adv-donut" style="background:conic-gradient(#ef4444 0% ${tPct}%, #16a34a ${tPct}% ${tPct + aPct}%, #f59e0b ${tPct + aPct}% 100%)"></div>
    <div class="tiny-label mt-2 text-center"><strong>${total}</strong> total signals</div>
  `;
  legend.innerHTML = `
    <div class="split-row"><div class="left-col tiny-label"><span class="legend-dot" style="background:#ef4444"></span>Trim</div><div class="right-col tiny-label">${trim}</div></div>
    <div class="split-row"><div class="left-col tiny-label"><span class="legend-dot" style="background:#16a34a"></span>Add</div><div class="right-col tiny-label">${add}</div></div>
    <div class="split-row"><div class="left-col tiny-label"><span class="legend-dot" style="background:#f59e0b"></span>Watch</div><div class="right-col tiny-label">${watch}</div></div>
  `;
}

function advisorRenderRiskTrend(rows) {
  const chart = document.getElementById("advisorRiskTrend");
  if (!chart) return;
  const data = (rows || [])
    .map(r => {
      const risk = Math.min(100, Math.max(0, (Math.max(0, r.allocPct - 12) * 3) + Math.max(0, -r.unrealPct * 2) + Math.max(0, (r.days - 20) * 0.8)));
      return { stock: r.stock, risk, unrealPct: r.unrealPct };
    })
    .sort((a, b) => b.risk - a.risk)
    .slice(0, 7);
  if (!data.length) {
    chart.innerHTML = `<div class="text-muted">No holdings for risk trend.</div>`;
    return;
  }
  chart.innerHTML = data.map(d => `
    <div class="adv-bar-row">
      <div class="adv-bar-label">${d.stock}</div>
      <div class="adv-bar-track"><div class="adv-bar ${d.risk >= 60 ? "loss" : "profit"}" style="width:${d.risk.toFixed(2)}%"></div></div>
      <div class="adv-bar-value ${d.unrealPct >= 0 ? "profit" : "loss"}">${d.risk.toFixed(0)}/100</div>
    </div>
  `).join("");
}

function advisorRenderAllocChart(rows) {
  const host = document.getElementById("advisorAllocChart");
  if (!host) return;
  const list = (rows || [])
    .slice()
    .sort((a, b) => b.allocPct - a.allocPct)
    .slice(0, 8);
  if (!list.length) {
    host.innerHTML = `<div class="text-muted">No allocation data.</div>`;
    return;
  }
  const max = Math.max(1, ...list.map(r => Number(r.allocPct || 0)));
  host.innerHTML = list.map(r => {
    const w = (Number(r.allocPct || 0) / max) * 100;
    return `
      <div class="adv-bar-row">
        <div class="adv-bar-label">${r.stock}</div>
        <div class="adv-bar-track"><div class="adv-bar" style="width:${w}%;background:linear-gradient(90deg,#2563eb,#38bdf8)"></div></div>
        <div class="adv-bar-value">${advPct(r.allocPct)}</div>
      </div>
    `;
  }).join("");
}

function advisorRenderSummary(analysis, rows) {
  const host = document.getElementById("advisorSummary");
  if (!host) return;
  host.innerHTML = `
    <div class="stat-card"><div class="stat-label">Active Holdings</div><div class="stat-value">${rows.length}</div></div>
    <div class="stat-card"><div class="stat-label">Trim Signals</div><div class="stat-value">${analysis.trim.length}</div></div>
    <div class="stat-card"><div class="stat-label">Add Signals</div><div class="stat-value">${analysis.add.length}</div></div>
    <div class="stat-card"><div class="stat-label">Risk Alerts</div><div class="stat-value">${analysis.watch.length}</div></div>
  `;
}

async function loadAdvisorPage() {
  const txns = await new Promise(resolve => {
    try {
      db.transaction("transactions", "readonly").objectStore("transactions").getAll().onsuccess = e => resolve(e.target.result || []);
    } catch (e) {
      resolve([]);
    }
  });
  getSettings(settings => {
    const { rows } = advisorBuildRows(txns, settings || {});
    const analysis = advisorAnalyze(rows, settings || {});

    advisorRenderSummary(analysis, rows);
    advisorRenderSignalDonut(analysis);
    advisorRenderRiskTrend(rows);
    advisorRenderAllocChart(rows);
    const trimEl = document.getElementById("advisorTrimList");
    const addEl = document.getElementById("advisorAddList");
    const watchEl = document.getElementById("advisorWatchList");
    const stampEl = document.getElementById("advisorStamp");

    if (trimEl) trimEl.innerHTML = advisorListHtml(analysis.trim, "No trim signals right now");
    if (addEl) addEl.innerHTML = advisorListHtml(analysis.add, "No add/rebuy candidates right now");
    if (watchEl) watchEl.innerHTML = advisorListHtml(analysis.watch, "No urgent risk alerts");
    if (stampEl) stampEl.textContent = `Last analysis: ${new Date().toLocaleString()}`;
  });
}

if (typeof window !== "undefined") {
  window.loadAdvisorPage = loadAdvisorPage;
}

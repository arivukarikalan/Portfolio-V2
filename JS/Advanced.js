(function () {
  function n(v, d = 0) {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  }

  function money(v) {
    return "\u20b9" + n(v).toFixed(2);
  }

  function pct(v) {
    return n(v).toFixed(2) + "%";
  }

  function moneyShort(v) {
    const x = n(v);
    if (Math.abs(x) >= 10000000) return "\u20b9" + (x / 10000000).toFixed(2) + "Cr";
    if (Math.abs(x) >= 100000) return "\u20b9" + (x / 100000).toFixed(2) + "L";
    if (Math.abs(x) >= 1000) return "\u20b9" + (x / 1000).toFixed(1) + "K";
    return "\u20b9" + x.toFixed(0);
  }

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function findAdvTapTarget(event, stopNode) {
    let cur = event.target;
    while (cur && cur !== stopNode) {
      if (cur.dataset && cur.dataset.advMonth) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function dLocal(s) {
    const parts = String(s || "").split("-");
    if (parts.length === 3) {
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
    return new Date(s);
  }

  function daysBetween(a, b) {
    const ms = (b.getTime() - a.getTime()) / 86400000;
    return Math.max(0, Math.floor(ms));
  }

  function normStock(v) {
    return String(v || "").trim().replace(/\s+/g, " ").toUpperCase();
  }

  function readStoreAll(storeName) {
    return new Promise((resolve) => {
      try {
        db.transaction(storeName, "readonly").objectStore(storeName).getAll().onsuccess = (e) => {
          resolve(e.target.result || []);
        };
      } catch (e) {
        resolve([]);
      }
    });
  }

  async function readSettings() {
    return new Promise((resolve) => {
      try {
        db.transaction("settings", "readonly").objectStore("settings").get(1).onsuccess = (e) => {
          resolve(e.target.result || {});
        };
      } catch (err) {
        resolve({});
      }
    });
  }

  function computeModel(txns, settings) {
    const sorted = (txns || []).slice().sort((a, b) => dLocal(a.date) - dLocal(b.date));
    const holdings = {};
    const monthlyRealized = {};
    const monthlyCapital = {};
    const monthlyContribution = {};
    const monthlyRealizedDetails = {};
    const monthlyContributionDetails = {};
    const realizedTrades = [];
    const stockAgg = {};
    const cycleAgg = {};
    const buyEvents = [];
    let internalCashPool = 0;

    sorted.forEach((t) => {
      const stock = normStock(t.stock);
      if (!stock) return;
      holdings[stock] = holdings[stock] || { lots: [], firstDate: null };
      stockAgg[stock] = stockAgg[stock] || { net: 0, wins: 0, losses: 0, holdDays: 0, invested: 0, trades: 0 };
      cycleAgg[stock] = cycleAgg[stock] || { openCost: 0, openQty: 0, pnl: 0, cycles: [], lossStreak: 0, maxLossStreak: 0 };

      const type = String(t.type || "").toUpperCase();
      const qty = n(t.qty);
      const price = n(t.price);
      const brkg = n(t.brokerage);
      const mKey = String(t.date || "").slice(0, 7);
      if (mKey) {
        if (type === "BUY") {
          const buyValue = qty * price + brkg;
          monthlyCapital[mKey] = n(monthlyCapital[mKey]) + buyValue;

          // New contribution only = amount that cannot be funded by historical sell proceeds.
          const fundedByPool = Math.min(internalCashPool, buyValue);
          const freshContribution = Math.max(0, buyValue - fundedByPool);
          monthlyContribution[mKey] = n(monthlyContribution[mKey]) + freshContribution;
          internalCashPool = Math.max(0, internalCashPool - fundedByPool);
          monthlyContributionDetails[mKey] = monthlyContributionDetails[mKey] || [];
          monthlyContributionDetails[mKey].push({
            date: t.date,
            stock,
            type: "BUY",
            qty,
            price,
            buyValue,
            fundedByPool,
            freshContribution
          });
        }
        if (type === "SELL") {
          const sellNet = qty * price - brkg;
          monthlyCapital[mKey] = n(monthlyCapital[mKey]) - sellNet;
          internalCashPool += Math.max(0, sellNet);
          monthlyContributionDetails[mKey] = monthlyContributionDetails[mKey] || [];
          monthlyContributionDetails[mKey].push({
            date: t.date,
            stock,
            type: "SELL",
            qty,
            price,
            sellNet
          });
        }
      }

      if (type === "BUY") {
        if (!holdings[stock].firstDate) holdings[stock].firstDate = t.date;
        holdings[stock].lots.push({
          qty,
          price,
          date: t.date,
          brkgPerUnit: qty > 0 ? brkg / qty : 0
        });
        buyEvents.push({ stock, date: t.date, price, qty });
        cycleAgg[stock].openCost += qty * price + brkg;
        cycleAgg[stock].openQty += qty;
        return;
      }

      if (type !== "SELL") return;
      let rem = qty;
      let buyCost = 0;
      let buyBrkg = 0;
      let firstLotDate = null;
      while (rem > 0 && holdings[stock].lots.length) {
        const lot = holdings[stock].lots[0];
        const used = Math.min(rem, n(lot.qty));
        if (!firstLotDate) firstLotDate = lot.date;
        buyCost += used * n(lot.price);
        buyBrkg += used * n(lot.brkgPerUnit);
        lot.qty = n(lot.qty) - used;
        rem -= used;
        if (lot.qty <= 0) holdings[stock].lots.shift();
      }
      const sellValue = qty * price;
      const net = sellValue - buyCost - buyBrkg - brkg;
      const invested = buyCost + buyBrkg;
      const holdDays = firstLotDate ? daysBetween(dLocal(firstLotDate), dLocal(t.date)) : 0;
      const returnPct = invested > 0 ? (net / invested) * 100 : 0;
      realizedTrades.push({ stock, date: t.date, qty, price, net, invested, holdDays, returnPct });
      monthlyRealized[mKey] = n(monthlyRealized[mKey]) + net;
      if (mKey) {
        monthlyRealizedDetails[mKey] = monthlyRealizedDetails[mKey] || [];
        monthlyRealizedDetails[mKey].push({
          date: t.date,
          stock,
          type: "SELL",
          qty,
          price,
          sellValue,
          buyCost: buyCost + buyBrkg,
          brokerage: brkg,
          net
        });
      }
      stockAgg[stock].net += net;
      stockAgg[stock].holdDays += holdDays;
      stockAgg[stock].invested += invested;
      stockAgg[stock].trades += 1;
      if (net >= 0) stockAgg[stock].wins += 1; else stockAgg[stock].losses += 1;

      cycleAgg[stock].pnl += net;
      if (holdings[stock].lots.length === 0 && cycleAgg[stock].openQty > 0) {
        const c = cycleAgg[stock].pnl;
        cycleAgg[stock].cycles.push(c);
        if (c < 0) {
          cycleAgg[stock].lossStreak += 1;
          cycleAgg[stock].maxLossStreak = Math.max(cycleAgg[stock].maxLossStreak, cycleAgg[stock].lossStreak);
        } else {
          cycleAgg[stock].lossStreak = 0;
        }
        cycleAgg[stock].openCost = 0;
        cycleAgg[stock].openQty = 0;
        cycleAgg[stock].pnl = 0;
      }
    });

    return {
      holdings,
      monthlyRealized,
      monthlyCapital,
      monthlyContribution,
      monthlyRealizedDetails,
      monthlyContributionDetails,
      realizedTrades,
      stockAgg,
      cycleAgg,
      buyEvents
    };
  }

  function renderBars(el, map, positiveClass, negativeClass, opts = {}) {
    if (!el) return;
    const keys = Object.keys(map || {}).sort();
    if (!keys.length) {
      el.innerHTML = '<div class="text-muted">No data</div>';
      return;
    }
    const vals = keys.map(k => n(map[k]));
    const maxAbs = Math.max(1, ...vals.map(v => Math.abs(v)));
    el.innerHTML = keys.map(k => {
      const v = n(map[k]);
      const w = (Math.abs(v) / maxAbs) * 100;
      const cls = v >= 0 ? positiveClass : negativeClass;
      const valueHtml = opts.onMonthTap
        ? `<button type="button" class="adv-amount-btn adv-bar-value ${cls}" data-adv-kind="${opts.kind || ""}" data-adv-month="${k}" title="View transactions">${money(v)}</button>`
        : `<div class="adv-bar-value ${cls}">${money(v)}</div>`;
      return `<div class="adv-bar-row"><div class="adv-bar-label">${k}</div><div class="adv-bar-track"><div class="adv-bar ${cls}" style="width:${w}%"></div></div>${valueHtml}</div>`;
    }).join("");

    if (opts.onMonthTap && el.dataset.tapWired !== "1") {
      el.dataset.tapWired = "1";
      el.addEventListener("click", (ev) => {
        const target = findAdvTapTarget(ev, el);
        if (!target) return;
        opts.onMonthTap(target.dataset.advKind || opts.kind || "", target.dataset.advMonth || "");
      });
    }
  }

  function renderMonthlyContributionTrend(el, map, opts = {}) {
    if (!el) return;
    const keys = Object.keys(map || {}).sort();
    if (!keys.length) {
      el.innerHTML = '<div class="text-muted">No contribution data</div>';
      return;
    }

    const labels = keys.slice(-12);
    const values = labels.map((k) => Math.max(0, n(map[k])));
    const maxV = Math.max(1, ...values);
    const minV = Math.min(...values);
    const range = Math.max(1, maxV - minV);

    const width = 640;
    const height = 220;
    const padL = 14;
    const padR = 14;
    const padT = 12;
    const padB = 34;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const stepX = labels.length > 1 ? plotW / (labels.length - 1) : 0;

    const points = values.map((v, i) => {
      const x = padL + i * stepX;
      const y = padT + (1 - ((v - minV) / range)) * plotH;
      return { x, y, v, label: labels[i] };
    });

    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    const areaPath = `${path} L${(padL + plotW).toFixed(2)} ${(padT + plotH).toFixed(2)} L${padL.toFixed(2)} ${(padT + plotH).toFixed(2)} Z`;
    const xLabels = points
      .map((p, i) => (i % Math.max(1, Math.floor(points.length / 6)) === 0 || i === points.length - 1)
        ? `<text x="${p.x.toFixed(2)}" y="${height - 10}" text-anchor="middle" class="adv-line-axis">${p.label.slice(2)}</text>`
        : "")
      .join("");
    const pointLabels = points
      .map((p, i) => {
        const y = Math.max(10, p.y - 10);
        const show = points.length <= 8 || i % 2 === 0 || i === points.length - 1;
        if (!show) return "";
        return `<text x="${p.x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" class="adv-line-value ${opts.onMonthTap ? "clickable" : ""}" data-adv-kind="${opts.kind || ""}" data-adv-month="${p.label}" title="View transactions">${moneyShort(p.v)}</text>`;
      })
      .join("");
    const dots = points.map((p) => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3.2" class="adv-line-dot"></circle>`).join("");
    const current = points[points.length - 1];
    const monthValueRows = labels.map((m, i) => {
      const valueHtml = opts.onMonthTap
        ? `<button type="button" class="adv-amount-btn tiny-label" data-adv-kind="${opts.kind || ""}" data-adv-month="${m}" title="View transactions"><strong>${money(values[i])}</strong></button>`
        : `<span class="tiny-label"><strong>${money(values[i])}</strong></span>`;
      return `<div class="split-row"><div class="left-col tiny-label">${m}</div><div class="right-col">${valueHtml}</div></div>`;
    }).join("");

    el.innerHTML = `
      <div class="adv-line-wrap">
        <div class="adv-line-main">
          <svg viewBox="0 0 ${width} ${height}" class="adv-line-svg" role="img" aria-label="Monthly contribution trend chart">
            <defs>
              <linearGradient id="advContributionFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="rgba(15,98,254,0.28)"></stop>
                <stop offset="100%" stop-color="rgba(15,98,254,0.02)"></stop>
              </linearGradient>
            </defs>
            <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" class="adv-line-grid"></line>
            <path d="${areaPath}" fill="url(#advContributionFill)"></path>
            <path d="${path}" class="adv-line-path"></path>
            ${pointLabels}
            ${dots}
            ${xLabels}
          </svg>
          <div class="split-row mt-2 adv-line-summary">
            <div class="tiny-label">Last ${labels.length} months new-money contribution</div>
            <div class="tiny-label"><strong>${current.label}</strong>: ${money(current.v)}</div>
          </div>
        </div>
        <div class="stack-gap adv-line-side">${monthValueRows}</div>
      </div>
    `;

    if (opts.onMonthTap && el.dataset.tapWired !== "1") {
      el.dataset.tapWired = "1";
      el.addEventListener("click", (ev) => {
        const target = findAdvTapTarget(ev, el);
        if (!target) return;
        opts.onMonthTap(target.dataset.advKind || opts.kind || "", target.dataset.advMonth || "");
      });
    }
  }

  function openMonthlyTxnModal(kind, month, model) {
    if (!month || !model) return;
    let modal = document.getElementById("advTxnModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "advTxnModal";
      modal.className = "app-dialog-backdrop";
      modal.innerHTML = `
        <div class="app-dialog-card adv-txn-modal-card" role="dialog" aria-modal="true">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <div class="app-dialog-title mb-0" id="advTxnModalTitle">Month Details</div>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="advTxnModalClose">Close</button>
          </div>
          <div id="advTxnModalBody"></div>
        </div>
      `;
      document.body.appendChild(modal);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.style.display = "none";
      });
      const closeBtn = document.getElementById("advTxnModalClose");
      if (closeBtn) closeBtn.addEventListener("click", () => { modal.style.display = "none"; });
    }

    const titleEl = document.getElementById("advTxnModalTitle");
    const bodyEl = document.getElementById("advTxnModalBody");
    if (!titleEl || !bodyEl) return;

    if (kind === "realized") {
      const rows = (model.monthlyRealizedDetails?.[month] || []).slice().sort((a, b) => dLocal(a.date) - dLocal(b.date));
      const total = n(model.monthlyRealized?.[month]);
      titleEl.textContent = `Monthly Realized P/L - ${month}`;
      if (!rows.length) {
        bodyEl.innerHTML = '<div class="text-muted">No realized transactions for this month.</div>';
      } else {
        bodyEl.innerHTML = `
          <div class="tiny-label mb-2">Total: <strong class="${total >= 0 ? "profit" : "loss"}">${money(total)}</strong></div>
          <div class="stack-gap adv-txn-list">
            ${rows.map(r => `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col"><strong>${escapeHtml(r.stock)}</strong> <span class="tiny-label">(${escapeHtml(r.date)})</span></div>
                  <div class="right-col ${n(r.net) >= 0 ? "profit" : "loss"}"><strong>${money(r.net)}</strong></div>
                </div>
                <div class="tiny-label mt-1">SELL ${n(r.qty)} @ ${money(r.price)} | Sell Value: ${money(r.sellValue)} | Cost Basis: ${money(r.buyCost)} | Brokerage: ${money(r.brokerage)}</div>
              </div>
            `).join("")}
          </div>
        `;
      }
    } else if (kind === "contribution") {
      const rows = (model.monthlyContributionDetails?.[month] || []).slice().sort((a, b) => dLocal(a.date) - dLocal(b.date));
      const total = n(model.monthlyContribution?.[month]);
      titleEl.textContent = `Monthly New-Money Contribution - ${month}`;
      if (!rows.length) {
        bodyEl.innerHTML = '<div class="text-muted">No contribution transactions for this month.</div>';
      } else {
        bodyEl.innerHTML = `
          <div class="tiny-label mb-2">Fresh Contribution: <strong>${money(total)}</strong></div>
          <div class="stack-gap adv-txn-list">
            ${rows.map(r => {
              if (r.type === "BUY") {
                return `
                  <div class="txn-card">
                    <div class="split-row">
                      <div class="left-col"><strong>${escapeHtml(r.stock)}</strong> <span class="tiny-label">(${escapeHtml(r.date)})</span></div>
                      <div class="right-col"><strong>${money(r.freshContribution)}</strong></div>
                    </div>
                    <div class="tiny-label mt-1">BUY ${n(r.qty)} @ ${money(r.price)} | Buy Value: ${money(r.buyValue)} | Reused Sell Cash: ${money(r.fundedByPool)} | New Cash: ${money(r.freshContribution)}</div>
                  </div>
                `;
              }
              return `
                <div class="txn-card">
                  <div class="split-row">
                    <div class="left-col"><strong>${escapeHtml(r.stock)}</strong> <span class="tiny-label">(${escapeHtml(r.date)})</span></div>
                    <div class="right-col profit"><strong>+${money(r.sellNet)}</strong></div>
                  </div>
                  <div class="tiny-label mt-1">SELL ${n(r.qty)} @ ${money(r.price)} | Added to reusable cash pool</div>
                </div>
              `;
            }).join("")}
          </div>
        `;
      }
    } else {
      titleEl.textContent = `Monthly Details - ${month}`;
      bodyEl.innerHTML = '<div class="text-muted">No detail view available.</div>';
    }
    modal.style.display = "flex";
  }

  function getLive(stock) {
    try {
      if (typeof window.getLivePriceForStock !== "function") return null;
      return window.getLivePriceForStock(stock);
    } catch (e) {
      return null;
    }
  }

  function computeActiveHoldings(model, settings) {
    const rows = [];
    const now = new Date();
    let totalInvested = 0;
    let totalCurrent = 0;
    Object.keys(model.holdings).forEach((stock) => {
      const lots = model.holdings[stock].lots || [];
      if (!lots.length) return;
      const qty = lots.reduce((a, l) => a + n(l.qty), 0);
      const invested = lots.reduce((a, l) => a + n(l.qty) * (n(l.price) + n(l.brkgPerUnit)), 0);
      const avg = qty > 0 ? invested / qty : 0;
      const first = dLocal(lots[0].date);
      const days = daysBetween(first, now);
      const live = getLive(stock);
      const ltp = n(live && live.ltp, avg);
      const current = qty * ltp;
      const unreal = current - invested;
      const unrealPct = invested > 0 ? (unreal / invested) * 100 : 0;
      totalInvested += invested;
      totalCurrent += current;
      rows.push({ stock, qty, invested, avg, days, ltp, current, unreal, unrealPct });
    });
    rows.forEach((r) => {
      r.allocPct = totalCurrent > 0 ? (r.current / totalCurrent) * 100 : 0;
      const maxAlloc = n(settings.maxAllocationPct, 25);
      r.overAlloc = r.allocPct > maxAlloc;
    });
    rows.sort((a, b) => b.current - a.current);
    return { rows, totalInvested, totalCurrent };
  }

  function renderCoreCards(core) {
    const host = document.getElementById("advCoreGrid");
    if (!host) return;
    const net = core.totalCurrent - core.totalInvested + core.totalRealized;
    const unreal = core.totalCurrent - core.totalInvested;
    host.innerHTML = [
      { k: "Total Invested", v: money(core.totalInvested), c: "" },
      { k: "Current Value", v: money(core.totalCurrent), c: "" },
      { k: "Net P/L", v: money(net), c: net >= 0 ? "profit" : "loss" },
      { k: "Realized P/L", v: money(core.totalRealized), c: core.totalRealized >= 0 ? "profit" : "loss" },
      { k: "Unrealized P/L", v: money(unreal), c: unreal >= 0 ? "profit" : "loss" },
      { k: "FD vs Inflation Gap", v: pct(core.fdInflationGap), c: core.fdInflationGap >= 0 ? "profit" : "loss" }
    ].map(x => `<div class="stat-card"><div class="stat-label">${x.k}</div><div class="stat-value ${x.c}">${x.v}</div></div>`).join("");
  }

  function renderAllocation(active, settings) {
    const donut = document.getElementById("advAllocDonut");
    const list = document.getElementById("advAllocList");
    if (!donut || !list) return;
    const rows = active.rows.slice(0, 6);
    if (!rows.length) {
      donut.innerHTML = '<div class="text-muted">No active holdings</div>';
      list.innerHTML = "";
      return;
    }
    const colors = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4", "#a855f7"];
    const gradients = rows.map((r, i) => `${colors[i]} ${rows.slice(0, i).reduce((a, x) => a + x.allocPct, 0)}% ${rows.slice(0, i + 1).reduce((a, x) => a + x.allocPct, 0)}%`);
    donut.innerHTML = `<div class="adv-donut" style="background:conic-gradient(${gradients.join(",")})"></div><div class="tiny-label mt-2">Top holdings allocation</div>`;
    const maxAlloc = n(settings.maxAllocationPct, 25);
    list.innerHTML = rows.map((r, i) => `<div class="split-row"><div class="left-col"><span class="legend-dot" style="background:${colors[i]}"></span> ${r.stock}</div><div class="right-col ${r.allocPct > maxAlloc ? "loss" : "profit"}">${pct(r.allocPct)}</div></div>`).join("");
  }

  function renderRanking(model) {
    const body = document.getElementById("advRankingBody");
    if (!body) return;
    const rows = Object.keys(model.stockAgg).map((stock) => {
      const s = model.stockAgg[stock];
      const avgHold = s.trades > 0 ? s.holdDays / s.trades : 0;
      const retPct = s.invested > 0 ? (s.net / s.invested) * 100 : 0;
      const eff = avgHold > 0 ? retPct / avgHold : 0;
      return { stock, net: s.net, wins: s.wins, losses: s.losses, eff };
    }).sort((a, b) => b.net - a.net);
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="4" class="text-center text-muted">No realized trades yet</td></tr>';
      return;
    }
    body.innerHTML = rows.map(r => `<tr><td>${r.stock}</td><td class="text-end ${r.net >= 0 ? "profit" : "loss"}">${money(r.net)}</td><td class="text-end">${r.wins}/${r.losses}</td><td class="text-end ${r.eff >= 0 ? "profit" : "loss"}">${r.eff.toFixed(3)}</td></tr>`).join("");
  }

  function renderBehavior(model, settings, active) {
    const el = document.getElementById("advBehavior");
    if (!el) return;
    const l1 = n(settings.avgLevel1Pct, 7);
    const l2 = n(settings.avgLevel2Pct, 12);
    let l1Hits = 0, l2Hits = 0, earlyAvg = 0;
    const lastBuy = {};
    model.buyEvents.forEach((b) => {
      if (!lastBuy[b.stock]) {
        lastBuy[b.stock] = b.price;
        return;
      }
      const drop = lastBuy[b.stock] > 0 ? ((lastBuy[b.stock] - b.price) / lastBuy[b.stock]) * 100 : 0;
      if (drop >= l1) l1Hits += 1; else earlyAvg += 1;
      if (drop >= l2) l2Hits += 1;
      lastBuy[b.stock] = b.price;
    });
    const cycleInfo = Object.keys(model.cycleAgg).map(k => model.cycleAgg[k]);
    const totalCycles = cycleInfo.reduce((a, c) => a + (c.cycles || []).length, 0);
    const winCycles = cycleInfo.reduce((a, c) => a + (c.cycles || []).filter(x => x >= 0).length, 0);
    const repeatLossStocks = Object.keys(model.cycleAgg).filter(k => n(model.cycleAgg[k].maxLossStreak) >= 2);

    const minHold = n(settings.minHoldDaysTrim, 20);
    const earlyExit = model.realizedTrades.filter(t => n(t.holdDays) < minHold).length;
    const tooLongHold = active.rows.filter(r => n(r.days) > minHold * 3).length;
    const overAllocCount = active.rows.filter(r => r.overAlloc).length;
    const stuckCapital = active.rows.filter(r => n(r.days) > minHold * 3 && n(r.unreal) < 0).length;

    el.innerHTML = `
      <div class="stat-card"><div class="stat-label">Averaging Discipline</div><div class="tiny-label">L1 hits: ${l1Hits} | L2 hits: ${l2Hits} | Early averages: ${earlyAvg}</div></div>
      <div class="stat-card"><div class="stat-label">Cycle Analysis</div><div class="tiny-label">Closed cycles: ${totalCycles} | Winning cycles: ${winCycles} | Repeated-loss stocks: ${repeatLossStocks.join(", ") || "-"}</div></div>
      <div class="stat-card"><div class="stat-label">Mistake Indicators</div><div class="tiny-label">Over-allocation: ${overAllocCount} | Early exits: ${earlyExit} | Capital stuck: ${stuckCapital} | Holding too long: ${tooLongHold}</div></div>
    `;
  }

  function computeExitPressure(active, settings) {
    const maxAlloc = n(settings.maxAllocationPct, 25);
    const minHold = n(settings.minHoldDaysTrim, 20);
    return active.rows.map((r) => {
      const allocStress = Math.min(40, Math.max(0, ((r.allocPct - maxAlloc) / Math.max(1, maxAlloc)) * 40));
      const lossStress = Math.min(30, Math.max(0, -n(r.unrealPct) * 0.6));
      const holdStress = Math.min(20, Math.max(0, ((n(r.days) - minHold) / Math.max(1, minHold)) * 10));
      const liveMomentum = r.avg > 0 ? ((r.ltp - r.avg) / r.avg) * 100 : 0;
      const momentumStress = Math.min(10, Math.max(0, -liveMomentum * 0.4));
      const score = Math.max(0, Math.min(100, allocStress + lossStress + holdStress + momentumStress));
      return { ...r, pressure: score };
    }).sort((a, b) => b.pressure - a.pressure);
  }

  function pickBuyCandidates(active, model) {
    const activeSet = new Set(active.rows.map(r => r.stock));
    const ranked = Object.keys(model.stockAgg).map((s) => {
      const x = model.stockAgg[s];
      const ret = x.invested > 0 ? (x.net / x.invested) * 100 : 0;
      return { stock: s, ret };
    }).sort((a, b) => b.ret - a.ret);
    const activeByAlloc = active.rows.slice().sort((a, b) => a.allocPct - b.allocPct).slice(0, 2).map(r => ({ stock: r.stock, reason: "Low allocation among active holdings" }));
    const pastWinners = ranked.filter(r => !activeSet.has(r.stock) && r.ret > 0).slice(0, 2).map(r => ({ stock: r.stock, reason: "Past winner with positive realized return" }));
    return [...activeByAlloc, ...pastWinners].slice(0, 3);
  }

  function renderExitBoard(exitRows, active, model) {
    const board = document.getElementById("advExitBoard");
    const stockSel = document.getElementById("advSellStock");
    const pctSel = document.getElementById("advSellPct");
    const qtyInput = document.getElementById("advSellQty");
    if (!board || !stockSel) return;
    if (!exitRows.length) {
      stockSel.innerHTML = "";
      board.innerHTML = '<div class="text-muted">No active holdings available for partial sell simulation.</div>';
      return;
    }
    stockSel.innerHTML = exitRows.map(r => `<option value="${r.stock}">${r.stock}</option>`).join("");

    function runSim() {
      const stock = stockSel.value;
      const row = active.rows.find(x => x.stock === stock);
      if (!row) return;
      const mode = pctSel.value;
      let sellQty = 0;
      if (mode === "custom") sellQty = Math.floor(n(qtyInput.value));
      else sellQty = Math.floor((n(mode) / 100) * n(row.qty));
      sellQty = Math.max(1, Math.min(sellQty, Math.floor(n(row.qty))));

      const sellPrice = n(row.ltp, row.avg);
      const realized = (sellPrice - n(row.avg)) * sellQty;
      const capitalFreed = sellPrice * sellQty;
      const remQty = n(row.qty) - sellQty;
      const newCurrent = Math.max(0, n(row.current) - capitalFreed);
      const totalCurrent = active.rows.reduce((a, r) => a + n(r.current), 0);
      const newAlloc = totalCurrent > 0 ? (newCurrent / totalCurrent) * 100 : 0;
      const candidates = pickBuyCandidates(active, model);

      board.innerHTML = `
        <div class="adv-grid">
          <div class="stat-card"><div class="stat-label">Exit Pressure (${stock})</div><div class="stat-value">${exitRows.find(x => x.stock === stock)?.pressure.toFixed(0) || 0}/100</div></div>
          <div class="stat-card"><div class="stat-label">Sell Qty</div><div class="stat-value">${sellQty}</div></div>
          <div class="stat-card"><div class="stat-label">Realized Impact</div><div class="stat-value ${realized >= 0 ? "profit" : "loss"}">${money(realized)}</div></div>
          <div class="stat-card"><div class="stat-label">Capital Freed</div><div class="stat-value">${money(capitalFreed)}</div></div>
          <div class="stat-card"><div class="stat-label">Remaining Qty</div><div class="stat-value">${remQty}</div></div>
          <div class="stat-card"><div class="stat-label">New Allocation</div><div class="stat-value">${pct(newAlloc)}</div></div>
        </div>
        <div class="panel mt-2">
          <div class="panel-body tight">
            <div class="section-title mt-0 mb-2">Best Trim Candidates (Now)</div>
            ${exitRows.slice(0, 3).map((r, i) => `<div class="split-row"><div class="left-col">${i + 1}. ${r.stock}</div><div class="right-col">${r.pressure.toFixed(0)}/100</div></div>`).join("")}
            <hr>
            <div class="section-title mt-0 mb-2">What To Buy With Freed Capital</div>
            ${candidates.map((c, i) => `<div class="split-row"><div class="left-col">${i + 1}. ${c.stock}</div><div class="right-col tiny-label">${c.reason}</div></div>`).join("") || '<div class="text-muted">No immediate candidate</div>'}
          </div>
        </div>
      `;
    }

    const btn = document.getElementById("advSimBtn");
    if (btn && btn.dataset.wired !== "1") {
      btn.dataset.wired = "1";
      btn.addEventListener("click", runSim);
    }
    runSim();
  }

  function renderRisk(core, active, model, settings) {
    const host = document.getElementById("advRiskGrid");
    if (!host) return;
    const peak = Math.max(core.totalInvested, core.totalCurrent);
    const drawdown = peak > 0 ? ((core.totalCurrent - peak) / peak) * 100 : 0;
    const top2 = active.rows.slice(0, 2).reduce((a, r) => a + n(r.allocPct), 0);
    const stress = Math.min(100, Math.max(0, (active.rows.filter(r => r.overAlloc).length * 15) + (top2 > 55 ? 25 : 0)));
    const win = model.realizedTrades.filter(t => n(t.net) >= 0).length;
    const loss = model.realizedTrades.filter(t => n(t.net) < 0).length;
    const wl = win + loss > 0 ? (win / (win + loss)) * 100 : 50;
    const health = Math.max(0, Math.min(100, 0.4 * (100 - stress) + 0.3 * wl + 0.3 * (drawdown >= 0 ? 100 : (100 + drawdown))));
    const totalNet = core.totalRealized + (core.totalCurrent - core.totalInvested);
    const annualReturn = core.totalInvested > 0 ? (totalNet / core.totalInvested) * 100 : 0;
    const infl = n(settings.inflationRatePct, 6);
    const fd = n(settings.fdRatePct, 6.5);
    const inflGap = annualReturn - infl;
    const fdGap = annualReturn - fd;

    host.innerHTML = `
      <div class="stat-card"><div class="stat-label">Drawdown Tracker</div><div class="stat-value ${drawdown >= 0 ? "profit" : "loss"}">${pct(drawdown)}</div></div>
      <div class="stat-card"><div class="stat-label">Portfolio Health Score</div><div class="stat-value">${health.toFixed(0)}/100</div></div>
      <div class="stat-card"><div class="stat-label">Allocation Stress</div><div class="stat-value ${stress > 60 ? "loss" : "profit"}">${stress.toFixed(0)}/100</div></div>
      <div class="stat-card"><div class="stat-label">Inflation-adjusted Gap</div><div class="stat-value ${inflGap >= 0 ? "profit" : "loss"}">${pct(inflGap)}</div></div>
      <div class="stat-card"><div class="stat-label">FD Benchmark Gap</div><div class="stat-value ${fdGap >= 0 ? "profit" : "loss"}">${pct(fdGap)}</div></div>
      <div class="stat-card"><div class="stat-label">Capital Concentration</div><div class="stat-value ${top2 > 55 ? "loss" : "profit"}">${pct(top2)} (Top 2)</div></div>
    `;
  }

  async function loadAdvancedDashboard() {
    const [txns, settings] = await Promise.all([
      readStoreAll("transactions"),
      readSettings()
    ]);

    const model = computeModel(txns, settings);
    const active = computeActiveHoldings(model, settings);
    const totalRealized = model.realizedTrades.reduce((a, t) => a + n(t.net), 0);
    const totalNet = totalRealized + (active.totalCurrent - active.totalInvested);
    const years = 1;
    const annual = active.totalInvested > 0 ? (totalNet / active.totalInvested) * (1 / years) * 100 : 0;
    const fdInflationGap = n(settings.fdRatePct, 6.5) - n(settings.inflationRatePct, 6);
    const core = {
      totalInvested: active.totalInvested,
      totalCurrent: active.totalCurrent,
      totalRealized,
      annual
    };
    core.fdInflationGap = fdInflationGap;

    renderCoreCards(core);
    const onMonthTap = (kind, month) => openMonthlyTxnModal(kind, month, model);
    renderBars(document.getElementById("advMonthlyChart"), model.monthlyRealized, "profit", "loss", { kind: "realized", onMonthTap });
    renderMonthlyContributionTrend(document.getElementById("advMonthlyContributionTrend"), model.monthlyContribution, { kind: "contribution", onMonthTap });
    renderAllocation(active, settings);
    renderRanking(model);
    renderBehavior(model, settings, active);
    const exitRows = computeExitPressure(active, settings);
    renderExitBoard(exitRows, active, model);
    renderRisk(core, active, model, settings);
  }

  window.loadAdvancedDashboard = loadAdvancedDashboard;
  if (typeof window !== "undefined") {
    window.addEventListener("live-prices-updated", () => {
      loadAdvancedDashboard().catch(() => {});
    });
  }
})();

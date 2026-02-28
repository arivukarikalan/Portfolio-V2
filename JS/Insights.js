/* =========================================================
   FILE: insights.js
   PURPOSE:
   - Portfolio Allocation Analysis
   - Average Down Indicators
   - Hold horizon classification
   ========================================================= */

function parseDateLocalInsight(dateStr) {
  const parts = String(dateStr || "").split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return new Date(dateStr);
  return new Date(y, m - 1, d);
}

function buildReasonOutcome(txns, settings) {
  const fifo = {};
  const byReason = {};

  txns
    .slice()
    .sort((a, b) => parseDateLocalInsight(a.date) - parseDateLocalInsight(b.date))
    .forEach(t => {
      const stock = String(t.stock || "");
      fifo[stock] ??= [];

      if (t.type === "BUY") {
        const buyBrkg = resolveTxnBrokerage(t, settings);
        fifo[stock].push({
          qty: Number(t.qty),
          price: Number(t.price),
          brokeragePerUnit: buyBrkg / Math.max(1, Number(t.qty)),
          date: t.date,
          reason: String(t.reason || "").trim() || "Unspecified"
        });
        return;
      }

      let sellQty = Number(t.qty || 0);
      const sellPrice = Number(t.price || 0);
      const sellBrkgTotal = resolveTxnBrokerage(t, settings);
      const sellDate = parseDateLocalInsight(t.date);

      while (sellQty > 0 && fifo[stock].length) {
        const lot = fifo[stock][0];
        const used = Math.min(lot.qty, sellQty);
        const usedRatio = Number(t.qty) > 0 ? used / Number(t.qty) : 0;

        const invested = used * (lot.price + lot.brokeragePerUnit);
        const sellValue = used * sellPrice;
        const sellBrkg = sellBrkgTotal * usedRatio;
        const net = sellValue - invested - sellBrkg;
        const daysHeld = Math.max(0, Math.floor((sellDate - parseDateLocalInsight(lot.date)) / 86400000));
        const reason = lot.reason || "Unspecified";

        byReason[reason] ??= {
          reason,
          invested: 0,
          net: 0,
          wins: 0,
          losses: 0,
          occurrences: 0,
          bucket30: 0,
          bucket60: 0,
          bucket90: 0,
          bucket90plus: 0
        };

        const r = byReason[reason];
        r.invested += invested;
        r.net += net;
        r.occurrences += 1;
        if (net >= 0) r.wins += 1;
        else r.losses += 1;

        if (daysHeld <= 30) r.bucket30 += 1;
        else if (daysHeld <= 60) r.bucket60 += 1;
        else if (daysHeld <= 90) r.bucket90 += 1;
        else r.bucket90plus += 1;

        lot.qty -= used;
        sellQty -= used;
        if (lot.qty === 0) fifo[stock].shift();
      }
    });

  return Object.values(byReason)
    .map(r => ({
      ...r,
      returnPct: r.invested > 0 ? (r.net / r.invested) * 100 : 0,
      winRate: (r.wins + r.losses) > 0 ? (r.wins / (r.wins + r.losses)) * 100 : 0
    }))
    .sort((a, b) => b.returnPct - a.returnPct);
}

function buildCapitalEfficiencyRows(activeRows, settings) {
  const maxAlloc = Math.max(1, Number(settings.maxAllocationPct || 25));
  return activeRows
    .map(r => {
      const returnScore = Math.max(0, Math.min(100, (r.returnPct + 10) * 4));
      const daysScore = Math.max(0, Math.min(100, 100 - ((r.daysHeld / 180) * 100)));
      const capitalScore = Math.max(0, Math.min(100, (r.capitalSharePct / maxAlloc) * 100));
      const score = (returnScore * 0.5) + (daysScore * 0.25) + (capitalScore * 0.25);

      let status = "Inefficient";
      let statusCls = "bad";
      if (score >= 75) {
        status = "Efficient";
        statusCls = "ok";
      } else if (score >= 55) {
        status = "Watch";
        statusCls = "warn";
      }

      let note = "Maintain discipline and track next add/trim decision.";
      if (r.returnPct < 0) {
        note = "Negative return. Avoid new averaging unless zone + allocation rules align.";
      } else if (r.daysHeld > 90 && r.returnPct < 5) {
        note = "Capital tied up with slow return. Reassess conviction and opportunity cost.";
      } else if (r.capitalSharePct > maxAlloc) {
        note = "Allocation above configured limit. Prefer trim on strength over fresh buys.";
      }

      return { ...r, score, status, statusCls, note };
    })
    .sort((a, b) => b.score - a.score);
}

function renderCapitalEfficiency(listEl, rows) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = `<div class="txn-card text-center text-muted">No active holdings for efficiency ranking</div>`;
    return;
  }

  listEl.innerHTML = rows.map((r, idx) => `
    <div class="txn-card">
      <div class="split-row">
        <div class="left-col">
          <div class="txn-name">#${idx + 1} ${r.stock}</div>
          <div class="tiny-label">Invested: \u20B9${r.invested.toFixed(2)} | Hold: ${r.daysHeld}d</div>
          <div class="tiny-label">Capital Share: ${r.capitalSharePct.toFixed(2)}%</div>
        </div>
        <div class="right-col">
          <div class="metric-strong ${r.returnPct >= 0 ? "profit" : "loss"}">${r.returnPct.toFixed(2)}%</div>
          <span class="status-pill-mini ${r.statusCls}">${r.status}</span>
        </div>
      </div>
      <div class="tiny-label mt-1">Unrealized: \u20B9${r.unrealized.toFixed(2)} | Ref Price: \u20B9${r.referencePrice.toFixed(2)}</div>
      <div class="suggestion-budget mt-1"><strong>Action:</strong> ${r.note}</div>
    </div>
  `).join("");
}

function buildHoldingEdgeRows(txns, settings) {
  const fifo = {};
  const buckets = {
    "0-7d": { label: "0-7d", trades: 0, wins: 0, losses: 0, invested: 0, net: 0, daysTotal: 0 },
    "8-15d": { label: "8-15d", trades: 0, wins: 0, losses: 0, invested: 0, net: 0, daysTotal: 0 },
    "16-30d": { label: "16-30d", trades: 0, wins: 0, losses: 0, invested: 0, net: 0, daysTotal: 0 },
    "31-60d": { label: "31-60d", trades: 0, wins: 0, losses: 0, invested: 0, net: 0, daysTotal: 0 },
    "61-90d": { label: "61-90d", trades: 0, wins: 0, losses: 0, invested: 0, net: 0, daysTotal: 0 },
    "90d+": { label: "90d+", trades: 0, wins: 0, losses: 0, invested: 0, net: 0, daysTotal: 0 }
  };

  const bucketOfDays = d => {
    if (d <= 7) return "0-7d";
    if (d <= 15) return "8-15d";
    if (d <= 30) return "16-30d";
    if (d <= 60) return "31-60d";
    if (d <= 90) return "61-90d";
    return "90d+";
  };

  txns
    .slice()
    .sort((a, b) => parseDateLocalInsight(a.date) - parseDateLocalInsight(b.date))
    .forEach(t => {
      const stock = String(t.stock || "");
      fifo[stock] ??= [];

      if (t.type === "BUY") {
        const buyBrkg = resolveTxnBrokerage(t, settings);
        fifo[stock].push({
          qty: Number(t.qty),
          price: Number(t.price),
          brokeragePerUnit: buyBrkg / Math.max(1, Number(t.qty)),
          date: t.date
        });
        return;
      }

      let sellQty = Number(t.qty || 0);
      const sellPrice = Number(t.price || 0);
      const sellBrkgTotal = resolveTxnBrokerage(t, settings);
      const sellDate = parseDateLocalInsight(t.date);

      while (sellQty > 0 && fifo[stock].length) {
        const lot = fifo[stock][0];
        const used = Math.min(lot.qty, sellQty);
        const usedRatio = Number(t.qty) > 0 ? used / Number(t.qty) : 0;
        const invested = used * (lot.price + lot.brokeragePerUnit);
        const sellValue = used * sellPrice;
        const sellBrkg = sellBrkgTotal * usedRatio;
        const net = sellValue - invested - sellBrkg;
        const daysHeld = Math.max(0, Math.floor((sellDate - parseDateLocalInsight(lot.date)) / 86400000));
        const key = bucketOfDays(daysHeld);
        const b = buckets[key];

        b.trades += 1;
        b.invested += invested;
        b.net += net;
        b.daysTotal += daysHeld;
        if (net >= 0) b.wins += 1;
        else b.losses += 1;

        lot.qty -= used;
        sellQty -= used;
        if (lot.qty === 0) fifo[stock].shift();
      }
    });

  return Object.values(buckets)
    .filter(b => b.trades > 0)
    .map(b => ({
      ...b,
      returnPct: b.invested > 0 ? (b.net / b.invested) * 100 : 0,
      winRate: (b.wins + b.losses) > 0 ? (b.wins / (b.wins + b.losses)) * 100 : 0,
      avgDays: b.trades > 0 ? b.daysTotal / b.trades : 0
    }))
    .sort((a, b) => b.returnPct - a.returnPct);
}

function renderHoldingEdge(listEl, rows) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = `<div class="txn-card text-center text-muted">No realized sells yet for holding edge analysis</div>`;
    return;
  }

  const best = rows[0];
  listEl.innerHTML = `
    <div class="section-shell mb-2">
      <div class="split-row">
        <div class="left-col">
          <div class="tiny-label">Best Holding Window</div>
          <div class="metric-strong">${best.label}</div>
        </div>
        <div class="right-col">
          <span class="status-pill-mini ok">${best.returnPct.toFixed(2)}%</span>
        </div>
      </div>
      <div class="tiny-label mt-1">Win Rate: ${best.winRate.toFixed(1)}% | Trades: ${best.trades} | Avg Hold: ${best.avgDays.toFixed(1)}d</div>
    </div>
    ${rows.map(r => `
      <div class="txn-card">
        <div class="split-row">
          <div class="left-col">
            <div class="txn-name">${r.label}</div>
            <div class="tiny-label">Trades: ${r.trades} | Win Rate: ${r.winRate.toFixed(1)}% | Avg Hold: ${r.avgDays.toFixed(1)}d</div>
          </div>
          <div class="right-col">
            <div class="metric-strong ${r.returnPct >= 0 ? "profit" : "loss"}">${r.returnPct.toFixed(2)}%</div>
            <div class="tiny-label">Net: \u20B9${r.net.toFixed(2)}</div>
          </div>
        </div>
        <div class="tiny-label mt-1">Invested: \u20B9${r.invested.toFixed(2)}</div>
      </div>
    `).join("")}
  `;
}

function renderReasonOutcome(listEl, rows) {
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = `<div class="txn-card text-center text-muted">No realised outcome data by reason yet</div>`;
    return;
  }

  listEl.innerHTML = rows.map(r => `
    <div class="txn-card">
      <div class="split-row">
        <div class="left-col">
          <div class="txn-name">${r.reason}</div>
          <div class="tiny-label">Occurrences: ${r.occurrences} | Win Rate: ${r.winRate.toFixed(1)}%</div>
        </div>
        <div class="right-col">
          <div class="metric-strong ${r.returnPct >= 0 ? "profit" : "loss"}">${r.returnPct.toFixed(2)}%</div>
          <div class="tiny-label">Net: ₹${r.net.toFixed(2)}</div>
        </div>
      </div>
      <div class="tiny-label mt-1">Invested: ₹${r.invested.toFixed(2)}</div>
      <div class="status-inline mt-2">
        <span class="status-pill-mini">0-30d: ${r.bucket30}</span>
        <span class="status-pill-mini">31-60d: ${r.bucket60}</span>
        <span class="status-pill-mini">61-90d: ${r.bucket90}</span>
        <span class="status-pill-mini">90d+: ${r.bucket90plus}</span>
      </div>
    </div>
  `).join("");
}

function toggleInsightsSection(panelId, btnEl) {
  const panel = document.getElementById(panelId);
  if (!panel || !btnEl) return;
  const hidden = panel.style.display === "none";
  panel.style.display = hidden ? "block" : "none";
  const icon = btnEl.querySelector("i");
  if (icon) {
    icon.classList.remove("bi-chevron-up", "bi-chevron-down");
    icon.classList.add(hidden ? "bi-chevron-up" : "bi-chevron-down");
  }
}

function loadInsights() {
  const allocationList = document.getElementById("allocationList");
  const avgDownList = document.getElementById("avgDownList");
  const advancedList = document.getElementById("advancedInsightsList");
  const reasonOutcomeList = document.getElementById("reasonOutcomeList");
  const capitalEfficiencyList = document.getElementById("capitalEfficiencyList");
  const holdingEdgeList = document.getElementById("holdingEdgeList");
  if (!allocationList || !avgDownList) return;

  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = e.target.result.sort(
          (a, b) => parseDateLocalInsight(a.date) - parseDateLocalInsight(b.date)
        );

        const state = {};
        const quality = {
          byStock: {},
          byMonth: {}
        };
        const fifoForQuality = {};
        const portfolioLots = {};

        function ensureQualityStock(stock) {
          quality.byStock[stock] ??= {
            buys: 0,
            sells: 0,
            chaseBuys: 0,
            weakDropBuys: 0,
            overAllocBuys: 0,
            panicSells: 0,
            details: []
          };
          return quality.byStock[stock];
        }

        function ensureQualityMonth(monthKey) {
          quality.byMonth[monthKey] ??= {
            buys: 0,
            sells: 0,
            chaseBuys: 0,
            weakDropBuys: 0,
            overAllocBuys: 0,
            panicSells: 0
          };
          return quality.byMonth[monthKey];
        }

        function monthFromDate(d) {
          const [y, m] = String(d || "").split("-");
          if (!y || !m) return "Unknown";
          return `${y}-${m}`;
        }

        // Build active cycle state per stock using FIFO.
        txns.forEach(t => {
          const monthKey = monthFromDate(t.date);
          const qStock = ensureQualityStock(t.stock);
          const qMonth = ensureQualityMonth(monthKey);
          fifoForQuality[t.stock] ??= [];
          portfolioLots[t.stock] ??= [];

          state[t.stock] ??= {
            lots: [],
            cycleFirstBuyPrice: null,
            cycleFirstBuyDate: null,
            cycleLastBuyDate: null,
            cycleLastBuyPrice: null,
            cycleLastTxnDate: null,
            cycleLastTxnPrice: null,
            cycleBuys: []
          };

          const s = state[t.stock];
          s.cycleLastTxnDate = t.date;
          s.cycleLastTxnPrice = Number(t.price);

          if (t.type === "BUY") {
            qStock.buys += 1;
            qMonth.buys += 1;

            // Reset cycle markers after full exit.
            if (s.lots.length === 0) {
              s.cycleFirstBuyPrice = t.price;
              s.cycleFirstBuyDate = t.date;
              s.cycleLastBuyPrice = t.price;
              s.cycleBuys = [];
            }

            s.cycleLastBuyDate = t.date;
            s.cycleLastBuyPrice = t.price;
            s.cycleBuys.push({
              date: t.date,
              price: Number(t.price),
              qty: Number(t.qty)
            });

            const prevBuy = s.cycleBuys.length > 1 ? s.cycleBuys[s.cycleBuys.length - 2] : null;
            if (prevBuy) {
              const prevPrice = Number(prevBuy.price || 0);
              const currPrice = Number(t.price || 0);
              if (currPrice > prevPrice) {
                qStock.chaseBuys += 1;
                qMonth.chaseBuys += 1;
                qStock.details.push({
                  date: t.date,
                  type: "BUY",
                  reason: "Chase Buy",
                  info: `Bought at ₹${currPrice.toFixed(2)} above previous buy ₹${prevPrice.toFixed(2)}.`
                });
              } else {
                const dropPct = prevPrice > 0 ? ((prevPrice - currPrice) / prevPrice) * 100 : 0;
                if (dropPct < Number(settings.avgLevel1Pct || 0)) {
                  qStock.weakDropBuys += 1;
                  qMonth.weakDropBuys += 1;
                  qStock.details.push({
                    date: t.date,
                    type: "BUY",
                    reason: "Weak Drop Buy",
                    info: `Drop ${dropPct.toFixed(2)}% from previous buy is below L1 rule ${Number(settings.avgLevel1Pct || 0).toFixed(2)}%.`
                  });
                }
              }
            }

            const buyBrkg = resolveTxnBrokerage(t, settings);
            const portfolioLot = {
              qty: Number(t.qty),
              price: Number(t.price),
              brokeragePerUnit: buyBrkg / Number(t.qty),
              date: t.date
            };
            portfolioLots[t.stock].push({ ...portfolioLot });

            const totalAfterBuy = Object.keys(portfolioLots).reduce((sum, st) => {
              return sum + portfolioLots[st].reduce((a, l) => a + l.qty * (l.price + l.brokeragePerUnit), 0);
            }, 0);
            const stockAfterBuy = portfolioLots[t.stock].reduce(
              (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
              0
            );
            const allocAfterBuyPct = totalAfterBuy > 0 ? (stockAfterBuy / totalAfterBuy) * 100 : 0;
            if (allocAfterBuyPct > Number(settings.maxAllocationPct || 0)) {
              qStock.overAllocBuys += 1;
              qMonth.overAllocBuys += 1;
              qStock.details.push({
                date: t.date,
                type: "BUY",
                reason: "Over Allocation Buy",
                info: `Post-buy allocation ${allocAfterBuyPct.toFixed(2)}% exceeded max ${Number(settings.maxAllocationPct || 0).toFixed(2)}%.`
              });
            }

            fifoForQuality[t.stock].push({
              qty: Number(t.qty),
              price: Number(t.price),
              brokeragePerUnit: buyBrkg / Number(t.qty),
              date: t.date
            });
            s.lots.push({
              qty: t.qty,
              price: t.price,
              brokeragePerUnit: buyBrkg / t.qty,
              date: t.date
            });
            return;
          }

          qStock.sells += 1;
          qMonth.sells += 1;

          let qSell = Number(t.qty);
          let qBuyCost = 0;
          let qBuyBrkg = 0;
          let consumedQty = 0;
          let weightedHoldDays = 0;
          while (qSell > 0 && fifoForQuality[t.stock].length) {
            const lot = fifoForQuality[t.stock][0];
            const used = Math.min(lot.qty, qSell);
            qBuyCost += used * lot.price;
            qBuyBrkg += used * lot.brokeragePerUnit;
            consumedQty += used;
            const holdDays = Math.max(0, Math.floor((parseDateLocalInsight(t.date) - parseDateLocalInsight(lot.date)) / 86400000));
            weightedHoldDays += used * holdDays;
            lot.qty -= used;
            qSell -= used;
            if (lot.qty === 0) fifoForQuality[t.stock].shift();
          }
          let pSell = Number(t.qty);
          while (pSell > 0 && portfolioLots[t.stock].length) {
            const lot = portfolioLots[t.stock][0];
            const used = Math.min(lot.qty, pSell);
            lot.qty -= used;
            pSell -= used;
            if (lot.qty === 0) portfolioLots[t.stock].shift();
          }

          const sellValue = Number(t.qty) * Number(t.price);
          const sellBrkg = resolveTxnBrokerage(t, settings);
          const sellNet = sellValue - qBuyCost - qBuyBrkg - sellBrkg;
          const avgHoldDays = consumedQty > 0 ? weightedHoldDays / consumedQty : 0;
          if (sellNet < 0 && avgHoldDays <= 15) {
            qStock.panicSells += 1;
            qMonth.panicSells += 1;
            qStock.details.push({
              date: t.date,
              type: "SELL",
              reason: "Panic Sell",
              info: `Loss sell ₹${sellNet.toFixed(2)} within ${avgHoldDays.toFixed(0)} hold days.`
            });
          }

          let sellQty = t.qty;
          while (sellQty > 0 && s.lots.length) {
            const lot = s.lots[0];
            const used = Math.min(lot.qty, sellQty);
            lot.qty -= used;
            sellQty -= used;
            if (lot.qty === 0) s.lots.shift();
          }
        });

        allocationList.innerHTML = "";
        avgDownList.innerHTML = "";
        if (advancedList) advancedList.innerHTML = "";
        if (reasonOutcomeList) reasonOutcomeList.innerHTML = "";
        if (capitalEfficiencyList) capitalEfficiencyList.innerHTML = "";
        if (holdingEdgeList) holdingEdgeList.innerHTML = "";

        const totalActiveInvested = Object.values(state)
          .reduce((sum, s) => sum + s.lots.reduce(
            (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
            0
          ), 0);
        const capitalRows = [];

        Object.keys(state).forEach(stock => {
          const s = state[stock];
          if (!s.lots.length) return;

          const invested = s.lots.reduce(
            (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
            0
          );
          const allocationPct =
            totalActiveInvested > 0
              ? (invested / totalActiveInvested) * 100
              : 0;

          const activeBuyCount = (s.cycleBuys || []).length;

          let status = "Balanced";
          let statusClass = "text-success";
          if (allocationPct > settings.maxAllocationPct) {
            status = "Warning";
            statusClass = "text-danger";
          } else if (allocationPct > 15) {
            status = "Moderate";
            statusClass = "text-warning";
          }

          const daysHeld = Math.floor(
            (new Date() - parseDateLocalInsight(s.cycleFirstBuyDate)) / 86400000
          );
          const qty = s.lots.reduce((a, l) => a + l.qty, 0);
          const referencePrice = Number(s.cycleLastTxnPrice || s.cycleLastBuyPrice || 0);
          const currentValue = qty * referencePrice;
          const unrealized = currentValue - invested;
          const returnPct = invested > 0 ? (unrealized / invested) * 100 : 0;
          const capitalSharePct = totalActiveInvested > 0 ? (invested / totalActiveInvested) * 100 : 0;
          capitalRows.push({
            stock,
            invested,
            qty,
            daysHeld,
            referencePrice,
            unrealized,
            returnPct,
            capitalSharePct
          });

          let horizonLabel = "Just now";
          let horizonClass = "horizon-now";
          if (daysHeld > 90) {
            horizonLabel = "Long term hold";
            horizonClass = "horizon-long";
          } else if (daysHeld >= 30) {
            horizonLabel = "Short term hold";
            horizonClass = "horizon-short";
          }

          allocationList.innerHTML += `
            <div class="txn-card">
              <div class="txn-name">${stock}</div>
              <div class="split-row mt-1">
                <div class="left-col">
                  <span class="hold-horizon ${horizonClass}">${horizonLabel}</span>
                  <div class="tiny-label">First Buy: ${s.cycleFirstBuyDate}</div>
                  <div class="tiny-label">Last Buy: ${s.cycleLastBuyDate}</div>
                </div>
                <div class="right-col">
                  <div class="metric-strong">\u20B9${invested.toFixed(2)}</div>
                  <div class="tiny-label">Invested</div>
                  <div class="tiny-label">Buys: ${activeBuyCount}</div>
                </div>
              </div>
              <div class="split-row mt-1">
                <div class="left-col">
                  <div class="tiny-label">Allocation: ${allocationPct.toFixed(2)}%</div>
                </div>
                <div class="right-col">
                  <span class="${statusClass}">(${status})</span>
                </div>
              </div>
            </div>
          `;

          const base = s.cycleFirstBuyPrice;
          const level1 = base * (1 - settings.avgLevel1Pct / 100);
          const level2 = base * (1 - settings.avgLevel2Pct / 100);
          const level1BuyTxn = (s.cycleBuys || [])[1] || null; // second buy in current active cycle
          const level2BuyTxn = (s.cycleBuys || [])[2] || null; // third buy in current active cycle
          const level1Done = level1BuyTxn != null;
          const level2Done = level2BuyTxn != null;
          const level1Buy = level1BuyTxn ? Number(level1BuyTxn.price) : null;
          const level2Buy = level2BuyTxn ? Number(level2BuyTxn.price) : null;
          const maxStockBudget =
            (Number(settings.portfolioSize || 0) * Number(settings.maxAllocationPct || 0)) / 100;
          const remainingBudget = Math.max(0, maxStockBudget - invested);
          const pendingLevels = [
            !level1Done ? { label: "L1", price: level1 } : null,
            !level2Done ? { label: "L2", price: level2 } : null
          ].filter(Boolean);
          const perLevelBudget =
            pendingLevels.length > 0 ? (remainingBudget / pendingLevels.length) : 0;
          const suggestedL1Qty = !level1Done ? Math.max(0, Math.floor(perLevelBudget / level1)) : 0;
          const suggestedL2Qty = !level2Done ? Math.max(0, Math.floor(perLevelBudget / level2)) : 0;
          const projectedAvgL1 = (!level1Done && suggestedL1Qty > 0)
            ? ((invested + (suggestedL1Qty * level1)) / (s.lots.reduce((a, l) => a + l.qty, 0) + suggestedL1Qty))
            : null;
          const projectedAvgL2 = (!level2Done && suggestedL2Qty > 0)
            ? ((invested + (suggestedL2Qty * level2)) / (s.lots.reduce((a, l) => a + l.qty, 0) + suggestedL2Qty))
            : null;

          let avgStatus = "";
          if (level1Done && level2Done) {
            avgStatus = `<span class="text-danger">Averaging Stage Completed</span>`;
          } else if (level1Done) {
            avgStatus = `<span class="text-warning">Level-1 Averaging Completed</span>`;
          }

          avgDownList.innerHTML += `
            <div class="txn-card">
              <div class="txn-name">${stock}</div>
              <div class="split-row mt-1">
                <div class="left-col">
                  <span class="hold-horizon ${horizonClass}">${horizonLabel}</span>
                </div>
                <div class="right-col">
                  <div class="tiny-label">L1 Target (${settings.avgLevel1Pct}%): \u20B9${level1.toFixed(2)}</div>
                  <div class="tiny-label">L2 Target (${settings.avgLevel2Pct}%): \u20B9${level2.toFixed(2)}</div>
                </div>
              </div>
              <div class="txn-sub mt-1">
                ${!level1Done ? `<div class="suggestion-row"><span>Next L1 Qty: ${suggestedL1Qty} @ \u20B9${level1.toFixed(2)}</span><span>${projectedAvgL1 ? `New Avg: \u20B9${projectedAvgL1.toFixed(2)}` : `New Avg: -`}</span></div>` : ``}
                ${!level2Done ? `<div class="suggestion-row"><span>Next L2 Qty: ${suggestedL2Qty} @ \u20B9${level2.toFixed(2)}</span><span>${projectedAvgL2 ? `New Avg: \u20B9${projectedAvgL2.toFixed(2)}` : `New Avg: -`}</span></div>` : ``}
                ${pendingLevels.length > 0 ? `<div class="suggestion-budget">Stock Budget: \u20B9${maxStockBudget.toFixed(2)} | Remaining: \u20B9${remainingBudget.toFixed(2)}</div>` : ``}
                ${pendingLevels.length > 0 && suggestedL1Qty <= 0 && suggestedL2Qty <= 0 ? `<span class="text-warning">At/near max allocation limit (${Number(settings.maxAllocationPct || 0).toFixed(2)}%)</span><br>` : ``}
                ${avgStatus}
              </div>
            </div>
          `;

          if (advancedList) {
            const buys = s.cycleBuys || [];
            const activeQty = s.lots.reduce((a, l) => a + l.qty, 0);
            const l1HitIndex = buys.findIndex(b => Number(b.price) <= level1);
            const l2HitIndex = buys.findIndex(b => Number(b.price) <= level2);

            const suggestion = !level1Done
              ? `Wait for L1 zone near ₹${level1.toFixed(2)}. Avoid chasing above last buy price unless conviction is strong.`
              : !level2Done
                ? `L1 is done. Next disciplined buy zone is L2 near ₹${level2.toFixed(2)}.`
                : `L1 and L2 completed. Pause averaging and focus on risk control/allocation discipline.`;

            const allocationRisk = allocationPct > settings.maxAllocationPct
              ? `<span class="risk-pill bad">Over Allocation</span>`
              : allocationPct > settings.maxAllocationPct * 0.85
                ? `<span class="risk-pill warn">Near Allocation Limit</span>`
                : `<span class="risk-pill ok">Allocation Healthy</span>`;

            advancedList.innerHTML += `
              <div class="txn-card advanced-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${stock}</div>
                    <div class="tiny-label">Active Qty: ${activeQty} | Total Buys: ${buys.length} | Invested: ₹${invested.toFixed(2)}</div>
                  </div>
                  <div class="right-col">
                    ${allocationRisk}
                  </div>
                </div>
                <div class="advanced-layer-row">
                  <span class="status-pill-mini ${level1Done ? "ok" : "bad"}">L1 ${level1Done ? `hit on Buy #${l1HitIndex + 1}` : "not hit"}</span>
                  <span class="status-pill-mini ${level2Done ? "ok" : "bad"}">L2 ${level2Done ? `hit on Buy #${l2HitIndex + 1}` : "not hit"}</span>
                </div>
                <div class="advanced-timeline">
                  ${buys.map((b, idx) => {
                    const prev = idx > 0 ? buys[idx - 1] : null;
                    const diff = prev ? (Number(b.price) - Number(prev.price)) : 0;
                    const diffPct = prev && Number(prev.price) > 0 ? (diff / Number(prev.price)) * 100 : 0;
                    const expectedPrice = prev
                      ? Number(prev.price) * (1 - Number(settings.avgLevel1Pct || 0) / 100)
                      : null;
                    const extraPerShare = expectedPrice != null ? Number(b.price) - expectedPrice : 0;
                    const extraTotal = extraPerShare > 0 ? extraPerShare * Number(b.qty || 0) : 0;
                    let tag = "Base buy";
                    let tagClass = "status-pill-mini";
                    if (idx > 0) {
                      const dropPct = prev && Number(prev.price) > 0
                        ? ((Number(prev.price) - Number(b.price)) / Number(prev.price)) * 100
                        : 0;
                      if (Number(b.price) <= Number(prev.price)) {
                        if (dropPct >= Number(settings.avgLevel1Pct || 0)) {
                          tag = "Good follow-up";
                          tagClass = "status-pill-mini ok";
                        } else {
                          tag = "Bad buy (weak drop)";
                          tagClass = "status-pill-mini bad";
                        }
                      } else if (diffPct <= 2) {
                        tag = "Slight chase";
                        tagClass = "status-pill-mini warn";
                      } else {
                        tag = "High chase";
                        tagClass = "status-pill-mini bad";
                      }
                    }
                    const layerTag = Number(b.price) <= level2
                      ? "L2 zone"
                      : Number(b.price) <= level1
                        ? "L1 zone"
                        : "Above zones";

                    return `
                      <div class="advanced-buy-row">
                        <div class="left-col">
                          <div class="tiny-label">Buy #${idx + 1} | ${b.date} | Qty ${Number(b.qty)} @ ₹${Number(b.price).toFixed(2)}</div>
                        </div>
                        <div class="right-col">
                          <div class="tiny-label">${idx === 0 ? "Start" : `Δ ₹${diff.toFixed(2)} (${diffPct.toFixed(2)}%)`}</div>
                          ${idx > 0
                            ? `<div class="tiny-label ${extraPerShare > 0 ? "loss" : "profit"}">${extraPerShare > 0
                                ? `+₹${extraPerShare.toFixed(2)} above expected`
                                : `₹${Math.abs(extraPerShare).toFixed(2)} below expected`}</div>`
                            : ``}
                        </div>
                        <div class="advanced-badges">
                          <span class="${tagClass}">${tag}</span>
                          <span class="status-pill-mini">${layerTag}</span>
                          ${idx > 0 && extraTotal > 0
                            ? `<span class="status-pill-mini bad">Extra Paid: ₹${extraTotal.toFixed(2)}</span>`
                            : ``}
                        </div>
                      </div>
                    `;
                  }).join("")}
                </div>
                <div class="suggestion-budget mt-2"><strong>Next Decision:</strong> ${suggestion}</div>
              </div>
            `;
          }
        });

        if (!allocationList.innerHTML) {
          allocationList.innerHTML = `
            <div class="txn-card text-center text-muted">
              No active holdings
            </div>`;
        }

        if (!avgDownList.innerHTML) {
          avgDownList.innerHTML = `
            <div class="txn-card text-center text-muted">
              No average-down data
            </div>`;
        }

        if (advancedList && !advancedList.innerHTML) {
          advancedList.innerHTML = `
            <div class="txn-card text-center text-muted">
              No active-cycle data for advanced analysis
            </div>`;
        }

        if (capitalEfficiencyList) {
          const rankedEfficiency = buildCapitalEfficiencyRows(capitalRows, settings);
          renderCapitalEfficiency(capitalEfficiencyList, rankedEfficiency);
        }

        if (reasonOutcomeList) {
          const reasonRows = buildReasonOutcome(txns, settings);
          renderReasonOutcome(reasonOutcomeList, reasonRows);
        }

        if (holdingEdgeList) {
          const edgeRows = buildHoldingEdgeRows(txns, settings);
          renderHoldingEdge(holdingEdgeList, edgeRows);
        }

        // set lastInsightsData for analyzer to use
        window.lastInsightsData = { state, capitalRows, settings };
        populateExitStockOptions(capitalRows);
        initExitAnalyzerControls();
      };
  });
}

// --- Smart Partial Exit & Re-Entry Analyzer helpers ---
// Uses lastInsightsData set by loadInsights()
function simulatePartialExit(stock, sellQty, sellPrice, lastInsights) {
  if (!lastInsights || !lastInsights.state || !lastInsights.settings) return { error: "Insights data not available" };
  const s = lastInsights.state[stock];
  if (!s) return { error: "Stock not found in active holdings" };

  const settings = lastInsights.settings;
  // Compute total held & invested from current lots (copy to avoid mutation)
  const lots = (s.lots || []).map(l => ({ qty: Number(l.qty), price: Number(l.price), brokeragePerUnit: Number(l.brokeragePerUnit || 0) }));
  const totalQty = lots.reduce((a, l) => a + l.qty, 0);
  const invested = lots.reduce((a, l) => a + l.qty * (l.price + l.brokeragePerUnit), 0);

  if (sellQty <= 0 || sellQty > totalQty) return { error: "Invalid sell quantity" };

  // SELL uses most-recent buys (simulate selling last buy(s)) => use lots from the end (LIFO of active lots)
  let remainingToSell = sellQty;
  let buyValueOfSold = 0;
  const lotsCopy = lots.slice(); // left-to-right oldest->newest
  for (let i = lotsCopy.length - 1; i >= 0 && remainingToSell > 0; i--) {
    const lot = lotsCopy[i];
    const used = Math.min(lot.qty, remainingToSell);
    buyValueOfSold += used * (lot.price + (lot.brokeragePerUnit || 0));
    remainingToSell -= used;
  }

  // Sell brokerage estimation
  const sellBrkg = resolveTxnBrokerage({ type: "SELL", qty: sellQty, price: sellPrice }, settings);

  const sellValueGross = sellQty * sellPrice;
  const netProfit = sellValueGross - buyValueOfSold - sellBrkg;
  const profitPct = buyValueOfSold > 0 ? (netProfit / buyValueOfSold) * 100 : 0;

  // Remaining position after sell
  const remainingQty = totalQty - sellQty;
  const remainingInvested = invested - buyValueOfSold;
  const newAvgAfterSell = remainingQty > 0 ? (remainingInvested / remainingQty) : 0;
  const oldAvg = totalQty > 0 ? (invested / totalQty) : 0;
  const avgImprovement = oldAvg - newAvgAfterSell;

  return {
    stock,
    sellQty,
    sellPrice,
    sellValueGross,
    sellBrkg,
    buyValueOfSold,
    netProfit,
    profitPct,
    totalQty,
    remainingQty,
    invested,
    remainingInvested,
    oldAvg,
    newAvgAfterSell,
    avgImprovement,
    settings,
    s // provide state for further suggestions
  };
}

function suggestReentry(simulation) {
  const { s, settings, sellPrice } = simulation;
  const base = Number(s.cycleFirstBuyPrice || s.cycleBuys?.[0]?.price || simulation.oldAvg || 0);
  const lvl1 = base * (1 - Number(settings.avgLevel1Pct || 0) / 100);
  const lvl2 = base * (1 - Number(settings.avgLevel2Pct || 0) / 100);

  // Scenario A: price moves up -> WAIT. Nearest safe re-entry = L1 (or L2 when deeper pullback).
  const upSuggestion = {
    action: "WAIT",
    reason: "Price has moved up after partial exit",
    nearestSafeLevel: Number(lvl1.toFixed(2)),
    confirmationCondition: `Look for pullback into L1 (~₹${lvl1.toFixed(2)}) or L2 (~₹${lvl2.toFixed(2)}). Avoid chasing above L1.`,
    warnIfAboveZone: `If price stays above L1 without pullback, avoid chasing new buys.`
  };

  // Scenario B: price moves down -> recommend re-buy level.
  // Choose suggested re-buy price between L1 and L2 or a discount from last sell.
  const discountPct = 5; // default 5% discount heuristic
  const discountedPrice = Number((sellPrice * (1 - discountPct / 100)).toFixed(2));
  // Prefer using L1/L2 zones: suggest max(L2, min(L1, discountedPrice))
  const suggestedPrice = Math.max(lvl2, Math.min(lvl1, discountedPrice));
  const suggestedQty = simulation.sellQty; // default to re-buy same qty
  const newTotalQty = simulation.remainingQty + suggestedQty;
  const newTotalInvested = simulation.remainingInvested + (suggestedQty * suggestedPrice);
  const newAvg = newTotalQty > 0 ? (newTotalInvested / newTotalQty) : 0;
  const avgImprovementOnRebuy = simulation.oldAvg - newAvg;

  const downSuggestion = {
    action: "RE-BUY",
    reason: "Price drops after sell offer a chance to re-enter at better price",
    suggestedPrice: Number(suggestedPrice.toFixed(2)),
    suggestedQty,
    newAvg: Number(newAvg.toFixed(2)),
    avgImprovementOnRebuy: Number(avgImprovementOnRebuy.toFixed(2)),
    details: `Based on L1: ₹${lvl1.toFixed(2)}, L2: ₹${lvl2.toFixed(2)} and ${discountPct}% discount heuristic.`
  };

  return { upSuggestion, downSuggestion, lvl1: Number(lvl1.toFixed(2)), lvl2: Number(lvl2.toFixed(2)) };
}

function renderExitAnalysis(containerEl, simResult, suggestions) {
  if (!containerEl) return;
  if (simResult.error) {
    containerEl.innerHTML = `<div class="txn-card text-danger">${simResult.error}</div>`;
    return;
  }

  const profitCls = simResult.netProfit >= 0 ? "profit" : "loss";
  containerEl.innerHTML = `
    <div class="txn-card">
      <div class="split-row">
        <div class="left-col">
          <div class="txn-name">${simResult.stock}</div>
          <div class="tiny-label">Sold ${simResult.sellQty} | Price ₹${simResult.sellPrice.toFixed(2)}</div>
        </div>
        <div class="right-col">
          <div class="metric-strong ${profitCls}">₹${simResult.netProfit.toFixed(2)}</div>
          <div class="tiny-label">${simResult.profitPct.toFixed(2)}% profit on sold lot</div>
        </div>
      </div>

      <div class="mt-2 tiny-label"><strong>Impact on Holdings</strong></div>
      <div class="txn-sub">
        Remaining Qty: ${simResult.remainingQty} | Old Avg: ₹${simResult.oldAvg.toFixed(2)} | New Avg: ₹${simResult.newAvgAfterSell ? simResult.newAvgAfterSell.toFixed(2) : "-"} | Avg Improvement: ₹${simResult.avgImprovement.toFixed(2)}
      </div>

      <div class="mt-2 tiny-label"><strong>Post-Sell Strategy</strong></div>

      <div class="section-shell mt-1">
        <div class="tiny-label"><strong>If price moves UP:</strong></div>
        <div class="tiny-label">${suggestions.upSuggestion.reason}</div>
        <div class="tiny-label">Nearest safe re-entry: ₹${suggestions.upSuggestion.nearestSafeLevel}</div>
        <div class="tiny-label text-muted">${suggestions.upSuggestion.confirmationCondition}</div>
      </div>

      <div class="section-shell mt-2">
        <div class="tiny-label"><strong>If price moves DOWN:</strong></div>
        <div class="tiny-label">${suggestions.downSuggestion.reason}</div>
        <div class="tiny-label">Suggested re-buy: ₹${suggestions.downSuggestion.suggestedPrice} | Qty: ${suggestions.downSuggestion.suggestedQty}</div>
        <div class="tiny-label">Projected new avg: ₹${suggestions.downSuggestion.newAvg} (avg improve ₹${suggestions.downSuggestion.avgImprovementOnRebuy})</div>
        <div class="tiny-label text-muted">${suggestions.downSuggestion.details}</div>
      </div>

      <div class="suggestion-budget mt-2">
        <strong>Consolidated Action:</strong>
        ${suggestions.downSuggestion.avgImprovementOnRebuy > 0 ? `Re-buy at ₹${suggestions.downSuggestion.suggestedPrice} to improve avg` : `Wait for pullback into L1 (${suggestions.lvl1}) or L2 (${suggestions.lvl2})`}
      </div>
    </div>
  `;
}

// Wire UI controls for analyzer
function initExitAnalyzerControls() {
  const stockInput = document.getElementById("exitStockInput");
  const qtyInput = document.getElementById("exitSellQty");
  const priceInput = document.getElementById("exitSellPrice");
  const simulateBtn = document.getElementById("exitSimulateBtn");
  const resetBtn = document.getElementById("exitResetBtn");
  const resultEl = document.getElementById("exitAnalyzerResult");

  simulateBtn?.addEventListener("click", () => {
    const stock = (stockInput?.value || "").trim();
    const sellQty = Number(qtyInput?.value || 0);
    const sellPrice = Number(priceInput?.value || 0);
    if (!stock) {
      if (resultEl) resultEl.innerHTML = `<div class="txn-card text-danger">Select a stock</div>`;
      return;
    }
    if (sellQty <= 0 || sellPrice <= 0) {
      if (resultEl) resultEl.innerHTML = `<div class="txn-card text-danger">Enter valid sell qty and price</div>`;
      return;
    }

    const sim = simulatePartialExit(stock, sellQty, sellPrice, window.lastInsightsData);
    if (sim.error) {
      if (resultEl) resultEl.innerHTML = `<div class="txn-card text-danger">${sim.error}</div>`;
      return;
    }
    const suggestions = suggestReentry({ ...sim, sellPrice });
    renderExitAnalysis(resultEl, sim, suggestions);
  });

  resetBtn?.addEventListener("click", () => {
    if (stockInput) stockInput.value = "";
    if (qtyInput) qtyInput.value = "";
    if (priceInput) priceInput.value = "";
    if (resultEl) resultEl.innerHTML = "";
  });
}

// Populate analyzer stock options based on active holdings
function populateExitStockOptions(capitalRows) {
  const dl = document.getElementById("exitStockOptions");
  if (!dl) return;
  dl.innerHTML = (capitalRows || []).map(r => `<option value="${r.stock}"></option>`).join("");
}


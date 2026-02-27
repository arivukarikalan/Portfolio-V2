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

function loadInsights() {
  const allocationList = document.getElementById("allocationList");
  const avgDownList = document.getElementById("avgDownList");
  if (!allocationList || !avgDownList) return;

  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = e.target.result.sort(
          (a, b) => parseDateLocalInsight(a.date) - parseDateLocalInsight(b.date)
        );

        const state = {};

        // Build active cycle state per stock using FIFO.
        txns.forEach(t => {
          state[t.stock] ??= {
            lots: [],
            cycleFirstBuyPrice: null,
            cycleFirstBuyDate: null,
            cycleLastBuyDate: null,
            cycleLastBuyPrice: null,
            cycleBuyPrices: []
          };

          const s = state[t.stock];

          if (t.type === "BUY") {
            // Reset cycle markers after full exit.
            if (s.lots.length === 0) {
              s.cycleFirstBuyPrice = t.price;
              s.cycleFirstBuyDate = t.date;
              s.cycleLastBuyPrice = t.price;
              s.cycleBuyPrices = [];
            }

            s.cycleLastBuyDate = t.date;
            s.cycleLastBuyPrice = t.price;
            s.cycleBuyPrices.push(t.price);
            const buyBrkg = resolveTxnBrokerage(t, settings);
            s.lots.push({
              qty: t.qty,
              price: t.price,
              brokeragePerUnit: buyBrkg / t.qty,
              date: t.date
            });
            return;
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

        const totalActiveInvested = Object.values(state)
          .reduce((sum, s) => sum + s.lots.reduce(
            (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
            0
          ), 0);

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

          const activeBuyCount = s.lots.length;

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
          const level1Buy = s.cycleBuyPrices.find(p => p <= level1);
          const level2Buy = s.cycleBuyPrices.find(p => p <= level2);
          const level1Done = level1Buy != null;
          const level2Done = level2Buy != null;
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
                  <div class="tiny-label">First Buy: \u20B9${base.toFixed(2)}</div>
                  <div class="tiny-label">Last Buy Price: \u20B9${Number(s.cycleLastBuyPrice).toFixed(2)}</div>
                  <div class="tiny-label">Last Buy Date: ${s.cycleLastBuyDate}</div>
                </div>
                <div class="right-col">
                  <div class="tiny-label">L1 Target (${settings.avgLevel1Pct}%): \u20B9${level1.toFixed(2)}</div>
                  <div class="tiny-label">L2 Target (${settings.avgLevel2Pct}%): \u20B9${level2.toFixed(2)}</div>
                </div>
              </div>
              <div class="txn-sub mt-1">
                ${level1Done ? `L1 Buy: \u20B9${level1Buy.toFixed(2)} (Diff: \u20B9${(level1Buy - level1).toFixed(2)}) <span class="good-buy-badge">Good Buy</span><br>` : `L1 Buy: -<br>`}
                ${level2Done ? `L2 Buy: \u20B9${level2Buy.toFixed(2)} (Diff: \u20B9${(level2Buy - level2).toFixed(2)}) <span class="good-buy-badge">Good Buy</span><br>` : `L2 Buy: -<br>`}
                ${!level1Done ? `<div class="suggestion-row"><span>Next L1 Qty: ${suggestedL1Qty} @ \u20B9${level1.toFixed(2)}</span><span>${projectedAvgL1 ? `New Avg: \u20B9${projectedAvgL1.toFixed(2)}` : `New Avg: -`}</span></div>` : ``}
                ${!level2Done ? `<div class="suggestion-row"><span>Next L2 Qty: ${suggestedL2Qty} @ \u20B9${level2.toFixed(2)}</span><span>${projectedAvgL2 ? `New Avg: \u20B9${projectedAvgL2.toFixed(2)}` : `New Avg: -`}</span></div>` : ``}
                ${pendingLevels.length > 0 ? `<div class="suggestion-budget">Stock Budget: \u20B9${maxStockBudget.toFixed(2)} | Remaining: \u20B9${remainingBudget.toFixed(2)}</div>` : ``}
                ${pendingLevels.length > 0 && suggestedL1Qty <= 0 && suggestedL2Qty <= 0 ? `<span class="text-warning">At/near max allocation limit (${Number(settings.maxAllocationPct || 0).toFixed(2)}%)</span><br>` : ``}
                ${avgStatus}
              </div>
            </div>
          `;
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
      };
  });
}


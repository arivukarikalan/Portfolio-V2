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

function toggleAdvancedInsights() {
  const panel = document.getElementById("advancedInsightsPanel");
  const btn = document.getElementById("toggleAdvancedBtn");
  if (!panel || !btn) return;
  const hidden = panel.style.display === "none";
  panel.style.display = hidden ? "block" : "none";
  btn.textContent = hidden ? "Hide" : "Show";
}

function toggleMistakeTracker() {
  const panel = document.getElementById("mistakeTrackerPanel");
  const btn = document.getElementById("toggleMistakeBtn");
  if (!panel || !btn) return;
  const hidden = panel.style.display === "none";
  panel.style.display = hidden ? "block" : "none";
  btn.textContent = hidden ? "Hide" : "Show";
}

function loadInsights() {
  const allocationList = document.getElementById("allocationList");
  const avgDownList = document.getElementById("avgDownList");
  const advancedList = document.getElementById("advancedInsightsList");
  const mistakeSummaryEl = document.getElementById("mistakeTrackerSummary");
  const mistakeListEl = document.getElementById("mistakeTrackerList");
  const sellAssistantList = document.getElementById("sellAssistantList");
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
            panicSells: 0
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
              } else {
                const dropPct = prevPrice > 0 ? ((prevPrice - currPrice) / prevPrice) * 100 : 0;
                if (dropPct < Number(settings.avgLevel1Pct || 0)) {
                  qStock.weakDropBuys += 1;
                  qMonth.weakDropBuys += 1;
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
        if (sellAssistantList) sellAssistantList.innerHTML = "";

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

          if (sellAssistantList) {
            const qty = s.lots.reduce((a, l) => a + l.qty, 0);
            const avgCost = qty > 0 ? invested / qty : 0;
            const referencePrice = Number(s.cycleLastTxnPrice || s.cycleLastBuyPrice || avgCost);
            const currentValue = qty * referencePrice;
            const unrealized = currentValue - invested;
            const unrealizedPct = invested > 0 ? (unrealized / invested) * 100 : 0;

            const targetPct = Number(settings.sellTargetPct ?? 15);
            const stopLossPct = Math.abs(Number(settings.stopLossPct ?? 8));
            const minHoldDaysTrim = Number(settings.minHoldDaysTrim ?? 20);

            let action = "Hold";
            let actionCls = "status-pill-mini ok";
            let reason = "No sell trigger met yet.";

            if (unrealizedPct <= -stopLossPct) {
              action = "Exit";
              actionCls = "status-pill-mini bad";
              reason = `Loss crossed stop-loss (${stopLossPct.toFixed(2)}%).`;
            } else if (unrealizedPct >= targetPct && daysHeld >= minHoldDaysTrim) {
              action = "Trim";
              actionCls = "status-pill-mini warn";
              reason = `Target met (${targetPct.toFixed(2)}%) with hold-days discipline (${minHoldDaysTrim}+).`;
            } else if (allocationPct > Number(settings.maxAllocationPct || 0) && unrealizedPct > 0) {
              action = "Trim";
              actionCls = "status-pill-mini warn";
              reason = "Over allocation with positive return; partial trim can reduce concentration.";
            } else if (unrealizedPct > 0 && daysHeld < minHoldDaysTrim) {
              action = "Hold";
              actionCls = "status-pill-mini ok";
              reason = `In profit but hold period still below ${minHoldDaysTrim} days.`;
            }

            sellAssistantList.innerHTML += `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${stock}</div>
                    <div class="tiny-label">Qty ${qty} | Avg ₹${avgCost.toFixed(2)} | Ref ₹${referencePrice.toFixed(2)}</div>
                  </div>
                  <div class="right-col">
                    <span class="${actionCls}">${action}</span>
                  </div>
                </div>
                <div class="split-row mt-1">
                  <div class="left-col tiny-label">Unrealized: ₹${unrealized.toFixed(2)} (${unrealizedPct.toFixed(2)}%)</div>
                  <div class="right-col tiny-label">Days: ${daysHeld}</div>
                </div>
                <div class="tiny-label mt-1">Rule: Target ${targetPct.toFixed(2)}% | Stop-loss ${stopLossPct.toFixed(2)}% | Min Hold ${minHoldDaysTrim}d</div>
                <div class="suggestion-budget mt-1"><strong>Reason:</strong> ${reason}</div>
              </div>
            `;
          }

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

        if (sellAssistantList && !sellAssistantList.innerHTML) {
          sellAssistantList.innerHTML = `
            <div class="txn-card text-center text-muted">
              No active holdings for sell discipline assistant
            </div>`;
        }

        if (mistakeSummaryEl && mistakeListEl) {
          const stockRows = Object.keys(quality.byStock).map(stock => {
            const q = quality.byStock[stock];
            const penalties =
              (q.chaseBuys * 8) +
              (q.weakDropBuys * 12) +
              (q.overAllocBuys * 15) +
              (q.panicSells * 10);
            const score = Math.max(0, 100 - penalties);
            return { stock, ...q, score };
          }).sort((a, b) => a.score - b.score);

          const monthRows = Object.keys(quality.byMonth).map(month => {
            const q = quality.byMonth[month];
            const penalties =
              (q.chaseBuys * 8) +
              (q.weakDropBuys * 12) +
              (q.overAllocBuys * 15) +
              (q.panicSells * 10);
            const score = Math.max(0, 100 - penalties);
            return { month, ...q, score };
          }).sort((a, b) => b.month.localeCompare(a.month));

          const totalPenalties = stockRows.reduce((a, r) => a + (100 - r.score), 0);
          const avgScore = stockRows.length ? Math.max(0, 100 - (totalPenalties / stockRows.length)) : 100;
          const overallCls = avgScore >= 80 ? "ok" : (avgScore >= 60 ? "warn" : "bad");

          mistakeSummaryEl.innerHTML = `
            <div class="split-row">
              <div class="left-col">
                <div class="tiny-label">Overall Decision Quality</div>
                <div class="metric-strong">${avgScore.toFixed(1)} / 100</div>
              </div>
              <div class="right-col">
                <span class="status-pill-mini ${overallCls}">
                  ${overallCls === "ok" ? "Healthy" : overallCls === "warn" ? "Needs Discipline" : "High Mistake Risk"}
                </span>
              </div>
            </div>
            <div class="status-inline mt-2">
              ${monthRows.slice(0, 3).map(m => `<span class="status-pill-mini ${m.score >= 80 ? "ok" : m.score >= 60 ? "warn" : "bad"}">${m.month}: ${m.score.toFixed(0)}</span>`).join("")}
            </div>
          `;

          if (!stockRows.length) {
            mistakeListEl.innerHTML = `<div class="txn-card text-center text-muted">No data for mistake tracking</div>`;
          } else {
            mistakeListEl.innerHTML = stockRows.map(r => `
              <div class="txn-card">
                <div class="split-row">
                  <div class="left-col">
                    <div class="txn-name">${r.stock}</div>
                    <div class="tiny-label">Buys ${r.buys} | Sells ${r.sells}</div>
                  </div>
                  <div class="right-col">
                    <span class="status-pill-mini ${r.score >= 80 ? "ok" : r.score >= 60 ? "warn" : "bad"}">${r.score.toFixed(0)}</span>
                  </div>
                </div>
                <div class="tiny-label mt-1">
                  Chase: ${r.chaseBuys} | Weak Drop: ${r.weakDropBuys} | Over Alloc: ${r.overAllocBuys} | Panic Sells: ${r.panicSells}
                </div>
              </div>
            `).join("");
          }
        }
      };
  });
}


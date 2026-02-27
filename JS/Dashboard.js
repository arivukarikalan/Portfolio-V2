/* =========================================================
   FILE: dashboard.js
   PURPOSE:
   - Dashboard analytics (REALIZED DATA ONLY)
   - Month-wise P/L + contribution (Chart.js)
   - Stock-wise performance
   - Best / Worst performers
   - Win / Loss summary
   ========================================================= */

let monthlyChart;

function parseDateLocal(dateStr) {
  const parts = String(dateStr || "").split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function monthIdFromDate(dateStr) {
  const d = parseDateLocal(dateStr);
  if (!d) return "0000-00";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function formatMonthId(monthId) {
  const [y, m] = monthId.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, 1);
  return dt.toLocaleString("default", { month: "short", year: "numeric" });
}

/* =========================================================
   ENTRY POINT
   ========================================================= */
function loadDashboardAnalytics() {
  const range = document.getElementById("dashRange")?.value || "1";
  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = e.target.result.sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        );

        // FIFO must run on full data for correct realized P/L
        const pnlData = buildRealisedPnL(txns, settings);
        const monthlyContribution = buildMonthlyContributionFromActiveHoldings(txns, settings);

        // Apply range after calculations
        const filtered = filterDashboardByRange(pnlData, range);
        renderDashboardSummary(txns, filtered.byStock, settings);
        renderMonthlyChart(filtered.monthly);
        renderMonthlyContributionTable(monthlyContribution);
        renderStockTable(filtered.byStock);
        renderTopPerformance(filtered.byStock);
        renderBestWorst(filtered.byStock);
        renderWinLoss(filtered.trades);
      };
  });
}

function buildActiveLots(txns, settings) {
  const map = {};

  txns.forEach(t => {
    map[t.stock] ??= { lots: [] };

    if (t.type === "BUY") {
      const buyBrkg = resolveTxnBrokerage(t, settings);
      map[t.stock].lots.push({
        qty: t.qty,
        price: t.price,
        brokeragePerUnit: buyBrkg / t.qty,
        date: t.date
      });
      return;
    }

    let sellQty = t.qty;
    while (sellQty > 0 && map[t.stock].lots.length) {
      const lot = map[t.stock].lots[0];
      const used = Math.min(lot.qty, sellQty);
      lot.qty -= used;
      sellQty -= used;
      if (lot.qty === 0) map[t.stock].lots.shift();
    }
  });

  return map;
}

function buildMonthlyContributionFromActiveHoldings(txns, settings) {
  const map = buildActiveLots(txns, settings);
  const monthly = {};

  for (const stock in map) {
    map[stock].lots.forEach(lot => {
      if (lot.qty <= 0) return;
      const key = monthIdFromDate(lot.date);
      const amount = lot.qty * (lot.price + lot.brokeragePerUnit);
      monthly[key] = (monthly[key] || 0) + amount;
    });
  }

  return monthly;
}

/* =========================================================
   FIFO-BASED REALISED P/L (SAME CORE AS P/L PAGE)
   ========================================================= */
function buildRealisedPnL(txns, settings) {
  const fifo = {};
  const monthly = {};
  const byStock = {};
  const realizedTrades = [];
  const trades = { total: 0, win: 0, loss: 0 };

  txns.forEach(t => {
    fifo[t.stock] ??= [];

    if (t.type === "BUY") {
      const buyBrkg = resolveTxnBrokerage(t, settings);
      fifo[t.stock].push({
        qty: t.qty,
        price: t.price,
        brokeragePerUnit: buyBrkg / t.qty,
        date: t.date
      });
    }

    if (t.type === "SELL") {
      let sellQty = t.qty;
      let buyCost = 0;
      let buyBrokerage = 0;
      let consumedQty = 0;
      let weightedHoldDaysSum = 0;

      while (sellQty > 0 && fifo[t.stock].length) {
        const lot = fifo[t.stock][0];
        const used = Math.min(lot.qty, sellQty);

        buyCost += used * lot.price;
        buyBrokerage += used * lot.brokeragePerUnit;
        consumedQty += used;
        const holdDays = Math.max(0, Math.floor((parseDateLocal(t.date) - parseDateLocal(lot.date)) / 86400000));
        weightedHoldDaysSum += used * holdDays;

        lot.qty -= used;
        sellQty -= used;

        if (lot.qty === 0) fifo[t.stock].shift();
      }

      const sellValue = t.qty * t.price;
      const sellBrkg = resolveTxnBrokerage(t, settings);
      const net = sellValue - buyCost - buyBrokerage - sellBrkg;
      const invested = buyCost + buyBrokerage;
      const avgHoldDays = consumedQty > 0 ? weightedHoldDaysSum / consumedQty : 0;
      const returnPct = invested > 0 ? (net / invested) * 100 : 0;

      const monthKey = monthIdFromDate(t.date);
      monthly[monthKey] = (monthly[monthKey] || 0) + net;
      realizedTrades.push({ stock: t.stock, net, date: t.date, invested, holdDays: avgHoldDays, returnPct });

      byStock[t.stock] ??= {
        pnl: 0,
        trades: 0,
        win: 0,
        loss: 0,
        invested: 0,
        holdDaysWeightedByInvested: 0
      };

      byStock[t.stock].pnl += net;
      byStock[t.stock].trades += 1;
      byStock[t.stock].invested += invested;
      byStock[t.stock].holdDaysWeightedByInvested += avgHoldDays * invested;

      if (net >= 0) {
        byStock[t.stock].win += 1;
        trades.win += 1;
      } else {
        byStock[t.stock].loss += 1;
        trades.loss += 1;
      }

      trades.total += 1;
    }
  });

  return { monthly, byStock, trades, realizedTrades };
}

/* =========================================================
   DASHBOARD SUMMARY
   ========================================================= */
function renderDashboardSummary(txns, filteredByStock, settings) {
  let activeHoldings = 0;
  let totalInvested = 0;
  const map = buildActiveLots(txns, settings);

  for (const stock in map) {
    const lots = map[stock].lots;
    if (!lots.length) continue;

    activeHoldings++;
    totalInvested += lots.reduce(
      (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
      0
    );
  }

  const netPnL = Object.values(filteredByStock)
    .reduce((a, s) => a + s.pnl, 0);

  document.getElementById("dashInvested").innerText = `\u20B9${totalInvested.toFixed(2)}`;
  document.getElementById("dashHoldings").innerText = activeHoldings;
  document.getElementById("dashNetPnL").innerText = `\u20B9${netPnL.toFixed(2)}`;
}

/* =========================================================
   RANGE FILTERS
   ========================================================= */
function filterDashboardByRange(pnlData, range) {
  if (range === "all") return pnlData;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - Number(range));

  const filteredMonthly = {};
  const filteredStock = {};
  const trades = { total: 0, win: 0, loss: 0 };

  pnlData.realizedTrades.forEach(t => {
    const tradeDate = parseDateLocal(t.date);
    if (!tradeDate || tradeDate < cutoff) return;

    const key = monthIdFromDate(t.date);
    filteredMonthly[key] = (filteredMonthly[key] || 0) + t.net;

    filteredStock[t.stock] ??= {
      pnl: 0,
      trades: 0,
      win: 0,
      loss: 0,
      invested: 0,
      holdDaysWeightedByInvested: 0
    };
    filteredStock[t.stock].pnl += t.net;
    filteredStock[t.stock].trades += 1;
    filteredStock[t.stock].invested += Number(t.invested || 0);
    filteredStock[t.stock].holdDaysWeightedByInvested += Number(t.holdDays || 0) * Number(t.invested || 0);

    if (t.net >= 0) {
      filteredStock[t.stock].win += 1;
      trades.win += 1;
    } else {
      filteredStock[t.stock].loss += 1;
      trades.loss += 1;
    }

    trades.total += 1;
  });

  return {
    monthly: filteredMonthly,
    byStock: filteredStock,
    trades
  };
}

/* =========================================================
   MONTH-WISE CHART + CONTRIBUTION
   ========================================================= */
function renderMonthlyChart(pnlMap) {
  const ctx = document.getElementById("monthlyChart");
  if (!ctx) return;
  const styles = getComputedStyle(document.body);
  const axisTextColor = styles.getPropertyValue("--muted").trim() || "#9fb0c9";
  const gridColor = document.body.classList.contains("dark")
    ? "rgba(148, 163, 184, 0.14)"
    : "rgba(100, 116, 139, 0.18)";

  const labels = Object.keys(pnlMap)
    .sort((a, b) => a.localeCompare(b));
  const displayLabels = labels.map(formatMonthId);

  const pnlValues = labels.map(label => pnlMap[label] || 0);

  if (monthlyChart) monthlyChart.destroy();

  monthlyChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: displayLabels,
      datasets: [
        {
          label: "Net P/L (\u20B9)",
          data: pnlValues,
          backgroundColor: pnlValues.map(v => (v >= 0 ? "#198754" : "#dc3545"))
        }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: axisTextColor
          }
        }
      },
      scales: {
        x: {
          ticks: { color: axisTextColor },
          grid: { color: gridColor }
        },
        y: {
          ticks: { color: axisTextColor },
          grid: { color: gridColor }
        }
      },
      onClick: (_, elements) => {
        if (!elements.length) return;
        const label = displayLabels[elements[0].index];
        drillDownMonth(label);
      }
    }
  });
}

function renderMonthlyContributionTable(contributionMap) {
  const tbody = document.getElementById("monthlyContributionBody");
  if (!tbody) return;

  const labels = Object.keys(contributionMap)
    .sort((a, b) => a.localeCompare(b));

  if (!labels.length) {
    tbody.innerHTML = `<tr><td colspan="2" class="text-center text-muted">No contribution data in this range</td></tr>`;
    return;
  }

  const rows = labels.map(label => `
    <tr>
      <td>${formatMonthId(label)}</td>
      <td class="text-end text-primary fw-semibold">\u20B9${contributionMap[label].toFixed(2)}</td>
    </tr>
  `);

  const total = labels.reduce((a, label) => a + contributionMap[label], 0);
  rows.push(`
    <tr class="fw-bold">
      <td>Total</td>
      <td class="text-end">\u20B9${total.toFixed(2)}</td>
    </tr>
  `);

  tbody.innerHTML = rows.join("");
}

/* =========================================================
   STOCK-WISE TABLE / BEST / WORST / WIN-LOSS
   ========================================================= */
function renderStockTable(data) {
  const tbody = document.getElementById("stockTable");
  if (!tbody) return;

  tbody.innerHTML = "";

  Object.entries(data)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .forEach(([stock, d]) => {
      tbody.innerHTML += `
        <tr style="cursor:pointer" onclick="drillDownStock('${stock}')">
          <td>${stock}</td>
          <td class="${d.pnl >= 0 ? "text-success" : "text-danger"}">\u20B9${d.pnl.toFixed(2)}</td>
          <td>${d.trades}</td>
          <td>${d.win} / ${d.loss}</td>
        </tr>
      `;
    });
}

function renderTopPerformance(data) {
  const list = document.getElementById("topPerformanceList");
  if (!list) return;

  const rows = Object.entries(data)
    .map(([stock, d]) => {
      const invested = Number(d.invested || 0);
      const avgDays = invested > 0 ? (Number(d.holdDaysWeightedByInvested || 0) / invested) : 0;
      const returnPct = invested > 0 ? (Number(d.pnl || 0) / invested) * 100 : 0;
      const speedFactor = 365 / (avgDays + 30);
      const sizeFactor = Math.log10(invested + 10);
      const score = returnPct * speedFactor * sizeFactor;
      return { stock, invested, avgDays, returnPct, score, pnl: Number(d.pnl || 0) };
    })
    .filter(r => r.invested > 0 && r.returnPct > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!rows.length) {
    list.innerHTML = `<div class="txn-card text-center text-muted">No positive performance data in selected range</div>`;
    return;
  }

  list.innerHTML = rows.map((r, idx) => `
    <div class="txn-card">
      <div class="split-row">
        <div class="left-col">
          <div class="txn-name">#${idx + 1} ${r.stock}</div>
          <div class="tiny-label">Invested ₹${r.invested.toFixed(2)} | Avg Hold ${r.avgDays.toFixed(0)} days</div>
        </div>
        <div class="right-col">
          <div class="metric-strong profit">${r.returnPct.toFixed(2)}%</div>
          <div class="tiny-label">Net ₹${r.pnl.toFixed(2)}</div>
        </div>
      </div>
    </div>
  `).join("");
}

function renderBestWorst(data) {
  const entries = Object.entries(data);
  if (!entries.length) return;

  entries.sort((a, b) => b[1].pnl - a[1].pnl);
  document.getElementById("bestStock").innerText = `${entries[0][0]} \u20B9${entries[0][1].pnl.toFixed(2)}`;
  document.getElementById("worstStock").innerText = `${entries.at(-1)[0]} \u20B9${entries.at(-1)[1].pnl.toFixed(2)}`;
}

function renderWinLoss(t) {
  const rate = t.total === 0 ? 0 : ((t.win / t.total) * 100).toFixed(1);
  document.getElementById("winLossSummary").innerText =
    `Trades: ${t.total} | Wins: ${t.win} | Losses: ${t.loss} | Win Rate: ${rate}%`;
}

/* =========================================================
   DRILL-DOWN
   ========================================================= */
function drillDownStock(stock) {
  location.href = `Pnl.html?stock=${encodeURIComponent(stock)}`;
}

function drillDownMonth(label) {
  const [month, year] = label.split(" ");
  location.href = `Pnl.html?month=${month}&year=${year}`;
}

document.getElementById("dashRange")
  ?.addEventListener("change", loadDashboardAnalytics);

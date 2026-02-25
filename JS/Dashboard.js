/* =========================================================
   FILE: dashboard.js
   PURPOSE:
   - Dashboard analytics (REALIZED DATA ONLY)
   - Month-wise P/L (Chart.js)
   - Stock-wise performance
   - Best / Worst performers
   - Win / Loss summary
   - FIFO-safe (matches P/L page exactly)
   ========================================================= */

   let monthlyChart;

   /* =========================================================
      ENTRY POINT
      ========================================================= */
   function loadDashboardAnalytics() {
     const range = document.getElementById("dashRange")?.value || "1";
   
     db.transaction("transactions", "readonly")
       .objectStore("transactions")
       .getAll().onsuccess = e => {
   
         const txns = e.target.result.sort(
           (a, b) => new Date(a.date) - new Date(b.date)
         );
   
         // IMPORTANT: FIFO must run on FULL DATA
         const pnlData = buildRealisedPnL(txns);
   
         // Apply time range AFTER FIFO
         const filtered = filterDashboardByRange(pnlData, range);
         
         renderDashboardSummary(txns, pnlData);
         renderMonthlyChart(filtered.monthly);
         renderStockTable(filtered.byStock);
         renderBestWorst(filtered.byStock);
         renderWinLoss(filtered.trades);
       };
   }
   
   /* =========================================================
      FIFO-BASED REALISED P/L ENGINE (SAME AS P/L PAGE)
      ========================================================= */
   function buildRealisedPnL(txns) {
     const fifo = {};
     const monthly = {};
     const byStock = {};
     const trades = { total: 0, win: 0, loss: 0 };
   
     txns.forEach(t => {
       fifo[t.stock] ??= [];
   
       if (t.type === "BUY") {
         fifo[t.stock].push({
           qty: t.qty,
           price: t.price,
           brokeragePerUnit: t.brokerage / t.qty
         });
       }
   
       if (t.type === "SELL") {
         let sellQty = t.qty;
         let buyCost = 0;
         let buyBrokerage = 0;
   
         while (sellQty > 0 && fifo[t.stock].length) {
           const lot = fifo[t.stock][0];
           const used = Math.min(lot.qty, sellQty);
   
           buyCost += used * lot.price;
           buyBrokerage += used * lot.brokeragePerUnit;
   
           lot.qty -= used;
           sellQty -= used;
   
           if (lot.qty === 0) fifo[t.stock].shift();
         }
   
         const sellValue = t.qty * t.price;
         const net =
           sellValue -
           buyCost -
           buyBrokerage -
           t.brokerage;
   
         /* ---------- Monthly Group ---------- */
         const monthKey = new Date(t.date).toLocaleString("default", {
           month: "short",
           year: "numeric"
         });
         monthly[monthKey] = (monthly[monthKey] || 0) + net;
   
         /* ---------- Stock Group ---------- */
         byStock[t.stock] ??= {
           pnl: 0,
           trades: 0,
           win: 0,
           loss: 0
         };
   
         byStock[t.stock].pnl += net;
         byStock[t.stock].trades += 1;
   
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
   
     return { monthly, byStock, trades };
   }
   
   /* =========================================================
   DASHBOARD SUMMARY (INVESTED / HOLDINGS / NET P/L)
   ========================================================= */
function renderDashboardSummary(txns, pnlData) {
    let totalInvested = 0;
    let activeHoldings = 0;
  
    // Build FIFO holdings (active only)
    const map = {};
  
    txns.forEach(t => {
      map[t.stock] ??= { lots: [] };
  
      if (t.type === "BUY") {
        map[t.stock].lots.push({
          qty: t.qty,
          price: t.price,
          brokeragePerUnit: t.brokerage / t.qty
        });
      } else {
        let sellQty = t.qty;
        while (sellQty > 0 && map[t.stock].lots.length) {
          const lot = map[t.stock].lots[0];
          const used = Math.min(lot.qty, sellQty);
          lot.qty -= used;
          sellQty -= used;
          if (lot.qty === 0) map[t.stock].lots.shift();
        }
      }
    });
  
    for (const stock in map) {
      const lots = map[stock].lots;
      if (!lots.length) continue;
  
      activeHoldings++;
  
      totalInvested += lots.reduce(
        (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
        0
      );
    }
  
    // Net realised P/L
    const netPnL = Object.values(pnlData.byStock)
      .reduce((a, s) => a + s.pnl, 0);
  
    // Update UI
    document.getElementById("dashInvested").innerText =
      `₹${totalInvested.toFixed(2)}`;
    document.getElementById("dashHoldings").innerText =
      activeHoldings;
    document.getElementById("dashNetPnL").innerText =
      `₹${netPnL.toFixed(2)}`;
  }

   /* =========================================================
      APPLY TIME RANGE (AFTER FIFO)
      ========================================================= */
   function filterDashboardByRange(pnlData, range) {
     if (range === "all") return pnlData;
   
     const cutoff = new Date();
     cutoff.setMonth(cutoff.getMonth() - Number(range));
   
     const filteredMonthly = {};
     const filteredStock = {};
     const trades = { total: 0, win: 0, loss: 0 };
   
     // Filter months
     for (const month in pnlData.monthly) {
       const d = new Date(month + " 01");
       if (d >= cutoff) {
         filteredMonthly[month] = pnlData.monthly[month];
       }
     }
   
     // Stock & trade summary stays consistent
     for (const stock in pnlData.byStock) {
       const s = pnlData.byStock[stock];
       if (s.trades > 0) {
         filteredStock[stock] = s;
         trades.total += s.trades;
         trades.win += s.win;
         trades.loss += s.loss;
       }
     }
   
     return {
       monthly: filteredMonthly,
       byStock: filteredStock,
       trades
     };
   }
   
   /* =========================================================
      MONTH-WISE P/L CHART
      ========================================================= */
   function renderMonthlyChart(data) {
     const ctx = document.getElementById("monthlyChart");
     if (!ctx) return;
   
     const labels = Object.keys(data);
     const values = Object.values(data);
   
     if (monthlyChart) monthlyChart.destroy();
   
     monthlyChart = new Chart(ctx, {
       type: "bar",
       data: {
         labels,
         datasets: [{
           label: "Net P/L (₹)",
           data: values,
           backgroundColor: values.map(v =>
             v >= 0 ? "#198754" : "#dc3545"
           )
         }]
       },
       options: {
         responsive: true,
         plugins: {
           legend: { display: false }
         },
         onClick: (_, elements) => {
           if (!elements.length) return;
           const label = labels[elements[0].index];
           drillDownMonth(label);
         }
       }
     });
   }
   
   /* =========================================================
      STOCK-WISE TABLE
      ========================================================= */
   function renderStockTable(data) {
     const tbody = document.getElementById("stockTable");
     if (!tbody) return;
   
     tbody.innerHTML = "";
   
     Object.entries(data)
       .sort((a, b) => b[1].pnl - a[1].pnl)
       .forEach(([stock, d]) => {
         tbody.innerHTML += `
           <tr style="cursor:pointer"
               onclick="drillDownStock('${stock}')">
             <td>${stock}</td>
             <td class="${d.pnl >= 0 ? "text-success" : "text-danger"}">
               ₹${d.pnl.toFixed(2)}
             </td>
             <td>${d.trades}</td>
             <td>${d.win} / ${d.loss}</td>
           </tr>
         `;
       });
   }
   
   /* =========================================================
      BEST / WORST PERFORMERS
      ========================================================= */
   function renderBestWorst(data) {
     const entries = Object.entries(data);
     if (!entries.length) return;
   
     entries.sort((a, b) => b[1].pnl - a[1].pnl);
   
     document.getElementById("bestStock").innerText =
       `${entries[0][0]} ₹${entries[0][1].pnl.toFixed(2)}`;
   
     document.getElementById("worstStock").innerText =
       `${entries.at(-1)[0]} ₹${entries.at(-1)[1].pnl.toFixed(2)}`;
   }
   
   /* =========================================================
      WIN / LOSS SUMMARY
      ========================================================= */
   function renderWinLoss(t) {
     const rate =
       t.total === 0 ? 0 : ((t.win / t.total) * 100).toFixed(1);
   
     document.getElementById("winLossSummary").innerText =
       `Trades: ${t.total} | Wins: ${t.win} | Losses: ${t.loss} | Win Rate: ${rate}%`;
   }
   
   /* =========================================================
      DRILL-DOWN NAVIGATION
      ========================================================= */
   function drillDownStock(stock) {
     location.href = `pnl.html?stock=${encodeURIComponent(stock)}`;
   }
   
   function drillDownMonth(label) {
     const [month, year] = label.split(" ");
     location.href = `pnl.html?month=${month}&year=${year}`;
   }
   
   /* =========================================================
      RANGE CHANGE HANDLER
      ========================================================= */
   document.getElementById("dashRange")
     ?.addEventListener("change", loadDashboardAnalytics);
/* =========================================================
   FILE: insights.js
   PURPOSE:
   - Portfolio Allocation Analysis
   - Average Down Indicators
   ========================================================= */


/* =========================================================
   ENTRY POINT
   ========================================================= */
   function loadInsights() {
    const allocationList = document.getElementById("allocationList");
    const avgDownList = document.getElementById("avgDownList");
  
    if (!allocationList || !avgDownList) return;
  
    getSettings(settings => {
      db.transaction("transactions", "readonly")
        .objectStore("transactions")
        .getAll().onsuccess = e => {
  
          const txns = e.target.result.sort(
            (a, b) => new Date(a.date) - new Date(b.date)
          );
  
          const holdings = {};
          const firstBuyPrice = {};
          const buyPricesByStock = {};
  
          /* =============================================
             STEP 1: Build Active Holdings (FIFO Qty)
             ============================================= */
          txns.forEach(t => {
            holdings[t.stock] ??= 0;
            buyPricesByStock[t.stock] ??= [];
  
            if (t.type === "BUY") {
              holdings[t.stock] += t.qty;
              buyPricesByStock[t.stock].push(t.price);
  
              if (!firstBuyPrice[t.stock]) {
                firstBuyPrice[t.stock] = t.price;
              }
            } else {
              holdings[t.stock] -= t.qty;
            }
          });
  
          allocationList.innerHTML = "";
          avgDownList.innerHTML = "";
  
          /* =============================================
             STEP 2: Portfolio Allocation
             ============================================= */
          for (const stock in holdings) {
            if (holdings[stock] <= 0) continue;
  
            const invested = txns
              .filter(t => t.stock === stock && t.type === "BUY")
              .reduce((a, t) => a + (t.qty * t.price + t.brokerage), 0);
  
            const allocationPct =
              (invested / settings.portfolioSize) * 100;
  
            let status = "Balanced";
            let statusClass = "text-success";
  
            if (allocationPct > settings.maxAllocationPct) {
              status = "Warning";
              statusClass = "text-danger";
            } else if (allocationPct > 15) {
              status = "Moderate";
              statusClass = "text-warning";
            }
  
            allocationList.innerHTML += `
              <div class="txn-card">
                <div class="txn-name">${stock}</div>
                <div class="txn-sub">
                  Allocation: ${allocationPct.toFixed(2)}%
                  <span class="${statusClass} ms-2">(${status})</span>
                </div>
              </div>
            `;
          }
  
          if (!allocationList.innerHTML) {
            allocationList.innerHTML = `
              <div class="txn-card text-center text-muted">
                No active holdings
              </div>`;
          }
  
          /* =============================================
             STEP 3: Average Down Levels (Active Only)
             ============================================= */
          for (const stock in firstBuyPrice) {
            if (!holdings[stock] || holdings[stock] <= 0) continue;
  
            const base = firstBuyPrice[stock];
            const level1 =
              base * (1 - settings.avgLevel1Pct / 100);
            const level2 =
              base * (1 - settings.avgLevel2Pct / 100);
  
            const prices = buyPricesByStock[stock] || [];
            const level1Done = prices.some(p => p <= level1);
            const level2Done = prices.some(p => p <= level2);
  
            let avgStatus = "";

            if (level1Done && level2Done) {
              avgStatus = `<span class="text-danger">⚠ Averaging Stage Completed</span>`;
            } else if (level1Done) {
              avgStatus = `<span class="text-warning">✅ Level-1 Averaging Completed</span>`;
            }
  
            avgDownList.innerHTML += `
              <div class="txn-card">
                <div class="txn-name">${stock}</div>
                <div class="txn-sub">
                  First Buy: ₹${base.toFixed(2)}<br>
                  Level 1 (${settings.avgLevel1Pct}%): ₹${level1.toFixed(2)}<br>
                  Level 2 (${settings.avgLevel2Pct}%): ₹${level2.toFixed(2)}<br>
                  ${avgStatus}
                </div>
              </div>
            `;
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
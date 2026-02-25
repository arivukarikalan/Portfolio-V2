/* =========================================================
   FILE: analytics.js
   PURPOSE:
   - FD vs Inflation Analytics
   - Realised SELL transactions only
   ========================================================= */

   function loadAnalytics() {
    const listEl = document.getElementById("analyticsList");
    if (!listEl) return;
  
    getSettings(settings => {
      db.transaction("transactions", "readonly")
        .objectStore("transactions")
        .getAll().onsuccess = e => {
  
          const txns = e.target.result.sort(
            (a, b) => new Date(a.date) - new Date(b.date)
          );
  
          const fifo = {};
          const results = [];
  
          /* =============================================
             STEP 1: FIFO PROCESSING
             ============================================= */
          txns.forEach(t => {
            fifo[t.stock] ??= [];
  
            if (t.type === "BUY") {
              fifo[t.stock].push({
                qty: t.qty,
                price: t.price,
                brokeragePerUnit: t.brokerage / t.qty,
                date: t.date
              });
            } else {
              let sellQty = t.qty;
              let buyCost = 0;
              let buyDate = null;
  
              while (sellQty > 0 && fifo[t.stock].length) {
                const lot = fifo[t.stock][0];
                const used = Math.min(lot.qty, sellQty);
  
                buyCost += used * lot.price;
                buyDate ??= lot.date;
  
                lot.qty -= used;
                sellQty -= used;
  
                if (lot.qty === 0) fifo[t.stock].shift();
              }
  
              const sellValue = t.qty * t.price;
              const netPL =
                sellValue -
                buyCost -
                t.brokerage;
  
              const daysHeld =
                Math.floor(
                  (new Date(t.date) - new Date(buyDate)) / 86400000
                );
  
              const fdReturn =
                buyCost *
                (settings.fdRatePct / 100) *
                (daysHeld / 365);
  
              const inflationLoss =
                buyCost *
                (settings.inflationRatePct / 100) *
                (daysHeld / 365);
  
                results.push({
                    stock: t.stock,
                    date: t.date,
                    qty: t.qty,
                    daysHeld,
                    invested: buyCost,   // ✅ ADD THIS
                    netPL,
                    fdReturn,
                    inflationLoss
                  });
            }
          });
  
          /* =============================================
             STEP 2: FILTERS
             ============================================= */
          const from = document.getElementById("anaFrom")?.value;
          const to = document.getElementById("anaTo")?.value;
          const stockFilter =
            document.getElementById("anaStock")?.value.toLowerCase() || "";
  
          const filtered = results.filter(r => {
            if (from && new Date(r.date) < new Date(from)) return false;
            if (to && new Date(r.date) > new Date(to)) return false;
            if (stockFilter && !r.stock.toLowerCase().includes(stockFilter))
              return false;
            return true;
          });
  
          renderAnalytics(filtered);
        };
    });
  }
  
  /* =========================================================
     RENDER ANALYTICS (GROUPED)
     ========================================================= */
  function renderAnalytics(data) {
    const listEl = document.getElementById("analyticsList");
    listEl.innerHTML = "";
  
    if (!data.length) {
      listEl.innerHTML = `
        <div class="txn-card text-center text-muted">
          No analytics data
        </div>`;
      return;
    }
  
    const grouped = {};
    data.forEach(r => {
      grouped[r.stock] ??= [];
      grouped[r.stock].push(r);
    });
  
    for (const stock in grouped) {
      const txns = grouped[stock];
  
      listEl.innerHTML += `
        <div class="txn-card">
          <div class="pnl-header" onclick="toggleAnalytics('${stock}')">
            <div class="txn-name">${stock}</div>
            <i class="bi bi-chevron-down"></i>
          </div>
  
          <div id="ana-${stock}" class="pnl-details" style="display:none">
            ${txns.map(t => {
              const beatsFD = t.netPL > t.fdReturn;
              const beatsInflation = t.netPL > t.inflationLoss;
  
              return `
                <div class="pnl-txn">
                  <small>
                    ${t.date} | Qty ${t.qty} | Days Held: ${t.daysHeld} |
                    Invested: ₹${t.invested.toFixed(2)}<br>
                    Stock P/L: ₹${t.netPL.toFixed(2)}<br>
                    FD Return: ₹${t.fdReturn.toFixed(2)}<br>
                    Inflation Impact: ₹${t.inflationLoss.toFixed(2)}<br>
                    <b>
                      FD: ${beatsFD ? "✅" : "❌"} |
                      Inflation: ${beatsInflation ? "✅" : "❌"}
                    </b>
                  </small>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    }
  }
  
  /* =========================================================
     TOGGLE HANDLER
     ========================================================= */
  function toggleAnalytics(stock) {
    const el = document.getElementById(`ana-${stock}`);
    if (!el) return;
    el.style.display = el.style.display === "none" ? "block" : "none";
  }
  
  /* =========================================================
     FILTER AUTO-REFRESH
     ========================================================= */
  ["anaFrom", "anaTo", "anaStock"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", loadAnalytics);
  });
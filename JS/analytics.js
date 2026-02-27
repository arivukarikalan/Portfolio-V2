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
            return;
          }

          let sellQty = t.qty;
          let buyCost = 0;
          let buyBrokerage = 0;
          let buyDate = null;

          while (sellQty > 0 && fifo[t.stock].length) {
            const lot = fifo[t.stock][0];
            const used = Math.min(lot.qty, sellQty);

            buyCost += used * lot.price;
            buyBrokerage += used * lot.brokeragePerUnit;
            buyDate ??= lot.date;

            lot.qty -= used;
            sellQty -= used;
            if (lot.qty === 0) fifo[t.stock].shift();
          }

          const sellValue = t.qty * t.price;
          const sellBrokerage = resolveTxnBrokerage(t, settings);
          const netPL = sellValue - buyCost - buyBrokerage - sellBrokerage;

          const daysHeld = Math.floor(
            (new Date(t.date) - new Date(buyDate)) / 86400000
          );

          const fdReturn = buyCost * (settings.fdRatePct / 100) * (daysHeld / 365);
          const inflationLoss = buyCost * (settings.inflationRatePct / 100) * (daysHeld / 365);

          results.push({
            stock: t.stock,
            date: t.date,
            qty: t.qty,
            daysHeld,
            invested: buyCost,
            soldCost: sellValue,
            netPL,
            fdReturn,
            inflationLoss,
            buyBrokerage,
            sellBrokerage
          });
        });

        const from = document.getElementById("anaFrom")?.value;
        const to = document.getElementById("anaTo")?.value;
        const stockFilter = document.getElementById("anaStock")?.value.toLowerCase() || "";

        const filtered = results.filter(r => {
          if (from && new Date(r.date) < new Date(from)) return false;
          if (to && new Date(r.date) > new Date(to)) return false;
          if (stockFilter && !r.stock.toLowerCase().includes(stockFilter)) return false;
          return true;
        });

        renderAnalytics(filtered);
      };
  });
}

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
    const stockNet = txns.reduce((a, t) => a + t.netPL, 0);
    const stockBrkg = txns.reduce((a, t) => a + t.buyBrokerage + t.sellBrokerage, 0);

    listEl.innerHTML += `
      <div class="txn-card">
        <div class="pnl-header" onclick="toggleAnalytics('${stock}')">
          <div class="left-col">
            <div class="txn-name">${stock}</div>
            <div class="tiny-label">Realised Trades: ${txns.length}</div>
          </div>
          <div class="right-col">
            <div class="metric-strong ${stockNet >= 0 ? "profit" : "loss"}">₹${stockNet.toFixed(2)}</div>
            <div class="tiny-label">Brkg: ₹${stockBrkg.toFixed(2)}</div>
          </div>
          <i class="bi bi-chevron-down"></i>
        </div>

        <div id="ana-${stock}" class="pnl-details" style="display:none">
          ${txns.map(t => {
            const beatsFD = t.netPL > t.fdReturn;
            const beatsInflation = t.netPL > t.inflationLoss;

            return `
              <div class="pnl-txn">
                <div class="split-row">
                  <div class="left-col tiny-label">${t.date} | Qty ${t.qty} | Days Held: ${t.daysHeld}</div>
                  <div class="right-col pnl-net ${t.netPL >= 0 ? "profit" : "loss"}">₹${t.netPL.toFixed(2)}</div>
                </div>
                <div class="split-row pnl-kv">
                  <div class="left-col">Invested</div>
                  <div class="right-col">₹${t.invested.toFixed(2)}</div>
                </div>
                <div class="split-row pnl-kv">
                  <div class="left-col">Sold Cost</div>
                  <div class="right-col">₹${t.soldCost.toFixed(2)}</div>
                </div>
                <div class="split-row pnl-kv">
                  <div class="left-col">Brokerage (Buy + Sell)</div>
                  <div class="right-col">₹${(t.buyBrokerage + t.sellBrokerage).toFixed(2)}</div>
                </div>
                <div class="split-row pnl-kv">
                  <div class="left-col">FD Return</div>
                  <div class="right-col">₹${t.fdReturn.toFixed(2)}</div>
                </div>
                <div class="split-row pnl-kv">
                  <div class="left-col">Inflation Impact</div>
                  <div class="right-col">₹${t.inflationLoss.toFixed(2)}</div>
                </div>
                <div class="status-inline">
                  <span class="status-pill-mini ${beatsFD ? "ok" : "bad"}">FD ${beatsFD ? "Better" : "Lower"}</span>
                  <span class="status-pill-mini ${beatsInflation ? "ok" : "bad"}">Inflation ${beatsInflation ? "Beat" : "Below"}</span>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }
}

function toggleAnalytics(stock) {
  const el = document.getElementById(`ana-${stock}`);
  if (!el) return;
  el.style.display = el.style.display === "none" ? "block" : "none";
}

["anaFrom", "anaTo", "anaStock"].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener("input", loadAnalytics);
});

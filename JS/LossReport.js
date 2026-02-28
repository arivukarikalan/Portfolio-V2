/* LossReport.js
   - loadTotalLoss(): compute total historical realized loss (sum of negative sell nets) and update home stat (#dashTotalLoss)
   - loadLossReport(): render page listing stocks with aggregated losses and drilldown per stock -> per-sell details and underlying used buy-lots
*/

function _toDate(d) {
  if (!d) return null;
  return (d instanceof Date) ? d : new Date(d);
}

/* computeSellDetails(stockTxns, sellIdx)
   - stockTxns: chronological transactions for a stock
   - sellIdx: index of a SELL tx within stockTxns
   Returns:
     { net, sellGross, buyCost, sellBrkg, usedLots: [{qty, buyDate, buyPrice, brkgPerUnit}], avgBuyPriceUsed, weightedBuyDate, holdDays }
*/
function computeSellDetails(stockTxns, sellIdx) {
  const sellTx = stockTxns[sellIdx];
  if (!sellTx) return null;
  const sellQty = Number(sellTx.qty || 0);
  const sellPrice = Number(sellTx.price || 0);
  const sellBrkg = Number(sellTx._brkg || 0);
  // build FIFO buy lots before this sell
  const buys = [];
  for (let i = 0; i < sellIdx; i++) {
    const tx = stockTxns[i];
    const ty = (tx.type || tx.txnType || "").toString().toUpperCase();
    if (ty === "BUY") {
      const q = Number(tx.qty || 0);
      const p = Number(tx.price || 0);
      const b = Number(tx._brkg || 0);
      const brkgPerUnit = q > 0 ? b / q : 0;
      buys.push({ qty: q, price: p, brkgPerUnit, date: tx.date });
    }
  }

  let remaining = sellQty;
  let buyCost = 0;
  const usedLots = [];
  for (let i = 0; i < buys.length && remaining > 0; i++) {
    const lot = buys[i];
    const used = Math.min(lot.qty, remaining);
    buyCost += used * (lot.price + (lot.brkgPerUnit || 0));
    usedLots.push({ qty: used, buyDate: lot.date, buyPrice: lot.price, brkgPerUnit: lot.brkgPerUnit });
    remaining -= used;
  }

  const sellGross = sellQty * sellPrice;
  const net = sellGross - buyCost - sellBrkg;

  // compute weighted avg buy date and avg buy price for usedLots
  let totalQtyUsed = 0;
  let weightedTime = 0;
  let weightedBuyPrice = 0;
  usedLots.forEach(l => {
    totalQtyUsed += l.qty;
    const bd = _toDate(l.buyDate);
    if (bd) weightedTime += bd.getTime() * l.qty;
    weightedBuyPrice += (l.buyPrice + (l.brkgPerUnit || 0)) * l.qty;
  });
  const weightedBuyDate = totalQtyUsed ? new Date(Math.floor(weightedTime / totalQtyUsed)) : null;
  const avgBuyPriceUsed = totalQtyUsed ? (weightedBuyPrice / totalQtyUsed) : 0;
  const sellDate = _toDate(sellTx.date);
  const holdDays = (weightedBuyDate && sellDate) ? Math.max(0, Math.floor((sellDate - weightedBuyDate) / 86400000)) : null;

  return { net, sellGross, buyCost, sellBrkg, usedLots, avgBuyPriceUsed, weightedBuyDate, holdDays, sellDate, sellQty, sellPrice };
}

/* loadTotalLoss()
   - scans all transactions and computes sum of negative realized nets (sells)
   - updates #dashTotalLoss if present
*/
function loadTotalLoss() {
  if (typeof db === "undefined" || !db) return;
  // ensure settings are available for brokerage computation
  getSettings((settings) => {
    const req = db.transaction("transactions", "readonly").objectStore("transactions").getAll();
    req.onsuccess = (e) => {
      const txns = (e.target.result || []).sort((a, b) => (_toDate(a.date)?.getTime() || 0) - (_toDate(b.date)?.getTime() || 0));
      // attach brokerage using resolved settings
      txns.forEach(t => {
        try { t._brkg = (typeof resolveTxnBrokerage === "function") ? resolveTxnBrokerage(t, settings) : (t._brkg || 0); }
        catch { t._brkg = t._brkg || 0; }
      });

      // group by stock
      const byStock = {};
      txns.forEach(t => {
        const stock = String(t.stock || "").toUpperCase();
        if (!stock) return;
        byStock[stock] ??= [];
        byStock[stock].push(t);
      });

      let totalLoss = 0;
      Object.values(byStock).forEach(stockTxns => {
        // for each sell, compute realized net
        stockTxns.forEach((tx, idx) => {
          const ty = (tx.type || tx.txnType || "").toString().toUpperCase();
          if (ty === "SELL") {
            const det = computeSellDetails(stockTxns, idx);
            if (det && typeof det.net === "number" && det.net < 0) totalLoss += det.net;
          }
        });
      });

      const el = document.getElementById("dashTotalLoss");
      if (el) {
        const display = totalLoss < 0 ? `-₹${Math.abs(totalLoss).toFixed(2)}` : `₹0.00`;
        el.textContent = display;
      }
    };
  });
}

/* loadLossReport()
   - Renders LossReport.html: stocks with aggregated losses and drilldown per stock
*/
function loadLossReport() {
  if (typeof db === "undefined" || !db) return;
  const tbody = document.querySelector("#lossTable tbody");
  const summaryEl = document.getElementById("lossSummary");
  const detailsEl = document.getElementById("lossDetails");
  const filterInput = document.getElementById("lossFilter");

  tbody.innerHTML = `<tr><td colspan="4" class="text-center tiny-label">Loading...</td></tr>`;
  detailsEl.innerHTML = "";

  // ensure settings are available for brokerage computation
  getSettings((settings) => {
    const req = db.transaction("transactions", "readonly").objectStore("transactions").getAll();
    req.onsuccess = (e) => {
      const txns = (e.target.result || []).sort((a, b) => (_toDate(a.date)?.getTime() || 0) - (_toDate(b.date)?.getTime() || 0));
      txns.forEach(t => { try { t._brkg = (typeof resolveTxnBrokerage === "function") ? resolveTxnBrokerage(t, settings) : (t._brkg || 0); } catch { t._brkg = t._brkg || 0; } });

      const byStock = {};
      txns.forEach(t => {
        const stock = String(t.stock || "").toUpperCase();
        if (!stock) return;
        byStock[stock] ??= [];
        byStock[stock].push(t);
      });

      const rows = Object.keys(byStock).map(stock => {
        const st = byStock[stock];
        let totalLoss = 0;
        let lossSells = 0;
        let totalHold = 0;
        st.forEach((tx, idx) => {
          if ((tx.type || tx.txnType || "").toString().toUpperCase() === "SELL") {
            const d = computeSellDetails(st, idx);
            if (d && typeof d.net === "number" && d.net < 0) {
              totalLoss += d.net; // negative
              lossSells += 1;
              totalHold += (d.holdDays || 0);
            }
          }
        });
        const avgHold = lossSells ? (totalHold / lossSells) : 0;
        return { stock, totalLoss, lossSells, avgHold, txns: st };
      }).filter(r => r.lossSells > 0)
        .sort((a,b) => a.totalLoss - b.totalLoss); // more negative first

      const totalLossAll = rows.reduce((s,r) => s + r.totalLoss, 0);
      summaryEl.innerHTML = `Total loss across stocks: ${totalLossAll < 0 ? '-₹' + Math.abs(totalLossAll).toFixed(2) : '₹0.00'} | Stocks: ${rows.length}`;

      function renderRows(filter) {
        const body = rows.filter(r => !filter || r.stock.includes(filter.toUpperCase())).map(r => `
          <tr class="row-clickable" data-stock="${r.stock}">
            <td>${r.stock}</td>
            <td class="text-end loss-value">${r.totalLoss < 0 ? '-₹' + Math.abs(r.totalLoss).toFixed(2) : '₹0.00'}</td>
            <td class="text-end">${r.lossSells}</td>
            <td class="text-end">${r.avgHold.toFixed(1)}</td>
          </tr>
        `).join('');
        tbody.innerHTML = body || `<tr><td colspan="4" class="text-center text-muted">No loss sells</td></tr>`;
      }

      renderRows(filterInput.value || "");

      // delegate click to show per-stock details
      const tableBody = document.querySelector("#lossTable tbody");
      if (tableBody) {
        tableBody.addEventListener('click', (ev) => {
          const tr = ev.target.closest('tr[data-stock]');
          if (!tr) return;
          const stock = tr.dataset.stock;
          const rec = rows.find(r => r.stock === stock);
          if (!rec) return;

          // build per-sell rows with precise realized net and hold days
          const sells = rec.txns.map((tx, idx) => {
            if ((tx.type || tx.txnType || "").toString().toUpperCase() !== "SELL") return null;
            const d = computeSellDetails(rec.txns, idx);
            if (!d) return null;
            return {
              date: tx.date,
              qty: d.sellQty,
              price: d.sellPrice,
              net: d.net,
              avgBuyUsed: d.avgBuyPriceUsed,
              holdDays: d.holdDays,
              usedLots: d.usedLots
            };
          }).filter(Boolean);

          const sellsHtml = sells.length ? sells.map((s, i) => `
            <div class="txn-card">
              <div class="split-row">
                <div class="left-col">
                  <div class="txn-name">Sell #${i+1} | ${s.date}</div>
                  <div class="tiny-label">Qty: ${s.qty} | Sold Price: ₹${s.price.toFixed(2)} | Avg Buy Used: ₹${s.avgBuyUsed.toFixed(2)}</div>
                </div>
                <div class="right-col">
                  <div class="metric-strong ${s.net >= 0 ? 'profit' : 'loss'}">${s.net >=0 ? '₹' + s.net.toFixed(2) : '-₹' + Math.abs(s.net).toFixed(2)}</div>
                  <div class="tiny-label">${s.holdDays ?? '-'} days</div>
                </div>
              </div>
              <div class="tiny-label mt-1">Underlying buys used:</div>
              <div class="tiny-label">
                ${s.usedLots.map(u => `Qty ${u.qty} @ ₹${u.buyPrice.toFixed(2)} on ${u.buyDate}`).join('<br>')}
              </div>
            </div>
          `).join('') : `<div class="txn-card text-center text-muted">No sell data</div>`;

          detailsEl.innerHTML = `<div class="section-title">Loss details: ${stock}</div>${sellsHtml}`;
          detailsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }

      filterInput.addEventListener('input', () => renderRows(filterInput.value || ""));
    };
  });
}

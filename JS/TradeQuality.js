/* TradeQuality.js
   - Reads transactions from IndexedDB
   - Builds cycles per stock (cycle = buys while position >0 until full exit)
   - Computes per-cycle P/L, avg buy price, hold days
   - Aggregates per-stock summaries and renders table + per-stock cycle details
*/

function _parseDate(d) {
  if (!d) return new Date();
  // support YYYY-MM-DD and Date objects
  if (d instanceof Date) return d;
  const parts = String(d).split("-");
  if (parts.length === 3) return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return new Date(d);
}

function loadTradeQuality() {
  const tbody = document.querySelector("#tqTable tbody");
  const summaryEl = document.getElementById("tqSummary");
  const detailsEl = document.getElementById("tqDetails");
  const filterInput = document.getElementById("tqFilter");

  tbody.innerHTML = `<tr><td colspan="8" class="text-center tiny-label">Loading...</td></tr>`;
  detailsEl.innerHTML = "";

  getSettings(settings => {
    db.transaction("transactions", "readonly").objectStore("transactions").getAll().onsuccess = e => {
      const txns = (e.target.result || []).sort((a, b) => _parseDate(a.date) - _parseDate(b.date));
      const byStock = {};
      // process transactions per stock
      txns.forEach(t => {
        // compute brokerage once and attach to txn for later display
        t._brkg = (typeof resolveTxnBrokerage === "function") ? resolveTxnBrokerage(t, settings) : 0;
        const stock = String(t.stock || "").toUpperCase();
        if (!stock) return;
        byStock[stock] ??= { cycles: [], lots: [], currentCycle: null, investedCurrent: 0, lastPrice: 0, allTxns: [] };
        const s = byStock[stock];
        // keep full transaction history per stock for details view
        s.allTxns.push(t);
        const type = (t.type || t.txnType || "").toString().toUpperCase();
        const qty = Number(t.qty || 0);
        const price = Number(t.price || 0);
        const brkgTotal = t._brkg || 0;
        const brkgPerUnit = qty > 0 ? brkgTotal / qty : 0;

        if (type === "BUY") {
          // start cycle if no lots
          if (!s.currentCycle) {
            s.currentCycle = {
              firstBuyDate: t.date,
              lastBuyDate: t.date,
              totalBuyQty: 0,
              totalBuyValue: 0,
              lots: [],
              realizedNet: 0,
              sells: [],
              endDate: null
            };
          }
          s.currentCycle.totalBuyQty += qty;
          s.currentCycle.totalBuyValue += qty * price + qty * brkgPerUnit;
          s.currentCycle.lots.push({ qty, price, brkgPerUnit, date: t.date });
          s.lots.push({ qty, price, brkgPerUnit, date: t.date });
        } else if (type === "SELL") {
          // allocate sell against FIFO lots
          let sellRemaining = qty;
          let sellBrkg = brkgTotal;
          const sellDate = t.date;
          while (sellRemaining > 0 && s.lots.length) {
            const lot = s.lots[0];
            const used = Math.min(lot.qty, sellRemaining);
            const invested = used * (lot.price + (lot.brokeragePerUnit || 0));
            // proportionate sell brokerage
            const usedSellBrkg = qty > 0 ? (brkgTotal * (used / qty)) : 0;
            const sellValue = used * price;
            const net = sellValue - invested - usedSellBrkg;
            // record into current cycle realizedNet
            if (!s.currentCycle) {
              // if there was a sell without prior recorded buys (edge), create a cycle placeholder
              s.currentCycle = { firstBuyDate: lot.date, lastBuyDate: lot.date, totalBuyQty: 0, totalBuyValue: 0, lots: [], realizedNet: 0, sells: [], endDate: null };
            }
            s.currentCycle.realizedNet += net;
            s.currentCycle.sells.push({ date: sellDate, qty: used, price, net });
            // reduce lot
            lot.qty -= used;
            sellRemaining -= used;
            if (lot.qty === 0) s.lots.shift();
          }
          // if after the sell there are no lots, cycle ends
          if (s.currentCycle && s.lots.length === 0) {
            s.currentCycle.endDate = t.date;
            // compute avgPrice of buys in cycle
            const totalBuyQty = s.currentCycle.lots.reduce((a, l) => a + Number(l.qty || 0), 0) || s.currentCycle.totalBuyQty || 0;
            const totalBuyValue = s.currentCycle.totalBuyValue || (s.currentCycle.lots.reduce((a, l) => a + l.qty * (l.price + (l.brokeragePerUnit || 0)), 0));
            const avgPrice = totalBuyQty > 0 ? (totalBuyValue / totalBuyQty) : 0;
            // days held
            const daysHeld = s.currentCycle.endDate ? Math.floor((_parseDate(s.currentCycle.endDate) - _parseDate(s.currentCycle.firstBuyDate)) / 86400000) : null;
            s.cycles.push({
              firstBuyDate: s.currentCycle.firstBuyDate,
              endDate: s.currentCycle.endDate,
              realizedNet: s.currentCycle.realizedNet || 0,
              avgBuyPrice: avgPrice,
              totalBuyQty,
              daysHeld
            });
            s.currentCycle = null;
          }
        }
        s.lastPrice = price || s.lastPrice;
      });

      // build per-stock summary rows
      const stocks = Object.keys(byStock).sort();
      const rows = stocks.map(stock => {
        const s = byStock[stock];
        const cycles = s.cycles || [];
        const cyclesCount = cycles.length;
        const wins = cycles.filter(c => c.realizedNet >= 0).length;
        const losses = cyclesCount - wins;
        const avgPL = cyclesCount ? (cycles.reduce((a, c) => a + c.realizedNet, 0) / cyclesCount) : 0;
        const avgHold = cyclesCount ? (cycles.reduce((a, c) => a + (c.daysHeld || 0), 0) / cyclesCount) : 0;
        // highestLoss = worst negative cycle (most negative realized net) or 0 if none
        const lossValues = cycles.map(c => c.realizedNet).filter(v => v < 0);
        const highestLoss = lossValues.length ? Math.min(...lossValues) : 0;
        // current invested (active lots remaining) approximate
        const investedCurrent = (s.lots || []).reduce((a, l) => a + l.qty * (l.price + (l.brokeragePerUnit || 0)), 0);
        const referencePrice = s.lastPrice || (s.lots[0]?.price || 0);
        return { stock, cyclesCount, wins, losses, avgPL, avgHold, highestLoss, investedCurrent, referencePrice, cycles, allTxns: s.allTxns || [] };
      });

      // compute portfolio totals to support allocation checks
      const totalActiveInvested = rows.reduce((a, r) => a + (r.investedCurrent || 0), 0);
      const portfolioSize = Number(settings.portfolioSize || 0);
      const maxAllocPct = Number(settings.maxAllocationPct || 0);

      // render summary
      summaryEl.innerHTML = `
        <div class="tiny-label">Stocks: ${rows.length} | Active invested: ₹${totalActiveInvested.toFixed(2)} | Portfolio Size: ₹${portfolioSize || 0}</div>
      `;

      // render table
      const renderRows = (filter) => {
        const body = rows.filter(r => !filter || r.stock.includes(filter.toUpperCase())).map(r => {
          // suggestion logic
          let suggestion = "Neutral";
          if (r.cyclesCount === 0) suggestion = "No cycles yet";
          else if (r.wins > r.losses) suggestion = "Consider re-invest";
          else suggestion = "Avoid new buys";

          // over allocation suggestion
          let overAllocNote = "";
          if (portfolioSize > 0 && maxAllocPct > 0) {
            const maxStockBudget = (portfolioSize * maxAllocPct) / 100;
            if (r.investedCurrent > maxStockBudget) {
              const amountToTrim = r.investedCurrent - maxStockBudget;
              const suggestedTrimQty = r.referencePrice > 0 ? Math.ceil(amountToTrim / r.referencePrice) : 0;
              // use prominent risk pill for over-allocation
              overAllocNote = ` <div class="tiny-label"><span class="risk-pill bad">Over-alloc by ₹${amountToTrim.toFixed(2)} → Trim ~${suggestedTrimQty} qty</span></div>`;
            }
          }

          return `
            <tr data-stock="${r.stock}">
              <td>${r.stock}</td>
              <td class="text-end">${r.cyclesCount}</td>
              <td class="text-end">${r.wins}</td>
              <td class="text-end">${r.losses}</td>
              <td class="text-end">₹${r.avgPL.toFixed(2)}</td>
              <td class="text-end">${r.avgHold.toFixed(1)}</td>
              <td class="text-end">₹${r.highestLoss.toFixed(2)}</td>
              <td>${suggestion}${overAllocNote}</td>
            </tr>
          `;
        }).join("");
        tbody.innerHTML = body || `<tr><td colspan="8" class="text-center text-muted">No stocks</td></tr>`;
      };

      renderRows(filterInput.value || "");

      // Delegate clicks on tbody so handlers persist after re-render
      const tableBody = document.querySelector("#tqTable tbody");
      if (tableBody) {
        tableBody.addEventListener('click', (ev) => {
          const tr = ev.target.closest('tr[data-stock]');
          if (!tr) return;
          const stock = tr.dataset.stock;
          const rec = rows.find(r => r.stock === stock);
          if (!rec) return;

          // build cycles summary
          const cyclesHtml = rec.cycles.length ? rec.cycles.map((c, i) => `
            <div class="txn-card">
              <div class="split-row">
                <div class="left-col">
                  <div class="txn-name">Cycle #${i+1}</div>
                  <div class="tiny-label">First Buy: ${c.firstBuyDate} | End: ${c.endDate}</div>
                  <div class="tiny-label">Qty: ${c.totalBuyQty || '-'}</div>
                </div>
                <div class="right-col">
                  <div class="metric-strong ${c.realizedNet >= 0 ? 'profit' : 'loss'}">₹${c.realizedNet.toFixed(2)}</div>
                  <div class="tiny-label">${c.daysHeld ?? '-'} days</div>
                </div>
              </div>
              <div class="tiny-label mt-1">Avg Buy: ₹${c.avgBuyPrice.toFixed(2)}</div>
            </div>
          `).join('') : `<div class="txn-card text-center text-muted">No completed cycles</div>`;

          // build transactions table (simple view)
          const stockTxns = rec.allTxns || [];
          const txRows = stockTxns.map((tx, idx) => {
            const ty = (tx.type || tx.txnType || "").toString().toUpperCase();
            const brkg = Number(tx._brkg || 0);
            let netDisplay = '-';
            if (ty === 'SELL') {
              const res = computeSellNet(stockTxns, idx);
              if (res && typeof res.net === 'number') {
                netDisplay = `${res.net >= 0 ? '₹' + res.net.toFixed(2) : '-₹' + Math.abs(res.net).toFixed(2)}`;
              } else {
                // fallback to gross - brkg if compute fails
                const gross = Number(tx.qty || 0) * Number(tx.price || 0);
                netDisplay = `₹${(gross - brkg).toFixed(2)}`;
              }
            }
            return `<tr>
              <td>${tx.date}</td>
              <td>${ty}</td>
              <td class="text-end">${Number(tx.qty || 0)}</td>
              <td class="text-end">₹${Number(tx.price || 0).toFixed(2)}</td>
              <td class="text-end">₹${brkg.toFixed(2)}</td>
              <td class="text-end">${netDisplay}</td>
            </tr>`;
          }).join('');

          const txTable = `
            <div class="section-title mt-3">Transactions: ${stock}</div>
            <div class="table-responsive txn-table">
              <table class="table table-sm table-bordered">
                <thead>
                  <tr><th>Date</th><th>Type</th><th class="text-end">Qty</th><th class="text-end">Price</th><th class="text-end">Brokerage</th><th class="text-end">Net (sell gross - brkg)</th></tr>
                </thead>
                <tbody>${txRows || `<tr><td colspan="6" class="text-center text-muted">No transactions</td></tr>`}</tbody>
              </table>
            </div>`;

          detailsEl.innerHTML = `<div class="section-title">Cycles: ${stock}</div>${cyclesHtml}${txTable}`;
          // bring details into view for the user
          detailsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }

      // filter handler
      filterInput.addEventListener("input", () => renderRows(filterInput.value || ""));
    };
  });
}

/* Helper: compute realized net for a sell transaction at index sellIdx within stockTxns (chronological)
   - Builds FIFO buy lots from prior BUY transactions
   - Consumes sell qty and returns realized net = sellGross - buyCost - sellBrokerage
*/
function computeSellNet(stockTxns, sellIdx) {
  const sellTx = stockTxns[sellIdx];
  if (!sellTx) return null;
  const sellQty = Number(sellTx.qty || 0);
  const sellPrice = Number(sellTx.price || 0);
  const sellBrkg = Number(sellTx._brkg || 0);

  // build FIFO buy lots from transactions before sellIdx
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
  for (let i = 0; i < buys.length && remaining > 0; i++) {
    const lot = buys[i];
    const used = Math.min(lot.qty, remaining);
    buyCost += used * (lot.price + (lot.brkgPerUnit || 0));
    remaining -= used;
  }

  // if not enough buy lots, we still compute with what we have (partial)
  const sellGross = sellQty * sellPrice;
  const net = sellGross - buyCost - sellBrkg;
  return { net, sellGross, buyCost, sellBrkg };
}

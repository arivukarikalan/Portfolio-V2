/* =========================================================
   FILE: transactions.js
   FEATURES COVERED:
   1. Brokerage Calculation
   2. Add / Edit Transactions
   3. Transaction History Rendering
   4. FIFO Holdings Calculation
   5. FIFO Profit & Loss Calculation
   6. Dashboard Aggregation
   7. Multi-page Safe Rendering
   ========================================================= */


   /* ================= FILTER DEFAULTS ================= */
function initTransactionFilters() {
  const from = document.getElementById("filterFrom");
  const to = document.getElementById("filterTo");

  if (!from || !to) return;

  const today = new Date();
  const last3Months = new Date();
  last3Months.setMonth(today.getMonth() - 3);

  from.value = last3Months.toISOString().split("T")[0];
  to.value = today.toISOString().split("T")[0];
}

function normalizeStockName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function parseDateLocal(dateStr) {
  const parts = String(dateStr || "").split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return new Date(dateStr);
  return new Date(y, m - 1, d);
}

function resolveTxnBrokerage(txn, settings) {
  const raw = Number(txn.brokerage);
  if (raw > 0) return raw;
  return calculateBrokerage(txn.type, Number(txn.qty), settings);
}

function refreshStockOptions() {
  const list = document.getElementById("stockOptions");
  if (!list) return;

  db.transaction("transactions", "readonly")
    .objectStore("transactions")
    .getAll().onsuccess = e => {
      const names = Array.from(
        new Set((e.target.result || []).map(t => normalizeStockName(t.stock)).filter(Boolean))
      ).sort();

      list.innerHTML = names.map(n => `<option value="${n}"></option>`).join("");
    };
}

/* =========================================================
   FEATURE 1: BROKERAGE CALCULATION
   RULES:
   - BUY  -> % brokerage only
   - SELL -> % brokerage + DP charge (once per sell)
   ========================================================= */
   function calculateBrokerage(type, qty, settings) {
    if (type === "BUY") {
      return (settings.brokerageBuyPct / 100) * qty;
    }
    return (settings.brokerageSellPct / 100) * qty + settings.dpCharge;
  }
  
  
  /* =========================================================
     FEATURE 2: TRANSACTION ENTRY FORM
     - Default date = today
     - Supports ADD & EDIT
     - Auto refreshes all dependent sections
     ========================================================= */
  function initTransactionForm() {
    const form = document.getElementById("txnForm");
    if (!form) return;
  
    const dateInput = document.getElementById("txnDate");
    const stockInputEl = document.getElementById("stockInput");
    dateInput.value = new Date().toISOString().split("T")[0];
    if (stockInputEl) {
      stockInputEl.addEventListener("blur", () => {
        stockInputEl.value = normalizeStockName(stockInputEl.value);
      });
    }
    refreshStockOptions();
  
    form.onsubmit = e => {
      e.preventDefault();
  
      const editId = editTxnId.value;
      const type = txnType.value;
      const date = dateInput.value;
      const stock = normalizeStockName(stockInput.value);
      const qty = Number(qtyInput.value);
      const price = Number(priceInput.value);
  
      if (!date || !stock || qty <= 0 || price <= 0) {
        if (typeof showToast === "function") {
          showToast("Please fill valid stock, quantity, price, and date", "error");
        } else {
          alert("Invalid input");
        }
        return;
      }
  
      getSettings(settings => {
        const brokerage = calculateBrokerage(type, qty, settings);
  
        const data = {
          date,
          stock,
          type,
          qty,
          price,
          brokerage,   // Brokerage includes DP for SELL
          dpCharge: 0  // Stored only for display (not re-added)
        };
  
        const tx = db.transaction("transactions", "readwrite");
        const store = tx.objectStore("transactions");
  
        editId
          ? store.put({ ...data, id: Number(editId) })
          : store.add(data);

        tx.oncomplete = () => {
          form.reset();
          editTxnId.value = "";
          dateInput.value = new Date().toISOString().split("T")[0];
  
          loadTransactions();
          calculateHoldings();
          calculatePnL();
          loadDashboard();
          refreshStockOptions();

          if (typeof showToast === "function") {
            showToast(editId ? "Transaction updated successfully" : "Transaction saved successfully");
          }
        };
      });
    };
  }
  
  
  /* =========================================================
     FEATURE 3: TRANSACTION HISTORY
     - Soft card rendering
     - Edit & Delete supported
     ========================================================= */
     function loadTransactions() {
      const txnList = document.getElementById("txnList");
      if (!txnList) return;
    
      const type = document.getElementById("filterType")?.value || "ALL";
      const from = document.getElementById("filterFrom")?.value;
      const to = document.getElementById("filterTo")?.value;
      const stock = document.getElementById("filterStock")?.value.toLowerCase() || "";
    
      db.transaction("transactions", "readonly")
        .objectStore("transactions")
        .getAll().onsuccess = e => {
          let data = e.target.result;
    
          /* ===== Apply Filters ===== */
          data = data.filter(t => {
            if (type !== "ALL" && t.type !== type) return false;
            if (from && new Date(t.date) < new Date(from)) return false;
            if (to && new Date(t.date) > new Date(to)) return false;
            if (stock && !t.stock.toLowerCase().includes(stock)) return false;
            return true;
          });
    
          renderTransactions(data);
        };
    }

    /* ================= FILTER EVENTS ================= */
function bindFilterEvents() {
  ["filterType", "filterFrom", "filterTo", "filterStock"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", loadTransactions);
  });
}
  
  function renderTransactions(data) {
    const txnList = document.getElementById("txnList");
    if (!txnList) return;
  
    txnList.innerHTML = "";
  
    if (!data.length) {
      txnList.innerHTML =
        `<div class="txn-card text-center text-muted">No transactions</div>`;
      return;
    }
  
    data
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .forEach(t => {
        const buyCost =
          t.type === "BUY"
            ? (t.qty * t.price + t.brokerage).toFixed(2)
            : null;
  
        txnList.innerHTML += `
          <div class="txn-card">
            <div class="txn-top">
              <div>
                <div class="txn-name">${t.stock}</div>
                <div class="txn-sub">
                  ${t.date} | ${t.type} | Qty ${t.qty} @ ₹${t.price.toFixed(2)}
                  ${buyCost ? ` | Buy Cost ₹${buyCost}` : ""}
                </div>
              </div>
              <div class="txn-actions">
                <button class="btn btn-sm btn-warning" onclick="editTxn(${t.id})">
                  <i class="bi bi-pencil"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="deleteTxn(${t.id})">
                  <i class="bi bi-trash"></i>
                </button>
              </div>
            </div>
          </div>`;
      });
  }
  
  function editTxn(id) {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .get(id).onsuccess = e => {
        const t = e.target.result;
        editTxnId.value = t.id;
        txnType.value = t.type;
        txnDate.value = t.date;
        stockInput.value = normalizeStockName(t.stock);
        qtyInput.value = t.qty;
        priceInput.value = t.price;

        if (typeof showToast === "function") {
          showToast(`Editing ${t.stock} transaction`, "info");
        }
      };
  }
  
  function deleteTxn(id) {
    if (!confirm("Delete this transaction permanently?")) return;
  
    const tx = db.transaction("transactions", "readwrite");
    tx.objectStore("transactions").delete(id);
  
    tx.oncomplete = () => {
      loadTransactions();
      calculateHoldings();
      calculatePnL();
      loadDashboard();
      refreshStockOptions();

      if (typeof showToast === "function") {
        showToast("Transaction deleted successfully");
      }
    };
  }
  
  
  /* =========================================================
     FEATURE 4: HOLDINGS CALCULATION (FIFO)
     - Uses FIFO lots
     - Calculates Avg Price, Invested, Days Held
     ========================================================= */
  function calculateHoldings() {
    const holdingsList = document.getElementById("holdingsList");
    if (!holdingsList) return;
  
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = e.target.result.sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        );
  
        const map = {};

        txns.forEach(t => {
          map[t.stock] ??= { lots: [], cycleFirstBuy: null };

          if (t.type === "BUY") {
            if (map[t.stock].lots.length === 0) {
              map[t.stock].cycleFirstBuy = t.date;
            }
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
  
        holdingsList.innerHTML = "";
  
        for (const s in map) {
          const lots = map[s].lots;
          if (!lots.length) continue;
  
          const qty = lots.reduce((a, l) => a + l.qty, 0);
          const invested = lots.reduce(
            (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
            0
          );
          const days = Math.floor(
            (new Date() - parseDateLocal(map[s].cycleFirstBuy)) / 86400000
          );
  
          holdingsList.innerHTML += `
            <div class="txn-card">
              <div class="txn-name">${s}</div>
              <div class="txn-sub">
                Qty ${qty} |
                Avg ₹${(invested / qty).toFixed(2)} |
                Invested ₹${invested.toFixed(2)} |
                Days ${days}
              </div>
            </div>`;
        }
  
        if (!holdingsList.innerHTML) {
          holdingsList.innerHTML =
            `<div class="txn-card text-center text-muted">No holdings</div>`;
        }
      };
  }
  
  
  /* =========================================================
     FEATURE 5: PROFIT & LOSS (FIFO - REALISED)
     - Independent sell calculation
     - Accurate brokerage & DP handling
     ========================================================= */
function calculatePnL() {
  const pnlList = document.getElementById("pnlList");
  if (!pnlList) return;

  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = e.target.result.sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        );

        const fifo = {};
        const result = [];

        txns.forEach(t => {
          fifo[t.stock] ??= [];

          if (t.type === "BUY") {
            const buyBrkg = resolveTxnBrokerage(t, settings);
            fifo[t.stock].push({
              qty: t.qty,
              price: t.price,
              brokeragePerUnit: buyBrkg / t.qty
            });
          } else {
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
            const sellBrokerage = resolveTxnBrokerage(t, settings);

            result.push({
              stock: t.stock,
              date: t.date,
              qty: t.qty,
              sellPrice: t.price,
              buyCost,
              buyBrokerage,
              sellBrokerage,
              net:
                sellValue -
                buyCost -
                buyBrokerage -
                sellBrokerage
            });
          }
        });

        applyPnLFilters(result);
      };
  });
}

  /* ================= P/L FILTER + GROUP ================= */
function applyPnLFilters(data) {
  const from = document.getElementById("pnlFrom")?.value;
  const to = document.getElementById("pnlTo")?.value;
  const stockFilter = document.getElementById("pnlStock")?.value.toLowerCase() || "";

  let filtered = data.filter(p => {
    if (from && new Date(p.date) < new Date(from)) return false;
    if (to && new Date(p.date) > new Date(to)) return false;
    if (stockFilter && !p.stock.toLowerCase().includes(stockFilter)) return false;
    return true;
  });

  renderGroupedPnL(filtered);
}
  
/* ================= GROUPED P/L RENDER ================= */
function renderGroupedPnL(data) {
  const pnlList = document.getElementById("pnlList");
  if (!pnlList) return;

  pnlList.innerHTML = "";

  if (!data.length) {
    pnlList.innerHTML =
      `<div class="txn-card text-center text-muted">No matching sell transactions</div>`;
    return;
  }

  /* Group by stock */
  const grouped = {};
  data.forEach(p => {
    grouped[p.stock] ??= [];
    grouped[p.stock].push(p);
  });

  Object.keys(grouped).forEach(stock => {
    const txns = grouped[stock];
    const totalNet = txns.reduce((a, t) => a + t.net, 0);
    const totalBuyBrkg = txns.reduce((a, t) => a + t.buyBrokerage, 0);
    const totalSellBrkg = txns.reduce((a, t) => a + t.sellBrokerage, 0);
    const totalTrades = txns.length;
    const cls = totalNet >= 0 ? "profit" : "loss";

    const id = `pnl-${stock.replace(/\s+/g, "")}`;

    pnlList.innerHTML += `
      <div class="txn-card">
        <div class="pnl-header" onclick="togglePnL('${id}')">
          <div class="left-col">
            <div class="txn-name">${stock}</div>
            <div class="tiny-label">Realised Trades: ${totalTrades}</div>
          </div>
          <div class="right-col">
            <div class="metric-strong ${cls}">₹${totalNet.toFixed(2)}</div>
            <div class="tiny-label">Brokerage: ₹${(totalBuyBrkg + totalSellBrkg).toFixed(2)}</div>
          </div>
          <i class="bi bi-chevron-down"></i>
        </div>

        <div id="${id}" class="pnl-details" style="display:none">
          ${txns.map(t => `
            <div class="pnl-txn">
              <div class="split-row">
                <div class="left-col tiny-label">${t.date} | Qty ${t.qty} @ ₹${t.sellPrice}</div>
                <div class="right-col pnl-net ${t.net >= 0 ? "profit" : "loss"}">₹${t.net.toFixed(2)}</div>
              </div>
              <div class="split-row pnl-kv">
                <div class="left-col">Buy Cost</div>
                <div class="right-col">₹${t.buyCost.toFixed(2)}</div>
              </div>
              <div class="split-row pnl-kv">
                <div class="left-col">Buy Brkg</div>
                <div class="right-col">₹${t.buyBrokerage.toFixed(2)}</div>
              </div>
              <div class="split-row pnl-kv">
                <div class="left-col">Sell Brkg</div>
                <div class="right-col">₹${t.sellBrokerage.toFixed(2)}</div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  });
}

/* ================= EXPAND / COLLAPSE ================= */
function togglePnL(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === "none" ? "block" : "none";
}

/* ================= P/L FILTER DEFAULT DATES ================= */
function initPnLFilters() {
  const from = document.getElementById("pnlFrom");
  const to = document.getElementById("pnlTo");

  if (!from || !to) return;

  const today = new Date();
  const last3Months = new Date();
  last3Months.setMonth(today.getMonth() - 3);

  from.value = last3Months.toISOString().split("T")[0];
  to.value = today.toISOString().split("T")[0];
}
  
  
  /* =====================================================
   FEATURE: Dashboard Summary
   - Total Invested (ACTIVE holdings only)
   - Total Realised P/L
   - Active Holdings Count
   ===================================================== */
function loadDashboard() {
  const investedEl = document.getElementById("dashInvested");
  const pnlEl = document.getElementById("dashPnL");
  const holdingsEl = document.getElementById("dashHoldings");
  const brokerageEl = document.getElementById("dashBrokerage");

  if (!investedEl || !pnlEl || !holdingsEl) return;

  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {

      const txns = e.target.result.sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );

      const map = {};
      const brokerageByStock = {};
      let totalPnL = 0;
      let totalBrokerage = 0;

      /* =============================================
         STEP 1: Build FIFO Holdings + Realised P/L
         ============================================= */
      txns.forEach(t => {
        map[t.stock] ??= { lots: [] };
        const txnBrokerage = resolveTxnBrokerage(t, settings);
        totalBrokerage += txnBrokerage;
        brokerageByStock[t.stock] ??= { buy: 0, sell: 0, total: 0 };
        if (t.type === "BUY") brokerageByStock[t.stock].buy += txnBrokerage;
        else brokerageByStock[t.stock].sell += txnBrokerage;
        brokerageByStock[t.stock].total += txnBrokerage;

        if (t.type === "BUY") {
          map[t.stock].lots.push({
            qty: t.qty,
            price: t.price,
            brokeragePerUnit: txnBrokerage / t.qty,
            date: t.date
          });
        } else {
          let sellQty = t.qty;
          let buyCost = 0;
          let buyBrokerage = 0;

          while (sellQty > 0 && map[t.stock].lots.length) {
            const lot = map[t.stock].lots[0];
            const used = Math.min(lot.qty, sellQty);

            buyCost += used * lot.price;
            buyBrokerage += used * lot.brokeragePerUnit;

            lot.qty -= used;
            sellQty -= used;

            if (lot.qty === 0) {
              map[t.stock].lots.shift();
            }
          }

          const sellValue = t.qty * t.price;

          const net =
            sellValue -
            buyCost -
            buyBrokerage -
            txnBrokerage;

          totalPnL += net;
        }
      });

      /* =============================================
         STEP 2: Total Invested (ACTIVE holdings only)
         ============================================= */
      let totalInvested = 0;
      let activeHoldings = 0;

      for (const stock in map) {
        const lots = map[stock].lots;
        if (!lots.length) continue;

        activeHoldings++;

        totalInvested += lots.reduce(
          (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
          0
        );
      }

      /* =============================================
         STEP 3: Update Dashboard UI
         ============================================= */
      investedEl.innerText = `₹${totalInvested.toFixed(2)}`;
      pnlEl.innerText = `₹${totalPnL.toFixed(2)}`;
      holdingsEl.innerText = activeHoldings;
      if (brokerageEl) brokerageEl.innerText = `₹${totalBrokerage.toFixed(2)}`;

      const brkgBody = document.getElementById("brokerageBreakdownBody");
      if (brkgBody) {
        const rows = Object.keys(brokerageByStock)
          .map(stock => ({ stock, ...brokerageByStock[stock] }))
          .filter(r => r.total > 0)
          .sort((a, b) => b.total - a.total);

        brkgBody.innerHTML = rows.length
          ? rows.map(r => `
              <tr>
                <td>${r.stock}</td>
                <td class="text-end">₹${r.buy.toFixed(2)}</td>
                <td class="text-end">₹${r.sell.toFixed(2)}</td>
                <td class="text-end fw-semibold">₹${r.total.toFixed(2)}</td>
              </tr>
            `).join("")
          : `<tr><td colspan="4" class="text-center text-muted">No brokerage data</td></tr>`;
      }

      const topHoldingsEl = document.getElementById("topHoldingsList");
      const homeInsightEl = document.getElementById("homeInsight");
      if (topHoldingsEl && homeInsightEl) {
        const rows = Object.keys(map)
          .map(stock => {
            const lots = map[stock].lots;
            if (!lots.length) return null;
            const invested = lots.reduce(
              (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
              0
            );
            const firstDate = lots[0].date;
            const days = Math.floor((new Date() - parseDateLocal(firstDate)) / 86400000);
            return { stock, invested, days };
          })
          .filter(Boolean)
          .sort((a, b) => b.invested - a.invested);

        const top2 = rows.slice(0, 2);
        if (!top2.length) {
          topHoldingsEl.innerHTML = `<div class="text-muted">No active holdings</div>`;
          homeInsightEl.textContent = "";
        } else {
          topHoldingsEl.innerHTML = top2.map(r => `
            <div class="txn-card">
              <div class="split-row">
                <div class="left-col">
                  <div class="txn-name">${r.stock}</div>
                  <div class="txn-sub">Hold Days: ${r.days}</div>
                </div>
                <div class="right-col">
                  <div class="metric-strong text-primary">₹${r.invested.toFixed(2)}</div>
                  <div class="tiny-label">Invested</div>
                </div>
              </div>
            </div>
          `).join("");

          const top2Invested = top2.reduce((a, r) => a + r.invested, 0);
          const concentration = totalInvested > 0 ? (top2Invested / totalInvested) * 100 : 0;
          homeInsightEl.textContent =
            `Top 2 concentration: ${concentration.toFixed(2)}% of active invested capital.`;
        }
      }
    };
  });
}

function toggleBrokerageBreakdown() {
  const panel = document.getElementById("brokeragePanel");
  if (!panel) return;
  panel.style.display = panel.style.display === "none" ? "block" : "none";
}



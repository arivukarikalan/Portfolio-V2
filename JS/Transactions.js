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
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - 7);

  from.value = lastWeek.toISOString().split("T")[0];
  to.value = today.toISOString().split("T")[0];
}

/* =========================================================
   FEATURE 1: BROKERAGE CALCULATION
   RULES:
   - BUY  → % brokerage only
   - SELL → % brokerage + DP charge (once per sell)
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
    dateInput.value = new Date().toISOString().split("T")[0];
  
    form.onsubmit = e => {
      e.preventDefault();
  
      const editId = editTxnId.value;
      const type = txnType.value;
      const date = dateInput.value;
      const stock = stockInput.value.trim();
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
        stockInput.value = t.stock;
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
          map[t.stock] ??= { lots: [], firstBuy: t.date };
  
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
            (new Date() - new Date(map[s].firstBuy)) / 86400000
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
     FEATURE 5: PROFIT & LOSS (FIFO – REALISED)
     - Independent sell calculation
     - Accurate brokerage & DP handling
     ========================================================= */
  function calculatePnL() {
    const pnlList = document.getElementById("pnlList");
    if (!pnlList) return;
  
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
            fifo[t.stock].push({
              qty: t.qty,
              price: t.price,
              brokeragePerUnit: t.brokerage / t.qty
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
  
            result.push({
              stock: t.stock,
              date: t.date,          // ✅ FIX: add sell date
              qty: t.qty,
              sellPrice: t.price,
              buyCost,
              buyBrokerage,
              sellBrokerage: t.brokerage,
              net:
                sellValue -
                buyCost -
                buyBrokerage -
                t.brokerage
            });
          }
        });
  
        applyPnLFilters(result);
      };
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
    const cls = totalNet >= 0 ? "profit" : "loss";

    const id = `pnl-${stock.replace(/\s+/g, "")}`;

    pnlList.innerHTML += `
      <div class="txn-card">
        <div class="pnl-header" onclick="togglePnL('${id}')">
          <div>
            <div class="txn-name ${cls}">${stock}</div>
            <div class="txn-sub">
              Net P/L: ₹${totalNet.toFixed(2)}
            </div>
          </div>
          <i class="bi bi-chevron-down"></i>
        </div>

        <div id="${id}" class="pnl-details" style="display:none">
          ${txns.map(t => `
            <div class="pnl-txn">
              <small>
                ${t.date} | Qty ${t.qty} @ ₹${t.sellPrice}<br>
                Buy Cost: ₹${t.buyCost.toFixed(2)} |
                Buy Brkg: ₹${t.buyBrokerage.toFixed(2)}<br>
                Sell Brkg: ₹${t.sellBrokerage.toFixed(2)}<br>
                <b>Net P/L: ₹${t.net.toFixed(2)}</b>
              </small>
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
  const lastMonth = new Date();
  lastMonth.setDate(today.getDate() - 30);

  from.value = lastMonth.toISOString().split("T")[0];
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

  if (!investedEl || !pnlEl || !holdingsEl) return;

  db.transaction("transactions", "readonly")
    .objectStore("transactions")
    .getAll().onsuccess = e => {

      const txns = e.target.result.sort(
        (a, b) => new Date(a.date) - new Date(b.date)
      );

      const map = {};
      let totalPnL = 0;

      /* =============================================
         STEP 1: Build FIFO Holdings + Realised P/L
         ============================================= */
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
            t.brokerage;

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
    };
}

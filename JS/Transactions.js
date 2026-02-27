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
  return calculateBrokerage(
    txn.type,
    Number(txn.qty),
    Number(txn.price),
    settings
  );
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

function buildActiveSnapshotForChecklist(txns, settings) {
  const map = {};

  txns
    .slice()
    .sort((a, b) => parseDateLocal(a.date) - parseDateLocal(b.date))
    .forEach(t => {
      const stock = normalizeStockName(t.stock);
      map[stock] ??= {
        lots: [],
        cycleFirstBuyPrice: null,
        cycleFirstBuyDate: null,
        cycleLastBuyPrice: null,
        cycleLastBuyDate: null
      };
      const s = map[stock];

      if (t.type === "BUY") {
        if (s.lots.length === 0) {
          s.cycleFirstBuyPrice = Number(t.price);
          s.cycleFirstBuyDate = t.date;
        }
        s.cycleLastBuyPrice = Number(t.price);
        s.cycleLastBuyDate = t.date;
        const brkg = resolveTxnBrokerage(t, settings);
        s.lots.push({
          qty: Number(t.qty),
          price: Number(t.price),
          brokeragePerUnit: brkg / Number(t.qty),
          date: t.date
        });
      } else {
        let sellQty = Number(t.qty);
        while (sellQty > 0 && s.lots.length) {
          const lot = s.lots[0];
          const used = Math.min(lot.qty, sellQty);
          lot.qty -= used;
          sellQty -= used;
          if (lot.qty === 0) s.lots.shift();
        }
      }
    });

  const totalActiveInvested = Object.keys(map).reduce((sum, stock) => {
    const invested = map[stock].lots.reduce((a, l) => a + l.qty * (l.price + l.brokeragePerUnit), 0);
    return sum + invested;
  }, 0);

  return { map, totalActiveInvested };
}

function runPreBuyChecklist() {
  const type = document.getElementById("txnType")?.value || "BUY";
  const panel = document.getElementById("preBuyChecklist");
  if (!panel) return;

  if (type !== "BUY") {
    panel.style.display = "block";
    panel.innerHTML = `<div class="tiny-label">Checklist applies to BUY transactions only.</div>`;
    return;
  }

  const stock = normalizeStockName(document.getElementById("stockInput")?.value || "");
  const qty = Number(document.getElementById("qtyInput")?.value || 0);
  const price = Number(document.getElementById("priceInput")?.value || 0);

  if (!stock || qty <= 0 || price <= 0) {
    panel.style.display = "block";
    panel.innerHTML = `<div class="tiny-label">Enter stock, quantity, and price to run checklist.</div>`;
    return;
  }

  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const txns = e.target.result || [];
        const { map, totalActiveInvested } = buildActiveSnapshotForChecklist(txns, settings);
        const s = map[stock] || {
          lots: [],
          cycleFirstBuyPrice: price,
          cycleFirstBuyDate: "",
          cycleLastBuyPrice: price,
          cycleLastBuyDate: ""
        };

        const existingInvested = s.lots.reduce((a, l) => a + l.qty * (l.price + l.brokeragePerUnit), 0);
        const existingQty = s.lots.reduce((a, l) => a + l.qty, 0);
        const buyBrokerage = calculateBrokerage("BUY", qty, price, settings);
        const newBuyCost = qty * price + buyBrokerage;

        const postStockInvested = existingInvested + newBuyCost;
        const postTotalInvested = totalActiveInvested + newBuyCost;
        const postAllocPct = postTotalInvested > 0 ? (postStockInvested / postTotalInvested) * 100 : 0;

        const maxAllocPct = Number(settings.maxAllocationPct || 0);
        const stockBudget = (Number(settings.portfolioSize || 0) * maxAllocPct) / 100;
        const remainingBudget = stockBudget - postStockInvested;

        const base = Number(s.cycleFirstBuyPrice || price);
        const l1 = base * (1 - Number(settings.avgLevel1Pct || 0) / 100);
        const l2 = base * (1 - Number(settings.avgLevel2Pct || 0) / 100);

        let zoneText = "Above L1/L2 zones";
        let zoneCls = "status-pill-mini bad";
        if (price <= l2) {
          zoneText = "In L2 zone";
          zoneCls = "status-pill-mini ok";
        } else if (price <= l1) {
          zoneText = "In L1 zone";
          zoneCls = "status-pill-mini warn";
        }

        const lastBuyPrice = Number(s.cycleLastBuyPrice || price);
        const dropFromLastPct = lastBuyPrice > 0 ? ((lastBuyPrice - price) / lastBuyPrice) * 100 : 0;
        const avgRuleHit = dropFromLastPct >= Number(settings.avgLevel1Pct || 0);
        const avgRuleText = avgRuleHit
          ? `Drop from last buy: ${dropFromLastPct.toFixed(2)}% (meets Avg L1 rule)`
          : `Drop from last buy: ${dropFromLastPct.toFixed(2)}% (below Avg L1 rule)`;
        const avgRuleCls = avgRuleHit ? "status-pill-mini ok" : "status-pill-mini bad";

        const projectedAvg = (existingQty + qty) > 0
          ? (postStockInvested / (existingQty + qty))
          : price;

        const allocCls = postAllocPct > maxAllocPct ? "status-pill-mini bad" : "status-pill-mini ok";
        const allocText = postAllocPct > maxAllocPct
          ? `Allocation ${postAllocPct.toFixed(2)}% (exceeds ${maxAllocPct.toFixed(2)}%)`
          : `Allocation ${postAllocPct.toFixed(2)}% (within ${maxAllocPct.toFixed(2)}%)`;

        const suggestion = postAllocPct > maxAllocPct
          ? "Suggestion: reduce qty or wait for lower zone to avoid over-allocation."
          : !avgRuleHit
            ? "Suggestion: buy is early. Better to wait for stronger dip or lower zone."
            : "Suggestion: setup looks disciplined. Continue only if conviction remains strong.";

        panel.style.display = "block";
        panel.innerHTML = `
          <div class="split-row mb-1">
            <div class="left-col tiny-label">Stock: ${stock} | Qty: ${qty} | Price: ₹${price.toFixed(2)}</div>
          </div>
          <div class="status-inline">
            <span class="${zoneCls}">${zoneText}</span>
            <span class="${avgRuleCls}">${avgRuleText}</span>
            <span class="${allocCls}">${allocText}</span>
          </div>
          <div class="suggestion-row mt-2">
            <span>Targets</span>
            <span>L1: ₹${l1.toFixed(2)} | L2: ₹${l2.toFixed(2)}</span>
          </div>
          <div class="suggestion-row">
            <span>Projected New Avg</span>
            <span>₹${projectedAvg.toFixed(2)}</span>
          </div>
          <div class="suggestion-row">
            <span>Stock Budget</span>
            <span>₹${stockBudget.toFixed(2)} | Remaining: ₹${remainingBudget.toFixed(2)}</span>
          </div>
          <div class="suggestion-budget mt-2">${suggestion}</div>
        `;
      };
  });
}

function txnCsvCell(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function txnCsvJoin(values) {
  return values.map(txnCsvCell).join(",");
}

function txnParseCsvRow(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function exportTransactionsCSV() {
  db.transaction("transactions", "readonly")
    .objectStore("transactions")
    .getAll().onsuccess = e => {
      const rows = e.target.result || [];
      let csv = "#TRANSACTIONS_ONLY_EXPORT_V1\n\n";
      csv += "#TRANSACTIONS\n";
      csv += "id,date,stock,type,qty,price,brokerage,dpCharge,createdAt,updatedAt\n";
      rows.forEach(t => {
        csv += `${txnCsvJoin([
          t.id,
          t.date,
          normalizeStockName(t.stock),
          t.type,
          Number(t.qty || 0),
          Number(t.price || 0),
          Number(t.brokerage || 0),
          Number(t.dpCharge || 0),
          t.createdAt || "",
          t.updatedAt || ""
        ])}\n`;
      });

      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transactions_backup_${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      if (typeof showToast === "function") showToast("Transaction CSV exported successfully");
    };
}

function importTransactionsCSV() {
  const fileInput = document.getElementById("txnImportFile");
  const file = fileInput?.files?.[0];
  if (!file) {
    if (typeof showToast === "function") showToast("Please select a transaction CSV file", "error");
    return;
  }
  if (!confirm("This will overwrite all transaction records only. Continue?")) return;

  const reader = new FileReader();
  reader.onload = ev => {
    const lines = String(ev.target?.result || "").split(/\r?\n/);
    let mode = "";
    const transactions = [];

    lines.forEach(raw => {
      const line = raw.trim();
      if (!line) return;
      if (line.startsWith("#")) {
        if (line === "#TRANSACTIONS") mode = "TRANSACTIONS";
        return;
      }
      if (line.toLowerCase().startsWith("id,")) return;
      if (mode !== "TRANSACTIONS") return;

      const cols = txnParseCsvRow(line);
      transactions.push({
        id: Number(cols[0]),
        date: cols[1] || "",
        stock: normalizeStockName(cols[2]),
        type: cols[3] === "SELL" ? "SELL" : "BUY",
        qty: Number(cols[4] || 0),
        price: Number(cols[5] || 0),
        brokerage: Number(cols[6] || 0),
        dpCharge: Number(cols[7] || 0),
        createdAt: cols[8] || "",
        updatedAt: cols[9] || ""
      });
    });

    const tx = db.transaction("transactions", "readwrite");
    tx.objectStore("transactions").clear();
    tx.oncomplete = () => {
      const tx2 = db.transaction("transactions", "readwrite");
      transactions.forEach(t => tx2.objectStore("transactions").add(t));
      tx2.oncomplete = () => {
        if (fileInput) fileInput.value = "";
        loadTransactions();
        calculateHoldings();
        calculatePnL();
        loadDashboard();
        refreshStockOptions();
        if (typeof showToast === "function") showToast("Transaction CSV imported successfully");
      };
    };
  };
  reader.readAsText(file);
}

function initTransactionBackupControls() {
  const exportBtn = document.getElementById("txnExportBtn");
  if (!exportBtn) return;

  exportBtn.addEventListener("click", exportTransactionsCSV);
}

/* =========================================================
   FEATURE 1: BROKERAGE CALCULATION
   RULES:
   - BUY  -> % brokerage only
   - SELL -> % brokerage + DP charge (once per sell)
   ========================================================= */
   function calculateBrokerage(type, qty, price, settings) {
    const tradeValue = Number(qty) * Number(price);
    if (type === "BUY") {
      return (settings.brokerageBuyPct / 100) * tradeValue;
    }
    return (settings.brokerageSellPct / 100) * tradeValue + Number(settings.dpCharge || 0);
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
    const checklistBtn = document.getElementById("runPreBuyChecklist");
    const checklistPanel = document.getElementById("preBuyChecklist");
    dateInput.value = new Date().toISOString().split("T")[0];
    if (stockInputEl) {
      stockInputEl.addEventListener("blur", () => {
        stockInputEl.value = normalizeStockName(stockInputEl.value);
      });
    }
    checklistBtn?.addEventListener("click", runPreBuyChecklist);
    ["txnType", "stockInput", "qtyInput", "priceInput"].forEach(id => {
      const el = document.getElementById(id);
      el?.addEventListener("input", () => {
        if (checklistPanel && checklistPanel.style.display === "block") {
          runPreBuyChecklist();
        }
      });
    });
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
        const brokerage = calculateBrokerage(type, qty, price, settings);
  
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
        const nowIso = new Date().toISOString();

        if (editId) {
          store.get(Number(editId)).onsuccess = ev => {
            const prev = ev.target.result || {};
            store.put({
              ...data,
              id: Number(editId),
              createdAt: prev.createdAt || nowIso,
              updatedAt: nowIso
            });
          };
        } else {
          store.add({
            ...data,
            createdAt: nowIso
          });
        }

        tx.oncomplete = () => {
          form.reset();
          editTxnId.value = "";
          dateInput.value = new Date().toISOString().split("T")[0];
          if (checklistPanel) {
            checklistPanel.style.display = "none";
            checklistPanel.innerHTML = "";
          }
  
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
    
      getSettings(settings => {
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
    
            renderTransactions(data, settings);
          };
      });
    }

    /* ================= FILTER EVENTS ================= */
function bindFilterEvents() {
  ["filterType", "filterFrom", "filterTo", "filterStock"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", loadTransactions);
  });
}
  
  function renderTransactions(data, settings) {
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
        const brokerage = settings
          ? resolveTxnBrokerage(t, settings)
          : Number(t.brokerage || 0);
        const buyCost =
          t.type === "BUY"
            ? (t.qty * t.price + brokerage).toFixed(2)
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
  
    getSettings(settings => {
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
              brokeragePerUnit: resolveTxnBrokerage(t, settings) / t.qty
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
    });
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
              brokeragePerUnit: buyBrkg / t.qty,
              date: t.date
            });
          } else {
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
            const sellBrokerage = resolveTxnBrokerage(t, settings);
            const investedAmount = buyCost + buyBrokerage;
            const holdDays = consumedQty > 0 ? weightedHoldDaysSum / consumedQty : 0;
            const returnPct = investedAmount > 0
              ? ((sellValue - buyCost - buyBrokerage - sellBrokerage) / investedAmount) * 100
              : 0;

            result.push({
              stock: t.stock,
              date: t.date,
              qty: t.qty,
              sellPrice: t.price,
              buyCost,
              buyBrokerage,
              sellBrokerage,
              investedAmount,
              holdDays,
              returnPct,
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
    const totalInvested = txns.reduce((a, t) => a + (t.investedAmount || (t.buyCost + t.buyBrokerage)), 0);
    const weightedHoldDaysByInvested = txns.reduce(
      (a, t) => a + (Number(t.holdDays || 0) * Number(t.investedAmount || (t.buyCost + t.buyBrokerage))),
      0
    );
    const avgHoldDays = totalInvested > 0 ? weightedHoldDaysByInvested / totalInvested : 0;
    const totalReturnPct = totalInvested > 0 ? (totalNet / totalInvested) * 100 : 0;
    const totalTrades = txns.length;
    const cls = totalNet >= 0 ? "profit" : "loss";

    const id = `pnl-${stock.replace(/\s+/g, "")}`;

    pnlList.innerHTML += `
      <div class="txn-card">
        <div class="pnl-header" onclick="togglePnL('${id}')">
          <div class="left-col">
            <div class="txn-name">${stock}</div>
            <div class="tiny-label">Realised Trades: ${totalTrades} | Avg Hold: ${avgHoldDays.toFixed(0)} days | Return: ${totalReturnPct.toFixed(2)}%</div>
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
                <div class="left-col">Invested | Hold | Return</div>
                <div class="right-col">₹${(t.investedAmount || (t.buyCost + t.buyBrokerage)).toFixed(2)} | ${Number(t.holdDays || 0).toFixed(0)}d | ${Number(t.returnPct || 0).toFixed(2)}%</div>
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
  const returnEl = document.getElementById("dashReturn");

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
      let periodPnL = 0;
      let periodInvestedBase = 0;
      const periodStart = new Date();
      periodStart.setMonth(periodStart.getMonth() - 3);

      /* =============================================
         STEP 1: Build FIFO Holdings + Realised P/L
         ============================================= */
      txns.forEach(t => {
        map[t.stock] ??= { lots: [] };
        const txnBrokerage = resolveTxnBrokerage(t, settings);
        totalBrokerage += txnBrokerage;
        if (t.type === "BUY" && new Date(t.date) >= periodStart) {
          periodInvestedBase += (Number(t.qty) * Number(t.price)) + txnBrokerage;
        }
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
          if (new Date(t.date) >= periodStart) {
            periodPnL += net;
          }
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
      if (returnEl) {
        const returnPct = periodInvestedBase > 0 ? (periodPnL / periodInvestedBase) * 100 : 0;
        returnEl.textContent = `${returnPct.toFixed(2)}% return in 3 Months`;
      }
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







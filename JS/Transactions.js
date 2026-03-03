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

function defaultTickerForStockName(stockName) {
  const stock = normalizeStockName(stockName);
  const symbol = stock.replace(/[^A-Z0-9.-]/g, "");
  return symbol ? `NSE:${symbol}` : "";
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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
  const safeSettings = settings || {
    brokerageBuyPct: 0,
    brokerageSellPct: 0,
    dpCharge: 0
  };
  return calculateBrokerage(
    txn.type,
    toFiniteNumber(txn.qty, 0),
    toFiniteNumber(txn.price, 0),
    safeSettings
  );
}

function refreshStockOptions() {
  const list = document.getElementById("stockOptions");
  if (!list) return;
  const hasMappings = !!(db && db.objectStoreNames && db.objectStoreNames.contains("stock_mappings"));
  const stores = hasMappings ? ["transactions", "stock_mappings"] : ["transactions"];
  const tx = db.transaction(stores, "readonly");
  const txnReq = tx.objectStore("transactions").getAll();
  const mapReq = hasMappings ? tx.objectStore("stock_mappings").getAll() : null;

  tx.oncomplete = () => {
    const txnRows = txnReq.result || [];
    const mapRows = mapReq ? (mapReq.result || []) : [];
    const names = Array.from(new Set(
      [
        ...txnRows.map(t => normalizeStockName(t.stock)),
        ...mapRows.map(m => normalizeStockName(m.stock))
      ].filter(Boolean)
    )).sort();
    list.innerHTML = names.map(n => `<option value="${n}"></option>`).join("");
  };
}

function ensureStockMappingRecord(stockName) {
  const stock = normalizeStockName(stockName);
  if (!stock) return;
  if (!db?.objectStoreNames?.contains("stock_mappings")) return;

  const tx = db.transaction("stock_mappings", "readwrite");
  const store = tx.objectStore("stock_mappings");
  const req = store.get(stock);
  req.onsuccess = e => {
    const existing = e.target.result;
    if (existing) return;
    store.put({
      stock,
      ticker: defaultTickerForStockName(stock),
      exchange: "NSE",
      enabled: true,
      updatedAt: new Date().toISOString()
    });
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

function computeAvailableQtyForStock(txns, stock) {
  const wanted = normalizeStockName(stock);
  if (!wanted) return 0;
  let qty = 0;
  (txns || [])
    .slice()
    .sort((a, b) => parseDateLocal(a.date) - parseDateLocal(b.date))
    .forEach(t => {
      if (normalizeStockName(t.stock) !== wanted) return;
      const q = toFiniteNumber(t.qty, 0);
      const ty = String(t.type || "").toUpperCase();
      if (ty === "BUY") qty += q;
      else if (ty === "SELL") qty -= q;
    });
  return Math.max(0, qty);
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

        const isFirstBuyInCycle = existingQty === 0;
        let zoneText = "Above L1/L2 zones";
        let zoneCls = "status-pill-mini bad";
        if (isFirstBuyInCycle) {
          zoneText = "Base buy (First buy of new cycle)";
          zoneCls = "status-pill-mini info";
        } else if (price <= l2) {
          zoneText = "In L2 zone";
          zoneCls = "status-pill-mini ok";
        } else if (price <= l1) {
          zoneText = "In L1 zone";
          zoneCls = "status-pill-mini warn";
        }

        const lastBuyPrice = Number(s.cycleLastBuyPrice || price);
        const dropFromLastPct = lastBuyPrice > 0 ? ((lastBuyPrice - price) / lastBuyPrice) * 100 : 0;
        const avgRuleHit = dropFromLastPct >= Number(settings.avgLevel1Pct || 0);
        const avgRuleText = isFirstBuyInCycle
          ? "First buy detected. Next buy analysis will apply Avg L1/L2 rule."
          : (avgRuleHit
              ? `Drop from last buy: ${dropFromLastPct.toFixed(2)}% (meets Avg L1 rule)`
              : `Drop from last buy: ${dropFromLastPct.toFixed(2)}% (below Avg L1 rule)`);
        const avgRuleCls = isFirstBuyInCycle
          ? "status-pill-mini info"
          : (avgRuleHit ? "status-pill-mini ok" : "status-pill-mini bad");

        const projectedAvg = (existingQty + qty) > 0
          ? (postStockInvested / (existingQty + qty))
          : price;

        const allocCls = postAllocPct > maxAllocPct ? "status-pill-mini bad" : "status-pill-mini ok";
        const allocText = postAllocPct > maxAllocPct
          ? `Allocation ${postAllocPct.toFixed(2)}% (exceeds ${maxAllocPct.toFixed(2)}%)`
          : `Allocation ${postAllocPct.toFixed(2)}% (within ${maxAllocPct.toFixed(2)}%)`;

        const suggestion = isFirstBuyInCycle
          ? "Suggestion: This is base buy for a new cycle. Track next buy near L1/L2 for better averaging discipline."
          : postAllocPct > maxAllocPct
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

function parseCsvTextRows(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => String(l || "").trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = txnParseCsvRow(lines[0]).map(h => String(h || "").trim());
  const rows = lines.slice(1).map(line => txnParseCsvRow(line));
  return { headers, rows };
}

function normalizeHeaderKey(h) {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

const IMPORT_HEADER_ALIASES = {
  date: ["trade_date", "date", "order_date", "execution_date", "transaction_date", "txn_date"],
  stock: ["symbol", "stock", "stock_name", "scrip", "security", "instrument", "tradingsymbol", "trading_symbol"],
  type: ["trade_type", "type", "side", "transaction_type", "buy_sell", "action"],
  qty: ["quantity", "qty", "filled_qty", "executed_qty", "shares"],
  price: ["price", "avg_price", "average_price", "trade_price", "execution_price", "rate"],
  note: ["note", "remarks", "comment", "order_id", "trade_id"],
  reason: ["reason", "tag", "strategy"]
};

function getCsvHeaderSignature(headers) {
  return (headers || []).map(normalizeHeaderKey).join("|");
}

function findHeaderIndex(headers, aliases) {
  const keys = (headers || []).map(normalizeHeaderKey);
  for (let i = 0; i < keys.length; i++) {
    if (aliases.includes(keys[i])) return i;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (aliases.some(a => key.includes(a))) return i;
  }
  return -1;
}

function suggestImportMapping(headers) {
  return {
    date: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.date),
    stock: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.stock),
    type: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.type),
    qty: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.qty),
    price: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.price),
    reason: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.reason),
    note: findHeaderIndex(headers, IMPORT_HEADER_ALIASES.note)
  };
}

function getSavedImportMappings() {
  try {
    return JSON.parse(localStorage.getItem("brokerCsvMappings") || "{}") || {};
  } catch (e) {
    return {};
  }
}

function getSavedMappingForHeaders(headers) {
  const all = getSavedImportMappings();
  return all[getCsvHeaderSignature(headers)] || null;
}

function saveMappingForHeaders(headers, mapping) {
  const all = getSavedImportMappings();
  const key = getCsvHeaderSignature(headers);
  all[key] = mapping;
  localStorage.setItem("brokerCsvMappings", JSON.stringify(all));
}

function detectBrokerByHeaders(headers) {
  const set = new Set((headers || []).map(normalizeHeaderKey));
  const zerodhaRequired = ["symbol", "trade_date", "trade_type", "quantity", "price"];
  const isZerodha = zerodhaRequired.every(k => set.has(k));
  if (isZerodha) return "zerodha";
  return "unknown";
}

function parseImportDate(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const dmy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const day = String(Number(dmy[1])).padStart(2, "0");
    const month = String(Number(dmy[2])).padStart(2, "0");
    const year = dmy[3];
    return `${year}-${month}-${day}`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseImportType(raw) {
  const t = String(raw || "").trim().toUpperCase();
  if (["BUY", "B"].includes(t)) return "BUY";
  if (["SELL", "S"].includes(t)) return "SELL";
  return "";
}

function parseImportNum(raw) {
  const cleaned = String(raw == null ? "" : raw).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseZerodhaFill(headers, row) {
  const idx = {};
  headers.forEach((h, i) => { idx[normalizeHeaderKey(h)] = i; });
  const stock = normalizeStockName(row[idx.symbol]);
  const date = parseImportDate(row[idx.trade_date]);
  const type = parseImportType(row[idx.trade_type]);
  const qty = parseImportNum(row[idx.quantity]);
  const price = parseImportNum(row[idx.price]);
  const exchange = String(row[idx.exchange] || "").trim().toUpperCase();
  const orderId = String(row[idx.order_id] || "").trim();
  const tradeId = String(row[idx.trade_id] || "").trim();
  const execTime = String(row[idx.order_execution_time] || "").trim();
  if (!stock) return { row: null, reason: "missing_stock", stock: "" };
  if (!date) return { row: null, reason: "invalid_date", stock };
  if (!type) return { row: null, reason: "invalid_type", stock };
  if (qty <= 0) return { row: null, reason: "invalid_qty", stock };
  if (price <= 0) return { row: null, reason: "invalid_price", stock };
  return {
    row: {
      date,
      stock,
      type,
      qty,
      price,
      exchange,
      orderId,
      tradeId,
      execTime
    },
    reason: "",
    stock
  };
}

function normalizeZerodhaFillsToOrders(fills) {
  const groups = {};
  const safeExecKey = (v) => String(v || "").trim() || "";

  (fills || []).forEach(f => {
    const orderKey = String(f.orderId || "").trim();
    const fallback = `${f.date}|${f.stock}|${f.type}|${safeExecKey(f.execTime).slice(0, 16)}`;
    const key = orderKey ? `order|${orderKey}|${f.date}|${f.stock}|${f.type}` : `fallback|${fallback}`;
    if (!groups[key]) {
      groups[key] = {
        date: f.date,
        stock: f.stock,
        type: f.type,
        exchange: f.exchange || "",
        orderId: orderKey,
        qtySum: 0,
        valueSum: 0,
        tradeIds: new Set(),
        firstExec: f.execTime || "",
        lastExec: f.execTime || ""
      };
    }
    const g = groups[key];
    g.qtySum += Number(f.qty || 0);
    g.valueSum += Number(f.qty || 0) * Number(f.price || 0);
    if (f.tradeId) g.tradeIds.add(String(f.tradeId));
    if (f.execTime && (!g.firstExec || f.execTime < g.firstExec)) g.firstExec = f.execTime;
    if (f.execTime && (!g.lastExec || f.execTime > g.lastExec)) g.lastExec = f.execTime;
  });

  const rows = Object.keys(groups).map(k => {
    const g = groups[k];
    const qty = Number(g.qtySum || 0);
    const avgPrice = qty > 0 ? (Number(g.valueSum || 0) / qty) : 0;
    const importKey = g.orderId
      ? `zerodha|order|${g.orderId}|${g.date}|${g.stock}|${g.type}`
      : `zerodha|${g.date}|${g.stock}|${g.type}|${qty}|${avgPrice.toFixed(4)}|${Array.from(g.tradeIds).sort().join("-")}`;
    const noteParts = [
      "Imported: Zerodha",
      g.exchange ? g.exchange : "",
      g.orderId ? `Order ${g.orderId}` : "",
      g.tradeIds.size ? `Trades ${g.tradeIds.size}` : ""
    ].filter(Boolean);
    return {
      date: g.date,
      stock: g.stock,
      type: g.type,
      qty,
      price: avgPrice,
      reason: "Broker Import",
      note: noteParts.join(" | "),
      importSource: "zerodha",
      importKey
    };
  }).filter(r => r.qty > 0 && r.price > 0);

  return { rows, groupsCount: rows.length, fillsCount: (fills || []).length };
}

function buildManualMappingUI(headers, preset = null) {
  const panel = document.getElementById("brokerMappingPanel");
  if (!panel) return;
  const optionHtml = [`<option value="">Select column</option>`]
    .concat(headers.map((h, i) => `<option value="${i}">${h}</option>`))
    .join("");
  const sel = (k) => {
    const idx = Number(preset?.[k]);
    return Number.isInteger(idx) && idx >= 0 ? String(idx) : "";
  };
  panel.style.display = "block";
  panel.innerHTML = `
    <div class="txn-card">
      <div class="txn-name">Manual Column Mapping</div>
      <div class="tiny-label mb-2">Map required fields for this CSV format.</div>
      <div class="row g-2">
        <div class="col-6">
          <label class="form-label">Date</label>
          <select id="mapColDate" class="form-select">${optionHtml}</select>
        </div>
        <div class="col-6">
          <label class="form-label">Stock</label>
          <select id="mapColStock" class="form-select">${optionHtml}</select>
        </div>
        <div class="col-6">
          <label class="form-label">Type</label>
          <select id="mapColType" class="form-select">${optionHtml}</select>
        </div>
        <div class="col-6">
          <label class="form-label">Quantity</label>
          <select id="mapColQty" class="form-select">${optionHtml}</select>
        </div>
        <div class="col-6">
          <label class="form-label">Price</label>
          <select id="mapColPrice" class="form-select">${optionHtml}</select>
        </div>
        <div class="col-6">
          <label class="form-label">Reason (optional)</label>
          <select id="mapColReason" class="form-select">${optionHtml}</select>
        </div>
        <div class="col-6">
          <label class="form-label">Note (optional)</label>
          <select id="mapColNote" class="form-select">${optionHtml}</select>
        </div>
      </div>
      <div class="tiny-label mt-2">Type values supported: BUY/SELL or B/S</div>
    </div>
  `;
  const setSel = (id, value) => {
    const el = document.getElementById(id);
    if (!el || value === "") return;
    el.value = value;
  };
  setSel("mapColDate", sel("date"));
  setSel("mapColStock", sel("stock"));
  setSel("mapColType", sel("type"));
  setSel("mapColQty", sel("qty"));
  setSel("mapColPrice", sel("price"));
  setSel("mapColReason", sel("reason"));
  setSel("mapColNote", sel("note"));
}

function parseManualMappedRows(rows) {
  const getIdx = id => Number(document.getElementById(id)?.value ?? -1);
  const iDate = getIdx("mapColDate");
  const iStock = getIdx("mapColStock");
  const iType = getIdx("mapColType");
  const iQty = getIdx("mapColQty");
  const iPrice = getIdx("mapColPrice");
  const iReason = getIdx("mapColReason");
  const iNote = getIdx("mapColNote");
  if ([iDate, iStock, iType, iQty, iPrice].some(i => i < 0)) {
    return { error: "Please map all required columns." };
  }
  let invalidRows = 0;
  const reasonCounts = {};
  const addReason = (k) => { reasonCounts[k] = (reasonCounts[k] || 0) + 1; };
  const parsed = rows.map(row => {
    const date = parseImportDate(row[iDate]);
    const stock = normalizeStockName(row[iStock]);
    const type = parseImportType(row[iType]);
    const qty = parseImportNum(row[iQty]);
    const price = parseImportNum(row[iPrice]);
    if (!date || !stock || !type || qty <= 0 || price <= 0) {
      invalidRows++;
      if (!stock) addReason("missing_stock");
      else if (!date) addReason("invalid_date");
      else if (!type) addReason("invalid_type");
      else if (qty <= 0) addReason("invalid_qty");
      else if (price <= 0) addReason("invalid_price");
      return null;
    }
    const reason = iReason >= 0 ? String(row[iReason] || "").trim() : "";
    const note = iNote >= 0 ? String(row[iNote] || "").trim() : "";
    return {
      date,
      stock,
      type,
      qty,
      price,
      reason: reason || "Broker Import",
      note: note || "Imported: Custom CSV mapping"
    };
  }).filter(Boolean);
  return { rows: parsed, invalidRows, reasonCounts };
}

function getManualMappingSelection() {
  const getIdx = id => {
    const v = document.getElementById(id)?.value;
    if (v == null || v === "") return -1;
    const n = Number(v);
    return Number.isInteger(n) ? n : -1;
  };
  return {
    date: getIdx("mapColDate"),
    stock: getIdx("mapColStock"),
    type: getIdx("mapColType"),
    qty: getIdx("mapColQty"),
    price: getIdx("mapColPrice"),
    reason: getIdx("mapColReason"),
    note: getIdx("mapColNote")
  };
}

function hasRequiredMapping(mapping) {
  return ["date", "stock", "type", "qty", "price"].every(k => Number(mapping?.[k]) >= 0);
}

function buildTxnIdentity(t) {
  if (t && t.importKey) return `import|${String(t.importKey).trim()}`;
  return `fallback|${t.date}|${normalizeStockName(t.stock)}|${String(t.type || "").toUpperCase()}|${Number(t.qty || 0)}|${Number(t.price || 0).toFixed(4)}`;
}

function dedupeImportedRows(newRows, existingRows) {
  const seen = new Set(
    (existingRows || []).map(t => buildTxnIdentity(t))
  );
  const out = [];
  let skipped = 0;
  (newRows || []).forEach(t => {
    const key = buildTxnIdentity(t);
    if (seen.has(key)) {
      skipped++;
      return;
    }
    seen.add(key);
    out.push(t);
  });
  return { rows: out, skipped };
}

function computeImportBrokerageRows(rowsToInsert, existingRows, settings) {
  const out = [];
  const dp = Number(settings?.dpCharge || 0);
  const buyPct = Number(settings?.brokerageBuyPct || 0);
  const sellPct = Number(settings?.brokerageSellPct || 0);

  const sellDpDone = new Set();
  (existingRows || []).forEach(t => {
    if (String(t?.type || "").toUpperCase() !== "SELL") return;
    const key = `${String(t.date || "")}|${normalizeStockName(t.stock)}`;
    if (key.trim() !== "|") sellDpDone.add(key);
  });

  (rowsToInsert || []).forEach(t => {
    const type = String(t.type || "").toUpperCase();
    const qty = Number(t.qty || 0);
    const price = Number(t.price || 0);
    const tradeValue = qty * price;
    const pctCharges = type === "BUY"
      ? (buyPct / 100) * tradeValue
      : (sellPct / 100) * tradeValue;
    let dpCharge = 0;
    if (type === "SELL") {
      const key = `${String(t.date || "")}|${normalizeStockName(t.stock)}`;
      if (!sellDpDone.has(key)) {
        dpCharge = dp;
        sellDpDone.add(key);
      }
    }
    out.push({
      ...t,
      __brokerageComputed: Number(pctCharges + dpCharge),
      __dpApplied: Number(dpCharge)
    });
  });
  return out;
}

async function uploadImportedSnapshotToCloud() {
  try {
    if (typeof window === "undefined" || !window.APP_APPS_SCRIPT_URL) return { ok: false, reason: "no-url" };
    const mod = await import("../client/cloudSync.js");
    const userId = localStorage.getItem("activeUserId") || "";
    const uploadPromise = mod.uploadToCloud(window.APP_APPS_SCRIPT_URL, { userId });
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: "timeout" }), 15000));
    const res = await Promise.race([uploadPromise, timeoutPromise]);
    return { ok: true, response: res };
  } catch (err) {
    console.warn("Cloud sync after import failed", err);
    return { ok: false, reason: String(err?.message || err) };
  }
}

async function importBrokerCsvFlow() {
  const fileInput = document.getElementById("brokerImportFile");
  const meta = document.getElementById("brokerImportMeta");
  const mappingPanel = document.getElementById("brokerMappingPanel");
  const file = fileInput?.files?.[0];
  if (!file) {
    if (typeof showToast === "function") showToast("Please choose a broker CSV file", "error");
    return;
  }

  try {
    const text = await file.text();
    const { headers, rows } = parseCsvTextRows(text);
    if (!headers.length || !rows.length) {
      if (typeof showToast === "function") showToast("CSV appears empty or invalid", "error");
      return;
    }

    const broker = detectBrokerByHeaders(headers);
    let parsedRows = [];
    let invalidRows = 0;
    const reasonCounts = {};
    const addReason = (k) => { reasonCounts[k] = (reasonCounts[k] || 0) + 1; };
    const showProgress = async (msg) => {
      if (typeof window !== "undefined" && typeof window.appShowLoading === "function") {
        window.appShowLoading(msg);
        await new Promise(r => setTimeout(r, 0));
      }
    };

    if (broker === "zerodha") {
      const fills = [];
      for (let i = 0; i < rows.length; i++) {
        const result = parseZerodhaFill(headers, rows[i]);
        const currentStock = result?.stock || normalizeStockName(rows[i][0] || "");
        if (i % 120 === 0 || i === rows.length - 1) {
          await showProgress(`Processing ${i + 1}/${rows.length}: ${currentStock || "-"}`);
        }
        if (result?.row) {
          fills.push(result.row);
        } else {
          invalidRows++;
          addReason(result?.reason || "invalid_row");
        }
      }
      const normalized = normalizeZerodhaFillsToOrders(fills);
      parsedRows = normalized.rows || [];
      if (meta) meta.textContent = `Detected: Zerodha | Fills: ${normalized.fillsCount} | Normalized orders: ${normalized.groupsCount}${invalidRows ? ` | Skipped invalid: ${invalidRows}` : ""}`;
      if (mappingPanel) {
        mappingPanel.style.display = "none";
        mappingPanel.innerHTML = "";
      }
    } else {
      const saved = getSavedMappingForHeaders(headers);
      const suggested = suggestImportMapping(headers);
      const prefilled = (saved && hasRequiredMapping(saved)) ? saved : suggested;
      buildManualMappingUI(headers, prefilled);
      if (meta) {
        meta.textContent = (saved && hasRequiredMapping(saved))
          ? "Detected: Custom broker format | Using your saved mapping."
          : "Unknown broker format. Review auto-mapping and click Import.";
      }
      const chosenMapping = getManualMappingSelection();
      if (!hasRequiredMapping(chosenMapping)) {
        if (typeof showToast === "function") showToast("Map required columns and click Import again", "info");
        return;
      }
      saveMappingForHeaders(headers, chosenMapping);
      const mapped = parseManualMappedRows(rows);
      if (mapped.error) {
        if (typeof showToast === "function") showToast(mapped.error, "error");
        return;
      }
      parsedRows = mapped.rows || [];
      invalidRows = Number(mapped.invalidRows || 0);
      Object.keys(mapped.reasonCounts || {}).forEach(k => addReason(k));
      if (meta) {
        meta.textContent = `Detected: Custom CSV | Parsed rows: ${parsedRows.length}${invalidRows ? ` | Skipped invalid: ${invalidRows}` : ""}`;
      }
    }

    if (!parsedRows.length) {
      const summary = [
        `CSV rows: ${rows.length}`,
        "Valid parsed: 0",
        "Stored: 0",
        "Duplicates skipped: 0",
        `Invalid skipped: ${invalidRows}`
      ].join("\n");
      if (typeof showToast === "function") showToast("No valid transaction rows found", "error");
      if (typeof window !== "undefined" && typeof window.appAlertDialog === "function") {
        await window.appAlertDialog(summary, { title: "Import Summary", okText: "OK" });
      }
      return;
    }

    if (typeof window !== "undefined" && typeof window.appHideLoading === "function") {
      window.appHideLoading();
    }

    const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
      ? await window.appConfirmDialog(`Import ${parsedRows.length} transactions? Duplicates will be skipped.`, { title: "Confirm Broker Import", okText: "Import" })
      : window.confirm(`Import ${parsedRows.length} transactions? Duplicates will be skipped.`);
    if (!ok) return;
    if (typeof window !== "undefined" && typeof window.appShowLoading === "function") {
      window.appShowLoading("Saving imported transactions...");
    }

    const readReq = db.transaction("transactions", "readonly").objectStore("transactions").getAll();
    readReq.onsuccess = async e => {
      try {
        const existing = e.target.result || [];
        const deduped = dedupeImportedRows(parsedRows, existing);
        const toInsert = deduped.rows;
        if (!toInsert.length) {
          const reasonText = Object.keys(reasonCounts).length
            ? Object.keys(reasonCounts).map(k => `${k}: ${reasonCounts[k]}`).join(", ")
            : "none";
          const summary = [
            `CSV rows: ${rows.length}`,
            `Valid parsed: ${parsedRows.length}`,
            "Stored: 0",
            `Duplicates skipped: ${deduped.skipped}`,
            `Invalid skipped: ${invalidRows}`,
            `Skip reasons: ${reasonText}`
          ].join("\n");
          if (typeof showToast === "function") showToast(`No new rows. Skipped duplicates: ${deduped.skipped}`, "info");
          if (typeof window !== "undefined" && typeof window.appAlertDialog === "function") {
            await window.appAlertDialog(summary, { title: "Import Summary", okText: "OK" });
          }
          return;
        }

        getSettings(settings => {
          const preparedRows = computeImportBrokerageRows(toInsert, existing, settings);
          const tx = db.transaction("transactions", "readwrite");
          const store = tx.objectStore("transactions");
          const nowIso = new Date().toISOString();
          let insertErrors = 0;
          let dpAppliedCount = 0;

          preparedRows.forEach(t => {
            try {
              const brokerage = Number(t.__brokerageComputed ?? calculateBrokerage(t.type, t.qty, t.price, settings));
              const dpApplied = Number(t.__dpApplied || 0);
              if (dpApplied > 0) dpAppliedCount++;
              const req = store.add({
                date: t.date,
                stock: t.stock,
                type: t.type,
                qty: Number(t.qty),
                price: Number(t.price),
                reason: t.reason || "Broker Import",
                note: t.note || "",
                importSource: t.importSource || "csv",
                importKey: t.importKey || "",
                brokerage,
                dpCharge: dpApplied,
                createdAt: nowIso,
                updatedAt: nowIso
              });
              req.onerror = () => { insertErrors++; };
              ensureStockMappingRecord(t.stock);
            } catch (err) {
              insertErrors++;
            }
          });

          tx.onerror = () => {
            if (typeof showToast === "function") showToast("Import failed while writing transactions", "error");
            if (typeof window !== "undefined" && typeof window.appHideLoading === "function") window.appHideLoading();
          };
          tx.onabort = () => {
            if (typeof showToast === "function") showToast("Import aborted", "error");
            if (typeof window !== "undefined" && typeof window.appHideLoading === "function") window.appHideLoading();
          };
          tx.oncomplete = async () => {
            loadTransactions();
            calculateHoldings();
            calculatePnL();
            loadDashboard();
            refreshStockOptions();
            const cloud = await uploadImportedSnapshotToCloud();
            const reasonText = Object.keys(reasonCounts).length
              ? Object.keys(reasonCounts).map(k => `${k}: ${reasonCounts[k]}`).join(", ")
              : "none";
            const storedCount = Math.max(0, toInsert.length - insertErrors);
            const summary = [
              `CSV rows: ${rows.length}`,
              `Valid parsed: ${parsedRows.length}`,
              `Stored: ${storedCount}`,
              `Duplicates skipped: ${deduped.skipped}`,
              `Invalid skipped: ${invalidRows}`,
              `Write errors: ${insertErrors}`,
              `DP applied rows: ${dpAppliedCount}`,
              `Skip reasons: ${reasonText}`
            ].join("\n");
            if (typeof showToast === "function") {
              showToast(
                `Imported ${storedCount} rows (Skipped duplicates ${deduped.skipped}${invalidRows ? `, invalid ${invalidRows}` : ""}${insertErrors ? `, errors ${insertErrors}` : ""})${cloud.ok ? " | Synced to cloud" : ""}`,
                insertErrors ? "info" : "success"
              );
            }
            if (typeof window !== "undefined" && typeof window.appAlertDialog === "function") {
              await window.appAlertDialog(summary, { title: "Import Summary", okText: "OK" });
            }
            if (meta) {
              meta.textContent = `Imported ${storedCount} new rows. Skipped duplicates: ${deduped.skipped}${invalidRows ? ` | Invalid rows: ${invalidRows}` : ""}${insertErrors ? ` | Write errors: ${insertErrors}` : ""}.${cloud.ok ? " Synced to Google Sheet." : " Cloud sync pending."}`;
            }
            if (typeof window !== "undefined" && typeof window.appHideLoading === "function") {
              window.appHideLoading();
            }
          };
        });
      } catch (err) {
        if (typeof showToast === "function") showToast("Import failed: " + (err?.message || err), "error");
        if (typeof window !== "undefined" && typeof window.appHideLoading === "function") window.appHideLoading();
      }
    };
    readReq.onerror = () => {
      if (typeof showToast === "function") showToast("Failed to read existing transactions for dedupe", "error");
      if (typeof window !== "undefined" && typeof window.appHideLoading === "function") window.appHideLoading();
    };
  } finally {
    if (typeof window !== "undefined" && typeof window.appHideLoading === "function") {
      window.appHideLoading();
    }
  }
}

function exportTransactionsCSV() {
  db.transaction("transactions", "readonly")
    .objectStore("transactions")
    .getAll().onsuccess = e => {
      const rows = e.target.result || [];
      let csv = "#TRANSACTIONS_ONLY_EXPORT_V1\n\n";
      csv += "#TRANSACTIONS\n";
      csv += "id,date,stock,type,qty,price,brokerage,dpCharge,reason,note,createdAt,updatedAt\n";
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
          t.reason || "",
          t.note || "",
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

async function importTransactionsCSV() {
  const fileInput = document.getElementById("txnImportFile");
  const file = fileInput?.files?.[0];
  if (!file) {
    if (typeof showToast === "function") showToast("Please select a transaction CSV file", "error");
    return;
  }
  const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
    ? await window.appConfirmDialog("This will overwrite all transaction records only. Continue?", { title: "Confirm Import", okText: "Overwrite" })
    : window.confirm("This will overwrite all transaction records only. Continue?");
  if (!ok) return;

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
        reason: cols[8] || "",
        note: cols[9] || "",
        createdAt: cols[10] || "",
        updatedAt: cols[11] || ""
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
  const importBtn = document.getElementById("brokerImportBtn");
  if (!importBtn) return;
  importBtn?.addEventListener("click", importBrokerCsvFlow);
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
      const reason = (document.getElementById("txnReason")?.value || "").trim();
      const note = (document.getElementById("txnNote")?.value || "").trim();
  
      if (!date || !stock || qty <= 0 || price <= 0) {
        if (typeof showToast === "function") showToast("Please fill valid stock, quantity, price, and date", "error");
        return;
      }
  
      getSettings(settings => {
        db.transaction("transactions", "readonly")
          .objectStore("transactions")
          .getAll().onsuccess = ev => {
            const all = ev.target.result || [];
            const currentEditId = Number(editId || 0);
            const baseline = all.filter(t => Number(t.id || 0) !== currentEditId);

            if (type === "SELL") {
              const availableQty = computeAvailableQtyForStock(baseline, stock);
              if (qty > availableQty) {
                if (typeof showToast === "function") {
                  showToast(`Invalid qty. Available holding for ${stock}: ${availableQty}`, "error", 4200);
                }
                return;
              }
            }

            const brokerage = calculateBrokerage(type, qty, price, settings);
            const data = {
              date,
              stock,
              type,
              qty,
              price,
              reason,
              note,
              brokerage,   // Brokerage includes DP for SELL
              dpCharge: 0  // Stored only for display (not re-added)
            };

            const tx = db.transaction("transactions", "readwrite");
            const store = tx.objectStore("transactions");
            const nowIso = new Date().toISOString();

            if (editId) {
              store.get(Number(editId)).onsuccess = iev => {
                const prev = iev.target.result || {};
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
              ensureStockMappingRecord(stock);
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
        const reasonText = t.reason ? ` | ${t.reason}` : "";
        const noteText = t.note ? ` | ${t.note}` : "";
  
        txnList.innerHTML += `
          <div class="txn-card">
            <div class="txn-top">
              <div>
                <div class="txn-name">${t.stock}</div>
                <div class="txn-sub">
                  ${t.date} | ${t.type} | Qty ${t.qty} @ ₹${t.price.toFixed(2)}
                  ${buyCost ? ` | Buy Cost ₹${buyCost}` : ""}
                  ${reasonText}
                  ${noteText}
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

function toggleTxnHistory() {
  const panel = document.getElementById("txnHistoryPanel");
  const btn = document.getElementById("toggleTxnHistoryBtn");
  if (!panel || !btn) return;
  const hidden = panel.style.display === "none";
  panel.style.display = hidden ? "block" : "none";
  const icon = btn.querySelector("i");
  if (icon) {
    icon.classList.remove("bi-chevron-up", "bi-chevron-down");
    icon.classList.add(hidden ? "bi-chevron-up" : "bi-chevron-down");
  }
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
        const reasonEl = document.getElementById("txnReason");
        const noteEl = document.getElementById("txnNote");
        if (reasonEl) reasonEl.value = t.reason || "";
        if (noteEl) noteEl.value = t.note || "";

        if (typeof showToast === "function") {
          showToast(`Editing ${t.stock} transaction`, "info");
        }
        };
  }
  
  async function deleteTxn(id) {
    const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
      ? await window.appConfirmDialog("Delete this transaction permanently?", { title: "Delete Transaction", okText: "Delete" })
      : window.confirm("Delete this transaction permanently?");
    if (!ok) return;
  
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
          const live = (typeof window !== "undefined" && typeof window.getLivePriceForStock === "function")
            ? window.getLivePriceForStock(s)
            : null;
          const ltp = Number(live?.ltp);
          const hasLive = Number.isFinite(ltp) && ltp > 0;
          const currentValue = hasLive ? qty * ltp : null;
          const unrealized = hasLive ? (currentValue - invested) : null;
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
              <div class="split-row mt-1">
                <div class="left-col tiny-label">
                  ${hasLive ? `LTP ₹${ltp.toFixed(2)} | Value ₹${currentValue.toFixed(2)}` : "LTP: -"}
                </div>
                <div class="right-col tiny-label ${hasLive && unrealized >= 0 ? "profit" : "loss"}">
                  ${hasLive ? `U P/L ₹${unrealized.toFixed(2)}` : ""}
                </div>
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

  renderPnLVisualSummary(filtered);
  renderGroupedPnL(filtered);
}

function renderPnLVisualSummary(data) {
  const grid = document.getElementById("pnlSummaryGrid");
  const chart = document.getElementById("pnlMonthlyChart");
  if (!grid || !chart) return;

  if (!Array.isArray(data) || !data.length) {
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-label">Realized Net</div><div class="stat-value">₹0.00</div></div>
      <div class="stat-card"><div class="stat-label">Win / Loss</div><div class="stat-value">0 / 0</div></div>
      <div class="stat-card"><div class="stat-label">Avg Return</div><div class="stat-value">0.00%</div></div>
      <div class="stat-card"><div class="stat-label">Avg Hold</div><div class="stat-value">0d</div></div>
    `;
    chart.innerHTML = `<div class="text-muted">No realized trades in selected range.</div>`;
    return;
  }

  const totalNet = data.reduce((a, t) => a + Number(t.net || 0), 0);
  const wins = data.filter(t => Number(t.net || 0) >= 0).length;
  const losses = data.length - wins;
  const avgReturn = data.reduce((a, t) => a + Number(t.returnPct || 0), 0) / Math.max(1, data.length);
  const avgHold = data.reduce((a, t) => a + Number(t.holdDays || 0), 0) / Math.max(1, data.length);

  grid.innerHTML = `
    <div class="stat-card"><div class="stat-label">Realized Net</div><div class="stat-value ${totalNet >= 0 ? "profit" : "loss"}">₹${totalNet.toFixed(2)}</div></div>
    <div class="stat-card"><div class="stat-label">Win / Loss</div><div class="stat-value">${wins} / ${losses}</div></div>
    <div class="stat-card"><div class="stat-label">Avg Return</div><div class="stat-value ${avgReturn >= 0 ? "profit" : "loss"}">${avgReturn.toFixed(2)}%</div></div>
    <div class="stat-card"><div class="stat-label">Avg Hold</div><div class="stat-value">${avgHold.toFixed(0)}d</div></div>
  `;

  const monthMap = {};
  data.forEach(t => {
    const m = String(t.date || "").slice(0, 7);
    if (!m) return;
    monthMap[m] = (monthMap[m] || 0) + Number(t.net || 0);
  });
  const months = Object.keys(monthMap).sort();
  const maxAbs = Math.max(1, ...months.map(m => Math.abs(Number(monthMap[m] || 0))));
  chart.innerHTML = months.map(m => {
    const v = Number(monthMap[m] || 0);
    const w = (Math.abs(v) / maxAbs) * 100;
    const barCls = v >= 0 ? "profit" : "loss";
    return `
      <div class="adv-bar-row">
        <div class="adv-bar-label">${m}</div>
        <div class="adv-bar-track"><div class="adv-bar ${barCls}" style="width:${w}%"></div></div>
        <div class="adv-bar-value ${barCls}">₹${v.toFixed(2)}</div>
      </div>
    `;
  }).join("");
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
                <div class="right-col">₹${t.buyCost.toFixed(2)} | ₹${(t.buyCost / Math.max(1, t.qty)).toFixed(2)}/qty</div>
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
        const qtyNum = toFiniteNumber(t.qty, 0);
        const priceNum = toFiniteNumber(t.price, 0);
        if (t.type === "BUY" && new Date(t.date) >= periodStart) {
          periodInvestedBase += (qtyNum * priceNum) + txnBrokerage;
        }
        brokerageByStock[t.stock] ??= { buy: 0, sell: 0, total: 0 };
        if (t.type === "BUY") brokerageByStock[t.stock].buy += txnBrokerage;
        else brokerageByStock[t.stock].sell += txnBrokerage;
        brokerageByStock[t.stock].total += txnBrokerage;

        if (t.type === "BUY") {
          map[t.stock].lots.push({
            qty: qtyNum,
            price: priceNum,
            brokeragePerUnit: qtyNum > 0 ? (txnBrokerage / qtyNum) : 0,
            date: t.date
          });
        } else {
          let sellQty = qtyNum;
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

          const sellValue = qtyNum * priceNum;

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
      let liveUnrealizedTotal = 0;
      let liveUnrealizedCount = 0;

      for (const stock in map) {
        const lots = map[stock].lots;
        if (!lots.length) continue;

        activeHoldings++;

        const invested = lots.reduce(
          (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
          0
        );
        totalInvested += invested;

        const qty = lots.reduce((a, l) => a + Number(l.qty || 0), 0);
        const live = (typeof window !== "undefined" && typeof window.getLivePriceForStock === "function")
          ? window.getLivePriceForStock(stock)
          : null;
        const ltp = Number(live?.ltp);
        const hasLive = Number.isFinite(ltp) && ltp > 0;
        if (hasLive && qty > 0) {
          liveUnrealizedTotal += (qty * ltp) - invested;
          liveUnrealizedCount++;
        }
      }

      /* =============================================
         STEP 3: Update Dashboard UI
         ============================================= */
      investedEl.innerText = `₹${toFiniteNumber(totalInvested, 0).toFixed(2)}`;
      pnlEl.innerText = `₹${toFiniteNumber(totalPnL, 0).toFixed(2)}`;
      holdingsEl.innerText = activeHoldings;
      if (brokerageEl) brokerageEl.innerText = `₹${toFiniteNumber(totalBrokerage, 0).toFixed(2)}`;
      if (returnEl) {
        const returnPct = periodInvestedBase > 0 ? (periodPnL / periodInvestedBase) * 100 : 0;
        returnEl.textContent = `${toFiniteNumber(returnPct, 0).toFixed(2)}% return in 3 Months`;
      }
      const dashUnrealizedEl = document.getElementById("dashUnrealizedLoss");
      const dashLiveRefreshEl = document.getElementById("dashLivePriceRefresh");
      if (dashUnrealizedEl) {
        if (liveUnrealizedCount > 0) {
          dashUnrealizedEl.classList.remove("text-muted", "profit", "loss");
          dashUnrealizedEl.classList.add(liveUnrealizedTotal >= 0 ? "profit" : "loss");
          dashUnrealizedEl.textContent = `Live Unrealized: ₹${liveUnrealizedTotal.toFixed(2)}`;
        } else {
          dashUnrealizedEl.classList.remove("profit", "loss");
          dashUnrealizedEl.classList.add("text-muted");
          dashUnrealizedEl.textContent = "Live Unrealized: -";
        }
      }
      if (dashLiveRefreshEl) {
        const fetchedAt = (typeof window !== "undefined" && window.__livePriceState?.fetchedAt)
          ? new Date(window.__livePriceState.fetchedAt)
          : null;
        const hasValidTime = fetchedAt && !Number.isNaN(fetchedAt.getTime());
        dashLiveRefreshEl.textContent = hasValidTime
          ? `Live refresh: ${fetchedAt.toLocaleString()}`
          : "Live refresh: -";
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
            const live = (typeof window !== "undefined" && typeof window.getLivePriceForStock === "function")
              ? window.getLivePriceForStock(stock)
              : null;
            const ltp = Number(live?.ltp);
            const hasLive = Number.isFinite(ltp) && ltp > 0;
            const livePnl = hasLive ? (lots.reduce((a, l) => a + l.qty, 0) * ltp) - invested : null;
            const firstDate = lots[0].date;
            const days = Math.floor((new Date() - parseDateLocal(firstDate)) / 86400000);
            return { stock, invested, days, livePnl };
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
                    <div class="metric-strong text-primary">₹${toFiniteNumber(r.invested, 0).toFixed(2)}</div>
                    <div class="tiny-label">Invested</div>
                    <div class="tiny-label ${r.livePnl == null ? "" : (r.livePnl >= 0 ? "profit" : "loss")}">
                      ${r.livePnl == null ? "Live P/L: -" : `Live P/L: ₹${r.livePnl.toFixed(2)}`}
                    </div>
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







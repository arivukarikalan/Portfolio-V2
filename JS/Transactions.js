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

function normalizeTrendDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const core = raw.includes("T") ? raw.split("T")[0] : raw.slice(0, 10);
  const text = core.replace(/\//g, "-");

  const ymd = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  const dmy = text.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmy) {
    const d = Number(dmy[1]);
    const m = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = dt.getMonth() + 1;
  const d = dt.getDate();
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function getHoldingTrendCloudEndpoint() {
  if (typeof window === "undefined") return "";
  return window.APP_LIVE_PRICE_URL || window.APP_APPS_SCRIPT_URL || "";
}

function normalizeTickerForTrend(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.startsWith("NSE:")) return raw;
  const cleaned = raw.replace(/^NSE\s*:/, "").replace(/[^A-Z0-9.-]/g, "");
  return cleaned ? `NSE:${cleaned}` : "";
}

async function getMappedTickerForStock(stockName) {
  const stock = normalizeStockName(stockName);
  if (!stock) return "";
  const fallback = normalizeTickerForTrend(stock);
  if (!db?.objectStoreNames?.contains("stock_mappings")) return fallback;

  return await new Promise(resolve => {
    try {
      db.transaction("stock_mappings", "readonly")
        .objectStore("stock_mappings")
        .getAll().onsuccess = (e) => {
          const all = Array.isArray(e?.target?.result) ? e.target.result : [];
          const exact = all.find(r => normalizeStockName(r?.stock) === stock);
          const mapped = normalizeTickerForTrend(exact?.ticker || "");
          resolve(mapped || fallback);
        };
    } catch (e) {
      resolve(fallback);
    }
  });
}

async function fetchHoldingCloudTrend(stockName, days = 7, options = {}) {
  const fast = !!options.fast;
  const timeoutMs = Math.max(4000, Number(options.timeoutMs || 8000));
  const key = `${normalizeStockName(stockName)}|${Math.max(2, Math.min(30, Number(days || 7)))}|${fast ? "fast" : "full"}`;
  if (!window.__holdingTrendCache) window.__holdingTrendCache = {};
  const cached = window.__holdingTrendCache[key];
  if (cached && (Date.now() - Number(cached.ts || 0) < 60000)) {
    return cached.payload;
  }

  const stock = normalizeStockName(stockName);
  const endpoint = getHoldingTrendCloudEndpoint();
  if (!stock || !endpoint) {
    return { ok: false, reason: "endpoint_missing", rows: [], ticker: "" };
  }

  const ticker = await getMappedTickerForStock(stock);
  if (!ticker) return { ok: false, reason: "ticker_missing", rows: [], ticker: "" };

  try {
    const url = new URL(endpoint);
    url.searchParams.set("mode", "history");
    url.searchParams.set("ticker", ticker);
    url.searchParams.set("days", String(Math.max(2, Math.min(30, Number(days || 7)))));
    if (fast) url.searchParams.set("fast", "1");
    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    let timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    const res = await fetch(url.toString(), { method: "GET", signal: ctrl ? ctrl.signal : undefined })
      .finally(() => {
        if (timer) clearTimeout(timer);
        timer = null;
      });
    if (!res.ok) throw new Error(`history_http_${res.status}`);
    const parsed = JSON.parse(await res.text());
    const srcRows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const rows = srcRows
      .map(r => ({
        date: normalizeTrendDate(r.date || r.dateKey || ""),
        price: Number(r.ltp ?? r.price ?? r.close ?? 0)
      }))
      .filter(r => !!r.date && Number.isFinite(r.price) && r.price > 0)
      .sort((a, b) => parseDateLocal(a.date) - parseDateLocal(b.date))
      .slice(-Math.max(2, Math.min(30, Number(days || 7))));
    const payload = { ok: true, rows, ticker };
    window.__holdingTrendCache[key] = { ts: Date.now(), payload };
    return payload;
  } catch (err) {
    const reason = String(err?.name || "").toLowerCase() === "aborterror" ? "fetch_timeout" : "fetch_failed";
    return { ok: false, reason, error: String(err?.message || err), rows: [], ticker };
  }
}

function escapeHoldingHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatHoldingTrendDate(dateStr) {
  const d = parseDateLocal(dateStr);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return String(dateStr || "");
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}-${mm}-${yy}`;
}

function buildHoldingTrendSvg(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return '<div class="text-muted tiny-label">No trend points available yet.</div>';
  }
  if (points.length === 1) {
    return `<div class="tiny-label">Only one price point: ₹${Number(points[0].price || 0).toFixed(2)} on ${formatHoldingTrendDate(points[0].date)}</div>`;
  }

  const w = 340;
  const h = 140;
  const padX = 12;
  const padY = 12;
  const min = Math.min(...points.map(p => Number(p.price || 0)));
  const max = Math.max(...points.map(p => Number(p.price || 0)));
  const range = Math.max(1, max - min);
  const stepX = (w - padX * 2) / Math.max(1, points.length - 1);

  const coords = points.map((p, i) => {
    const x = padX + i * stepX;
    const y = h - padY - (((Number(p.price || 0) - min) / range) * (h - padY * 2));
    return { x, y, price: Number(p.price || 0), date: p.date };
  });
  const line = coords.map(c => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
  const area = `${padX},${h - padY} ${line} ${w - padX},${h - padY}`;
  const gradId = `holdingTrendFill-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  return `
    <div class="holding-trend-chart">
      <div class="holding-trend-tooltip" id="holdingTrendTooltip" style="display:none"></div>
      <svg class="holding-trend-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="7-day stock trend">
        <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(37,99,235,0.35)"></stop>
          <stop offset="100%" stop-color="rgba(37,99,235,0.04)"></stop>
        </linearGradient>
        </defs>
        <polyline points="${area}" fill="url(#${gradId})" stroke="none"></polyline>
        <polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${coords.map(c => `
          <circle
            class="holding-trend-point"
            cx="${c.x.toFixed(2)}"
            cy="${c.y.toFixed(2)}"
            r="3.2"
            fill="#2563eb"
            data-price="${c.price.toFixed(2)}"
            data-date="${formatHoldingTrendDate(c.date)}"></circle>
        `).join("")}
      </svg>
    </div>
  `;
}

function wireHoldingTrendTooltip() {
  const chart = document.querySelector("#holdingTrendBody .holding-trend-chart");
  const tip = document.getElementById("holdingTrendTooltip");
  if (!chart || !tip) return;

  const hide = () => { tip.style.display = "none"; };
  const showFor = (point) => {
    if (!point) return;
    const date = String(point.getAttribute("data-date") || "");
    const price = Number(point.getAttribute("data-price") || 0).toFixed(2);
    tip.innerHTML = `<strong>₹${price}</strong><span>${date}</span>`;
    tip.style.display = "grid";

    const chartRect = chart.getBoundingClientRect();
    const pointRect = point.getBoundingClientRect();
    const left = Math.max(6, Math.min(chartRect.width - 126, (pointRect.left - chartRect.left) - 52));
    const top = Math.max(6, (pointRect.top - chartRect.top) - 44);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  chart.querySelectorAll(".holding-trend-point").forEach(point => {
    point.addEventListener("mouseenter", () => showFor(point));
    point.addEventListener("mousemove", () => showFor(point));
    point.addEventListener("click", () => showFor(point));
    point.addEventListener("touchstart", () => showFor(point), { passive: true });
  });

  chart.addEventListener("mouseleave", hide);
  chart.addEventListener("touchend", () => setTimeout(hide, 1200), { passive: true });
}

function ensureHoldingTrendModal() {
  let modal = document.getElementById("holdingTrendModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "holdingTrendModal";
  modal.className = "holding-trend-modal";
  modal.innerHTML = `
    <div class="holding-trend-card" role="dialog" aria-modal="true" aria-labelledby="holdingTrendTitle">
      <div class="holding-trend-head">
        <div id="holdingTrendTitle" class="section-title mb-0">7-Day Price Trend</div>
        <button type="button" id="holdingTrendCloseBtn" class="btn btn-sm btn-outline-secondary" aria-label="Close">
          <i class="bi bi-x-lg"></i>
        </button>
      </div>
      <div id="holdingTrendBody" class="holding-trend-body"></div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });
  const closeBtn = modal.querySelector("#holdingTrendCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      modal.style.display = "none";
    });
  }
  return modal;
}

async function openHoldingPriceTrend(encodedStock) {
  let decoded = String(encodedStock || "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch (e) {}
  const stock = normalizeStockName(decoded);
  if (!stock) return;

  const modal = ensureHoldingTrendModal();
  const body = document.getElementById("holdingTrendBody");
  if (!modal || !body) return;

  modal.style.display = "flex";
  body.innerHTML = `<div class="tiny-label text-muted">Loading cloud trend...</div>`;
  const cloud = await fetchHoldingCloudTrend(stock, 7);
  const series = Array.isArray(cloud.rows) ? cloud.rows : [];
  const firstPrice = Number(series[0]?.price || 0);
  const lastPrice = Number(series[series.length - 1]?.price || 0);
  const delta = lastPrice - firstPrice;
  const deltaPct = firstPrice > 0 ? (delta / firstPrice) * 100 : 0;

  body.innerHTML = `
    <div class="split-row mb-2">
      <div class="left-col"><strong>${escapeHoldingHtml(stock)}</strong></div>
      <div class="right-col tiny-label ${delta >= 0 ? "profit" : "loss"}">
        ${series.length > 1 ? `${delta >= 0 ? "+" : ""}₹${delta.toFixed(2)} (${deltaPct.toFixed(2)}%)` : "Trend unavailable"}
      </div>
    </div>
    ${buildHoldingTrendSvg(series)}
    <div class="tiny-label text-muted">Tap/hover points to see price tooltip.</div>
    ${series.length ? "" : `<div class="tiny-label text-muted">Cloud trend data not available for ${escapeHoldingHtml(cloud.ticker || stock)}.</div>`}
    ${!cloud.ok ? `<div class="tiny-label text-muted mt-1">Reason: ${escapeHoldingHtml(cloud.reason || "unknown")}</div>` : ""}
  `;
  wireHoldingTrendTooltip();
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
        const map = buildPositionHoldingsMap(txns, settings, { captureCycleTxns: true });
        const totalActiveInvested = Object.keys(map).reduce((sum, st) => {
          const invested = (map[st]?.lots || []).reduce((a, l) => a + Number(l.qty || 0) * (Number(l.price || 0) + Number(l.brokeragePerUnit || 0)), 0);
          return sum + invested;
        }, 0);
        const s = map[stock] || { lots: [], cycleFirstBuy: null, cycleTxns: [] };
        const cycleBuyTxns = (s.cycleTxns || []).filter(ct => String(ct.type || "").toUpperCase() === "BUY");

        const existingInvested = s.lots.reduce((a, l) => a + l.qty * (l.price + l.brokeragePerUnit), 0);
        const existingQty = s.lots.reduce((a, l) => a + l.qty, 0);
        const currentAvg = existingQty > 0 ? (existingInvested / existingQty) : 0;
        const buyBrokerage = calculateBrokerage("BUY", qty, price, settings);
        const newBuyCost = qty * price + buyBrokerage;

        const postStockInvested = existingInvested + newBuyCost;
        const postTotalInvested = totalActiveInvested + newBuyCost;
        const postAllocPct = postTotalInvested > 0 ? (postStockInvested / postTotalInvested) * 100 : 0;

        const maxAllocPct = Number(settings.maxAllocationPct || 0);
        const stockBudget = (Number(settings.portfolioSize || 0) * maxAllocPct) / 100;
        const remainingBudget = stockBudget - postStockInvested;

        const base = Number(cycleBuyTxns[cycleBuyTxns.length - 1]?.price || price);
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

        const lastBuyPrice = Number(cycleBuyTxns[cycleBuyTxns.length - 1]?.price || price);
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
            <div class="left-col tiny-label">Stock: ${stock} | Qty: ${qty} | Price: ₹${price.toFixed(2)} | Buy Cost: ₹${newBuyCost.toFixed(2)}</div>
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
            <span>Current Avg (Old)</span>
            <span>${existingQty > 0 ? `₹${currentAvg.toFixed(2)}` : "-"}</span>
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

function compactHeaderKey(h) {
  return normalizeHeaderKey(h).replace(/_/g, "");
}

function buildHeaderAliasSet() {
  const all = [];
  Object.keys(IMPORT_HEADER_ALIASES).forEach(k => {
    (IMPORT_HEADER_ALIASES[k] || []).forEach(a => all.push(a));
  });
  return new Set(all.map(compactHeaderKey));
}

function scoreHeaderCandidate(cells) {
  const aliasSet = buildHeaderAliasSet();
  let score = 0;
  const raw = (cells || []).map(v => String(v || "").trim()).filter(Boolean);
  const keys = raw.map(normalizeHeaderKey);
  const compact = raw.map(compactHeaderKey);
  for (let i = 0; i < raw.length; i++) {
    const c = compact[i];
    if (!c) continue;
    if (aliasSet.has(c)) score += 2;
    if (c.includes("date")) score += 1;
    if (c.includes("price")) score += 1;
    if (c.includes("qty") || c.includes("quantity")) score += 1;
    if (c.includes("symbol") || c.includes("stock")) score += 1;
  }
  const zerodhaBoost = ["symbol", "trade_date", "trade_type", "quantity", "price"]
    .filter(k => keys.includes(k)).length;
  if (zerodhaBoost >= 4) score += 6;
  return score;
}

function normalizeTableFromAoa(aoa) {
  const table = Array.isArray(aoa) ? aoa : [];
  let headerIdx = -1;
  let bestScore = -1;
  const limit = Math.min(60, table.length);
  for (let i = 0; i < limit; i++) {
    const row = Array.isArray(table[i]) ? table[i] : [];
    const nonEmpty = row.filter(c => String(c == null ? "" : c).trim() !== "").length;
    if (nonEmpty < 3) continue;
    const score = scoreHeaderCandidate(row);
    if (score > bestScore) {
      bestScore = score;
      headerIdx = i;
    }
  }
  if (headerIdx < 0) return { headers: [], rows: [] };
  const headers = (table[headerIdx] || []).map(h => String(h == null ? "" : h).trim());
  const rows = [];
  for (let i = headerIdx + 1; i < table.length; i++) {
    const raw = Array.isArray(table[i]) ? table[i] : [];
    const row = raw.map(v => String(v == null ? "" : v).trim()).slice(0, headers.length);
    while (row.length < headers.length) row.push("");
    if (!row.some(c => c !== "")) continue;
    rows.push(row);
  }
  return { headers, rows };
}

async function parseBrokerImportFile(file) {
  const name = String(file?.name || "").toLowerCase();
  const isCsv = name.endsWith(".csv") || String(file?.type || "").toLowerCase().includes("csv");
  const isExcel = name.endsWith(".xlsx") || name.endsWith(".xls")
    || String(file?.type || "").toLowerCase().includes("spreadsheet")
    || String(file?.type || "").toLowerCase().includes("excel");

  if (isCsv) {
    const text = await file.text();
    return { ...parseCsvTextRows(text), format: "csv" };
  }

  if (isExcel) {
    if (typeof window === "undefined" || typeof window.XLSX === "undefined") {
      throw new Error("Excel parser not loaded. Refresh the page and try again.");
    }
    const ab = await file.arrayBuffer();
    const wb = window.XLSX.read(ab, { type: "array", cellDates: true });
    const sheetName = (wb?.SheetNames || []).find(Boolean);
    if (!sheetName) return { headers: [], rows: [], format: "excel" };
    const ws = wb.Sheets[sheetName];
    const aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
    return { ...normalizeTableFromAoa(aoa), format: "excel", sheetName };
  }

  throw new Error("Unsupported file type. Use CSV or Excel (.xlsx/.xls).");
}

function normalizeHeaderKey(h) {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

const IMPORT_HEADER_ALIASES = {
  date: ["trade_date", "date", "order_date", "execution_date", "transaction_date", "txn_date", "exchange_time", "trade_time"],
  stock: ["symbol", "stock", "stock_name", "scrip", "security", "instrument", "instrument_name", "tradingsymbol", "trading_symbol", "company", "company_name"],
  type: ["trade_type", "type", "side", "transaction_type", "buy_sell", "action", "trade", "order_type"],
  qty: ["quantity", "qty", "filled_qty", "executed_qty", "shares", "filled_quantity", "executed_quantity"],
  price: ["price", "avg_price", "average_price", "trade_price", "execution_price", "rate", "avg_traded_price", "average_traded_price"],
  note: ["note", "remarks", "comment", "order_id", "trade_id", "order_number", "exchange_order_id"],
  reason: ["reason", "tag", "strategy", "product", "segment"]
};

function getCsvHeaderSignature(headers) {
  return (headers || []).map(normalizeHeaderKey).join("|");
}

function findHeaderIndex(headers, aliases) {
  const keys = (headers || []).map(normalizeHeaderKey);
  const compactKeys = (headers || []).map(compactHeaderKey);
  const compactAliases = (aliases || []).map(compactHeaderKey);
  for (let i = 0; i < keys.length; i++) {
    if (aliases.includes(keys[i])) return i;
  }
  for (let i = 0; i < compactKeys.length; i++) {
    if (compactAliases.includes(compactKeys[i])) return i;
  }
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (aliases.some(a => key.includes(a))) return i;
  }
  for (let i = 0; i < compactKeys.length; i++) {
    const key = compactKeys[i];
    if (compactAliases.some(a => key.includes(a))) return i;
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
  const compactSet = new Set((headers || []).map(compactHeaderKey));
  const has = (k) => set.has(k) || compactSet.has(compactHeaderKey(k));
  const zerodhaRequired = ["symbol", "trade_date", "trade_type", "quantity", "price"];
  const isZerodha = zerodhaRequired.every(has);
  if (isZerodha) return "zerodha";
  const upstoxRequired = ["tradingsymbol", "transaction_type", "quantity", "average_price"];
  if (upstoxRequired.every(has)) return "upstox";
  const growwRequired = ["stock_name", "transaction_type", "quantity", "price"];
  if (growwRequired.every(has)) return "groww";
  const angelLikeRequired = ["symbol", "trade_type", "quantity", "price"];
  if (angelLikeRequired.every(has)) return "angel_one";
  return "unknown";
}

function detectSpecialImportFormat(headers) {
  const keys = new Set((headers || []).map(h => compactHeaderKey(h)));
  const has = (k) => keys.has(compactHeaderKey(k));
  const isFlatTradeLedger = has("scrip") && has("company") && has("date") && has("bqty") && has("snrate") && has("sqty") && has("bnrate");
  if (isFlatTradeLedger) return "flat_trade_ledger";
  const isGrowwPnl = has("stockname") && has("quantity") && has("buydate") && has("buyprice") && has("selldate") && has("sellprice");
  if (isGrowwPnl) return "groww_pnl_realised";
  return "";
}

function parseImportDate(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const isoDateTime = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T]/);
  if (isoDateTime) return `${isoDateTime[1]}-${isoDateTime[2]}-${isoDateTime[3]}`;
  const ymd = v.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (ymd) {
    const year = ymd[1];
    const month = String(Number(ymd[2])).padStart(2, "0");
    const day = String(Number(ymd[3])).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const dmy = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const day = String(Number(dmy[1])).padStart(2, "0");
    const month = String(Number(dmy[2])).padStart(2, "0");
    const year = dmy[3];
    return `${year}-${month}-${day}`;
  }
  const dmy2 = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (dmy2) {
    const day = String(Number(dmy2[1])).padStart(2, "0");
    const month = String(Number(dmy2[2])).padStart(2, "0");
    const yy = Number(dmy2[3]);
    const year = String(yy >= 70 ? 1900 + yy : 2000 + yy);
    return `${year}-${month}-${day}`;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseImportDateTime(raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  const isoLike = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (isoLike) {
    const sec = isoLike[6] || "00";
    return `${isoLike[1]}-${isoLike[2]}-${isoLike[3]}T${isoLike[4]}:${isoLike[5]}:${sec}`;
  }
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString();
}

function parseImportType(raw) {
  const t = String(raw || "").trim().toUpperCase();
  if (!t) return "";
  if (["BUY", "B", "LONG", "BOT", "PURCHASE"].includes(t)) return "BUY";
  if (["SELL", "S", "SHORT", "SLD", "DISPOSE"].includes(t)) return "SELL";
  if (t.includes("BUY")) return "BUY";
  if (t.includes("SELL")) return "SELL";
  return "";
}

function parseImportNum(raw) {
  const cleaned = String(raw == null ? "" : raw)
    .replace(/[, ]+/g, "")
    .replace(/[^\d.+-]/g, "")
    .trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function normalizeImportedStock(raw) {
  const base = normalizeStockName(raw);
  if (!base) return "";
  return base.replace(/-(EQ|BE|BZ|BL|SM|ST|GC|GS|IV)$/i, "");
}

function normalizeFlatTradeAliasKey(value) {
  const text = String(value || "").toUpperCase().trim();
  if (!text) return "";
  const compact = text
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\b(LIMITED|LTD|INDIA|INDUSTRIES|INDUSTRY|COMPANY|CO|CORP|CORPORATION)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact;
}

const FLAT_TRADE_COMPANY_TO_STOCK = {
  "AGI GREENPAC": "AGI",
  "AMBUJA CEMENTS": "AMBUJACEM",
  "ANANT RAJ": "ANANTRAJ",
  "APOLLO TYRES": "APOLLOTYRE",
  "BERGER PAINTS": "BERGEPAINT",
  "BRIGADE ENTERPRISES": "BRIGADE",
  "BSE": "BSE",
  "CAPLIN POINT LABORATORIES": "CAPLIPOINT",
  "CENTRAL DEPO SER I": "CDSL",
  "CIPLA": "CIPLA",
  "CORAL LABORATORIES": "CORALAB",
  "DABUR": "DABUR",
  "DLF": "DLF",
  "EIH": "EIHOTEL",
  "EMAMI": "EMAMILTD",
  "EASY TRIP PLANNERS": "EASEMYTRIP",
  "ETERNAL": "ETERNAL",
  "GOYAL ALUMINIUMS": "GOYALALUM",
  "GRAVITA": "GRAVITA",
  "HINDALCO": "HINDALCO",
  "HINDUSTAN AERONAUTICS": "HAL",
  "INDIAN OVERSEAS BANK": "IOB",
  "JK TYRE": "JKTYRE",
  "KNR CONSTRUCTIONS": "KNRCON",
  "MARKSANS PHARMA": "MARKSANS",
  "NATCO PHARMA": "NATCOPHARM",
  "NATIONAL ALUMINIUM": "NATIONALUM",
  "NHPC": "NHPC",
  "NMDC": "NMDC",
  "RPG LIFE SCIENCES": "RPGLIFE",
  "RADHIKA JEWELTECH": "RADHIKAJWE",
  "RELIANCE INDUSTRIES": "RELIANCE",
  "SOUTH INDIAN BANK": "SOUTHBANK",
  "SUN TV NETWORK": "SUNTV",
  "SUZLON ENERGY": "SUZLON",
  "SHANTI GOLD INTERNATIONAL LIMI": "SHANTIGOLD",
  "TAMILNADU PETROPRODUCTS": "TNPETRO",
  "TATA POWER": "TATAPOWER",
  "TATA STEEL": "TATASTEEL",
  "WIPRO": "WIPRO",
  "ICICI PRUDENTIAL GOLD ETF": "GOLDIETF",
  "MOTILAL OSWAL MOST SHARES NASD": "MON100",
  "GOKUL AGRO RESOURCES": "GOKULAGRO",
  "GOKUL AGRO": "GOKULAGRO"
};

function getFlatTradeCompanyAliasMap() {
  const out = Object.assign({}, FLAT_TRADE_COMPANY_TO_STOCK);
  try {
    const raw = localStorage.getItem("flatTradeStockAliases");
    const parsed = raw ? JSON.parse(raw) : {};
    Object.keys(parsed || {}).forEach(k => {
      const key = normalizeFlatTradeAliasKey(k);
      const val = normalizeImportedStock(parsed[k]);
      if (key && val) out[key] = val;
    });
  } catch (e) {}
  return out;
}

function parseGrowwPnlRows(headers, rows) {
  const idx = {
    stock: findHeaderIndex(headers, ["stock_name", "stockname", "stock"]),
    qty: findHeaderIndex(headers, ["quantity", "qty"]),
    buyDate: findHeaderIndex(headers, ["buy_date", "buydate"]),
    buyPrice: findHeaderIndex(headers, ["buy_price", "buyprice", "avg_buy_price"]),
    sellDate: findHeaderIndex(headers, ["sell_date", "selldate"]),
    sellPrice: findHeaderIndex(headers, ["sell_price", "sellprice", "avg_sell_price"])
  };
  if (Object.values(idx).some(v => v < 0)) {
    return { error: "Groww report columns not found (stock/qty/buy/sell date+price required)." };
  }

  let invalidRows = 0;
  const reasonCounts = {};
  const addReason = (k) => { reasonCounts[k] = (reasonCounts[k] || 0) + 1; };
  const out = [];

  (rows || []).forEach((row, i) => {
    const stock = normalizeImportedStock(row[idx.stock]);
    const qty = parseImportNum(row[idx.qty]);
    const buyDate = parseImportDate(row[idx.buyDate]);
    const sellDate = parseImportDate(row[idx.sellDate]);
    const buyPrice = parseImportNum(row[idx.buyPrice]);
    const sellPrice = parseImportNum(row[idx.sellPrice]);
    if (!stock) { invalidRows++; addReason("missing_stock"); return; }
    if (qty <= 0) { invalidRows++; addReason("invalid_qty"); return; }
    if (!buyDate || !sellDate) { invalidRows++; addReason("invalid_date"); return; }
    if (buyPrice <= 0 || sellPrice <= 0) { invalidRows++; addReason("invalid_price"); return; }

    const baseKey = `groww_pnl|${stock}|${buyDate}|${sellDate}|${qty}|${buyPrice.toFixed(4)}|${sellPrice.toFixed(4)}|${i}`;
    out.push({
      date: buyDate,
      stock,
      type: "BUY",
      qty,
      price: buyPrice,
      reason: "Broker Import",
      note: "Imported: Groww P&L report (realised buy leg)",
      importSource: "groww_pnl",
      importKey: `${baseKey}|BUY`
    });
    out.push({
      date: sellDate,
      stock,
      type: "SELL",
      qty,
      price: sellPrice,
      reason: "Broker Import",
      note: "Imported: Groww P&L report (realised sell leg)",
      importSource: "groww_pnl",
      importKey: `${baseKey}|SELL`
    });
  });

  return { rows: out, invalidRows, reasonCounts };
}

function extractFlatTradeStockName(scripRaw) {
  const text = String(scripRaw || "").trim();
  if (!text) return "";
  // Typical: "500187 AGI GREENPAC LIMITED" -> "AGI GREENPAC LIMITED"
  const withoutCode = text.replace(/^\d+\s+/, "").trim();
  const aliasMap = getFlatTradeCompanyAliasMap();
  const key = normalizeFlatTradeAliasKey(withoutCode || text);
  const mapped = aliasMap[key];
  if (mapped) return normalizeImportedStock(mapped);
  return normalizeImportedStock(withoutCode || text);
}

function parseFlatTradeLedgerRows(headers, rows) {
  const idx = {
    scrip: findHeaderIndex(headers, ["scrip"]),
    date: findHeaderIndex(headers, ["date"]),
    bQty: findHeaderIndex(headers, ["b_qty", "bqty"]),
    bRate: findHeaderIndex(headers, ["b_n_rate", "bnrate", "b_gr_rate", "bgrrate"]),
    sQty: findHeaderIndex(headers, ["s_qty", "sqty"]),
    sRate: findHeaderIndex(headers, ["s_n_rate", "snrate", "s_gr_rate", "sgrrate"]),
    narration: findHeaderIndex(headers, ["narration"]),
    company: findHeaderIndex(headers, ["company"])
  };
  if ([idx.scrip, idx.date, idx.bQty, idx.bRate, idx.sQty, idx.sRate].some(v => v < 0)) {
    return { error: "Flat Trade format columns not found (Scrip/Date/B.Qty/B.N.Rate/S.Qty/S.N.Rate)." };
  }

  let invalidRows = 0;
  const reasonCounts = {};
  const addReason = (k) => { reasonCounts[k] = (reasonCounts[k] || 0) + 1; };
  const out = [];

  (rows || []).forEach((row, i) => {
    const stock = extractFlatTradeStockName(row[idx.scrip]);
    const date = parseImportDate(row[idx.date]);
    const buyQty = parseImportNum(row[idx.bQty]);
    const buyRate = parseImportNum(row[idx.bRate]);
    const sellQty = parseImportNum(row[idx.sQty]);
    const sellRate = parseImportNum(row[idx.sRate]);
    const narration = idx.narration >= 0 ? String(row[idx.narration] || "").trim() : "";
    const company = idx.company >= 0 ? String(row[idx.company] || "").trim() : "";

    if (!stock || !date) {
      invalidRows++;
      addReason(!stock ? "missing_stock" : "invalid_date");
      return;
    }

    let created = 0;
    if (buyQty > 0 && buyRate > 0) {
      out.push({
        date,
        stock,
        type: "BUY",
        qty: buyQty,
        price: buyRate,
        reason: "Broker Import",
        note: `Imported: Flat Trade ledger${narration ? ` | ${narration}` : ""}${company ? ` | ${company}` : ""}`,
        importSource: "flat_trade_ledger",
        importKey: `flat_trade|${i}|BUY|${date}|${stock}|${buyQty}|${buyRate.toFixed(4)}`
      });
      created++;
    }
    if (sellQty > 0 && sellRate > 0) {
      out.push({
        date,
        stock,
        type: "SELL",
        qty: sellQty,
        price: sellRate,
        reason: "Broker Import",
        note: `Imported: Flat Trade ledger${narration ? ` | ${narration}` : ""}${company ? ` | ${company}` : ""}`,
        importSource: "flat_trade_ledger",
        importKey: `flat_trade|${i}|SELL|${date}|${stock}|${sellQty}|${sellRate.toFixed(4)}`
      });
      created++;
    }

    if (!created) {
      invalidRows++;
      addReason("zero_qty_or_price");
    }
  });

  return { rows: out, invalidRows, reasonCounts };
}

function parseZerodhaFill(headers, row) {
  const idx = {};
  headers.forEach((h, i) => { idx[normalizeHeaderKey(h)] = i; });
  const stock = normalizeImportedStock(row[idx.symbol]);
  const date = parseImportDate(row[idx.trade_date]);
  const type = parseImportType(row[idx.trade_type]);
  const qty = parseImportNum(row[idx.quantity]);
  const price = parseImportNum(row[idx.price]);
  const exchange = String(row[idx.exchange] || "").trim().toUpperCase();
  const orderId = String(row[idx.order_id] || "").trim();
  const tradeId = String(row[idx.trade_id] || "").trim();
  const execTime = String(row[idx.order_execution_time] || "").trim();
  const tradeDateTime = parseImportDateTime(execTime) || parseImportDateTime(row[idx.trade_date]);
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
      execTime,
      tradeDateTime
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
      importKey,
      tradeDateTime: g.firstExec || ""
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
      <div class="tiny-label mb-2">Map required fields for this broker file format.</div>
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
      <div class="tiny-label mt-2">Type values supported: BUY/SELL, B/S, LONG/SHORT</div>
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
    const rawDate = row[iDate];
    const date = parseImportDate(rawDate);
    const tradeDateTime = parseImportDateTime(rawDate);
    const stock = normalizeImportedStock(row[iStock]);
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
      note: note || "Imported: Custom broker mapping",
      importSource: "broker_file",
      tradeDateTime
    };
  }).filter(Boolean);
  return { rows: parsed, invalidRows, reasonCounts };
}

function readAllTransactionsForImport() {
  return new Promise((resolve, reject) => {
    try {
      const req = db.transaction("transactions", "readonly").objectStore("transactions").getAll();
      req.onsuccess = e => resolve(Array.isArray(e?.target?.result) ? e.target.result : []);
      req.onerror = () => reject(req.error || new Error("Failed to read transactions"));
    } catch (err) {
      reject(err);
    }
  });
}

function makeImportRowIdentity(row) {
  const type = String(row?.type || "").toUpperCase();
  const qty = Number(row?.qty || 0);
  const price = Number(row?.price || 0).toFixed(4);
  const stock = normalizeStockName(row?.stock || "");
  const date = String(row?.date || "");
  const dt = String(row?.tradeDateTime || "");
  return `${date}|${dt}|${stock}|${type}|${qty}|${price}`;
}

function getImportSortTime(row) {
  const dt = String(row?.tradeDateTime || "").trim();
  if (dt) {
    const t = Date.parse(dt);
    if (Number.isFinite(t)) return t;
  }
  const d = String(row?.date || "").trim();
  const t2 = Date.parse(d);
  if (Number.isFinite(t2)) return t2;
  return 0;
}

function analyzeImportRowsForValidation(parsedRows, existingRows) {
  const rows = Array.isArray(parsedRows) ? parsedRows : [];
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const duplicateIdx = [];
  const firstSeen = new Map();
  rows.forEach((r, idx) => {
    const key = makeImportRowIdentity(r);
    if (firstSeen.has(key)) duplicateIdx.push(idx);
    else firstSeen.set(key, idx);
  });

  const balances = {};
  const sortedExisting = existing.slice().sort((a, b) => getImportSortTime(a) - getImportSortTime(b));
  sortedExisting.forEach(t => {
    const stock = normalizeStockName(t?.stock || "");
    const qty = Number(t?.qty || 0);
    const type = String(t?.type || "").toUpperCase();
    if (!stock || qty <= 0) return;
    balances[stock] = Number(balances[stock] || 0);
    if (type === "BUY") balances[stock] += qty;
    else if (type === "SELL") balances[stock] -= qty;
  });

  const withIdx = rows.map((r, idx) => ({ ...r, __idx: idx }));
  const sortedImport = withIdx.slice().sort((a, b) => {
    const d = getImportSortTime(a) - getImportSortTime(b);
    if (d !== 0) return d;
    return a.__idx - b.__idx;
  });

  const impossibleSells = [];
  const symbolStats = {};
  sortedImport.forEach(r => {
    const stock = normalizeStockName(r?.stock || "");
    const qty = Number(r?.qty || 0);
    const type = String(r?.type || "").toUpperCase();
    if (!stock || qty <= 0 || (type !== "BUY" && type !== "SELL")) return;
    balances[stock] = Number(balances[stock] || 0);
    symbolStats[stock] ??= { buy: 0, sell: 0, net: 0 };
    if (type === "BUY") {
      balances[stock] += qty;
      symbolStats[stock].buy += qty;
      symbolStats[stock].net += qty;
      return;
    }
    if (qty > balances[stock] + 1e-9) {
      impossibleSells.push({
        idx: Number(r.__idx),
        stock,
        date: String(r.date || ""),
        tradeDateTime: String(r.tradeDateTime || ""),
        qty,
        available: Number(Math.max(0, balances[stock]))
      });
      balances[stock] = 0;
    } else {
      balances[stock] -= qty;
    }
    symbolStats[stock].sell += qty;
    symbolStats[stock].net -= qty;
  });

  const topSymbols = Object.keys(symbolStats)
    .map(s => ({ stock: s, ...symbolStats[s] }))
    .sort((a, b) => Math.abs(Number(b.net || 0)) - Math.abs(Number(a.net || 0)))
    .slice(0, 10);

  return {
    totalRows: rows.length,
    duplicateIdx,
    impossibleSells,
    topSymbols
  };
}

function openImportValidatorModal(report) {
  return new Promise(resolve => {
    const duplicateCount = Number(report?.duplicateIdx?.length || 0);
    const impossibleCount = Number(report?.impossibleSells?.length || 0);
    const sampleImpossible = (report?.impossibleSells || []).slice(0, 8);
    const topSymbols = (report?.topSymbols || []).slice(0, 8);
    const backdrop = document.createElement("div");
    backdrop.className = "backup-popup-backdrop";
    backdrop.innerHTML = `
      <div class="backup-popup" style="width:min(94vw,700px);max-height:85vh;overflow:auto">
        <div class="backup-popup-head">
          <span class="backup-popup-icon"><i class="bi bi-shield-check"></i></span>
          <div>
            <div class="backup-popup-title">Import Validator</div>
            <div class="backup-popup-sub">Review and optionally clean suspicious rows before import.</div>
          </div>
        </div>
        <div class="tiny-label mb-2">
          Parsed rows: <strong>${Number(report?.totalRows || 0)}</strong> |
          Exact duplicates in file: <strong>${duplicateCount}</strong> |
          Impossible sells: <strong>${impossibleCount}</strong>
        </div>
        <div class="mb-2">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="importSkipDup" ${duplicateCount ? "checked" : ""}>
            <label class="form-check-label" for="importSkipDup">Skip exact duplicate rows in this file (${duplicateCount})</label>
          </div>
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="importSkipImpossible" ${impossibleCount ? "checked" : ""}>
            <label class="form-check-label" for="importSkipImpossible">Skip impossible SELL rows (sell qty exceeds available)</label>
          </div>
        </div>
        <div class="mb-2">
          <label class="form-label">Exclude symbols (comma/newline separated)</label>
          <textarea id="importExcludeSymbols" class="form-control" rows="2" placeholder="Example: RELIANCE, XYZ"></textarea>
        </div>
        <div class="mb-2 tiny-label">
          <strong>Top symbols by net qty in import:</strong>
          <div>${topSymbols.length ? topSymbols.map(s => `${s.stock} (${Number(s.net).toFixed(2)})`).join(", ") : "n/a"}</div>
        </div>
        <div class="mb-2 tiny-label">
          <strong>Impossible sell samples:</strong>
          <div>${sampleImpossible.length ? sampleImpossible.map(x => `${x.stock} ${x.date || x.tradeDateTime} sell=${x.qty} available=${x.available}`).join(" | ") : "none"}</div>
        </div>
        <div class="backup-popup-actions">
          <button type="button" class="btn btn-outline-secondary" id="importValidatorCancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="importValidatorProceed">Apply & Continue</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const cleanup = () => {
      try { backdrop.remove(); } catch (e) {}
    };
    backdrop.querySelector("#importValidatorCancel")?.addEventListener("click", () => {
      cleanup();
      resolve({ proceed: false });
    });
    backdrop.querySelector("#importValidatorProceed")?.addEventListener("click", () => {
      const skipDuplicates = !!backdrop.querySelector("#importSkipDup")?.checked;
      const skipImpossible = !!backdrop.querySelector("#importSkipImpossible")?.checked;
      const excludeSymbolsRaw = String(backdrop.querySelector("#importExcludeSymbols")?.value || "");
      const excludeSymbols = excludeSymbolsRaw
        .split(/[\n,]+/)
        .map(s => normalizeStockName(s))
        .filter(Boolean);
      cleanup();
      resolve({
        proceed: true,
        skipDuplicates,
        skipImpossible,
        excludeSymbols
      });
    });
  });
}

function applyImportValidationSelection(rows, report, selection) {
  const list = Array.isArray(rows) ? rows : [];
  const skipIdx = new Set();
  if (selection?.skipDuplicates) {
    (report?.duplicateIdx || []).forEach(i => skipIdx.add(Number(i)));
  }
  if (selection?.skipImpossible) {
    (report?.impossibleSells || []).forEach(x => skipIdx.add(Number(x?.idx)));
  }
  const excludedSymbols = new Set((selection?.excludeSymbols || []).map(normalizeStockName).filter(Boolean));

  let removedDuplicate = 0;
  let removedImpossible = 0;
  let removedSymbol = 0;
  const impossibleIdx = new Set((report?.impossibleSells || []).map(x => Number(x?.idx)));
  const duplicateIdx = new Set((report?.duplicateIdx || []).map(Number));

  const kept = list.filter((r, idx) => {
    const stock = normalizeStockName(r?.stock || "");
    if (excludedSymbols.has(stock)) {
      removedSymbol++;
      return false;
    }
    if (skipIdx.has(idx)) {
      if (duplicateIdx.has(idx)) removedDuplicate++;
      if (impossibleIdx.has(idx)) removedImpossible++;
      return false;
    }
    return true;
  });

  return {
    rows: kept,
    removedDuplicate,
    removedImpossible,
    removedSymbol
  };
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
  return `fallback|${t.date}|${String(t.tradeDateTime || "").trim()}|${normalizeStockName(t.stock)}|${String(t.type || "").toUpperCase()}|${Number(t.qty || 0)}|${Number(t.price || 0).toFixed(4)}`;
}

function dedupeImportedRows(newRows, existingRows) {
  const seenCounts = new Map();
  (existingRows || []).forEach(t => {
    const key = buildTxnIdentity(t);
    seenCounts.set(key, Number(seenCounts.get(key) || 0) + 1);
  });
  const out = [];
  let skipped = 0;
  (newRows || []).forEach(t => {
    const key = buildTxnIdentity(t);
    const have = Number(seenCounts.get(key) || 0);
    if (have > 0) {
      skipped++;
      seenCounts.set(key, have - 1);
      return;
    }
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
    if (typeof showToast === "function") showToast("Please choose a broker file (CSV/Excel)", "error");
    return;
  }

  try {
    const { headers, rows, format, sheetName } = await parseBrokerImportFile(file);
    if (!headers.length || !rows.length) {
      if (typeof showToast === "function") showToast("File appears empty or invalid", "error");
      return;
    }

    const broker = detectBrokerByHeaders(headers);
    const specialFormat = detectSpecialImportFormat(headers);
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

    if (specialFormat === "flat_trade_ledger") {
      const flatParsed = parseFlatTradeLedgerRows(headers, rows);
      if (flatParsed.error) {
        if (typeof showToast === "function") showToast(flatParsed.error, "error");
        return;
      }
      parsedRows = flatParsed.rows || [];
      invalidRows = Number(flatParsed.invalidRows || 0);
      Object.keys(flatParsed.reasonCounts || {}).forEach(k => addReason(k));
      if (meta) {
        meta.textContent = `Detected: Flat Trade Ledger (${String(format || "").toUpperCase()}) | Generated txns: ${parsedRows.length}${invalidRows ? ` | Skipped invalid: ${invalidRows}` : ""}${sheetName ? ` | Sheet: ${sheetName}` : ""}`;
      }
      if (mappingPanel) {
        mappingPanel.style.display = "none";
        mappingPanel.innerHTML = "";
      }
    } else if (specialFormat === "groww_pnl_realised") {
      const growwParsed = parseGrowwPnlRows(headers, rows);
      if (growwParsed.error) {
        if (typeof showToast === "function") showToast(growwParsed.error, "error");
        return;
      }
      parsedRows = growwParsed.rows || [];
      invalidRows = Number(growwParsed.invalidRows || 0);
      Object.keys(growwParsed.reasonCounts || {}).forEach(k => addReason(k));
      if (meta) {
        meta.textContent = `Detected: Groww P&L Report (${String(format || "").toUpperCase()}) | Generated txns: ${parsedRows.length}${invalidRows ? ` | Skipped invalid: ${invalidRows}` : ""}${sheetName ? ` | Sheet: ${sheetName}` : ""}`;
      }
      if (mappingPanel) {
        mappingPanel.style.display = "none";
        mappingPanel.innerHTML = "";
      }
    } else if (broker === "zerodha") {
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
      if (meta) meta.textContent = `Detected: Zerodha (${String(format || "").toUpperCase()}) | Fills: ${normalized.fillsCount} | Normalized orders: ${normalized.groupsCount}${invalidRows ? ` | Skipped invalid: ${invalidRows}` : ""}${sheetName ? ` | Sheet: ${sheetName}` : ""}`;
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
          ? `Detected: ${broker === "unknown" ? "Custom broker" : broker} (${String(format || "").toUpperCase()}) | Using your saved mapping.`
          : `Detected: ${broker === "unknown" ? "Unknown broker format" : broker} (${String(format || "").toUpperCase()}). Review auto-mapping and click Import.`;
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
        meta.textContent = `Detected: ${broker === "unknown" ? "Custom broker format" : broker} | Parsed rows: ${parsedRows.length}${invalidRows ? ` | Skipped invalid: ${invalidRows}` : ""}${sheetName ? ` | Sheet: ${sheetName}` : ""}`;
      }
    }

    if (!parsedRows.length) {
      const summary = [
        `Input rows: ${rows.length}`,
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

    const existing = await readAllTransactionsForImport();
    const validation = analyzeImportRowsForValidation(parsedRows, existing);
    const selection = await openImportValidatorModal(validation);
    if (!selection?.proceed) return;
    const sanitized = applyImportValidationSelection(parsedRows, validation, selection);
    parsedRows = sanitized.rows || [];
    if (!parsedRows.length) {
      const removedTotal = Number(sanitized.removedDuplicate || 0) + Number(sanitized.removedImpossible || 0) + Number(sanitized.removedSymbol || 0);
      if (typeof showToast === "function") showToast(`Nothing to import after validator filters (removed ${removedTotal})`, "info");
      return;
    }

    const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
      ? await window.appConfirmDialog(`Import ${parsedRows.length} transactions? Duplicates will be skipped.`, { title: "Confirm Broker Import", okText: "Import" })
      : window.confirm(`Import ${parsedRows.length} transactions? Duplicates will be skipped.`);
    if (!ok) return;
    if (typeof window !== "undefined" && typeof window.appShowLoading === "function") {
      window.appShowLoading("Saving imported transactions...");
    }

    try {
      const deduped = dedupeImportedRows(parsedRows, existing);
      const toInsert = deduped.rows;
      if (!toInsert.length) {
        const reasonText = Object.keys(reasonCounts).length
          ? Object.keys(reasonCounts).map(k => `${k}: ${reasonCounts[k]}`).join(", ")
          : "none";
        const summary = [
          `Input rows: ${rows.length}`,
          `Valid parsed: ${parsedRows.length}`,
          "Stored: 0",
          `Duplicates skipped: ${deduped.skipped}`,
          `Invalid skipped: ${invalidRows}`,
          `Validator removed duplicates: ${Number(sanitized.removedDuplicate || 0)}`,
          `Validator removed impossible sells: ${Number(sanitized.removedImpossible || 0)}`,
          `Validator removed excluded symbols: ${Number(sanitized.removedSymbol || 0)}`,
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
              tradeDateTime: t.tradeDateTime || "",
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
            `Input rows: ${rows.length}`,
            `Valid parsed: ${parsedRows.length}`,
            `Stored: ${storedCount}`,
            `Duplicates skipped: ${deduped.skipped}`,
            `Invalid skipped: ${invalidRows}`,
            `Validator removed duplicates: ${Number(sanitized.removedDuplicate || 0)}`,
            `Validator removed impossible sells: ${Number(sanitized.removedImpossible || 0)}`,
            `Validator removed excluded symbols: ${Number(sanitized.removedSymbol || 0)}`,
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
            meta.textContent = `Imported ${storedCount} new rows. Skipped duplicates: ${deduped.skipped}${invalidRows ? ` | Invalid rows: ${invalidRows}` : ""}${insertErrors ? ` | Write errors: ${insertErrors}` : ""}. Validator removed: dup ${Number(sanitized.removedDuplicate || 0)}, impossible ${Number(sanitized.removedImpossible || 0)}, symbols ${Number(sanitized.removedSymbol || 0)}.${cloud.ok ? " Synced to Google Sheet." : " Cloud sync pending."}`;
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
  } catch (err) {
    if (typeof showToast === "function") showToast("Import failed: " + (err?.message || err), "error");
    if (typeof window !== "undefined" && typeof window.appHideLoading === "function") window.appHideLoading();
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

function getTxnSortTime(txn) {
  const dt = String(txn?.tradeDateTime || "").trim();
  if (dt) {
    const tm = Date.parse(dt);
    if (Number.isFinite(tm)) return tm;
  }
  const d = String(txn?.date || "").trim();
  const tm2 = Date.parse(d);
  if (Number.isFinite(tm2)) return tm2;
  return 0;
}

function toggleHoldingCycle(panelId, btnEl) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  const isOpen = panel.style.display !== "none";
  panel.style.display = isOpen ? "none" : "block";
  if (btnEl) {
    btnEl.setAttribute("aria-expanded", String(!isOpen));
    const textEl = btnEl.querySelector("span");
    if (textEl) textEl.textContent = isOpen ? "Show Transactions" : "Hide Transactions";
    const icon = btnEl.querySelector("i");
    if (icon) {
      icon.classList.remove("bi-chevron-down", "bi-chevron-up");
      icon.classList.add(isOpen ? "bi-chevron-down" : "bi-chevron-up");
    }
  }
}

function renderHoldingsVisuals(rows) {
  const donut = document.getElementById("holdingsAllocDonut");
  const legend = document.getElementById("holdingsAllocLegend");
  const trend = document.getElementById("holdingsTrendChart");
  if (!donut && !legend && !trend) return;

  const list = (rows || []).slice().sort((a, b) => Number(b.invested || 0) - Number(a.invested || 0));
  const totalInvested = list.reduce((a, r) => a + Number(r.invested || 0), 0);
  if (!list.length || totalInvested <= 0) {
    if (donut) donut.innerHTML = `<div class="text-muted">No active holdings</div>`;
    if (legend) legend.innerHTML = "";
    if (trend) trend.innerHTML = `<div class="text-muted">No trend data</div>`;
    return;
  }

  const top = list.slice(0, 6);
  const colors = ["#2563eb", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];
  let cursor = 0;
  const gradients = top.map((r, i) => {
    const pct = (Number(r.invested || 0) / totalInvested) * 100;
    const seg = `${colors[i % colors.length]} ${cursor}% ${cursor + pct}%`;
    cursor += pct;
    return seg;
  });
  if (cursor < 100) gradients.push(`#cbd5e1 ${cursor}% 100%`);

  if (donut) {
    donut.innerHTML = `
      <div class="adv-donut" style="background:conic-gradient(${gradients.join(",")})"></div>
      <div class="tiny-label mt-2 text-center">Top holdings allocation</div>
    `;
  }
  if (legend) {
    legend.innerHTML = top.map((r, i) => `
      <div class="split-row">
        <div class="left-col tiny-label"><span class="legend-dot" style="background:${colors[i % colors.length]}"></span>${r.stock}</div>
        <div class="right-col tiny-label">${((Number(r.invested || 0) / totalInvested) * 100).toFixed(2)}%</div>
      </div>
    `).join("");
  }
  if (trend) {
    const maxAbs = Math.max(1, ...list.map(r => Math.abs(Number(r.unrealized || 0))));
    trend.innerHTML = list.slice(0, 8).map(r => {
      const v = Number(r.unrealized || 0);
      const w = (Math.abs(v) / maxAbs) * 100;
      const cls = v >= 0 ? "profit" : "loss";
      return `
        <div class="adv-bar-row">
          <div class="adv-bar-label">${r.stock}</div>
          <div class="adv-bar-track"><div class="adv-bar ${cls}" style="width:${w}%"></div></div>
          <div class="adv-bar-value ${cls}">${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}</div>
        </div>
      `;
    }).join("");
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
  function buildPositionHoldingsMap(txns, settings, options = {}) {
    const captureCycleTxns = !!options.captureCycleTxns;
    const sorted = (txns || []).slice().sort((a, b) => {
      const d = getTxnSortTime(a) - getTxnSortTime(b);
      if (d !== 0) return d;
      return toFiniteNumber(a.id, 0) - toFiniteNumber(b.id, 0);
    });

    const map = {};
    sorted.forEach(t => {
      const stock = normalizeStockName(t.stock);
      if (!stock) return;
      map[stock] ??= { lots: [], cycleFirstBuy: null, cycleTxns: [] };

      const qty = toFiniteNumber(t.qty, 0);
      const price = toFiniteNumber(t.price, 0);
      const type = String(t.type || "").toUpperCase();
      if (qty <= 0 || price <= 0 || (type !== "BUY" && type !== "SELL")) return;

      if (type === "BUY") {
        if (map[stock].lots.length === 0) {
          map[stock].cycleFirstBuy = String(t.date || "");
          map[stock].cycleTxns = [];
        }
        const txnBrokerage = resolveTxnBrokerage(t, settings);
        map[stock].lots.push({
          qty,
          price,
          brokeragePerUnit: qty > 0 ? txnBrokerage / qty : 0,
          date: String(t.date || "")
        });
        if (captureCycleTxns) {
          map[stock].cycleTxns.push({
            date: String(t.date || ""),
            type: "BUY",
            qty,
            price
          });
        }
        return;
      }

      const availableQty = map[stock].lots.reduce((a, l) => a + Number(l.qty || 0), 0);
      const appliedQty = Math.min(qty, availableQty);
      if (appliedQty <= 0) return;

      if (captureCycleTxns && map[stock].lots.length > 0) {
        map[stock].cycleTxns.push({
          date: String(t.date || ""),
          type: "SELL",
          qty: appliedQty,
          price
        });
      }

      let sellQty = appliedQty;
      while (sellQty > 0 && map[stock].lots.length) {
        const lot = map[stock].lots[0];
        const used = Math.min(lot.qty, sellQty);
        lot.qty -= used;
        sellQty -= used;
        if (lot.qty === 0) map[stock].lots.shift();
      }

      if (map[stock].lots.length === 0) {
        map[stock].cycleFirstBuy = null;
        map[stock].cycleTxns = [];
      }
    });

    return map;
  }

  function getHoldingsSortMode() {
    try {
      const saved = String(localStorage.getItem("holdings_sort_mode") || "").trim();
      if (saved) return saved;
    } catch (e) {}
    return "profit_desc";
  }

  function sortHoldingRows(rows, mode) {
    const list = (rows || []).slice();
    const compareName = (a, b) => String(a.stock || "").localeCompare(String(b.stock || ""));
    switch (String(mode || "")) {
      case "name_asc":
        return list.sort(compareName);
      case "profit_desc":
        return list.sort((a, b) => Number(b.unrealizedSort || 0) - Number(a.unrealizedSort || 0));
      case "loss_desc":
        return list.sort((a, b) => Number(a.unrealizedSort || 0) - Number(b.unrealizedSort || 0));
      case "qty_desc":
        return list.sort((a, b) => Number(b.qty || 0) - Number(a.qty || 0));
      case "days_desc":
        return list.sort((a, b) => Number(b.days || 0) - Number(a.days || 0));
      case "value_desc":
      default:
        return list.sort((a, b) => Number(b.valueSort || 0) - Number(a.valueSort || 0));
    }
  }

  function calculateHoldings() {
    const holdingsList = document.getElementById("holdingsList");
    if (!holdingsList) return;

    const sortEl = document.getElementById("holdingsSort");
    if (sortEl) {
      if (sortEl.dataset.wired !== "1") {
        sortEl.dataset.wired = "1";
        sortEl.addEventListener("change", () => {
          try { localStorage.setItem("holdings_sort_mode", String(sortEl.value || "invested_desc")); } catch (e) {}
          calculateHoldings();
        });
      }
      const mode = getHoldingsSortMode();
      if (sortEl.value !== mode) sortEl.value = mode;
    }
  
    getSettings(settings => {
      db.transaction("transactions", "readonly")
        .objectStore("transactions")
        .getAll().onsuccess = e => {
        const txns = e.target.result || [];
        const map = buildPositionHoldingsMap(txns, settings, { captureCycleTxns: true });
  
        holdingsList.innerHTML = "";
        const visualRows = [];
        const holdingRows = [];
  
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
          const avgPrice = qty > 0 ? (invested / qty) : 0;
          const unrealizedPct = hasLive && invested > 0 ? (unrealized / invested) * 100 : null;
          const days = Math.floor(
            (new Date() - parseDateLocal(map[s].cycleFirstBuy)) / 86400000
          );
          const cyclePanelId = `holding-cycle-${String(s).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          const stockToken = encodeURIComponent(s);
          const cycleTxns = Array.isArray(map[s].cycleTxns) ? map[s].cycleTxns : [];
          const cycleHtml = cycleTxns.length
            ? cycleTxns.map(ct => `
                <div class="holding-cycle-row">
                  <div class="left-col tiny-label">${ct.date} | ${ct.type} | Qty ${Number(ct.qty || 0)}</div>
                  <div class="right-col tiny-label">₹${Number(ct.price || 0).toFixed(2)}</div>
                </div>
              `).join("")
            : `<div class="tiny-label text-muted">No current cycle transactions</div>`;
  
          visualRows.push({
            stock: s,
            invested,
            unrealized: hasLive ? unrealized : 0
          });
          holdingRows.push({
            stock: s,
            qty,
            invested,
            avgPrice,
            days,
            hasLive,
            ltp,
            currentValue,
            unrealized,
            unrealizedPct,
            unrealizedSort: hasLive ? Number(unrealized || 0) : Number.NEGATIVE_INFINITY,
            valueSort: hasLive ? Number(currentValue || 0) : Number(invested || 0),
            cyclePanelId,
            stockToken,
            cycleHtml
          });
        }

        const sortedRows = sortHoldingRows(holdingRows, getHoldingsSortMode());
        sortedRows.forEach(r => {
          const pnlClass = !r.hasLive ? "text-muted" : (r.unrealized >= 0 ? "profit" : "loss");
          const pnlText = r.hasLive ? `${r.unrealized >= 0 ? "+" : "-"}₹${Math.abs(r.unrealized).toFixed(2)}` : "LTP unavailable";
          const pnlPctText = r.hasLive && Number.isFinite(r.unrealizedPct)
            ? `${r.unrealizedPct >= 0 ? "+" : ""}${r.unrealizedPct.toFixed(2)}%`
            : "";
          holdingsList.innerHTML += `
            <div class="txn-card holding-card-shell ${r.hasLive && r.unrealized < 0 ? "holding-loss-card" : "holding-profit-card"}">
              <div class="holding-main-row">
                <div class="holding-title-block">
                  <div class="txn-name">${r.stock}</div>
                  <div class="holding-meta-row">
                    <span>Qty ${r.qty}</span>
                    <span>Avg ₹${r.avgPrice.toFixed(2)}</span>
                    <span>Days ${Math.max(0, r.days)}</span>
                  </div>
                </div>
                <div class="holding-pnl-block ${pnlClass}">
                  <div class="holding-pnl-value">${pnlText}</div>
                  <div class="holding-pnl-percent">${pnlPctText || "&nbsp;"}</div>
                </div>
              </div>
              <div class="holding-value-grid">
                <div class="holding-value-cell">
                  <div class="tiny-label">Invested Value</div>
                  <div class="holding-value-number">₹${r.invested.toFixed(2)}</div>
                </div>
                <div class="holding-value-cell">
                  <div class="tiny-label">Current Value</div>
                  <div class="holding-value-number ${r.hasLive ? pnlClass : "text-muted"}">${r.hasLive ? `₹${r.currentValue.toFixed(2)}` : "-"}</div>
                </div>
              </div>
              <div class="holding-market-row">
                <div class="tiny-label">${r.hasLive ? `LTP ₹${r.ltp.toFixed(2)}` : "LTP unavailable"}</div>
              </div>
              <div class="holding-action-row">
                <button type="button" class="holding-action-btn" onclick="toggleHoldingCycle('${r.cyclePanelId}', this)" aria-expanded="false">
                  <span>Show Transactions</span>
                  <i class="bi bi-chevron-down"></i>
                </button>
                <button
                  type="button"
                  class="holding-action-btn holding-trend-btn"
                  onclick="openHoldingPriceTrend('${r.stockToken}')"
                  title="View price trend"
                  aria-label="View price trend">
                  <i class="bi bi-graph-up-arrow"></i>
                  <span>View Details</span>
                </button>
              </div>
              <div id="${r.cyclePanelId}" class="holding-cycle-wrap" style="display:none">
                <div class="tiny-label holding-cycle-title">Current cycle transactions</div>
                ${r.cycleHtml}
              </div>
            </div>`;
        });
  
        if (!holdingsList.innerHTML) {
          holdingsList.innerHTML =
            `<div class="txn-card text-center text-muted">No holdings</div>`;
        }
        renderHoldingsVisuals(visualRows);
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
  const donut = document.getElementById("pnlSignalDonut");
  const legend = document.getElementById("pnlSignalLegend");
  if (!grid || !chart) return;

  if (!Array.isArray(data) || !data.length) {
    grid.innerHTML = `
      <div class="stat-card"><div class="stat-label">Realized Net</div><div class="stat-value">₹0.00</div></div>
      <div class="stat-card"><div class="stat-label">Win / Loss</div><div class="stat-value">0 / 0</div></div>
      <div class="stat-card"><div class="stat-label">Avg Return</div><div class="stat-value">0.00%</div></div>
      <div class="stat-card"><div class="stat-label">Avg Hold</div><div class="stat-value">0d</div></div>
    `;
    chart.innerHTML = `<div class="text-muted">No realized trades in selected range.</div>`;
    if (donut) donut.innerHTML = `<div class="text-muted">No signal mix</div>`;
    if (legend) legend.innerHTML = "";
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
  if (donut) {
    const winPct = (wins / Math.max(1, data.length)) * 100;
    donut.innerHTML = `
      <div class="adv-donut" style="background:conic-gradient(#22c55e 0% ${winPct}%, #ef4444 ${winPct}% 100%)"></div>
      <div class="tiny-label mt-2 text-center">Win/Loss Mix</div>
    `;
  }
  if (legend) {
    legend.innerHTML = `
      <div class="split-row"><div class="left-col tiny-label"><span class="legend-dot" style="background:#22c55e"></span>Wins</div><div class="right-col tiny-label">${wins}</div></div>
      <div class="split-row"><div class="left-col tiny-label"><span class="legend-dot" style="background:#ef4444"></span>Losses</div><div class="right-col tiny-label">${losses}</div></div>
      <div class="split-row"><div class="left-col tiny-label">Win Ratio</div><div class="right-col tiny-label">${((wins / Math.max(1, data.length)) * 100).toFixed(2)}%</div></div>
    `;
  }

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

      const fifoMap = {};
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
        fifoMap[t.stock] ??= { lots: [] };
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
          fifoMap[t.stock].lots.push({
            qty: qtyNum,
            price: priceNum,
            brokeragePerUnit: qtyNum > 0 ? (txnBrokerage / qtyNum) : 0,
            date: t.date
          });
        } else {
          let sellQty = qtyNum;
          let buyCost = 0;
          let buyBrokerage = 0;

          while (sellQty > 0 && fifoMap[t.stock].lots.length) {
            const lot = fifoMap[t.stock].lots[0];
            const used = Math.min(lot.qty, sellQty);

            buyCost += used * lot.price;
            buyBrokerage += used * lot.brokeragePerUnit;

            lot.qty -= used;
            sellQty -= used;

            if (lot.qty === 0) {
              fifoMap[t.stock].lots.shift();
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
      const positionMap = buildPositionHoldingsMap(txns, settings, { captureCycleTxns: false });

      /* =============================================
         STEP 2: Total Invested (ACTIVE holdings only)
         ============================================= */
      let totalInvested = 0;
      let activeHoldings = 0;
      let liveUnrealizedTotal = 0;
      let liveUnrealizedCount = 0;

      for (const stock in positionMap) {
        const lots = positionMap[stock].lots;
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
          dashUnrealizedEl.textContent = `₹${liveUnrealizedTotal.toFixed(2)}`;
        } else {
          dashUnrealizedEl.classList.remove("profit", "loss");
          dashUnrealizedEl.classList.add("text-muted");
          dashUnrealizedEl.textContent = "-";
        }
      }
      if (dashLiveRefreshEl) {
        const fetchedAt = (typeof window !== "undefined" && window.__livePriceState?.fetchedAt)
          ? new Date(window.__livePriceState.fetchedAt)
          : null;
        const hasValidTime = fetchedAt && !Number.isNaN(fetchedAt.getTime());
        dashLiveRefreshEl.textContent = hasValidTime
          ? `Price sync: ${fetchedAt.toLocaleString()}`
          : "Price sync: -";
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

      const homeInsightEl = document.getElementById("homeInsight");
      const cycleMap = buildPositionHoldingsMap(txns, settings, { captureCycleTxns: true });
      const activeRows = Object.keys(positionMap)
        .map(stock => {
          const lots = positionMap[stock].lots;
          if (!lots.length) return null;
          const qty = lots.reduce((a, l) => a + Number(l.qty || 0), 0);
          const invested = lots.reduce(
            (a, l) => a + l.qty * (l.price + l.brokeragePerUnit),
            0
          );
          const avg = qty > 0 ? invested / qty : 0;
          const live = (typeof window !== "undefined" && typeof window.getLivePriceForStock === "function")
            ? window.getLivePriceForStock(stock)
            : null;
          const ltp = Number(live?.ltp);
          const hasLive = Number.isFinite(ltp) && ltp > 0;
          const livePnl = hasLive ? (qty * ltp) - invested : 0;
          const cycleTxns = Array.isArray(cycleMap?.[stock]?.cycleTxns) ? cycleMap[stock].cycleTxns : [];
          const cycleBuys = cycleTxns.filter(ct => String(ct?.type || "").toUpperCase() === "BUY");
          const lastBuyPrice = cycleBuys.length
            ? toFiniteNumber(cycleBuys[cycleBuys.length - 1].price, avg)
            : avg;
          return { stock, qty, invested, avg, livePnl, ltp: hasLive ? ltp : 0, hasLive, lastBuyPrice };
        })
        .filter(Boolean)
        .sort((a, b) => b.invested - a.invested);
      const liveCurrentTotal = activeRows.reduce((a, r) => a + toFiniteNumber(r.invested, 0) + toFiniteNumber(r.livePnl, 0), 0);
      renderHomeDashboardVisuals(activeRows, {
        totalInvested,
        liveCurrentTotal,
        liveUnrealizedTotal,
        hasLive: liveUnrealizedCount > 0,
        avgLevel1Pct: toFiniteNumber(settings?.avgLevel1Pct, 0),
        avgLevel2Pct: toFiniteNumber(settings?.avgLevel2Pct, 0)
      });
      if (homeInsightEl) {
        const top2 = activeRows.slice(0, 2);
        const top2Invested = top2.reduce((a, r) => a + toFiniteNumber(r.invested, 0), 0);
        const concentration = totalInvested > 0 ? (top2Invested / totalInvested) * 100 : 0;
        homeInsightEl.textContent = top2.length
          ? `Top 2 concentration: ${concentration.toFixed(2)}% of active invested capital.`
          : "";
      }
    };
  });
}

let homeUnrealizedTrendRenderToken = 0;
async function mapWithConcurrency(items, worker, limit = 4) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, list.length || 1)) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= list.length) break;
      try {
        out[i] = await worker(list[i], i);
      } catch (e) {
        out[i] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}

function buildHomeUnrealizedCloudTrendSvg(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return `<div class="text-muted">No unrealized trend yet.</div>`;
  }

  const w = 340;
  const h = 140;
  const padX = 12;
  const padY = 12;
  const values = points.map(p => toFiniteNumber(p.value, 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const stepX = (w - padX * 2) / Math.max(1, points.length - 1);
  const stroke = values[values.length - 1] >= values[0] ? "#10b981" : "#ef4444";
  const gradId = `homeUnrealizedFill-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

  const coords = points.map((p, i) => {
    const x = padX + i * stepX;
    const y = h - padY - (((toFiniteNumber(p.value, 0) - min) / range) * (h - padY * 2));
    return { x, y, value: toFiniteNumber(p.value, 0), date: String(p.date || "") };
  });
  const line = coords.map(c => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(" ");
  const area = `${padX},${h - padY} ${line} ${w - padX},${h - padY}`;
  const first = coords[0];
  const last = coords[coords.length - 1];
  const todayChange = toFiniteNumber(points[points.length - 1]?.dayChange, 0);
  const totalNow = toFiniteNumber(last.value, 0);

  return `
    <div class="holding-trend-chart home-unrealized-trend-chart">
      <div class="holding-trend-tooltip home-unrealized-trend-tooltip" style="display:none"></div>
      <svg class="holding-trend-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="7-day unrealized P/L trend">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(37,99,235,0.35)"></stop>
            <stop offset="100%" stop-color="rgba(37,99,235,0.04)"></stop>
          </linearGradient>
        </defs>
        <polyline points="${area}" fill="url(#${gradId})" stroke="none"></polyline>
        <polyline points="${line}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></polyline>
        ${coords.map((c, i) => `
          <circle
            class="holding-trend-point home-unrealized-point"
            cx="${c.x.toFixed(2)}"
            cy="${c.y.toFixed(2)}"
            r="3.1"
            fill="${stroke}"
            data-value="${c.value.toFixed(2)}"
            data-day-change="${toFiniteNumber(points[i]?.dayChange, 0).toFixed(2)}"
            data-date="${formatHoldingTrendDate(c.date)}"></circle>
        `).join("")}
      </svg>
      <div class="split-row mt-1">
        <div class="left-col tiny-label">${formatHoldingTrendDate(first.date)} to ${formatHoldingTrendDate(last.date)}</div>
        <div class="right-col tiny-label ${todayChange >= 0 ? "profit" : "loss"}">Today ${todayChange >= 0 ? "+" : ""}₹${todayChange.toFixed(2)}</div>
      </div>
      <div class="split-row">
        <div class="left-col tiny-label">Cumulative</div>
        <div class="right-col tiny-label ${totalNow >= 0 ? "profit" : "loss"}">${totalNow >= 0 ? "+" : ""}₹${totalNow.toFixed(2)}</div>
      </div>
    </div>
  `;
}

function wireHomeUnrealizedTrendTooltip(container) {
  if (!container) return;
  const chart = container.querySelector(".home-unrealized-trend-chart");
  const tip = container.querySelector(".home-unrealized-trend-tooltip");
  if (!chart || !tip) return;

  const hide = () => { tip.style.display = "none"; };
  const showFor = (point) => {
    const date = String(point.getAttribute("data-date") || "");
    const value = toFiniteNumber(point.getAttribute("data-value"), 0);
    const dayChange = toFiniteNumber(point.getAttribute("data-day-change"), 0);
    tip.innerHTML = `
      <strong class="${dayChange >= 0 ? "profit" : "loss"}">Day ${dayChange >= 0 ? "+" : ""}₹${dayChange.toFixed(2)}</strong>
      <span class="${value >= 0 ? "profit" : "loss"}">Total ${value >= 0 ? "+" : ""}₹${value.toFixed(2)}</span>
      <span>${date}</span>
    `;
    tip.style.display = "grid";
    const chartRect = chart.getBoundingClientRect();
    const pointRect = point.getBoundingClientRect();
    const left = Math.max(6, Math.min(chartRect.width - 126, (pointRect.left - chartRect.left) - 52));
    const top = Math.max(6, (pointRect.top - chartRect.top) - 44);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  chart.querySelectorAll(".home-unrealized-point").forEach(point => {
    point.addEventListener("mouseenter", () => showFor(point));
    point.addEventListener("mousemove", () => showFor(point));
    point.addEventListener("click", () => showFor(point));
    point.addEventListener("touchstart", () => showFor(point), { passive: true });
  });
  chart.addEventListener("mouseleave", hide);
  chart.addEventListener("touchend", () => setTimeout(hide, 1200), { passive: true });
}

function buildPortfolioUnrealizedFromCloud(activeRows, historyRowsByStock, days = 7) {
  const allDates = Array.from(new Set(
    (historyRowsByStock || [])
      .flatMap(item => (Array.isArray(item.rows) ? item.rows : []).map(r => String(r.date || "").slice(0, 10)))
      .filter(Boolean)
  )).sort((a, b) => parseDateLocal(a) - parseDateLocal(b));
  const dates = allDates.slice(-Math.max(2, Math.min(30, Number(days || 7))));
  if (!dates.length) return [];

  const points = dates.map(date => {
    let total = 0;
    (historyRowsByStock || []).forEach(item => {
      const row = (activeRows || []).find(r => normalizeStockName(r.stock) === normalizeStockName(item.stock));
      if (!row) return;
      const qty = toFiniteNumber(row.qty, 0);
      const invested = toFiniteNumber(row.invested, 0);
      if (qty <= 0) return;
      let price = null;
      (item.rows || []).forEach(p => {
        const d = String(p.date || "").slice(0, 10);
        if (parseDateLocal(d) <= parseDateLocal(date)) price = toFiniteNumber(p.price, 0);
      });
      if (!Number.isFinite(price) || price <= 0) return;
      total += (qty * price) - invested;
    });
    return { date, value: total };
  }).filter(Boolean);

  return points.map((p, i) => {
    const prev = i > 0 ? toFiniteNumber(points[i - 1].value, 0) : toFiniteNumber(p.value, 0);
    return { ...p, dayChange: toFiniteNumber(p.value, 0) - prev };
  });
}

async function renderHomeUnrealizedTrendFromCloud(activeRows, container) {
  if (!container) return;
  const rows = (activeRows || []).filter(r => toFiniteNumber(r.qty, 0) > 0 && toFiniteNumber(r.invested, 0) > 0);
  if (!rows.length) {
    container.innerHTML = `<div class="text-muted">No active holdings for unrealized trend.</div>`;
    return;
  }

  const token = ++homeUnrealizedTrendRenderToken;
  container.innerHTML = `<div class="tiny-label text-muted">Loading cloud trend...</div>`;
  const historyRowsByStock = await mapWithConcurrency(rows, async (r) => {
    let cloud = await fetchHoldingCloudTrend(r.stock, 7, { fast: true, timeoutMs: 8000 });
    // Fast mode may miss symbols not yet present in LivePriceHistory; retry full mode per stock.
    if (!cloud?.ok || !Array.isArray(cloud.rows) || cloud.rows.length < 2) {
      cloud = await fetchHoldingCloudTrend(r.stock, 7, { fast: false, timeoutMs: 10000 });
    }
    return {
      stock: r.stock,
      ok: !!cloud?.ok,
      ticker: String(cloud?.ticker || ""),
      rows: Array.isArray(cloud?.rows) ? cloud.rows : []
    };
  }, 2);
  if (token !== homeUnrealizedTrendRenderToken) return;

  // Second-pass retry for failed stocks (sequential, longer timeout) to match holdings-page reliability.
  for (let i = 0; i < historyRowsByStock.length; i++) {
    const h = historyRowsByStock[i];
    if (h && h.ok && Array.isArray(h.rows) && h.rows.length > 0) continue;
    const stock = h?.stock || rows[i]?.stock;
    if (!stock) continue;
    const retry = await fetchHoldingCloudTrend(stock, 7, { fast: false, timeoutMs: 18000 });
    historyRowsByStock[i] = {
      stock,
      ok: !!retry?.ok,
      ticker: String(retry?.ticker || ""),
      rows: Array.isArray(retry?.rows) ? retry.rows : []
    };
    if (token !== homeUnrealizedTrendRenderToken) return;
  }

  const missing = historyRowsByStock.filter(h => !h || !h.ok || !h.rows.length).map(h => h?.stock).filter(Boolean);
  if (missing.length) {
    container.innerHTML = `<div class="text-muted">Trend unavailable for: ${missing.join(", ")}</div>`;
    return;
  }

  const points = buildPortfolioUnrealizedFromCloud(rows, historyRowsByStock, 7);
  container.innerHTML = buildHomeUnrealizedCloudTrendSvg(points);
  wireHomeUnrealizedTrendTooltip(container);
}

function renderHomeDashboardVisuals(activeRows, stats) {
  const zoneStocksEl = document.getElementById("homeZoneStocks");
  const capitalDonutEl = document.getElementById("homeCapitalDonut");
  const capitalLegendEl = document.getElementById("homeCapitalLegend");
  const holdingsBarsEl = document.getElementById("homeTopHoldingsBars");
  if (!zoneStocksEl && !capitalDonutEl && !capitalLegendEl && !holdingsBarsEl) return;

  const rows = (activeRows || []).slice();
  const totalInvested = toFiniteNumber(stats?.totalInvested, 0);
  const liveCurrentTotal = toFiniteNumber(stats?.liveCurrentTotal, 0);
  const liveUnrealizedTotal = toFiniteNumber(stats?.liveUnrealizedTotal, 0);
  const hasLive = !!stats?.hasLive;
  const l1Pct = Math.max(0, toFiniteNumber(stats?.avgLevel1Pct, 0));
  const l2Pct = Math.max(0, toFiniteNumber(stats?.avgLevel2Pct, 0));

  if (zoneStocksEl) {
    const zoneRows = rows
      .filter(r => !!r.hasLive && toFiniteNumber(r.lastBuyPrice, 0) > 0)
      .map(r => {
        const lastBuy = toFiniteNumber(r.lastBuyPrice, 0);
        const ltp = toFiniteNumber(r.ltp, 0);
        const invested = toFiniteNumber(r.invested, 0);
        const qty = toFiniteNumber(r.qty, 0);
        const allocPct = totalInvested > 0 ? (invested / totalInvested) * 100 : 0;
        if (lastBuy <= 0 || ltp <= 0) return null;
        const l1 = lastBuy * (1 - (l1Pct / 100));
        const l2 = lastBuy * (1 - (l2Pct / 100));
        if (ltp <= l2) return { stock: r.stock, zone: "L2", ltp, qty, invested, allocPct, l1, l2, lastBuy };
        if (ltp <= l1) return { stock: r.stock, zone: "L1", ltp, qty, invested, allocPct, l1, l2, lastBuy };
        return null;
      })
      .filter(Boolean);

    if (!zoneRows.length) {
      zoneStocksEl.innerHTML = `<div class="text-muted">No stocks currently in L1/L2 zone.</div>`;
    } else {
      zoneStocksEl.innerHTML = zoneRows
        .sort((a, b) => String(a.stock).localeCompare(String(b.stock)))
        .map(z => `
          <div class="txn-card">
            <div class="split-row">
              <div class="left-col tiny-label"><strong>${z.stock}</strong></div>
              <div class="right-col tiny-label ${z.zone === "L2" ? "profit" : "loss"}">${z.zone}</div>
            </div>
            <div class="tiny-label">Qty ${z.qty.toFixed(2)} | Invested ₹${z.invested.toFixed(2)} | Alloc ${z.allocPct.toFixed(2)}%</div>
            <div class="tiny-label">Last Buy ₹${z.lastBuy.toFixed(2)} | L1 ₹${z.l1.toFixed(2)} | L2 ₹${z.l2.toFixed(2)} | LTP ₹${z.ltp.toFixed(2)}</div>
          </div>
        `)
        .join("");
    }
  }

  if (capitalDonutEl || capitalLegendEl) {
    const invested = Math.max(0, totalInvested);
    const current = Math.max(0, liveCurrentTotal || totalInvested);
    const sum = Math.max(1, invested + current);
    const investedPct = (invested / sum) * 100;
    if (capitalDonutEl) {
      capitalDonutEl.innerHTML = `
        <div class="adv-donut adv-donut-home" style="background:conic-gradient(var(--accent) 0% ${investedPct}%, var(--profit) ${investedPct}% 100%)"></div>
        <div class="tiny-label mt-2 text-center">${hasLive ? "Invested vs current value" : "Live price unavailable"}</div>
      `;
    }
    if (capitalLegendEl) {
      const delta = current - invested;
      capitalLegendEl.innerHTML = `
        <div class="capital-metric-card">
          <div class="tiny-label"><span class="legend-dot" style="background:var(--accent)"></span>Invested</div>
          <div class="capital-metric-value">₹${invested.toFixed(2)}</div>
        </div>
        <div class="capital-metric-card">
          <div class="tiny-label"><span class="legend-dot" style="background:var(--profit)"></span>Current Value</div>
          <div class="capital-metric-value">₹${current.toFixed(2)}</div>
        </div>
        <div class="capital-metric-card">
          <div class="tiny-label"><span class="legend-dot" style="background:${delta >= 0 ? "var(--profit)" : "var(--loss)"}"></span>Unrealized</div>
          <div class="capital-metric-value ${delta >= 0 ? "profit" : "loss"}">₹${delta.toFixed(2)}</div>
        </div>
      `;
    }
  }

  if (holdingsBarsEl) {
    if (!rows.length) {
      holdingsBarsEl.innerHTML = `<div class="text-muted">No active holdings for bar chart.</div>`;
    } else {
      const total = rows.reduce((a, r) => a + toFiniteNumber(r.invested, 0), 0);
      const maxInv = Math.max(1, ...rows.map(r => toFiniteNumber(r.invested, 0)));
      holdingsBarsEl.innerHTML = rows.slice(0, 7).map(r => {
          const v = toFiniteNumber(r.invested, 0);
          const width = (v / maxInv) * 100;
          const allocPct = total > 0 ? (v / total) * 100 : 0;
          return `
            <div class="adv-bar-row">
              <div class="adv-bar-label">${r.stock}</div>
              <div class="adv-bar-track"><div class="adv-bar" style="width:${width}%;background:linear-gradient(90deg,var(--accent), color-mix(in oklab, var(--accent) 56%, white))"></div></div>
              <div class="adv-bar-value">${allocPct.toFixed(1)}%</div>
            </div>
          `;
        }).join("");
    }
  }
}

function toggleBrokerageBreakdown() {
  const panel = document.getElementById("brokeragePanel");
  if (!panel) return;
  panel.style.display = panel.style.display === "none" ? "block" : "none";
}







function normalizeMappingStockName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function normalizeNseTicker(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.startsWith("NSE:")) return raw;
  const cleaned = raw.replace(/^NSE\s*:/, "").replace(/[^A-Z0-9.-]/g, "");
  return cleaned ? `NSE:${cleaned}` : "";
}

function tickerFromStockName(stock) {
  return normalizeNseTicker(stock);
}

function getLivePriceEndpointForMappings() {
  if (typeof window === "undefined") return "";
  return window.APP_LIVE_PRICE_URL || window.APP_APPS_SCRIPT_URL || "";
}

async function probeTickerHealth(rows) {
  const endpoint = getLivePriceEndpointForMappings();
  const tickers = Array.from(new Set(
    (rows || [])
      .filter(r => r.enabled !== false)
      .map(r => normalizeNseTicker(r.ticker))
      .filter(Boolean)
  ));

  if (!endpoint || !tickers.length) return {};

  try {
    const url = new URL(endpoint);
    url.searchParams.set("mode", "prices");
    url.searchParams.set("tickers", tickers.join(","));
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) return {};
    const parsed = JSON.parse(await res.text());
    const rowsResp = Array.isArray(parsed?.rows) ? parsed.rows : [];
    const out = {};
    rowsResp.forEach(r => {
      const t = normalizeNseTicker(r.ticker);
      if (!t) return;
      out[t] = {
        hasPrice: r.ltp != null && Number.isFinite(Number(r.ltp)),
        ltp: r.ltp
      };
    });
    return out;
  } catch (err) {
    console.warn("[StockMappings] ticker probe failed", err);
    return {};
  }
}

function renderStockMappings(rows, tickerProbe = {}) {
  const host = document.getElementById("mappingList");
  const summaryHost = document.getElementById("mappingSummary");
  const barsHost = document.getElementById("mappingHealthBars");
  const total = rows.length;
  const enabled = rows.filter(r => r.enabled !== false).length;
  const valid = rows.filter(r => {
    const t = normalizeNseTicker(r.ticker);
    if (!t) return false;
    if (r.enabled === false) return false;
    const p = tickerProbe[t];
    return !!(p && p.hasPrice);
  }).length;
  const invalid = rows.filter(r => r.enabled !== false).length - valid;

  if (summaryHost) {
    summaryHost.innerHTML = `
      <div class="row g-2">
        <div class="col-6"><div class="stat-card"><div class="stat-label">Total Mappings</div><div class="stat-value">${total}</div></div></div>
        <div class="col-6"><div class="stat-card"><div class="stat-label">Enabled</div><div class="stat-value">${enabled}</div></div></div>
        <div class="col-6"><div class="stat-card"><div class="stat-label">Price-resolving</div><div class="stat-value profit">${valid}</div></div></div>
        <div class="col-6"><div class="stat-card"><div class="stat-label">Needs Attention</div><div class="stat-value ${invalid > 0 ? "loss" : "profit"}">${Math.max(0, invalid)}</div></div></div>
      </div>
    `;
  }

  if (barsHost) {
    const safeTotal = Math.max(1, enabled);
    const validPct = (valid / safeTotal) * 100;
    const badPct = (Math.max(0, invalid) / safeTotal) * 100;
    barsHost.innerHTML = `
      <div class="tiny-label mb-1">Enabled mapping health</div>
      <div style="height:12px;background:rgba(148,163,184,.18);border-radius:999px;overflow:hidden;display:flex;">
        <div style="width:${validPct}%;background:linear-gradient(90deg,#10b981,#22c55e)"></div>
        <div style="width:${badPct}%;background:linear-gradient(90deg,#ef4444,#f97316)"></div>
      </div>
      <div class="split-row mt-1">
        <div class="left-col tiny-label"><span class="profit">Valid ${pctText(validPct)}</span></div>
        <div class="right-col tiny-label"><span class="${invalid > 0 ? "loss" : "profit"}">Attention ${pctText(badPct)}</span></div>
      </div>
    `;
  }

  if (!host) return;
  if (!rows.length) {
    host.innerHTML = `<div class="txn-card text-center text-muted">No stock mappings yet</div>`;
    return;
  }

  host.innerHTML = rows.map(r => `
    ${(() => {
      const normalizedTicker = normalizeNseTicker(r.ticker);
      const tickerMissing = !normalizedTicker;
      const invalidFormat = !!r.ticker && !normalizedTicker;
      const probe = normalizedTicker ? tickerProbe[normalizedTicker] : null;
      const liveMissing = !!(normalizedTicker && r.enabled !== false && probe && !probe.hasPrice);

      let status = "";
      if (invalidFormat) {
        status = `<span class="status-pill-mini bad">Invalid ticker format</span>`;
      } else if (tickerMissing) {
        status = `<span class="status-pill-mini bad">Ticker missing</span>`;
      } else if (liveMissing) {
        status = `<span class="status-pill-mini bad">Ticker not resolving price</span>`;
      } else if (r.enabled === false) {
        status = `<span class="status-pill-mini warn">Disabled</span>`;
      } else {
        status = `<span class="status-pill-mini ok">Valid</span>`;
      }

      return `
    <div class="txn-card">
      <div class="split-row">
        <div class="left-col">
          <div class="txn-name">${r.stock}</div>
          <div class="tiny-label">${r.ticker || "Ticker pending"} | ${r.enabled ? "Enabled" : "Disabled"}</div>
          <div class="mt-1">${status}</div>
        </div>
        <div class="right-col d-flex gap-2 justify-content-end">
          <button class="btn btn-sm btn-warning" onclick="editStockMapping('${r.stock.replace(/'/g, "\\'")}')">
            <i class="bi bi-pencil"></i>
          </button>
          <button class="btn btn-sm btn-danger" onclick="deleteStockMapping('${r.stock.replace(/'/g, "\\'")}')">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>
    </div>
  `; })()}
  `).join("");
}

function pctText(v) {
  return `${Number(v || 0).toFixed(1)}%`;
}

async function loadStockMappings() {
  if (!db?.objectStoreNames?.contains("stock_mappings")) return;
  const rows = await new Promise(resolve => {
    db.transaction("stock_mappings", "readonly")
      .objectStore("stock_mappings")
      .getAll().onsuccess = e => resolve(e.target.result || []);
  });
  const sorted = rows.sort((a, b) => String(a.stock).localeCompare(String(b.stock)));
  const probe = await probeTickerHealth(sorted);
  renderStockMappings(sorted, probe);
}

function editStockMapping(stock) {
  if (!db?.objectStoreNames?.contains("stock_mappings")) return;
  db.transaction("stock_mappings", "readonly")
    .objectStore("stock_mappings")
    .get(stock).onsuccess = e => {
      const row = e.target.result;
      if (!row) return;
      const stockEl = document.getElementById("mapStock");
      const tickerEl = document.getElementById("mapTicker");
      const enabledEl = document.getElementById("mapEnabled");
      if (stockEl) stockEl.value = row.stock || "";
      if (tickerEl) tickerEl.value = row.ticker || "";
      if (tickerEl) {
        const defaultTicker = tickerFromStockName(row.stock || "");
        tickerEl.dataset.autoFromStock = String((row.ticker || "") === defaultTicker ? 1 : 0);
      }
      if (enabledEl) enabledEl.checked = row.enabled !== false;
      stockEl?.focus();
    };
}

async function deleteStockMapping(stock) {
  const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
    ? await window.appConfirmDialog(`Delete mapping for ${stock}?`, { title: "Delete Mapping", okText: "Delete" })
    : window.confirm(`Delete mapping for ${stock}?`);
  if (!ok) return;

  const tx = db.transaction("stock_mappings", "readwrite");
  tx.objectStore("stock_mappings").delete(stock);
  tx.oncomplete = () => {
    loadStockMappings();
    if (typeof showToast === "function") showToast("Mapping deleted successfully");
  };
}

function bindStockMappingForm() {
  const form = document.getElementById("mappingForm");
  if (!form) return;

  const stockEl = document.getElementById("mapStock");
  const tickerEl = document.getElementById("mapTicker");

  stockEl?.addEventListener("blur", () => {
    const normalizedStock = normalizeMappingStockName(stockEl.value);
    stockEl.value = normalizedStock;
    const defaultTicker = tickerFromStockName(normalizedStock);
    const currentTicker = normalizeNseTicker(tickerEl?.value || "");
    const canAutoFill = !currentTicker || String(tickerEl?.dataset.autoFromStock || "1") === "1";
    if (tickerEl && canAutoFill) {
      tickerEl.value = defaultTicker;
      tickerEl.dataset.autoFromStock = "1";
    }
  });
  tickerEl?.addEventListener("blur", () => {
    tickerEl.value = normalizeNseTicker(tickerEl.value);
  });
  tickerEl?.addEventListener("input", () => {
    const stock = normalizeMappingStockName(stockEl?.value || "");
    const defaultTicker = tickerFromStockName(stock);
    const current = normalizeNseTicker(tickerEl?.value || "");
    tickerEl.dataset.autoFromStock = String(current === defaultTicker ? 1 : 0);
  });

  form.addEventListener("submit", e => {
    e.preventDefault();
    const stock = normalizeMappingStockName(stockEl?.value || "");
    const ticker = normalizeNseTicker(tickerEl?.value || stock);
    const enabled = document.getElementById("mapEnabled")?.checked !== false;

    if (!stock) {
      if (typeof showToast === "function") showToast("Stock name is required", "error");
      return;
    }
    if (!ticker) {
      if (typeof showToast === "function") showToast("Valid NSE ticker is required", "error");
      return;
    }

    const tx = db.transaction("stock_mappings", "readwrite");
    tx.objectStore("stock_mappings").put({
      stock,
      ticker,
      exchange: "NSE",
      enabled,
      updatedAt: new Date().toISOString()
    });
    tx.oncomplete = () => {
      form.reset();
      const enabledEl = document.getElementById("mapEnabled");
      if (enabledEl) enabledEl.checked = true;
      if (tickerEl) tickerEl.dataset.autoFromStock = "1";
      loadStockMappings();
      if (typeof showToast === "function") showToast("Mapping saved successfully");
    };
  });
}

function seedMissingMappingsFromTransactions() {
  if (!db?.objectStoreNames?.contains("stock_mappings")) return;
  const tx = db.transaction(["transactions", "stock_mappings"], "readwrite");
  const txnReq = tx.objectStore("transactions").getAll();
  const mapReq = tx.objectStore("stock_mappings").getAll();
  tx.oncomplete = () => {
    const txns = txnReq.result || [];
    const maps = mapReq.result || [];
    const existing = new Set(maps.map(m => normalizeMappingStockName(m.stock)));
    const store = db.transaction("stock_mappings", "readwrite").objectStore("stock_mappings");
    Array.from(new Set(txns.map(t => normalizeMappingStockName(t.stock)).filter(Boolean)))
      .filter(stock => !existing.has(stock))
      .forEach(stock => {
        store.put({
          stock,
          ticker: tickerFromStockName(stock),
          exchange: "NSE",
          enabled: true,
          updatedAt: new Date().toISOString()
        });
      });
    store.transaction.oncomplete = loadStockMappings;
  };
}

function initStockMappingsPage() {
  bindStockMappingForm();
  seedMissingMappingsFromTransactions();
  loadStockMappings();
}

if (typeof window !== "undefined") {
  window.initStockMappingsPage = initStockMappingsPage;
}

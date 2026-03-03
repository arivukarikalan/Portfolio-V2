function normalizeLiveStockName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

const LIVE_PRICE_CACHE_KEY = "live_price_cache_v1";
const LIVE_PRICE_LAST_FETCH_MS_KEY = "live_price_last_fetch_ms_v1";
const LIVE_PRICE_MIN_REFRESH_MS = 60 * 1000; // safety floor (60s)
const LIVE_PRICE_DEBUG = false; // set true only while diagnosing API issues
const LIVE_PRICE_SETTINGS_BUMP_KEY = "live_price_settings_bump_v1";

function normalizeLiveTicker(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (raw.startsWith("NSE:")) return raw;
  const cleaned = raw.replace(/^NSE\s*:/, "").replace(/[^A-Z0-9.-]/g, "");
  return cleaned ? `NSE:${cleaned}` : "";
}

function getLivePriceEndpoint() {
  if (typeof window === "undefined") return "";
  return window.APP_LIVE_PRICE_URL || window.APP_APPS_SCRIPT_URL || "";
}

function isLocalDevOrigin() {
  try {
    const host = String(window.location.hostname || "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "";
  } catch (e) {
    return false;
  }
}

function parseLivePriceJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function jsonpRequest(url) {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("jsonp_unavailable"));
      return;
    }
    const cbName = "__pt_lp_jsonp_" + Date.now() + "_" + Math.random().toString(36).slice(2);
    const u = new URL(url.toString());
    u.searchParams.set("callback", cbName);
    const script = document.createElement("script");
    let done = false;
    const cleanup = () => {
      try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      try { script.remove(); } catch (e) {}
    };
    window[cbName] = (data) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("jsonp_failed"));
    };
    script.src = u.toString();
    document.head.appendChild(script);
    setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("jsonp_timeout"));
    }, 15000);
  });
}

async function fetchJsonWithLocalFallback(url) {
  try {
    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Live price fetch failed: ${res.status} ${res.statusText} ${txt}`);
    }
    const text = await res.text();
    const parsed = parseLivePriceJson(text);
    if (!parsed) throw new Error("Invalid JSON from live price endpoint");
    return parsed;
  } catch (err) {
    if (!isLocalDevOrigin()) throw err;
    return await jsonpRequest(url);
  }
}

function toNum(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeChangePct(ltp, prevClose, changePct) {
  const pct = toNum(changePct);
  if (pct != null) return pct;
  const l = toNum(ltp);
  const p = toNum(prevClose);
  if (l == null || p == null || p === 0) return null;
  return ((l - p) / p) * 100;
}

function normalizePriceRows(parsed) {
  const rows = [];
  const sourceRows = Array.isArray(parsed?.rows)
    ? parsed.rows
    : (Array.isArray(parsed) ? parsed : []);

  sourceRows.forEach(r => {
    const ticker = normalizeLiveTicker(r.ticker || r.symbol || r.code);
    const stock = normalizeLiveStockName(r.stockName || r.stock || r.name || "");
    const ltp = toNum(r.ltp ?? r.price ?? r.lastPrice);
    const prevClose = toNum(r.prevClose ?? r.close ?? r.closeYest);
    const changePct = computeChangePct(ltp, prevClose, r.changePct ?? r.pctChange);
    if (!ticker && !stock) return;
    rows.push({
      stock,
      ticker,
      ltp,
      prevClose,
      changePct,
      lastUpdated: r.lastUpdated || parsed?.lastUpdated || new Date().toISOString()
    });
  });

  if (!rows.length && parsed?.prices && typeof parsed.prices === "object") {
    Object.keys(parsed.prices).forEach(tk => {
      const item = parsed.prices[tk] || {};
      const ticker = normalizeLiveTicker(tk);
      const ltp = toNum(item.ltp ?? item.price ?? item.lastPrice);
      const prevClose = toNum(item.prevClose ?? item.close ?? item.closeYest);
      const changePct = computeChangePct(ltp, prevClose, item.changePct ?? item.pctChange);
      rows.push({
        stock: normalizeLiveStockName(item.stockName || item.stock || ""),
        ticker,
        ltp,
        prevClose,
        changePct,
        lastUpdated: item.lastUpdated || parsed?.lastUpdated || new Date().toISOString()
      });
    });
  }

  return rows;
}

function readCachedLivePrices() {
  try {
    const raw = localStorage.getItem(LIVE_PRICE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeCachedLivePrices(data) {
  try {
    localStorage.setItem(LIVE_PRICE_CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(LIVE_PRICE_LAST_FETCH_MS_KEY, String(Date.now()));
  } catch (e) {}
}

function getLastFetchMs() {
  const raw = localStorage.getItem(LIVE_PRICE_LAST_FETCH_MS_KEY);
  const n = Number(raw || 0);
  return Number.isFinite(n) ? n : 0;
}

function publishLivePriceState(state) {
  if (typeof window === "undefined") return;
  window.__livePriceState = state || null;
  try {
    window.dispatchEvent(new CustomEvent("live-prices-updated", { detail: state || null }));
  } catch (e) {}
}

function buildMappingIndex(mappings, rows) {
  const byTicker = {};
  const byStock = {};

  rows.forEach(r => {
    if (r.ticker) byTicker[r.ticker] = r;
    if (r.stock) byStock[r.stock] = r;
  });

  const stockMap = {};
  mappings.forEach(m => {
    const stock = normalizeLiveStockName(m.stock);
    const ticker = normalizeLiveTicker(m.ticker);
    if (!stock) return;
    const row = (ticker && byTicker[ticker]) || byStock[stock] || null;
    if (!row) return;
    stockMap[stock] = {
      ticker: ticker || row.ticker || "",
      ltp: row.ltp,
      prevClose: row.prevClose,
      changePct: row.changePct,
      lastUpdated: row.lastUpdated
    };
  });

  return stockMap;
}

async function readEnabledMappings() {
  if (!db?.objectStoreNames?.contains("stock_mappings")) return [];
  return new Promise(resolve => {
    db.transaction("stock_mappings", "readonly")
      .objectStore("stock_mappings")
      .getAll().onsuccess = e => {
        const rows = (e.target.result || []).filter(m => m.enabled !== false && normalizeLiveTicker(m.ticker));
        resolve(rows);
      };
  });
}

async function fetchLiveRows(endpoint, tickers, opts = {}) {
  if (!endpoint) throw new Error("Live price endpoint not configured");
  const url = new URL(endpoint);
  url.searchParams.set("mode", "prices");
  if (LIVE_PRICE_DEBUG || opts.debug) url.searchParams.set("debug", "1");
  if (tickers.length) url.searchParams.set("tickers", tickers.join(","));
  if (LIVE_PRICE_DEBUG || opts.debug) console.info("[LivePrices] request url:", url.toString());
  const parsed = await fetchJsonWithLocalFallback(url);
  if (LIVE_PRICE_DEBUG || opts.debug) {
    console.info("[LivePrices] scriptTag:", parsed?.scriptTag || "missing");
    if (parsed?.debug) console.info("[LivePrices] server debug:", parsed.debug);
  }
  return {
    rows: normalizePriceRows(parsed),
    meta: {
      scriptTag: parsed?.scriptTag || "",
      debug: parsed?.debug || null
    }
  };
}

async function refreshLivePrices(opts = {}) {
  try {
    const lastFetchMs = getLastFetchMs();
    const cooldownMs = Number(opts.cooldownMs || LIVE_PRICE_MIN_REFRESH_MS);
    const cached = readCachedLivePrices();
    if (!opts.force && cached && Date.now() - lastFetchMs < cooldownMs) {
      return cached;
    }

    const mappings = await readEnabledMappings();
    if (LIVE_PRICE_DEBUG || opts.debug) console.info("[LivePrices] enabled mappings:", mappings.length);
    const tickers = Array.from(new Set(mappings.map(m => normalizeLiveTicker(m.ticker)).filter(Boolean)));
    if (LIVE_PRICE_DEBUG || opts.debug) console.info("[LivePrices] request tickers:", tickers);
    if (!tickers.length) {
      console.warn("[LivePrices] No enabled ticker mappings found. Add ticker in StockMappings page.");
      if (cached) publishLivePriceState(cached);
      return cached || null;
    }

    const endpoint = getLivePriceEndpoint();
    if (!endpoint) console.error("[LivePrices] Endpoint missing. Set window.APP_APPS_SCRIPT_URL / APP_LIVE_PRICE_URL.");
    if (LIVE_PRICE_DEBUG || opts.debug) console.info("[LivePrices] endpoint:", endpoint);
    const result = await fetchLiveRows(endpoint, tickers, opts);
    const rows = result?.rows || [];
    if (LIVE_PRICE_DEBUG || opts.debug) console.info("[LivePrices] rows received:", rows);
    const byStock = buildMappingIndex(mappings, rows);
    if (LIVE_PRICE_DEBUG || opts.debug) console.info("[LivePrices] stocks mapped:", Object.keys(byStock));
    const state = {
      fetchedAt: new Date().toISOString(),
      byStock
    };
    writeCachedLivePrices(state);
    publishLivePriceState(state);
    return state;
  } catch (err) {
    console.error("[LivePrices] refresh failed:", err);
    const cached = readCachedLivePrices();
    if (cached) {
      console.warn("[LivePrices] using cached prices");
      publishLivePriceState(cached);
      return cached;
    }
    if (!opts.silent) console.error("Live price refresh error", err);
    return null;
  }
}

function getLivePriceForStock(stockName) {
  const stock = normalizeLiveStockName(stockName);
  const state = (typeof window !== "undefined") ? window.__livePriceState : null;
  return state?.byStock?.[stock] || null;
}

let LIVE_PRICE_TIMER = null;
async function getConfiguredLiveRefreshMs() {
  try {
    if (!db?.objectStoreNames?.contains("settings")) return LIVE_PRICE_MIN_REFRESH_MS;
    const sec = await new Promise(resolve => {
      db.transaction("settings", "readonly")
        .objectStore("settings")
        .get(1).onsuccess = e => {
          const raw = Number(e?.target?.result?.livePriceRefreshSec || 60);
          resolve(raw);
        };
    });
    const clampedSec = Math.max(60, Math.min(3600, Number(sec || 60)));
    return clampedSec * 1000;
  } catch (e) {
    return LIVE_PRICE_MIN_REFRESH_MS;
  }
}

function initLivePrices() {
  // Instant paint from cache for fast page switch UX.
  const cached = readCachedLivePrices();
  if (cached) publishLivePriceState(cached);
  getConfiguredLiveRefreshMs().then(intervalMs => {
    const refreshMs = Math.max(LIVE_PRICE_MIN_REFRESH_MS, Number(intervalMs || LIVE_PRICE_MIN_REFRESH_MS));
    refreshLivePrices({ silent: true, cooldownMs: refreshMs });
    if (LIVE_PRICE_TIMER) clearInterval(LIVE_PRICE_TIMER);
    LIVE_PRICE_TIMER = setInterval(
      () => refreshLivePrices({ silent: true, force: true }),
      refreshMs
    );
  });
}

if (typeof window !== "undefined") {
  window.refreshLivePrices = refreshLivePrices;
  window.getLivePriceForStock = getLivePriceForStock;
  window.initLivePrices = initLivePrices;
  window.addEventListener("storage", (e) => {
    if (e.key === LIVE_PRICE_SETTINGS_BUMP_KEY) initLivePrices();
  });
  window.addEventListener("live-price-settings-updated", () => initLivePrices());
}

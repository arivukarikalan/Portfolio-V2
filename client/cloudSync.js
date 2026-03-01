/* cloudSync.js
   - Reads IndexedDB stores and builds export JSON
   - Uploads JSON to a Google Apps Script URL (POST)
   - Fetches latest snapshot from Apps Script (GET) and restores DB
   - Does not modify any existing business logic; works in isolation
*/

const DB_NAME = 'PortfolioDB'; // <-- adjust if your app uses a different DB name
const STORE_NAMES = {
  transactions: 'transactions',
  settings: 'settings',
  debtBorrows: 'debt_borrows',
  debtRepays: 'debt_repays'
};
const DEVICE_ID_KEY = 'pt_device_id';
const APP_NAME = 'PortfolioTracker';
const APP_VERSION = '1.0';

/* Generate or return a persistent deviceId stored in localStorage */
function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : ('dev-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    try { localStorage.setItem(DEVICE_ID_KEY, id); } catch (e) { /* ignore storage errors */ }
  }
  return id;
}

/* Read all records from the given object store (returns a Promise<Array>) */
function readStore(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    } catch (err) {
      reject(err);
    }
  });
}

/* Open existing DB and return IDBDatabase instance */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      // Do not change schema here; fail safe if app hasn't created stores yet.
    };
  });
}

/* Export all app data into a single JSON object */
export async function exportAll() {
  const db = await openDatabase();
  try {
    const [transactions, settingsArr, borrows, repays] = await Promise.all([
      readStore(db, STORE_NAMES.transactions),
      readStore(db, STORE_NAMES.settings),
      readStore(db, STORE_NAMES.debtBorrows),
      readStore(db, STORE_NAMES.debtRepays)
    ]);

    // settings may be stored as an array or single object depending on app - normalize to object
    const settings = Array.isArray(settingsArr) && settingsArr.length === 1 ? settingsArr[0] : (settingsArr || {});

    const payload = {
      app: APP_NAME,
      version: APP_VERSION,
      exportedAt: new Date().toISOString(),
      deviceId: getDeviceId(),
      data: {
        transactions: transactions || [],
        settings: settings || {},
        debt: {
          borrows: borrows || [],
          repays: repays || []
        }
      }
    };
    return payload;
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

/* Upload export JSON to Google Apps Script URL (POST)
   appsScriptUrl: string (required)
   opts: { signal?: AbortSignal, onProgress?: fn } (optional)

   Behavior:
   - First attempt: POST JSON as text/plain to avoid CORS preflight.
   - Fallback: POST as application/x-www-form-urlencoded (payload=...) if first attempt fails.
*/
export async function uploadToCloud(appsScriptUrl, opts = {}) {
  if (!appsScriptUrl) throw new Error('appsScriptUrl required');
  const payload = await exportAll();
  const bodyJson = JSON.stringify(payload);

  // helper to perform fetch and parse response
  async function doFetch(bodyToSend, headers) {
    const res = await fetch(appsScriptUrl, {
      method: 'POST',
      headers,
      body: bodyToSend,
      signal: opts.signal,
      // Keep defaults for mode/credentials; using a "simple" Content-Type avoids preflight
    });

    // Opaque response indicates CORS / deployment issue
    if (res.type === 'opaque') {
      throw new Error('Opaque response from server - possible CORS/deployment issue (check Apps Script access settings).');
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Upload failed: ${res.status} ${res.statusText} ${txt}`);
    }

    // Expect JSON response from Apps Script
    const json = await res.json().catch(async () => {
      const t = await res.text().catch(() => '');
      throw new Error('Invalid JSON response from cloud: ' + t);
    });
    return { ok: true, response: json };
  }

  // First, try as text/plain (simple request -> no preflight)
  try {
    const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    return await doFetch(bodyJson, headers);
  } catch (err) {
    // If error looks like CORS/fetch failure, try fallback
    const msg = err && err.message ? err.message.toLowerCase() : '';
    const shouldFallback = msg.includes('opaque') || msg.includes('failed to fetch') || msg.includes('preflight') || msg.includes('cors');

    if (!shouldFallback) {
      // not a CORS-like error, rethrow
      throw err;
    }

    // Fallback: send as application/x-www-form-urlencoded -> also a "simple" request
    try {
      const formBody = 'payload=' + encodeURIComponent(bodyJson);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      return await doFetch(formBody, headers);
    } catch (err2) {
      // Give a helpful final message for debugging
      const finalMsg = (err2 && err2.message) ? err2.message : String(err2);
      throw new Error('Upload failed (attempted text/plain and form fallback). ' + finalMsg + ' Check Apps Script deployment (Execute as: Me) and access (Anyone, even anonymous).');
    }
  }
}

/* Fetch latest snapshot from Apps Script (GET) and return parsed JSON payload.
   appsScriptUrl: string (required)
   This implementation is tolerant to various Apps Script response shapes:
   - fully-formed export object { app, version, exportedAt, deviceId, data: { ... } }
   - wrapper { raw: "...", ... } or { jsonPayload: "..." }
   - payload where transactions/settings/debt are at the top level
   It will attempt multiple parse strategies and return a normalized payload.
*/
export async function fetchLatestFromCloud(appsScriptUrl, opts = {}) {
  if (!appsScriptUrl) throw new Error('appsScriptUrl required');
  try {
    const url = new URL(appsScriptUrl);
    url.searchParams.set('mode', 'latest');
    const res = await fetch(url.toString(), { method: 'GET', signal: opts.signal });
    // If non-OK, attempt to read body (for better diagnostics)
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Fetch failed: ${res.status} ${res.statusText} ${txt}`);
    }
    const text = await res.text();
    if (!text) throw new Error('Empty response from cloud');

    // Keep the raw latest response for diagnostics
    const rawLatest = text;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // try to extract JSON substring
      const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch (e2) { parsed = null; }
      } else parsed = null;
    }

    // If server indicated no backups or no_valid_backups, attempt mode=all fallback
    if (parsed && parsed.error && (parsed.error === 'no_backups' || parsed.error === 'no_valid_backups')) {
      // try mode=all to get rows and scan them
      try {
        const allUrl = new URL(appsScriptUrl);
        allUrl.searchParams.set('mode', 'all');
        const r2 = await fetch(allUrl.toString(), { method: 'GET', signal: opts.signal });
        if (!r2.ok) {
          const txt = await r2.text().catch(() => '');
          throw new Error('Fallback fetch mode=all failed: ' + (txt || r2.statusText));
        }
        const txt2 = await r2.text();
        let parsedAll;
        try {
          parsedAll = JSON.parse(txt2);
        } catch (e) {
          // include both responses for debugging
          throw new Error('Fallback mode=all returned non-JSON. latest response snippet: '
            + (rawLatest.slice(0,500)) + ' ... ; mode=all response snippet: ' + (txt2.slice(0,500)));
        }
        if (parsedAll && Array.isArray(parsedAll.rows)) {
          // scan rows for a parseable payload
          for (const rowObj of parsedAll.rows) {
            // try jsonPayload first
            const candidates = [];
            if (rowObj.jsonPayload) candidates.push(rowObj.jsonPayload);
            // also scan rawRow string entries
            if (Array.isArray(rowObj.rawRow)) {
              for (const cell of rowObj.rawRow) {
                if (typeof cell === 'string') candidates.push(cell);
              }
            }
            for (const c of candidates) {
              if (!c || typeof c !== 'string') continue;
              const s = c.trim();
              if (!(s.startsWith('{') || s.startsWith('['))) continue;
              try {
                const p = JSON.parse(s);
                // attach metadata from rowObj if missing
                if (!p.exportedAt && rowObj.exportedAt) p.exportedAt = rowObj.exportedAt;
                if (!p.deviceId && rowObj.deviceId) p.deviceId = rowObj.deviceId;
                if (!p.version && rowObj.appVersion) p.version = rowObj.appVersion;
                // simple validation: must contain data
                if (p && p.data) return p;
                // if top-level transactions, wrap
                if (p && (p.transactions || p.settings || p.debt)) {
                  return {
                    app: p.app || APP_NAME,
                    version: p.version || APP_VERSION,
                    exportedAt: p.exportedAt || new Date().toISOString(),
                    deviceId: p.deviceId || '',
                    data: {
                      transactions: Array.isArray(p.transactions) ? p.transactions : [],
                      settings: p.settings || {},
                      debt: p.debt || { borrows: (p.borrows || []), repays: (p.repays || []) }
                    }
                  };
                }
              } catch (e) {
                continue;
              }
            }
          }
          // no parseable rows found — include a snippet of rows for debugging
          const rowsSnippet = JSON.stringify(parsedAll.rows.slice(0,5)).slice(0,1000);
          throw new Error('No parseable backup found in sheet rows returned by server. Rows sample: ' + rowsSnippet);
        }
        throw new Error('No parseable backup found in sheet rows returned by server. mode=all response: ' + (txt2.slice(0,500)));
      } catch (fallbackErr) {
        // surface fallback error plus the original latest response snippet
        throw new Error('Initial fetch reported "' + parsed.error + '". Fallback attempt failed: '
          + (fallbackErr.message || fallbackErr)
          + ' | latest response snippet: ' + (rawLatest.slice(0,500)));
      }
    }

    // If parsed is an error object, surface it
    if (parsed && parsed.error) {
      throw new Error('Server error: ' + parsed.error + ' | server response snippet: ' + (rawLatest.slice(0,500)));
    }

    if (!parsed) throw new Error('Invalid JSON in cloud response. Server returned: ' + (rawLatest.slice(0,500)));

    // Try to normalize parsed to expected shape (reuse existing tolerant logic)
    // If parsed contains data, accept it
    if (parsed.data && (parsed.data.transactions || parsed.data.settings || parsed.data.debt)) return parsed;

    // If parsed has raw/jsonPayload/payload string, try to parse inner
    const innerCandidates = [];
    if (typeof parsed.raw === 'string') innerCandidates.push(parsed.raw);
    if (typeof parsed.jsonPayload === 'string') innerCandidates.push(parsed.jsonPayload);
    if (typeof parsed.payload === 'string') innerCandidates.push(parsed.payload);

    for (const c of innerCandidates) {
      try {
        const inner = JSON.parse(c);
        if (inner && inner.data) return inner;
        if (inner && (inner.transactions || inner.settings || inner.debt)) {
          return {
            app: inner.app || APP_NAME,
            version: inner.version || APP_VERSION,
            exportedAt: inner.exportedAt || new Date().toISOString(),
            deviceId: inner.deviceId || '',
            data: {
              transactions: Array.isArray(inner.transactions) ? inner.transactions : [],
              settings: inner.settings || {},
              debt: inner.debt || { borrows: (inner.borrows || []), repays: (inner.repays || []) }
            }
          };
        }
      } catch (e) { /* ignore */ }
    }

    // If parsed already is the top-level payload (transactions/settings at top), normalize
    if (parsed.transactions || parsed.settings || parsed.debt || parsed.borrows || parsed.repays) {
      return {
        app: parsed.app || APP_NAME,
        version: parsed.version || APP_VERSION,
        exportedAt: parsed.exportedAt || new Date().toISOString(),
        deviceId: parsed.deviceId || '',
        data: {
          transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
          settings: parsed.settings || {},
          debt: {
            borrows: Array.isArray(parsed.debt?.borrows) ? parsed.debt.borrows : (Array.isArray(parsed.borrows) ? parsed.borrows : []),
            repays: Array.isArray(parsed.debt?.repays) ? parsed.debt.repays : (Array.isArray(parsed.repays) ? parsed.repays : [])
          }
        }
      };
    }

    throw new Error('Cloud snapshot has unexpected shape');
  } catch (err) {
    throw err;
  }
}

/* Clear the listed stores and repopulate them with provided data object.
   data: { transactions: [...], settings: {...} or [...], debt: { borrows: [...], repays: [...] } }
*/
export async function clearAndRestore(data) {
  const db = await openDatabase();
  try {
    const tx = db.transaction([
      STORE_NAMES.transactions,
      STORE_NAMES.settings,
      STORE_NAMES.debtBorrows,
      STORE_NAMES.debtRepays
    ], 'readwrite');

    const stores = {
      transactions: tx.objectStore(STORE_NAMES.transactions),
      settings: tx.objectStore(STORE_NAMES.settings),
      debtBorrows: tx.objectStore(STORE_NAMES.debtBorrows),
      debtRepays: tx.objectStore(STORE_NAMES.debtRepays)
    };

    // Clear stores
    Object.values(stores).forEach(store => store.clear());

    // Populate transactions
    if (Array.isArray(data.transactions)) {
      for (const item of data.transactions) stores.transactions.add(item);
    }

    // Settings: if object, store as single record; if array put all
    if (Array.isArray(data.settings)) {
      for (const s of data.settings) stores.settings.add(s);
    } else if (data.settings && typeof data.settings === 'object') {
      stores.settings.add(data.settings);
    }

    // Debt
    if (Array.isArray(data.debt?.borrows)) {
      for (const b of data.debt.borrows) stores.debtBorrows.add(b);
    }
    if (Array.isArray(data.debt?.repays)) {
      for (const r of data.debt.repays) stores.debtRepays.add(r);
    }

    return await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ ok: true });
      tx.onerror = () => reject(tx.error || new Error('Transaction failed during restore'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  } finally {
    try { db.close(); } catch (e) { /* ignore */ }
  }
}

/* Full restore flow:
   - fetch latest snapshot from cloud
   - confirm with user (caller should show confirmation UI; this function includes a built-in confirm fallback)
   - clear and restore DB
   - returns result object
   opts: { confirmFn?: (message)=>Promise<boolean> } - optional async confirmation function
*/
export async function restoreFromCloud(appsScriptUrl, opts = {}) {
  if (!appsScriptUrl) throw new Error('appsScriptUrl required');
  const payload = await fetchLatestFromCloud(appsScriptUrl, { signal: opts.signal });
  if (!payload || !payload.data) throw new Error('No snapshot data found in cloud');
  const confirmFn = opts.confirmFn || (msg => Promise.resolve(window.confirm(msg)));
  const message = `Restore will overwrite local data with snapshot exported at ${payload.exportedAt} from device ${payload.deviceId}. Proceed?`;
  const ok = await confirmFn(message);
  if (!ok) throw new Error('User cancelled restore');
  // Clear and restore
  await clearAndRestore(payload.data);
  return { ok: true, restoredAt: new Date().toISOString(), source: payload.deviceId, exportedAt: payload.exportedAt };
}

/* Expose helper functions for quick testing in browser console:
   - await window.__cloudExportAll()
   - await window.__uploadToCloud(url)
   - await window.__restoreFromCloud(url)
   These are convenience bindings only and do not modify business logic.
*/
if (typeof window !== 'undefined') {
  window.__cloudExportAll = exportAll;
  window.__uploadToCloud = async (url) => uploadToCloud(url);
  window.__cloudFetchLatest = async (url) => fetchLatestFromCloud(url);
  window.__restoreFromCloud = async (url) => restoreFromCloud(url, { confirmFn: async (msg) => {
    // default confirm when called from console (bypass UI modal)
    return window.confirm(msg);
  }});
  window.__cloudFetchRawLatest = async (url) => {
    const u = new URL(url);
    u.searchParams.set('mode', 'latest');
    const r = await fetch(u.toString());
    const text = await r.text().catch(() => '');
    console.log('rawLatest', { status: r.status, statusText: r.statusText, textSnippet: text.slice(0,1000) });
    return { status: r.status, statusText: r.statusText, text };
  };
  window.__cloudFetchRawAll = async (url) => {
    const u = new URL(url);
    u.searchParams.set('mode', 'all');
    const r = await fetch(u.toString());
    const text = await r.text().catch(() => '');
    console.log('rawAll', { status: r.status, statusText: r.statusText, textSnippet: text.slice(0,1000) });
    return { status: r.status, statusText: r.statusText, text };
  };
  // Diagnostic helper: fetch server-side diagnostic info (?mode=diag)
  window.__cloudFetchDiag = async (url) => {
    try {
      const u = new URL(url);
      u.searchParams.set('mode', 'diag');
      const r = await fetch(u.toString(), { method: 'GET' });
      const text = await r.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
      console.log('diag', { status: r.status, statusText: r.statusText, parsed, textSnippet: text.slice(0,1000) });
      return { status: r.status, statusText: r.statusText, parsed, text };
    } catch (err) {
      console.error('diag fetch failed', err);
      throw err;
    }
  };
}

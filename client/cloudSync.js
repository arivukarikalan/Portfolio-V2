/* cloudSync.js
   - Reads IndexedDB stores and builds export JSON
   - Uploads JSON to a Google Apps Script URL (POST)
   - Fetches latest snapshot from Apps Script (GET) and restores DB
   - Does not modify any existing business logic; works in isolation
*/

let CURRENT_DB_BASE = 'PortfolioDB';
let CURRENT_USER_ID = null;
const FIXED_DB_NAME = 'PortfolioDB'; // Always use a single DB name

export function setUserContext(userId) {
  if (userId && typeof userId === 'string' && userId.trim()) {
    CURRENT_USER_ID = userId;
  } else {
    CURRENT_USER_ID = null;
  }
  // publish fixed DB name for non-module scripts
  try { if (typeof window !== 'undefined') window.PORTFOLIO_DB_NAME = FIXED_DB_NAME; } catch (e) {}
}

export function getCurrentUserId() {
  return CURRENT_USER_ID;
}

const STORE_NAMES = {
  transactions: 'transactions',
  settings: 'settings',
  debtBorrows: 'debt_borrows',
  debtRepays: 'debt_repays'
};
const DEVICE_ID_KEY = 'pt_device_id';
const APP_NAME = 'PortfolioTracker';
const APP_VERSION = '1.0';

async function fetchAllCloudRows(appsScriptUrl, opts = {}) {
  const url = new URL(appsScriptUrl);
  url.searchParams.set('mode', 'all');
  if (opts.userId) url.searchParams.set('userId', opts.userId);

  const res = await fetch(url.toString(), { method: 'GET', signal: opts.signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Fetch all failed: ${res.status} ${res.statusText} ${txt}`);
  }
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (e2) { parsed = null; }
    }
  }
  if (!parsed) throw new Error('Invalid JSON in cloud all response');
  return Array.isArray(parsed?.rows) ? parsed.rows : [];
}

async function getLatestRecoveryKeyHashForUser(appsScriptUrl, userId, opts = {}) {
  if (!userId) return null;
  const wanted = String(userId).trim();
  try {
    const rows = await fetchAllCloudRows(appsScriptUrl, { userId: wanted, signal: opts.signal });
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      let rowUserId = String(rows[i]?.userId || '').trim();
      let hash = rows[i]?.recoveryKeyHash;
      if ((!rowUserId || !hash) && rows[i]?.jsonPayload) {
        try {
          const payload = JSON.parse(String(rows[i].jsonPayload));
          if (!rowUserId) rowUserId = String(payload?.userId || '').trim();
          if (!hash) hash = payload?.recoveryKeyHash || payload?.recovery_key || null;
        } catch (e) {}
      }
      if (rowUserId !== wanted) continue;
      if (hash && String(hash).trim()) return String(hash).trim();
    }
  } catch (e) {
    // fallback to latest endpoint
    try {
      const latest = await fetchLatestFromCloud(appsScriptUrl, { userId: wanted, signal: opts.signal });
      const hash = latest?.recoveryKeyHash || latest?.recovery_key || null;
      if (hash) return String(hash).trim();
    } catch (e2) {}
  }
  return null;
}

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

/* Open existing DB and return IDBDatabase instance (always uses FIXED_DB_NAME)
   Ensures the known object stores exist. If missing, performs a version upgrade
   to create them so subsequent transactions (clearAndRestore) do not fail.
*/
function openDatabase() {
  const requiredStores = Object.values(STORE_NAMES);
  const DB_NAME = FIXED_DB_NAME;

  return new Promise((resolve, reject) => {
    let req = indexedDB.open(DB_NAME);

    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      for (const s of requiredStores) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
        }
      }
    };

    req.onsuccess = async () => {
      const db = req.result;
      try {
        const missing = requiredStores.filter(s => !db.objectStoreNames.contains(s));
        if (missing.length === 0) {
          return resolve(db);
        }
        const newVersion = db.version + 1;
        db.close();
        const req2 = indexedDB.open(DB_NAME, newVersion);
        req2.onupgradeneeded = (ev2) => {
          const d = ev2.target.result;
          for (const s of requiredStores) {
            if (!d.objectStoreNames.contains(s)) {
              d.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
            }
          }
        };
        req2.onsuccess = () => resolve(req2.result);
        req2.onerror = () => reject(req2.error || new Error('Failed to open db for upgrade'));
      } catch (err) {
        try { db.close(); } catch (e) {}
        reject(err);
      }
    };

    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
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


/* Upload provided snapshot JSON to Google Apps Script URL (POST)
   - Does NOT read IndexedDB; caller supplies full payload object.
   - Used by auth/profile flows that must avoid creating local DB before login.
*/
export async function uploadSnapshotToCloud(appsScriptUrl, snapshot, opts = {}) {
  if (!appsScriptUrl) throw new Error('appsScriptUrl required');
  if (!snapshot || typeof snapshot !== 'object') throw new Error('snapshot object required');

  const bodyJson = JSON.stringify(snapshot);

  async function doFetch(bodyToSend, headers) {
    const res = await fetch(appsScriptUrl, {
      method: 'POST',
      headers,
      body: bodyToSend,
      signal: opts.signal,
    });

    if (res.type === 'opaque') {
      throw new Error('Opaque response from server - possible CORS/deployment issue (check Apps Script access settings).');
    }

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Upload failed: ${res.status} ${res.statusText} ${txt}`);
    }

    const json = await res.json().catch(async () => {
      const t = await res.text().catch(() => '');
      throw new Error('Invalid JSON response from cloud: ' + t);
    });
    return { ok: true, response: json };
  }

  try {
    const headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
    return await doFetch(bodyJson, headers);
  } catch (err) {
    const msg = err && err.message ? err.message.toLowerCase() : '';
    const shouldFallback = msg.includes('opaque') || msg.includes('failed to fetch') || msg.includes('preflight') || msg.includes('cors');
    if (!shouldFallback) throw err;
    try {
      const formBody = 'payload=' + encodeURIComponent(bodyJson);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      return await doFetch(formBody, headers);
    } catch (err2) {
      const finalMsg = (err2 && err2.message) ? err2.message : String(err2);
      throw new Error('Upload failed (attempted text/plain and form fallback). ' + finalMsg + ' Check Apps Script deployment (Execute as: Me) and access (Anyone, even anonymous).');
    }
  }
}/* Upload export JSON to Google Apps Script URL (POST)
   appsScriptUrl: string (required)
   opts may include:
     - userId: optional (string) to include in snapshot
     - recoveryKeyHash: optional (string) to include in snapshot
*/
export async function uploadToCloud(appsScriptUrl, opts = {}) {
  if (!appsScriptUrl) throw new Error('appsScriptUrl required');
  const payload = await exportAll();

  // attach profile metadata if available (prefer opts, fallback to current context)
  const userIdToSend = opts.userId || CURRENT_USER_ID || null;
  let recoveryKeyHashToSend = opts.recoveryKeyHash || null;
  if (!recoveryKeyHashToSend && userIdToSend) {
    recoveryKeyHashToSend = await getLatestRecoveryKeyHashForUser(appsScriptUrl, userIdToSend, opts);
  }
  if (!recoveryKeyHashToSend && typeof window !== 'undefined') {
    const sessionHash = window.__sessionRecoveryKeyHash || null;
    if (sessionHash) recoveryKeyHashToSend = String(sessionHash);
  }
  if (!recoveryKeyHashToSend && userIdToSend) {
    console.warn('Missing recoveryKeyHash for upload; proceeding without hash (server may backfill).');
  }

  if (opts.skipIfNoChange && userIdToSend) {
    try {
      const latest = await fetchLatestFromCloud(appsScriptUrl, { userId: userIdToSend, signal: opts.signal });
      if (latest?.data && JSON.stringify(latest.data) === JSON.stringify(payload.data)) {
        return { ok: true, skipped: true, reason: 'no_change' };
      }
    } catch (e) {
      // ignore compare failures and continue upload
    }
  }

  const extended = Object.assign({}, payload, {
    userId: userIdToSend || undefined,
    recoveryKeyHash: recoveryKeyHashToSend || undefined,
    eventType: opts.eventType || undefined
  });

  return uploadSnapshotToCloud(appsScriptUrl, extended, opts);
}
/* Fetch latest snapshot from Apps Script (GET)
   accepts opts.userId to restrict snapshots to a particular user in the server-side filter.
*/
export async function fetchLatestFromCloud(appsScriptUrl, opts = {}) {
  if (!appsScriptUrl) throw new Error('appsScriptUrl required');
  try {
    // For login/restore with a specific userId, use mode=all and strict client-side filtering.
    // This avoids older/misconfigured deployments returning another user's latest snapshot.
    if (opts.userId) {
      const wanted = String(opts.userId).trim();
      const rows = await fetchAllCloudRows(appsScriptUrl, { userId: wanted, signal: opts.signal });

      let best = null;
      let bestTime = -1;
      let canonicalHash = null;
      let canonicalProfileCreateTime = -1;
      let canonicalLatestHash = null;
      let canonicalLatestTime = -1;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] || {};
        const rowUser = String(row.userId || '').trim();
        let payload = null;
        try {
          payload = row.jsonPayload ? JSON.parse(String(row.jsonPayload)) : null;
        } catch (e) {
          payload = null;
        }
        const payloadUser = String(payload?.userId || '').trim();
        const effectiveUser = rowUser || payloadUser;
        if (effectiveUser !== wanted) continue;

        const rowHash = String(
          row.recoveryKeyHash ||
          payload?.recoveryKeyHash ||
          payload?.recovery_key ||
          ''
        ).trim();
        const rowEventType = String(row.eventType || payload?.eventType || '').trim();
        const rowTimeRaw = payload?.exportedAt || row.exportedAt || 0;
        const rowTimeParsed = Date.parse(rowTimeRaw);
        const rowTime = Number.isFinite(rowTimeParsed) ? rowTimeParsed : 0;

        // Build canonical hash for this user:
        // prefer latest profile_create hash; else latest any hash.
        if (rowHash) {
          if (rowTime >= canonicalLatestTime) {
            canonicalLatestTime = rowTime;
            canonicalLatestHash = rowHash;
          }
          if (rowEventType === 'profile_create' && rowTime >= canonicalProfileCreateTime) {
            canonicalProfileCreateTime = rowTime;
            canonicalHash = rowHash;
          }
        }

        if (!payload || typeof payload !== 'object' || !payload.data) continue;

        if (!payload.userId) payload.userId = effectiveUser;
        if (!payload.exportedAt && row.exportedAt) payload.exportedAt = row.exportedAt;
        if (!payload.deviceId && row.deviceId) payload.deviceId = row.deviceId;
        if (!payload.version && row.appVersion) payload.version = row.appVersion;
        if (!payload.eventType && row.eventType) payload.eventType = row.eventType;
        if (!payload.recoveryKeyHash && row.recoveryKeyHash) payload.recoveryKeyHash = row.recoveryKeyHash;
        payload._sheetName = row.sheetName || payload._sheetName || null;

        const t = Date.parse(payload.exportedAt || row.exportedAt || 0);
        const tm = Number.isFinite(t) ? t : 0;
        if (!best || tm >= bestTime) {
          best = payload;
          bestTime = tm;
        }
      }

      const finalCanonicalHash = (canonicalHash || canonicalLatestHash || null);
      if (best && !best.recoveryKeyHash && finalCanonicalHash) {
        best.recoveryKeyHash = finalCanonicalHash;
      }

      if (best && best.data && (best.data.transactions || best.data.settings || best.data.debt)) {
        return best;
      }
      throw new Error(`No cloud snapshot found for userId: ${wanted}`);
    }

    const url = new URL(appsScriptUrl);
    url.searchParams.set('mode', 'latest');
    // pass userId to server filter if provided
    if (opts.userId) url.searchParams.set('userId', opts.userId);

    const res = await fetch(url.toString(), { method: 'GET', signal: opts.signal });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Fetch failed: ${res.status} ${res.statusText} ${txt}`);
    }
    const text = await res.text();
    if (!text) throw new Error('Empty response from cloud');

    // existing tolerant parsing/normalization logic follows...
    const rawLatest = text;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch (e2) { parsed = null; }
      } else parsed = null;
    }

    if (!parsed) throw new Error('Invalid JSON in cloud response. Server returned: ' + (rawLatest.slice(0,500)));

    if (parsed.data && (parsed.data.transactions || parsed.data.settings || parsed.data.debt)) return parsed;

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
  const confirmFn = opts.confirmFn || (msg => {
    if (typeof window !== 'undefined' && typeof window.appConfirmDialog === 'function') {
      return window.appConfirmDialog(msg, { title: 'Confirm Restore', okText: 'Restore' });
    }
    return Promise.resolve(window.confirm(msg));
  });
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
    if (typeof window.appConfirmDialog === 'function') {
      return window.appConfirmDialog(msg, { title: 'Confirm Restore', okText: 'Restore' });
    }
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


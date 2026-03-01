/* profileManager.js
   Stable auth lifecycle:
   - One DB name: PortfolioDB
   - DB exists only after successful login
   - Cloud snapshot is source of truth
*/
import { setUserContext, clearAndRestore, fetchLatestFromCloud, uploadToCloud, uploadSnapshotToCloud } from './cloudSync.js';
const DEFAULT_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxRX-y7kiDT4GqN18F6-e46pibw_gbJxmOHlglm4YCoUMjYdhVt-vbBj2fQgGkcQr8S/exec';

function getAppsUrl() {
  const url = (typeof window !== 'undefined' && window.APP_APPS_SCRIPT_URL) ? window.APP_APPS_SCRIPT_URL : DEFAULT_APPS_SCRIPT_URL;
  if (typeof window !== 'undefined' && !window.APP_APPS_SCRIPT_URL) {
    window.APP_APPS_SCRIPT_URL = url;
  }
  return url;
}

function base64UrlEncode(bytes) {
  const b64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function setSessionRecoveryHash(hash) {
  try {
    if (typeof window !== 'undefined') {
      window.__sessionRecoveryKeyHash = hash || null;
    }
  } catch (e) {}
}

export async function hashRecoveryKey(recoveryKey) {
  const enc = new TextEncoder().encode(recoveryKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', enc);
  return base64UrlEncode(new Uint8Array(hashBuffer));
}

async function closeGlobalDBIfOpen() {
  try {
    if (typeof window !== 'undefined' && typeof window.closePortfolioDBAsync === 'function') {
      await window.closePortfolioDBAsync(250);
      return;
    }
    if (typeof window !== 'undefined' && window.db && typeof window.db.close === 'function') {
      window.db.close();
      try { delete window.db; } catch (e) {}
    }
  } catch (e) {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showBusyOverlay(message) {
  try {
    if (typeof window !== 'undefined' && typeof window.appShowLoading === 'function') {
      window.appShowLoading(message || 'Please wait...');
      return;
    }
    let el = document.getElementById('appLoadingOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appLoadingOverlay';
      el.style.position = 'fixed';
      el.style.inset = '0';
      el.style.background = 'rgba(15, 23, 42, 0.45)';
      el.style.zIndex = '12000';
      el.style.display = 'flex';
      el.style.alignItems = 'center';
      el.style.justifyContent = 'center';
      el.innerHTML = '<div style="background:#fff;padding:12px 16px;border-radius:10px;font-weight:700;">Please wait...</div>';
      document.body.appendChild(el);
    }
    const textEl = el.querySelector('div');
    if (textEl) textEl.textContent = message || 'Please wait...';
    el.style.display = 'flex';
  } catch (e) {}
}

function hideBusyOverlay() {
  try {
    if (typeof window !== 'undefined' && typeof window.appHideLoading === 'function') {
      window.appHideLoading();
      return;
    }
    const el = document.getElementById('appLoadingOverlay');
    if (el) el.style.display = 'none';
  } catch (e) {}
}

let LOGOUT_IN_PROGRESS = null;

async function retryDeleteDatabase(name, attempts = 6, waitMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    const ok = await new Promise(resolve => {
      try {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
        req.onblocked = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
    if (ok) return true;
    await delay(waitMs);
  }
  return false;
}

async function fetchUserRows(appsUrl) {
  const url = new URL(appsUrl);
  url.searchParams.set('mode', 'all');
  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = null;
  }
  if (!parsed) throw new Error('Invalid JSON from cloud');
  return Array.isArray(parsed?.rows) ? parsed.rows : [];
}

async function fetchRowsForUserDebug(appsUrl, userId) {
  try {
    const rows = await fetchUserRows(appsUrl);
    const wanted = String(userId || '').trim();
    return rows
      .filter(r => {
        const directUser = String(r?.userId || '').trim();
        if (directUser === wanted) return true;
        try {
          const payload = r?.jsonPayload ? JSON.parse(String(r.jsonPayload)) : null;
          return String(payload?.userId || '').trim() === wanted;
        } catch (e) {
          return false;
        }
      })
      .slice(-5)
      .map(r => {
        let payload = null;
        try { payload = r?.jsonPayload ? JSON.parse(String(r.jsonPayload)) : null; } catch (e) {}
        return {
          exportedAt: r?.exportedAt || payload?.exportedAt || null,
          userId: String(r?.userId || payload?.userId || '').trim(),
          eventType: r?.eventType || payload?.eventType || null,
          recoveryKeyHash: r?.recoveryKeyHash || payload?.recoveryKeyHash || payload?.recovery_key || null
        };
      });
  } catch (e) {
    return [];
  }
}

async function fetchSimilarUserRowsDebug(appsUrl, userId) {
  try {
    const rows = await fetchUserRows(appsUrl);
    const wanted = String(userId || '').trim().toLowerCase();
    if (!wanted) return [];
    return rows
      .map(r => {
        let payload = null;
        try { payload = r?.jsonPayload ? JSON.parse(String(r.jsonPayload)) : null; } catch (e) {}
        return {
          exportedAt: r?.exportedAt || payload?.exportedAt || null,
          userId: String(r?.userId || payload?.userId || '').trim(),
          eventType: r?.eventType || payload?.eventType || null,
          recoveryKeyHash: r?.recoveryKeyHash || payload?.recoveryKeyHash || payload?.recovery_key || null
        };
      })
      .filter(r => r.userId && r.userId.toLowerCase() === wanted)
      .slice(-10);
  } catch (e) {
    return [];
  }
}

async function findExistingUserIdInCloud(appsUrl, userId) {
  const wanted = String(userId || '').trim();
  const wantedLower = wanted.toLowerCase();
  if (!wanted) return '';

  // Primary path: query all rows and enforce strict client-side uniqueness.
  // Treat IDs case-insensitively for uniqueness warning (mobile typing safety).
  try {
    const rows = await fetchUserRows(appsUrl);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const directUser = String(row?.userId || '').trim();
      if (directUser && directUser.toLowerCase() === wantedLower) return directUser;
      try {
        const payload = row?.jsonPayload ? JSON.parse(String(row.jsonPayload)) : null;
        const payloadUser = String(payload?.userId || '').trim();
        if (payloadUser && payloadUser.toLowerCase() === wantedLower) return payloadUser;
      } catch (e) {}
    }
    return '';
  } catch (e) {
    // Fallback for deployments that do not support mode=all reliably.
    try {
      const payload = await fetchLatestFromCloud(appsUrl, { userId: wanted });
      const payloadUserId = String(payload?.userId || '').trim();
      if (payloadUserId && payloadUserId.toLowerCase() === wantedLower) return payloadUserId;
      return '';
    } catch (fallbackErr) {
      throw fallbackErr;
    }
  }
}

// Use 'activeUserId' as single persisted identity (string). Do not store passkey/hash in localStorage.
export function getLocalProfile() {
  try {
    const uid = localStorage.getItem('activeUserId');
    return uid ? { userId: uid } : null;
  } catch (e) {
    return null;
  }
}

export function setLocalProfile(profile) {
  try {
    if (profile && profile.userId) {
      localStorage.setItem('activeUserId', String(profile.userId));
      setUserContext(profile.userId);
    }
  } catch (e) {}
}

/* createProfile(displayName, userId)
   - userId MUST be user-chosen and unique (no mutation)
   - uploads initial empty snapshot + passkey hash to cloud
   - does not open local IndexedDB before login
*/
export async function createProfile(displayName, userId) {
  const trimmedName = (displayName || '').trim();
  const chosenUserId = (userId || '').trim();

  if (!trimmedName) throw new Error('Display name required');
  if (!chosenUserId) throw new Error('User ID required (choose a unique ID)');
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(chosenUserId)) {
    throw new Error('User ID must be 3-64 chars: letters, numbers, ., _, -');
  }

  const appsUrl = getAppsUrl();
  if (!appsUrl) throw new Error('Cloud endpoint not configured');

  let existingUserId = '';
  try {
    existingUserId = await findExistingUserIdInCloud(appsUrl, chosenUserId);
  } catch (e) {
    throw new Error('Cannot verify user ID uniqueness right now. Check network/cloud and try again.');
  }
  if (existingUserId) {
    const sameCase = existingUserId === chosenUserId;
    const message = sameCase
      ? 'User ID already exists. Choose a different ID.'
      : `User ID already exists as "${existingUserId}" (case-insensitive match). Choose a different ID.`;
    return { ok: false, reason: 'user_exists', message };
  }

  const recoveryKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(recoveryKeyBytes);
  const recoveryKey = base64UrlEncode(recoveryKeyBytes);
  const recoveryKeyHash = await hashRecoveryKey(recoveryKey);
  setSessionRecoveryHash(recoveryKeyHash);

  const initialSnapshot = {
    app: 'PortfolioTracker',
    version: '1.0',
    exportedAt: new Date().toISOString(),
    deviceId: 'profile-create',
    userId: chosenUserId,
    recoveryKeyHash,
    eventType: 'profile_create',
    data: {
      transactions: [],
      settings: {},
      debt: { borrows: [], repays: [] }
    }
  };

  try {
    await uploadSnapshotToCloud(appsUrl, initialSnapshot, { userId: chosenUserId });
  } catch (uploadErr) {
    return { ok: false, reason: 'upload_failed', message: String(uploadErr && uploadErr.message ? uploadErr.message : uploadErr) };
  }

  // Created profile can enter app immediately.
  try { localStorage.setItem('activeUserId', chosenUserId); } catch (e) {}
  setUserContext(chosenUserId);

  return { ok: true, userId: chosenUserId, name: trimmedName, createdAt: new Date().toISOString(), recoveryKey };
}

export function clearTransientPasskey() {
  // No-op: passkeys are never persisted locally.
}

/* authenticateAndStore(userId, recoveryKey)
   Required order:
   1) verify cloud credentials
   2) delete local PortfolioDB
   3) restore cloud snapshot into fresh PortfolioDB
   4) save activeUserId
   5) start app
*/
export async function authenticateAndStore(userId, recoveryKey) {
  const chosenUserId = (userId || '').trim();
  if (!chosenUserId || !recoveryKey) throw new Error('userId and recoveryKey required');

  const urlToUse = getAppsUrl();
  if (!urlToUse) throw new Error('Shared Apps Script endpoint not configured');

  const providedHash = await hashRecoveryKey(recoveryKey);
  try {
    console.group('[Auth Debug] Login Attempt');
    console.log('enteredUserId:', chosenUserId);
    console.log('enteredUserIdLower:', chosenUserId.toLowerCase());
    console.log('providedHash:', providedHash);
  } catch (e) {}

  let payload = null;
  try {
    payload = await fetchLatestFromCloud(urlToUse, { userId: chosenUserId });
  } catch (e) {
    try {
      console.error('[Auth Debug] fetchLatestFromCloud failed', e);
      console.groupEnd();
    } catch (e2) {}
    return { ok: false, notFound: true };
  }
  if (!payload) {
    try {
      console.warn('[Auth Debug] No payload returned for user:', chosenUserId);
      console.groupEnd();
    } catch (e) {}
    return { ok: false, notFound: true };
  }

  const expectedHash = payload.recoveryKeyHash || payload.recovery_key || null;
  const payloadUserId = String(payload.userId || '').trim();
  try {
    console.log('cloudPayload.userId:', payloadUserId || null);
    console.log('cloudPayload.userIdLower:', payloadUserId ? payloadUserId.toLowerCase() : null);
    console.log('cloudPayload.eventType:', payload.eventType || null);
    console.log('cloudPayload.exportedAt:', payload.exportedAt || null);
    console.log('cloudPayload.sheet:', payload._sheetName || null);
    console.log('expectedHash:', expectedHash);
    console.log('hashMatch:', providedHash === expectedHash);
    if (payloadUserId !== chosenUserId) {
      console.warn('[Auth Debug] User ID mismatch between entered and payload', {
        entered: chosenUserId,
        enteredLower: chosenUserId.toLowerCase(),
        payloadUserId,
        payloadLower: payloadUserId.toLowerCase()
      });
    }
    const recentRows = await fetchRowsForUserDebug(urlToUse, chosenUserId);
    console.log('recentRowsForEnteredUser (last 5):', recentRows);
    const similarCaseRows = await fetchSimilarUserRowsDebug(urlToUse, chosenUserId);
    console.log('rowsMatchingEnteredUserCaseInsensitive (last 10):', similarCaseRows);
  } catch (e) {}

  // Do not compare hash if server returned a different user snapshot.
  if (payloadUserId && payloadUserId !== chosenUserId) {
    try { console.groupEnd(); } catch (e) {}
    return { ok: false, reason: 'user_mismatch', payloadUserId };
  }

  if (!expectedHash) {
    try { console.groupEnd(); } catch (e) {}
    return { ok: false, notFound: true };
  }
  if (providedHash !== expectedHash) {
    try { console.groupEnd(); } catch (e) {}
    return { ok: false, reason: 'mismatch' };
  }
  setSessionRecoveryHash(expectedHash);

  try {
    await closeGlobalDBIfOpen();
    const deleted = await retryDeleteDatabase('PortfolioDB', 8, 250);

    await clearAndRestore(payload.data || { transactions: [], settings: {}, debt: { borrows: [], repays: [] } });

    try { localStorage.setItem('activeUserId', chosenUserId); } catch (e) {}
    setUserContext(chosenUserId);

    if (typeof window !== 'undefined' && typeof window.startApp === 'function') {
      await window.startApp();
    } else if (typeof window !== 'undefined' && typeof window.openDB === 'function') {
      await window.openDB();
    }

    return { ok: true, restored: !!payload.data, exportedAt: payload.exportedAt || null, dbDeleted: deleted };
  } catch (restoreErr) {
    try {
      console.error('[Auth Debug] Restore failed', restoreErr);
    } catch (e) {}
    return { ok: false, reason: 'restore_failed', error: String(restoreErr && restoreErr.message ? restoreErr.message : restoreErr) };
  } finally {
    try { console.groupEnd(); } catch (e) {}
    recoveryKey = '';
  }
}

/* logout()
   Required order:
   1) export local DB
   2) upload snapshot to cloud
   3) close DB
   4) delete DB
   5) clear activeUserId
   6) reload to login page
*/
export async function logout() {
  if (LOGOUT_IN_PROGRESS) {
    return LOGOUT_IN_PROGRESS;
  }
  showBusyOverlay('Signing out and syncing cloud backup...');
  LOGOUT_IN_PROGRESS = (async () => {
  try {
    const userId = (typeof localStorage !== 'undefined') ? localStorage.getItem('activeUserId') : null;
    if (!userId) {
      window.location.href = './client/profile.html';
      return;
    }

    const appsUrl = getAppsUrl();
    if (!appsUrl) throw new Error('Cloud endpoint not configured');

    const uploadRes = await uploadToCloud(appsUrl, { userId, eventType: 'logout' });
    try {
      const resp = uploadRes?.response || uploadRes || {};
      const prune = uploadRes?.response?.prune || null;
      const scriptTag = resp?.scriptTag || null;
      console.group('[Logout Debug] Cloud Upload');
      console.log('userId:', userId);
      console.log('appsScriptUrl:', appsUrl);
      console.log('uploadResponse:', uploadRes?.response || uploadRes);
      console.log('scriptTag:', scriptTag);
      if (prune) {
        console.log('pruneSummary:', {
          keepCount: prune.keepCount,
          totalMatchedBefore: prune.totalMatchedBefore,
          deletedCount: prune.deletedCount,
          totalMatchedAfter: prune.totalMatchedAfter
        });
        console.log('deletedSnapshots:', prune.deleted || []);
      }
      console.groupEnd();
      if (!scriptTag || !prune) {
        console.warn('[Logout Debug] Old Apps Script deployment detected (missing scriptTag/prune in response). Update APP_APPS_SCRIPT_URL or redeploy current script version.');
      }
      try {
        localStorage.setItem('lastCloudPruneDebug', JSON.stringify({
          at: new Date().toISOString(),
          userId,
          appsScriptUrl: appsUrl,
          response: uploadRes?.response || uploadRes || null,
          scriptTag,
          prune
        }));
      } catch (e2) {}
    } catch (e) {}
    await closeGlobalDBIfOpen();
    const deleted = await retryDeleteDatabase('PortfolioDB', 8, 250);
    // If delete was blocked by another open tab/handle, mark pending purge.
    // Login page will retry delete with no active session.
    if (!deleted) {
      try { localStorage.setItem('pendingDbPurge', '1'); } catch (e) {}
    } else {
      try { localStorage.removeItem('pendingDbPurge'); } catch (e) {}
    }

    try { localStorage.removeItem('activeUserId'); } catch (e) {}
    setSessionRecoveryHash(null);
    window.location.href = './client/profile.html';
  } catch (err) {
    console.error('Logout failed', err);
    try { localStorage.removeItem('activeUserId'); } catch (e) {}
    setSessionRecoveryHash(null);
    window.location.href = './client/profile.html';
  }
  })();
  try {
    return await LOGOUT_IN_PROGRESS;
  } finally {
    hideBusyOverlay();
    LOGOUT_IN_PROGRESS = null;
  }
}

if (typeof window !== 'undefined') window.appLogout = logout;

/* rotateRecoveryKey(currentRecoveryKey, nextRecoveryKey?)
   - Verifies current key against cloud hash
   - Updates cloud snapshot with new recovery hash (eventType: passkey_update)
   - Returns newly active recovery key once; never persisted locally
*/
export async function rotateRecoveryKey(currentRecoveryKey, nextRecoveryKey) {
  const userId = (typeof localStorage !== 'undefined') ? String(localStorage.getItem('activeUserId') || '').trim() : '';
  if (!userId) throw new Error('No active user');
  const currentKey = String(currentRecoveryKey || '').trim();
  if (!currentKey) throw new Error('Current recovery key required');

  const appsUrl = getAppsUrl();
  if (!appsUrl) throw new Error('Cloud endpoint not configured');

  const latest = await fetchLatestFromCloud(appsUrl, { userId });
  const expectedHash = String(latest?.recoveryKeyHash || latest?.recovery_key || '').trim();
  if (!expectedHash) throw new Error('No recovery hash found in cloud for this user');

  const currentHash = await hashRecoveryKey(currentKey);
  if (currentHash !== expectedHash) throw new Error('Current recovery key mismatch');

  let newKey = String(nextRecoveryKey || '').trim();
  if (!newKey) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    newKey = base64UrlEncode(bytes);
  }
  if (newKey.length < 8) throw new Error('New recovery key must be at least 8 characters');

  const newHash = await hashRecoveryKey(newKey);
  await uploadToCloud(appsUrl, {
    userId,
    recoveryKeyHash: newHash,
    eventType: 'passkey_update',
    skipIfNoChange: false
  });
  setSessionRecoveryHash(newHash);
  return { ok: true, userId, recoveryKey: newKey };
}

export async function __debugListDatabases() {
  try {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      return dbs.map(d => ({ name: d.name, version: d.version }));
    }
    return [];
  } catch (e) {
    return { error: String(e) };
  }
}

export function __debugLocalState() {
  try {
    const out = { activeUserId: localStorage.getItem('activeUserId') };
    out.window = { dbPresent: typeof window !== 'undefined' ? !!window.db : false };
    return out;
  } catch (e) {
    return { error: String(e) };
  }
}

if (typeof window !== 'undefined') {
  window.__debugListDatabases = __debugListDatabases;
  window.__debugLocalState = __debugLocalState;
}

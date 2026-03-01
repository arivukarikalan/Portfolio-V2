/* cloudUi.js
   - Attach to two buttons:
     #sync-cloud-btn  => initiate uploadToCloud(...)
     #restore-cloud-btn => initiate restoreFromCloud(...)
   - Shows toasts and confirms for user safety
   - Replace APPS_SCRIPT_URL with your deployed Apps Script URL (do NOT hardcode secrets)
*/

import { uploadToCloud, restoreFromCloud } from './cloudSync.js';

// Replace or set this URL at runtime (do not hardcode secrets)
// Default set to the URL you provided; can be overridden at runtime by setting window.APP_APPS_SCRIPT_URL
const APPS_SCRIPT_URL = window.APP_APPS_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbzhUIiOEAqK6x5txJHZwI_dwnc-gPWg7sAn169b3Lje1wFiiFYugukLxYHwxc2fpZNU/exec';

// Expose for console/debug use
if (typeof window !== 'undefined') window.APP_APPS_SCRIPT_URL = window.APP_APPS_SCRIPT_URL || APPS_SCRIPT_URL;

function showToast(message, type = 'info', ms = 5000) {
  // Minimal toast: can be replaced by app's notification system
  const el = document.createElement('div');
  el.textContent = message;
  el.style.position = 'fixed';
  el.style.right = '16px';
  el.style.bottom = '16px';
  el.style.padding = '8px 12px';
  el.style.background = type === 'error' ? '#c0392b' : (type === 'success' ? '#27ae60' : '#333');
  el.style.color = '#fff';
  el.style.borderRadius = '4px';
  el.style.zIndex = 9999;
  document.body.appendChild(el);
  setTimeout(() => { el.remove(); }, ms);
}

/* Create minimal controls if buttons are missing in the existing UI.
   Non-invasive: only adds UI when #sync-cloud-btn and #restore-cloud-btn are absent.
*/
function ensureButtonsExist() {
  const existingSync = document.getElementById('sync-cloud-btn');
  const existingRestore = document.getElementById('restore-cloud-btn');
  if (existingSync || existingRestore) return;

  const container = document.createElement('div');
  container.id = 'cloud-sync-controls';
  container.style.position = 'fixed';
  container.style.left = '16px';
  container.style.bottom = '16px';
  container.style.display = 'flex';
  container.style.gap = '8px';
  container.style.zIndex = 9998;

  const syncBtn = document.createElement('button');
  syncBtn.id = 'sync-cloud-btn';
  syncBtn.type = 'button';
  syncBtn.textContent = 'Sync to Cloud';

  const restoreBtn = document.createElement('button');
  restoreBtn.id = 'restore-cloud-btn';
  restoreBtn.type = 'button';
  restoreBtn.textContent = 'Restore from Cloud';

  // Minimal styling for visibility; can be overridden by app CSS
  [syncBtn, restoreBtn].forEach(b => {
    b.style.padding = '8px 10px';
    b.style.borderRadius = '4px';
    b.style.border = '1px solid rgba(0,0,0,0.1)';
    b.style.background = '#fff';
    b.style.cursor = 'pointer';
  });

  container.appendChild(syncBtn);
  container.appendChild(restoreBtn);
  document.body.appendChild(container);
}

function wireButtons() {
  ensureButtonsExist();

  const syncBtn = document.getElementById('sync-cloud-btn');
  const restoreBtn = document.getElementById('restore-cloud-btn');
  const checkBtn = document.getElementById('check-cloud-btn');

  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      if (!window.APP_APPS_SCRIPT_URL) { showToast('Cloud URL not configured', 'error'); return; }
      syncBtn.disabled = true;
      showToast('Preparing export...', 'info', 2000);
      try {
        const res = await uploadToCloud(window.APP_APPS_SCRIPT_URL);
        // Try to show exportedAt if Apps Script returned it
        const exportedAt = res && res.response && (res.response.exportedAt || res.response.exportedAt === 0) ? res.response.exportedAt : null;
        if (exportedAt) {
          showToast('Backup uploaded to cloud (exportedAt: ' + exportedAt + ')', 'success', 7000);
        } else {
          showToast('Backup uploaded to cloud', 'success', 5000);
        }
        console.info('cloud upload response', res);
      } catch (err) {
        // Provide more detail in the toast but keep it concise
        const msg = err && err.message ? err.message : String(err);
        showToast('Upload failed: ' + msg, 'error', 10000);
        console.error('upload error', err);
      } finally {
        syncBtn.disabled = false;
      }
    });
  }

  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      if (!window.APP_APPS_SCRIPT_URL) { showToast('Cloud URL not configured', 'error'); return; }
      restoreBtn.disabled = true;
      try {
        const result = await restoreFromCloud(window.APP_APPS_SCRIPT_URL, { confirmFn: async (msg) => {
          return window.confirm(msg);
        }});
        showToast('Local data restored from cloud snapshot', 'success', 6000);
        console.info('restore result', result);
      } catch (err) {
        // Enhanced diagnostics on restore failure
        if ((err && err.message) === 'User cancelled restore') {
          showToast('Restore cancelled', 'info', 3000);
        } else {
          const msg = err && err.message ? err.message : String(err);
          showToast('Restore failed: ' + msg + '. See console for diagnostics', 'error', 15000);
          console.error('restore error', err);

          // Try to call diagnostic helpers (if available) and log results
          try {
            if (typeof window.__cloudFetchRawLatest === 'function') {
              const rawLatest = await window.__cloudFetchRawLatest(window.APP_APPS_SCRIPT_URL);
              console.group('cloud rawLatest');
              console.log(rawLatest);
              console.groupEnd();
            } else {
              console.warn('__cloudFetchRawLatest not available');
            }
          } catch (d1) {
            console.error('Error fetching rawLatest', d1);
          }

          try {
            if (typeof window.__cloudFetchRawAll === 'function') {
              const rawAll = await window.__cloudFetchRawAll(window.APP_APPS_SCRIPT_URL);
              console.group('cloud rawAll');
              console.log(rawAll);
              console.groupEnd();
            } else {
              console.warn('__cloudFetchRawAll not available');
            }
          } catch (d2) {
            console.error('Error fetching rawAll', d2);
          }

          try {
            if (typeof window.__cloudFetchDiag === 'function') {
              const diag = await window.__cloudFetchDiag(window.APP_APPS_SCRIPT_URL);
              console.group('cloud diag');
              console.log(diag);
              console.groupEnd();
              // If diag parsed exists, surface quick readable info
              if (diag && diag.parsed) {
                const p = diag.parsed;
                console.log('Diag parsed keys:', Object.keys(p));
                console.log('SpreadsheetId:', p.spreadsheetId);
                console.log('sheetNames:', p.sheetNames);
                console.log('expectedSheet:', p.expectedSheet);
                console.log('activeSheetName:', p.activeSheetName);
                console.log('lastRow:', p.lastRow, 'lastCol:', p.lastCol);
                console.log('lastRowSample:', p.lastRowSample);
              }
            } else {
              console.warn('__cloudFetchDiag not available');
            }
          } catch (d3) {
            console.error('Error fetching diag', d3);
          }

          // Guidance for next step
          console.info('If you still see "no_backups": confirm the deployed Apps Script uses the same SPREADSHEET_ID and is the latest deployment. Paste the console outputs here for further analysis.');
        }
      } finally {
        restoreBtn.disabled = false;
      }
    });
  }

  if (checkBtn) {
    checkBtn.addEventListener('click', async () => {
      if (!window.APP_APPS_SCRIPT_URL) { showToast('Cloud URL not configured', 'error'); return; }
      checkBtn.disabled = true;
      showToast('Checking cloud diagnostics...', 'info', 2000);
      try {
        // __cloudFetchDiag is exposed by cloudSync.js for diagnostics
        if (typeof window.__cloudFetchDiag !== 'function') {
          showToast('Diag helper not available (ensure cloudSync.js is loaded)', 'error', 7000);
          console.warn('diag helper not found on window');
        } else {
          const diag = await window.__cloudFetchDiag(window.APP_APPS_SCRIPT_URL);
          console.info('Cloud diag result:', diag);
          if (diag && diag.parsed) {
            const p = diag.parsed;
            showToast(`Cloud: sheet=${p.activeSheetName || p.expectedSheet} lastRow=${p.lastRow}`, 'success', 8000);
            // show small detail in console for debugging
            console.log('Cloud diag parsed:', p);
          } else {
            showToast('Cloud diag returned no parsed info (see console)', 'error', 8000);
            console.log('cloud diag raw:', diag);
          }
        }
      } catch (err) {
        console.error('diag error', err);
        const msg = err && err.message ? err.message : String(err);
        showToast('Cloud diag failed: ' + msg, 'error', 10000);
      } finally {
        checkBtn.disabled = false;
      }
    });
  }
}

/* Auto-wire on DOMContentLoaded if present */
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    try { wireButtons(); } catch (e) { /* ignore wiring errors */ }
  });
}

/* Export for manual wiring if needed */
export { wireButtons, showToast };

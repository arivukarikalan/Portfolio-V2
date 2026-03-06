/* =========================================================
   FILE: settings.js
   PURPOSE:
   - Centralised application settings
   ========================================================= */

/* ================= UX HELPERS ================= */
let LAST_TOAST_SIG = "";
let LAST_TOAST_AT = 0;

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(message, type = "success", durationMs) {
  const text = (message || "").trim();
  if (!text) return;
  const sig = `${type}::${text}`;
  const now = Date.now();
  if (sig === LAST_TOAST_SIG && now - LAST_TOAST_AT < 1000) return;
  LAST_TOAST_SIG = sig;
  LAST_TOAST_AT = now;

  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    host.setAttribute("aria-live", "polite");
    host.setAttribute("aria-atomic", "true");
    document.body.appendChild(host);
  }

  const iconMap = {
    success: "bi-check2-circle",
    error: "bi-exclamation-octagon",
    info: "bi-info-circle"
  };
  const iconClass = iconMap[type] || iconMap.info;
  const life = Number.isFinite(Number(durationMs))
    ? Number(durationMs)
    : (type === "error" ? 4200 : (type === "info" ? 3000 : 2400));

  const toast = document.createElement("div");
  toast.className = `app-toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML = `
    <div class="app-toast-inner">
      <span class="app-toast-icon"><i class="bi ${iconClass}"></i></span>
      <span class="app-toast-text"></span>
    </div>
    <span class="app-toast-progress"></span>
  `;
  const toastText = toast.querySelector(".app-toast-text");
  if (toastText) toastText.textContent = text;
  host.appendChild(toast);

  // Keep stack compact on mobile.
  while (host.children.length > 3) {
    host.removeChild(host.firstChild);
  }

  toast.addEventListener("click", () => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 180);
  });

  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 220);
  }, life);
}
if (typeof window !== "undefined" && typeof window.showToast !== "function") {
  window.showToast = showToast;
}

let APP_LOADING_PROGRESS_TIMER = null;

function stopLoadingProgressTimer() {
  if (APP_LOADING_PROGRESS_TIMER) {
    clearInterval(APP_LOADING_PROGRESS_TIMER);
    APP_LOADING_PROGRESS_TIMER = null;
  }
}

function setLoadingProgressValue(percent) {
  const bar = document.getElementById("appLoadingBarFill");
  const pctEl = document.getElementById("appLoadingPercent");
  const wrap = document.getElementById("appLoadingProgressWrap");
  const p = Math.max(0, Math.min(100, Number(percent || 0)));
  if (wrap) wrap.style.display = "block";
  if (bar) bar.style.width = `${p}%`;
  if (pctEl) pctEl.textContent = `${Math.round(p)}%`;
}

function appShowLoading(message = "Please wait...", opts = {}) {
  let el = document.getElementById("appLoadingOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "appLoadingOverlay";
    el.className = "app-loading-overlay";
    el.innerHTML = `
      <div class="app-loading-card">
        <div class="app-loading-spinner" aria-hidden="true"></div>
        <div class="app-loading-main">
          <div class="app-loading-text" id="appLoadingText"></div>
          <div class="app-loading-progress-wrap" id="appLoadingProgressWrap" style="display:none">
            <div class="app-loading-progress-track"><div class="app-loading-progress-fill" id="appLoadingBarFill"></div></div>
            <div class="app-loading-percent" id="appLoadingPercent">0%</div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);
  }
  stopLoadingProgressTimer();
  const textEl = document.getElementById("appLoadingText");
  const progressWrap = document.getElementById("appLoadingProgressWrap");
  if (textEl) textEl.textContent = String(message || "Please wait...");
  if (progressWrap) progressWrap.style.display = opts?.showProgress ? "block" : "none";
  if (opts?.showProgress) {
    setLoadingProgressValue(Number(opts?.progress || 0));
  }
  el.style.display = "flex";
}

function appHideLoading() {
  stopLoadingProgressTimer();
  const el = document.getElementById("appLoadingOverlay");
  if (el) el.style.display = "none";
}

function appShowActionProgress(message = "Please wait...") {
  appShowLoading(message, { showProgress: true, progress: 3 });
  let p = 3;
  stopLoadingProgressTimer();
  APP_LOADING_PROGRESS_TIMER = setInterval(() => {
    if (p >= 92) return;
    p += Math.max(1, Math.floor((100 - p) / 8));
    setLoadingProgressValue(p);
  }, 700);
}

function appUpdateActionProgress(percent, message) {
  const textEl = document.getElementById("appLoadingText");
  if (textEl && message) textEl.textContent = String(message);
  setLoadingProgressValue(percent);
}

function appHideActionProgress() {
  setLoadingProgressValue(100);
  stopLoadingProgressTimer();
  setTimeout(() => appHideLoading(), 180);
}

function appAlertDialog(message, opts = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    backdrop.innerHTML = `
      <div class="app-dialog-card" role="dialog" aria-modal="true">
        <div class="app-dialog-title">${opts.title || "Notice"}</div>
        <div class="app-dialog-message"></div>
        <div class="app-dialog-actions">
          <button type="button" class="btn btn-primary app-dialog-ok">${opts.okText || "OK"}</button>
        </div>
      </div>
    `;
    const messageEl = backdrop.querySelector(".app-dialog-message");
    if (messageEl) messageEl.textContent = String(message || "");
    const okBtn = backdrop.querySelector(".app-dialog-ok");
    okBtn?.addEventListener("click", () => {
      backdrop.remove();
      resolve(true);
    });
    document.body.appendChild(backdrop);
    okBtn?.focus();
  });
}

function appConfirmDialog(message, opts = {}) {
  return new Promise(resolve => {
    const backdrop = document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    backdrop.innerHTML = `
      <div class="app-dialog-card" role="dialog" aria-modal="true">
        <div class="app-dialog-title">${opts.title || "Confirm"}</div>
        <div class="app-dialog-message"></div>
        <div class="app-dialog-actions">
          <button type="button" class="btn btn-outline-secondary app-dialog-cancel">${opts.cancelText || "Cancel"}</button>
          <button type="button" class="btn btn-primary app-dialog-ok">${opts.okText || "Confirm"}</button>
        </div>
      </div>
    `;
    const messageEl = backdrop.querySelector(".app-dialog-message");
    if (messageEl) messageEl.textContent = String(message || "");
    const okBtn = backdrop.querySelector(".app-dialog-ok");
    const cancelBtn = backdrop.querySelector(".app-dialog-cancel");
    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };
    okBtn?.addEventListener("click", () => close(true));
    cancelBtn?.addEventListener("click", () => close(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
    document.body.appendChild(backdrop);
    okBtn?.focus();
  });
}

function appPromptDialog(opts = {}) {
  return new Promise(resolve => {
    const title = opts.title || "Input";
    const message = opts.message || "";
    const placeholder = opts.placeholder || "";
    const defaultValue = opts.defaultValue || "";
    const required = !!opts.required;
    const minLength = Number(opts.minLength || 0);
    const inputType = opts.inputType || "text";

    const backdrop = document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    backdrop.innerHTML = `
      <div class="app-dialog-card" role="dialog" aria-modal="true">
        <div class="app-dialog-title">${title}</div>
        <div class="app-dialog-message"></div>
        <input class="form-control app-dialog-input" />
        <div class="app-dialog-error" style="display:none;"></div>
        <div class="app-dialog-actions">
          <button type="button" class="btn btn-outline-secondary app-dialog-cancel">Cancel</button>
          <button type="button" class="btn btn-primary app-dialog-ok">Continue</button>
        </div>
      </div>
    `;
    const messageEl = backdrop.querySelector(".app-dialog-message");
    const input = backdrop.querySelector(".app-dialog-input");
    const errorEl = backdrop.querySelector(".app-dialog-error");
    const okBtn = backdrop.querySelector(".app-dialog-ok");
    const cancelBtn = backdrop.querySelector(".app-dialog-cancel");
    if (messageEl) messageEl.textContent = String(message);
    if (input) {
      input.type = inputType;
      input.placeholder = placeholder;
      input.value = defaultValue;
      input.autocomplete = "off";
      input.autocapitalize = "off";
      input.autocorrect = "off";
      input.spellcheck = false;
    }

    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };

    const submit = () => {
      const val = String(input?.value || "").trim();
      if (required && !val) {
        if (errorEl) {
          errorEl.textContent = "This field is required.";
          errorEl.style.display = "block";
        }
        return;
      }
      if (minLength > 0 && val && val.length < minLength) {
        if (errorEl) {
          errorEl.textContent = `Minimum ${minLength} characters required.`;
          errorEl.style.display = "block";
        }
        return;
      }
      close(val || "");
    };

    okBtn?.addEventListener("click", submit);
    cancelBtn?.addEventListener("click", () => close(null));
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.appendChild(backdrop);
    input?.focus();
  });
}

if (typeof window !== "undefined") {
  window.appShowLoading = appShowLoading;
  window.appHideLoading = appHideLoading;
  window.appShowActionProgress = appShowActionProgress;
  window.appUpdateActionProgress = appUpdateActionProgress;
  window.appHideActionProgress = appHideActionProgress;
  window.appAlertDialog = appAlertDialog;
  window.appConfirmDialog = appConfirmDialog;
  window.appPromptDialog = appPromptDialog;
}

function setupBottomNav() {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return;
  // Legacy bottom nav is now hidden by shared side-shell.
}

function daysBetween(fromIso, toDate = new Date()) {
  if (!fromIso) return Number.POSITIVE_INFINITY;
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return Number.POSITIVE_INFINITY;
  const ms = toDate.getTime() - from.getTime();
  return ms / (1000 * 60 * 60 * 24);
}

function markBackupReminderSeen() {
  localStorage.setItem("backup_last_reminder_at", new Date().toISOString());
}

function markBackupDone() {
  const nowIso = new Date().toISOString();
  localStorage.setItem("backup_last_csv_at", nowIso);
  localStorage.setItem("backup_last_reminder_at", nowIso);
}

function closeBackupReminder() {
  const backdrop = document.getElementById("backupPopupBackdrop");
  if (backdrop) backdrop.remove();
}

function openBackupReminder() {
  if (document.getElementById("backupPopupBackdrop")) return;

  const backdrop = document.createElement("div");
  backdrop.id = "backupPopupBackdrop";
  backdrop.className = "backup-popup-backdrop";
  backdrop.innerHTML = `
    <div class="backup-popup">
      <div class="backup-popup-head">
        <span class="backup-popup-icon"><i class="bi bi-cloud-arrow-down"></i></span>
        <div>
          <div class="backup-popup-title">Weekly Backup Reminder</div>
          <div class="backup-popup-sub">Export your latest CSV backup to keep data safe.</div>
        </div>
      </div>
      <div class="backup-popup-actions">
        <button type="button" class="btn btn-primary" id="backupNowBtn">Backup Now</button>
        <button type="button" class="btn btn-outline-secondary" id="backupLaterBtn">Later</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const nowBtn = document.getElementById("backupNowBtn");
  const laterBtn = document.getElementById("backupLaterBtn");

  nowBtn?.addEventListener("click", () => {
    exportCSV();
    closeBackupReminder();
  });

  laterBtn?.addEventListener("click", () => {
    markBackupReminderSeen();
    closeBackupReminder();
  });

  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) {
      markBackupReminderSeen();
      closeBackupReminder();
    }
  });
}

function maybeShowWeeklyBackupReminder() {
  const lastBackup = localStorage.getItem("backup_last_csv_at");
  const lastReminder = localStorage.getItem("backup_last_reminder_at");
  const sinceBackupDays = daysBetween(lastBackup);
  const sinceReminderDays = daysBetween(lastReminder);

  if (sinceBackupDays >= 7 && sinceReminderDays >= 7) {
    openBackupReminder();
  }
}

const AUTO_SYNC_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const AUTO_SYNC_LAST_AT_KEY = "cloud_auto_sync_last_at";
const AUTO_SYNC_REPORT_KEY = "cloud_auto_sync_last_report";
const AUTO_SYNC_RUNNING_KEY = "cloud_auto_sync_running";
const SETTINGS_LIVE_PRICE_BUMP_KEY = "live_price_settings_bump_v1";

function isLocalDevOrigin() {
  try {
    const host = String(window.location.hostname || "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "";
  } catch (e) {
    return false;
  }
}

function getAutoSyncReport() {
  try {
    const raw = localStorage.getItem(AUTO_SYNC_REPORT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveAutoSyncReport(report) {
  try {
    localStorage.setItem(AUTO_SYNC_REPORT_KEY, JSON.stringify(report || {}));
    localStorage.setItem(AUTO_SYNC_LAST_AT_KEY, new Date().toISOString());
  } catch (e) {}
}

async function maybeRunAutoCloudSync(force = false) {
  if (isLocalDevOrigin()) {
    return { skipped: true, reason: "local_dev_cors" };
  }
  const userId = String(localStorage.getItem("activeUserId") || "").trim();
  if (!userId) return { skipped: true, reason: "no_user" };

  const now = Date.now();
  const lastAtIso = localStorage.getItem(AUTO_SYNC_LAST_AT_KEY);
  const lastAtMs = lastAtIso ? Date.parse(lastAtIso) : 0;
  const due = !lastAtMs || !Number.isFinite(lastAtMs) || (now - lastAtMs >= AUTO_SYNC_INTERVAL_MS);
  if (!force && !due) return { skipped: true, reason: "not_due" };

  const runningAt = Number(localStorage.getItem(AUTO_SYNC_RUNNING_KEY) || 0);
  if (runningAt && now - runningAt < 45000) return { skipped: true, reason: "already_running" };

  localStorage.setItem(AUTO_SYNC_RUNNING_KEY, String(now));
  const startedAt = new Date().toISOString();
  try {
    const mod = await import("../client/cloudSync.js");
    const url = getAppsScriptUrl();
    const result = await mod.uploadToCloud(url, {
      userId,
      eventType: "auto_sync_2d",
      // Avoid extra GETs on strict CORS setups; keep sync robust.
      skipIfNoChange: false,
      skipRecoveryHashLookup: true
    });
    const report = {
      ok: true,
      userId,
      startedAt,
      finishedAt: new Date().toISOString(),
      skipped: !!result?.skipped,
      reason: result?.reason || null,
      exportedAt: result?.response?.exportedAt || null
    };
    saveAutoSyncReport(report);
    if (!result?.skipped) showToast("Auto sync completed", "success", 2200);
    return report;
  } catch (err) {
    const report = {
      ok: false,
      userId,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: String(err?.message || err)
    };
    try { localStorage.setItem(AUTO_SYNC_REPORT_KEY, JSON.stringify(report)); } catch (e) {}
    return report;
  } finally {
    localStorage.removeItem(AUTO_SYNC_RUNNING_KEY);
  }
}

function readStoreAll(storeName) {
  return new Promise(resolve => {
    try {
      db.transaction(storeName, "readonly").objectStore(storeName).getAll().onsuccess = e => {
        resolve(e.target.result || []);
      };
    } catch (e) {
      resolve([]);
    }
  });
}

function csvCell(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function csvRow(values) {
  return (values || []).map(csvCell).join(",");
}

async function exportAllDataCsv() {
  try {
    if (typeof db === "undefined" || !db) {
      if (typeof openDB === "function") await openDB();
    }
    const [txns, settingsRows, borrows, repays, mappings, expenses] = await Promise.all([
      readStoreAll("transactions"),
      readStoreAll("settings"),
      readStoreAll("debt_borrows"),
      readStoreAll("debt_repays"),
      readStoreAll("stock_mappings"),
      readStoreAll("expenses")
    ]);

    const settings = (settingsRows && settingsRows[0]) ? settingsRows[0] : {};
    const buyValue = txns.filter(t => String(t.type || "").toUpperCase() === "BUY")
      .reduce((sum, t) => sum + (Number(t.qty || 0) * Number(t.price || 0)), 0);
    const sellValue = txns.filter(t => String(t.type || "").toUpperCase() === "SELL")
      .reduce((sum, t) => sum + (Number(t.qty || 0) * Number(t.price || 0)), 0);
    const totalBrokerage = txns.reduce((sum, t) => sum + Number(t.brokerage || 0), 0);
    const realizedApprox = sellValue - buyValue - totalBrokerage;

    let csv = "#FINANCE_APP_FULL_EXPORT_V1\n";
    csv += `#EXPORTED_AT,${new Date().toISOString()}\n`;
    csv += `#ACTIVE_USER,${csvCell(localStorage.getItem("activeUserId") || "")}\n\n`;

    csv += "#SUMMARY\n";
    csv += "transactions_count,debt_borrows_count,debt_repays_count,stock_mappings_count,expenses_count,sell_gross,buy_gross,total_brokerage,realized_net_approx\n";
    csv += `${csvRow([txns.length, borrows.length, repays.length, mappings.length, expenses.length, sellValue.toFixed(2), buyValue.toFixed(2), totalBrokerage.toFixed(2), realizedApprox.toFixed(2)])}\n\n`;

    csv += "#SETTINGS\n";
    csv += "key,value\n";
    Object.keys(settings || {}).forEach(k => {
      csv += `${csvRow([k, settings[k]])}\n`;
    });
    csv += "\n";

    csv += "#TRANSACTIONS\n";
    csv += "id,date,stock,type,qty,price,brokerage,reason,note,createdAt,updatedAt\n";
    (txns || []).forEach(t => {
      csv += `${csvRow([t.id, t.date, t.stock, t.type, t.qty, t.price, t.brokerage, t.reason, t.note, t.createdAt, t.updatedAt])}\n`;
    });
    csv += "\n";

    csv += "#DEBT_BORROWS\n";
    csv += "id,date,lender,category,amount,interestPct,note,createdAt\n";
    (borrows || []).forEach(b => {
      csv += `${csvRow([b.id, b.date, b.lender, b.category, b.amount, b.interestPct, b.note, b.createdAt])}\n`;
    });
    csv += "\n";

    csv += "#DEBT_REPAYS\n";
    csv += "id,date,lender,amount,note,createdAt\n";
    (repays || []).forEach(r => {
      csv += `${csvRow([r.id, r.date, r.lender, r.amount, r.note, r.createdAt])}\n`;
    });
    csv += "\n";

    csv += "#STOCK_MAPPINGS\n";
    csv += "stock,ticker,exchange,enabled,updatedAt\n";
    (mappings || []).forEach(m => {
      csv += `${csvRow([m.stock, m.ticker, m.exchange, m.enabled, m.updatedAt])}\n`;
    });
    csv += "\n";

    csv += "#EXPENSES\n";
    csv += "id,date,amount,category,note,paymentMode,createdAt,updatedAt\n";
    (expenses || []).forEach(ex => {
      csv += `${csvRow([ex.id, ex.date, ex.amount, ex.category, ex.note, ex.paymentMode, ex.createdAt, ex.updatedAt])}\n`;
    });

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `finance_full_export_${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);

    markBackupDone();
    showToast("Full CSV export downloaded", "success");
  } catch (err) {
    showToast("Full export failed: " + (err?.message || err), "error", 4000);
  }
}

function getAppsScriptUrl() {
  const fallback = "https://script.google.com/macros/s/AKfycbzkSMNGyDU7yk-pMSvF1wsEVetBJaQepnqOV8DbjbdoxS37TfszxMeGNufhe3N9viw/exec";
  return (typeof window !== "undefined" && window.APP_APPS_SCRIPT_URL) ? window.APP_APPS_SCRIPT_URL : fallback;
}

async function fetchCloudRowsForActiveUser() {
  const userId = localStorage.getItem("activeUserId");
  if (!userId) return { userId: null, rows: [] };

  const url = new URL(getAppsScriptUrl());
  url.searchParams.set("mode", "all");
  url.searchParams.set("userId", userId);

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Cloud fetch failed: ${res.status} ${res.statusText} ${txt}`);
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    const m = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; }
    }
  }
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  const exactRows = rows
    .map(r => {
      let normalized = {
        ...r,
        userId: r?.userId || "",
        recoveryKeyHash: r?.recoveryKeyHash || "",
        eventType: r?.eventType || "",
        jsonPayload: r?.jsonPayload || null
      };
      if (normalized.jsonPayload) {
        try {
          const payload = JSON.parse(String(normalized.jsonPayload));
          if (!normalized.userId) normalized.userId = payload?.userId || "";
          if (!normalized.recoveryKeyHash) normalized.recoveryKeyHash = payload?.recoveryKeyHash || payload?.recovery_key || "";
          if (!normalized.eventType) normalized.eventType = payload?.eventType || "";
        } catch (e) {}
      }
      return normalized;
    })
    .filter(r => String(r?.userId || "").trim() === String(userId).trim());
  return { userId, rows: exactRows };
}

function upsertCloudStatusModal(contentHtml) {
  let modal = document.getElementById("cloudStatusModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "cloudStatusModal";
    modal.className = "cloud-status-modal";
    modal.innerHTML = `
      <div id="cloudStatusCard" class="cloud-status-card">
        <div class="d-flex justify-content-between align-items-center mb-2">
          <h5 class="mb-0"><i class="bi bi-cloud-check"></i> Cloud Status</h5>
          <button id="cloudStatusClose" type="button" class="btn btn-sm btn-outline-secondary">Close</button>
        </div>
        <div id="cloudStatusBody"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.style.display = "none";
    });
    const closeBtn = document.getElementById("cloudStatusClose");
    if (closeBtn) closeBtn.addEventListener("click", () => { modal.style.display = "none"; });
  }
  const body = document.getElementById("cloudStatusBody");
  if (body) body.innerHTML = contentHtml;
  modal.style.display = "block";
}

function formatIso(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function addCloudHeaderButton() {
  const uid = localStorage.getItem("activeUserId");
  if (!uid) return;
  // Phase-1 shell has compact right actions; keep cloud status inside Settings panel only.
  if (document.getElementById("appShellActions")) return;
  const host =
    document.querySelector("#appShellActions") ||
    document.querySelector(".app-header .d-flex");
  if (!host) return;
  if (document.getElementById("cloud-status-btn")) return;

  const btn = document.createElement("button");
  btn.id = "cloud-status-btn";
  btn.type = "button";
  btn.className = "btn btn-sm btn-light";
  btn.title = "Cloud status";
  btn.innerHTML = '<i class="bi bi-cloud-check"></i>';

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    appShowActionProgress("Checking cloud status...");
    upsertCloudStatusModal('<div class="text-muted">Loading cloud details...</div>');
    try {
      const { userId, rows } = await fetchCloudRowsForActiveUser();
      if (!userId) {
        upsertCloudStatusModal('<div class="text-danger">No active user found.</div>');
        return;
      }
      if (!rows.length) {
        upsertCloudStatusModal(`<div><div><strong>User:</strong> ${escapeHtml(userId)}</div><div class="text-danger mt-2">No cloud snapshots found for this user.</div></div>`);
        return;
      }

      rows.sort((a, b) => new Date(a.exportedAt || 0) - new Date(b.exportedAt || 0));
      const latest = rows[rows.length - 1] || {};
      const latestHash = String(latest.recoveryKeyHash || "").trim();
      let txCount = "-";
      try {
        const payload = latest.jsonPayload ? JSON.parse(String(latest.jsonPayload)) : null;
        txCount = Array.isArray(payload?.data?.transactions) ? payload.data.transactions.length : "-";
      } catch (e) {}

      const report = getAutoSyncReport();
      const autoSyncHtml = report
        ? `<hr><div><strong>Auto Sync (2d):</strong> ${report.ok ? "OK" : '<span class="text-danger">Failed</span>'}</div>
           <div><strong>Last run:</strong> ${escapeHtml(formatIso(report.finishedAt || report.startedAt))}</div>
           <div><strong>Status:</strong> ${report.skipped ? `Skipped (${escapeHtml(report.reason || "n/a")})` : "Uploaded"}</div>`
        : `<hr><div><strong>Auto Sync (2d):</strong> No report yet</div>`;

      const html = `
        <div><strong>User:</strong> ${escapeHtml(userId)}</div>
        <div><strong>Total snapshots:</strong> ${rows.length}</div>
        <div><strong>Latest event:</strong> ${escapeHtml(latest.eventType || "-")}</div>
        <div><strong>Latest export:</strong> ${escapeHtml(formatIso(latest.exportedAt))}</div>
        <div><strong>Latest tx count:</strong> ${escapeHtml(txCount)}</div>
        <div><strong>Recovery hash:</strong> ${latestHash ? "Present" : '<span class="text-danger">Missing</span>'}</div>
        ${autoSyncHtml}
      `;
      upsertCloudStatusModal(html);
    } catch (err) {
      upsertCloudStatusModal(`<div class="text-danger">Failed to load cloud status: ${escapeHtml(err?.message || err)}</div>`);
    } finally {
      appHideActionProgress();
      btn.disabled = false;
    }
  });

  host.prepend(btn);
}

function wireRotatePasskeyButton() {
  const btn = document.getElementById("rotate-passkey-btn");
  if (!btn || btn.dataset.wired === "1") return;
  btn.dataset.wired = "1";

  btn.addEventListener("click", async () => {
    const userId = String(localStorage.getItem("activeUserId") || "").trim();
    if (!userId) {
      showToast("No active user found. Login again.", "error");
      return;
    }

    const current = await appPromptDialog({
      title: "Change Password",
      message: "Enter current password to verify identity.",
      placeholder: "Current password",
      inputType: "password",
      required: true,
      minLength: 8
    });
    if (current === null) return;
    const currentKey = String(current || "").trim();
    if (!currentKey) {
      showToast("Current password is required", "error");
      return;
    }

    const next = await appPromptDialog({
      title: "New Password",
      message: "Enter new password (leave empty to auto-generate).",
      placeholder: "New password",
      inputType: "password",
      required: false,
      minLength: 8
    });
    if (next === null) return;
    const nextKey = String(next || "").trim();

    btn.disabled = true;
    appShowLoading("Updating password...");
    try {
      const mod = await import("../client/profileManager.js");
      const res = await mod.rotateRecoveryKey(currentKey, nextKey || undefined);
      if (!res || !res.ok) throw new Error("Passkey update failed");

      const finalKey = String(res.recoveryKey || "");
      if (!finalKey) throw new Error("New password not generated");

      const copied = await navigator.clipboard.writeText(finalKey).then(() => true).catch(() => false);
      const msg = copied
        ? "Password changed and copied to clipboard. Save it now."
        : "Password changed. Copy and save the new password now.";
      showToast(msg, "success");
      appHideLoading();
      await appAlertDialog("New Password (save this now):\n\n" + finalKey, { title: "Password Updated", okText: "Done" });
    } catch (err) {
      showToast("Change key failed: " + (err.message || err), "error");
      console.error("rotate passkey error", err);
    } finally {
      appHideLoading();
      btn.disabled = false;
    }
  });
}

function initSharedUi() {
  setupBottomNav();
  maybeRunAutoCloudSync().catch(() => {});
  addCloudHeaderButton();
  wireRotatePasskeyButton();
  const settingsExportBtn = document.getElementById("settingsExportBtn");
  if (settingsExportBtn && settingsExportBtn.dataset.wired !== "1") {
    settingsExportBtn.dataset.wired = "1";
    settingsExportBtn.addEventListener("click", exportAllDataCsv);
  }
  const autoSyncNowBtn = document.getElementById("autoSyncNowBtn");
  if (autoSyncNowBtn && autoSyncNowBtn.dataset.wired !== "1") {
    autoSyncNowBtn.dataset.wired = "1";
    autoSyncNowBtn.addEventListener("click", async () => {
      autoSyncNowBtn.disabled = true;
      appShowLoading("Running cloud auto sync...");
      try {
        const res = await maybeRunAutoCloudSync(true);
        if (res?.ok) showToast("Auto sync report updated", "success");
        else showToast("Auto sync failed: " + (res?.error || "unknown"), "error");
      } finally {
        appHideLoading();
        autoSyncNowBtn.disabled = false;
      }
    });
  }
  const livePriceRefreshNowBtn = document.getElementById("livePriceRefreshNowBtn");
  if (livePriceRefreshNowBtn && livePriceRefreshNowBtn.dataset.wired !== "1") {
    livePriceRefreshNowBtn.dataset.wired = "1";
    livePriceRefreshNowBtn.addEventListener("click", async () => {
      livePriceRefreshNowBtn.disabled = true;
      appShowLoading("Refreshing live prices...");
      try {
        if (typeof window.refreshLivePrices === "function") {
          await window.refreshLivePrices({ force: true, debug: false });
          showToast("Live prices refreshed", "success");
        } else {
          showToast("Live price module is not loaded on this page", "error");
        }
      } catch (err) {
        showToast("Live price refresh failed: " + (err?.message || err), "error");
      } finally {
        appHideLoading();
        livePriceRefreshNowBtn.disabled = false;
      }
    });
  }
  try {
    const raw = localStorage.getItem("lastCloudPruneDebug");
    if (raw) {
      const parsed = JSON.parse(raw);
      console.group("[Prune Debug] Last Logout");
      console.log(parsed);
      console.groupEnd();
      const hasNewBackend = !!(parsed && parsed.scriptTag && parsed.prune);
      if (hasNewBackend) {
        showToast("Last prune debug is available in console", "info");
      } else {
        showToast("Old cloud deployment detected. Check console for Apps Script URL and redeploy.", "error");
      }
      localStorage.removeItem("lastCloudPruneDebug");
    }
  } catch (e) {}
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSharedUi);
} else {
  initSharedUi();
}

/* ================= SEED DEFAULT SETTINGS ================= */
function seedSettings() {
  return new Promise(resolve => {
    const tx = db.transaction("settings", "readwrite");
    const store = tx.objectStore("settings");

    store.get(1).onsuccess = e => {
      if (!e.target.result) {
        store.add({
          id: 1,
          brokerageBuyPct: 0.15,
          brokerageSellPct: 0.15,
          dpCharge: 50,

          portfolioSize: 100000,
          maxAllocationPct: 25,

          avgLevel1Pct: 7,
          avgLevel2Pct: 12,
          livePriceRefreshSec: 60,

          fdRatePct: 6.5,        // ✅ NEW
          inflationRatePct: 6.0, // ✅ NEW

          sellTargetPct: 15,
          stopLossPct: 8,
          minHoldDaysTrim: 20
        });
      }
    };

    tx.oncomplete = resolve;
  });
}

/* ================= LOAD SETTINGS ================= */
function loadSettings() {
  const tx = db.transaction("settings", "readonly");
  const store = tx.objectStore("settings");

  store.get(1).onsuccess = e => {
    const s = e.target.result;
    if (!s) return;

    document.getElementById("buyBrokeragePct").value = s.brokerageBuyPct;
    document.getElementById("sellBrokeragePct").value = s.brokerageSellPct;
    document.getElementById("dpCharge").value = s.dpCharge;

    document.getElementById("portfolioSize").value = s.portfolioSize;
    document.getElementById("maxAllocationPct").value = s.maxAllocationPct;

    document.getElementById("avgLevel1Pct").value = s.avgLevel1Pct;
    document.getElementById("avgLevel2Pct").value = s.avgLevel2Pct;
    document.getElementById("livePriceRefreshSec").value = Math.max(60, Number(s.livePriceRefreshSec || 60));

    document.getElementById("fdRatePct").value = s.fdRatePct;           // ✅ NEW
    document.getElementById("inflationRatePct").value = s.inflationRatePct; // ✅ NEW
    document.getElementById("sellTargetPct").value = s.sellTargetPct ?? 15;
    document.getElementById("stopLossPct").value = s.stopLossPct ?? 8;
    document.getElementById("minHoldDaysTrim").value = s.minHoldDaysTrim ?? 20;
  };
}

/* ================= SAVE SETTINGS ================= */
function saveSettings() {
  const data = {
    id: 1,
    brokerageBuyPct: Number(buyBrokeragePct.value),
    brokerageSellPct: Number(sellBrokeragePct.value),
    dpCharge: Number(dpCharge.value),

    portfolioSize: Number(portfolioSize.value),
    maxAllocationPct: Number(maxAllocationPct.value),

    avgLevel1Pct: Number(avgLevel1Pct.value),
    avgLevel2Pct: Number(avgLevel2Pct.value),
    livePriceRefreshSec: Math.max(60, Number(livePriceRefreshSec.value || 60)),

    fdRatePct: Number(fdRatePct.value),               // ✅ NEW
    inflationRatePct: Number(inflationRatePct.value), // ✅ NEW

    sellTargetPct: Number(sellTargetPct.value),
    stopLossPct: Number(stopLossPct.value),
    minHoldDaysTrim: Number(minHoldDaysTrim.value)
  };

  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put(data);

  tx.oncomplete = () => {
    showToast("Settings saved successfully");
    try {
      localStorage.setItem(SETTINGS_LIVE_PRICE_BUMP_KEY, String(Date.now()));
      window.dispatchEvent(new CustomEvent("live-price-settings-updated"));
    } catch (e) {}
    if (typeof window.initLivePrices === "function") {
      window.initLivePrices();
    }
  };
}

/* ================= READ SETTINGS HELPER ================= */
function getSettings(cb) {
  const tx = db.transaction("settings", "readonly");
  tx.objectStore("settings").get(1).onsuccess = e => cb(e.target.result);
}

/* =========================================================
   CSV EXPORT / IMPORT
   ========================================================= */

/* ---------------- EXPORT ---------------- */
function exportCSV() {
  // Previously exported CSV from IndexedDB. Now replaced by cloud backup.
  appAlertDialog('Export to CSV is deprecated. Use Cloud Backup (Sync to Cloud) in the Data Management section to back up your profile to Google Sheets.');
  // If you still need a local CSV export for offline purposes, re-enable the legacy exporter here.
}

/* ---------------- IMPORT ---------------- */
function importCSV() {
  // Previously imported CSV into IndexedDB. Now use Cloud Restore instead.
  appAlertDialog('Import from CSV is disabled. Use Restore from Cloud (after authenticating with your User ID and Password) to restore your data.');
  // If you still need CSV import, implement a careful import routine that validates and maps fields.
}

// Keep functions global for Settings.html onclick handlers
window.exportCSV = exportCSV;
window.importCSV = importCSV;


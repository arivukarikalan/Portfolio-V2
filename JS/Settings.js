/* =========================================================
   FILE: settings.js
   PURPOSE:
   - Centralised application settings
   ========================================================= */

/* ================= UX HELPERS ================= */
function showToast(message, type = "success") {
  const text = (message || "").trim();
  if (!text) return;

  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-host";
    document.body.appendChild(host);
  }

  const iconMap = {
    success: "bi-check2-circle",
    error: "bi-exclamation-octagon",
    info: "bi-info-circle"
  };
  const iconClass = iconMap[type] || iconMap.info;

  const toast = document.createElement("div");
  toast.className = `app-toast ${type}`;
  toast.innerHTML = `
    <div class="app-toast-inner">
      <span class="app-toast-icon"><i class="bi ${iconClass}"></i></span>
      <span class="app-toast-text">${text}</span>
    </div>
    <span class="app-toast-progress"></span>
  `;
  host.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hide");
    setTimeout(() => toast.remove(), 220);
  }, 2200);
}

function setupBottomNav() {
  const nav = document.querySelector(".bottom-nav");
  if (!nav) return;

  const links = Array.from(nav.querySelectorAll("a"));
  if (links.length <= 5) return;

  const current = (location.pathname.split("/").pop() || "index.html").toLowerCase();

  let hideHref = "analytics.html";
  if (current === "analytics.html") hideHref = "insights.html";
  if (current === "insights.html") hideHref = "analytics.html";

  const toHide = links.find(
    a => (a.getAttribute("href") || "").toLowerCase() === hideHref
  );

  if (toHide) {
    toHide.style.display = "none";
    nav.classList.add("nav-five");
  }
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

function initSharedUi() {
  setupBottomNav();
  maybeShowWeeklyBackupReminder();
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

          fdRatePct: 6.5,        // ✅ NEW
          inflationRatePct: 6.0  // ✅ NEW
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

    document.getElementById("fdRatePct").value = s.fdRatePct;           // ✅ NEW
    document.getElementById("inflationRatePct").value = s.inflationRatePct; // ✅ NEW
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

    fdRatePct: Number(fdRatePct.value),               // ✅ NEW
    inflationRatePct: Number(inflationRatePct.value)  // ✅ NEW
  };

  const tx = db.transaction("settings", "readwrite");
  tx.objectStore("settings").put(data);

  tx.oncomplete = () => {
    showToast("Settings saved successfully");
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
  if (!db) {
    showToast("Database still loading. Please try again.", "info");
    return;
  }

  Promise.all([
    getAllFromStore("settings"),
    getAllFromStore("transactions"),
    getAllFromStoreSafe("debt_borrows"),
    getAllFromStoreSafe("debt_repays")
  ]).then(([settings, transactions, debtBorrows, debtRepays]) => {

    let csv = "#PORTFOLIO_TRACKER_EXPORT_V1\n\n";

    /* SETTINGS */
    csv += "#SETTINGS\n";
    csv += "id,brokerageBuyPct,brokerageSellPct,dpCharge,portfolioSize,maxAllocationPct,avgLevel1Pct,avgLevel2Pct,fdRatePct,inflationRatePct\n";

    const s = settings[0] || {
      id: 1,
      brokerageBuyPct: 0.15,
      brokerageSellPct: 0.15,
      dpCharge: 50,
      portfolioSize: 100000,
      maxAllocationPct: 25,
      avgLevel1Pct: 7,
      avgLevel2Pct: 12,
      fdRatePct: 6.5,
      inflationRatePct: 6
    };
    csv += `${csvJoin([s.id, s.brokerageBuyPct, s.brokerageSellPct, s.dpCharge, s.portfolioSize, s.maxAllocationPct, s.avgLevel1Pct, s.avgLevel2Pct, s.fdRatePct, s.inflationRatePct])}\n\n`;

    /* TRANSACTIONS */
    csv += "#TRANSACTIONS\n";
    csv += "id,date,stock,type,qty,price,brokerage,dpCharge\n";

    transactions.forEach(t => {
      csv += `${csvJoin([t.id, t.date, t.stock, t.type, t.qty, t.price, t.brokerage, t.dpCharge])}\n`;
    });

    csv += "\n#DEBT_BORROWS\n";
    csv += "id,date,lender,category,amount,interestPct,note,createdAt\n";
    debtBorrows.forEach(b => {
      csv += `${csvJoin([b.id, b.date, b.lender, b.category, b.amount, b.interestPct, b.note, b.createdAt])}\n`;
    });

    csv += "\n#DEBT_REPAYS\n";
    csv += "id,date,lender,amount,note,createdAt\n";
    debtRepays.forEach(r => {
      csv += `${csvJoin([r.id, r.date, r.lender, r.amount, r.note, r.createdAt])}\n`;
    });

    downloadCSV(csv);
    markBackupDone();
    showToast("CSV exported successfully");
  });
}

/* ---------------- HELPERS ---------------- */
function getAllFromStore(storeName) {
  return new Promise(resolve => {
    db.transaction(storeName, "readonly")
      .objectStore(storeName)
      .getAll().onsuccess = e => resolve(e.target.result);
  });
}

function getAllFromStoreSafe(storeName) {
  return new Promise(resolve => {
    try {
      db.transaction(storeName, "readonly")
        .objectStore(storeName)
        .getAll().onsuccess = e => resolve(e.target.result || []);
    } catch (_) {
      resolve([]);
    }
  });
}

function csvCell(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function csvJoin(values) {
  return values.map(csvCell).join(",");
}

function parseCsvRow(line) {
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

function downloadCSV(content) {
  const blob = new Blob([content], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = "portfolio_backup.csv";
  a.click();

  URL.revokeObjectURL(url);
}

/* ---------------- IMPORT ---------------- */
function importCSV() {
  if (!db) {
    showToast("Database still loading. Please try again.", "info");
    return;
  }

  const file = document.getElementById("importFile").files[0];
  if (!file) {
    showToast("Please select a CSV file first", "error");
    return;
  }

  if (!confirm("This will overwrite all existing data. Continue?")) return;

  const reader = new FileReader();
  reader.onload = e => processCSV(e.target.result);
  reader.readAsText(file);
}

function processCSV(text) {
  const lines = text.split(/\r?\n/);
  let mode = "";

  const settings = [];
  const transactions = [];
  const debtBorrows = [];
  const debtRepays = [];

  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    if (line.startsWith("#")) {
      if (line === "#SETTINGS") mode = "SETTINGS";
      else if (line === "#TRANSACTIONS") mode = "TRANSACTIONS";
      else if (line === "#DEBT_BORROWS") mode = "DEBT_BORROWS";
      else if (line === "#DEBT_REPAYS") mode = "DEBT_REPAYS";
      return;
    }

    if (line.startsWith("id,")) return;

    const cols = parseCsvRow(line);

    if (mode === "SETTINGS") {
      settings.push({
        id: Number(cols[0]),
        brokerageBuyPct: Number(cols[1]),
        brokerageSellPct: Number(cols[2]),
        dpCharge: Number(cols[3]),
        portfolioSize: Number(cols[4]),
        maxAllocationPct: Number(cols[5]),
        avgLevel1Pct: Number(cols[6]),
        avgLevel2Pct: Number(cols[7]),
        fdRatePct: Number(cols[8]),
        inflationRatePct: Number(cols[9])
      });
    }

    if (mode === "TRANSACTIONS") {
      transactions.push({
        id: Number(cols[0]),
        date: cols[1],
        stock: cols[2],
        type: cols[3],
        qty: Number(cols[4]),
        price: Number(cols[5]),
        brokerage: Number(cols[6]),
        dpCharge: Number(cols[7])
      });
    }

    if (mode === "DEBT_BORROWS") {
      debtBorrows.push({
        id: Number(cols[0]),
        date: cols[1],
        lender: cols[2],
        category: cols[3],
        amount: Number(cols[4]),
        interestPct: Number(cols[5] || 0),
        note: cols[6] || "",
        createdAt: cols[7] || ""
      });
    }

    if (mode === "DEBT_REPAYS") {
      debtRepays.push({
        id: Number(cols[0]),
        date: cols[1],
        lender: cols[2],
        amount: Number(cols[3]),
        note: cols[4] || "",
        createdAt: cols[5] || ""
      });
    }
  });

  restoreDatabase(settings[0], transactions, debtBorrows, debtRepays);
}

/* ---------------- RESTORE ---------------- */
function restoreDatabase(setting, transactions, debtBorrows = [], debtRepays = []) {
  const tx = db.transaction(["settings", "transactions", "debt_borrows", "debt_repays"], "readwrite");

  tx.objectStore("settings").clear();
  tx.objectStore("transactions").clear();
  tx.objectStore("debt_borrows").clear();
  tx.objectStore("debt_repays").clear();

  tx.oncomplete = () => {
    const tx2 = db.transaction(["settings", "transactions", "debt_borrows", "debt_repays"], "readwrite");

    tx2.objectStore("settings").add(setting);
    transactions.forEach(t => tx2.objectStore("transactions").add(t));
    debtBorrows.forEach(b => tx2.objectStore("debt_borrows").add(b));
    debtRepays.forEach(r => tx2.objectStore("debt_repays").add(r));

    tx2.oncomplete = () => {
      showToast("Import completed. Reloading data...");
      setTimeout(() => location.reload(), 800);
    };
  };
}

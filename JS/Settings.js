/* =========================================================
   FILE: settings.js
   PURPOSE:
   - Centralised application settings
   ========================================================= */

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
    alert("Settings saved successfully ✅");
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
  Promise.all([
    getAllFromStore("settings"),
    getAllFromStore("transactions")
  ]).then(([settings, transactions]) => {

    let csv = "#PORTFOLIO_TRACKER_EXPORT_V1\n\n";

    /* SETTINGS */
    csv += "#SETTINGS\n";
    csv += "id,brokerageBuyPct,brokerageSellPct,dpCharge,portfolioSize,maxAllocationPct,avgLevel1Pct,avgLevel2Pct,fdRatePct,inflationRatePct\n";

    const s = settings[0];
    csv += `${s.id},${s.brokerageBuyPct},${s.brokerageSellPct},${s.dpCharge},${s.portfolioSize},${s.maxAllocationPct},${s.avgLevel1Pct},${s.avgLevel2Pct},${s.fdRatePct},${s.inflationRatePct}\n\n`;

    /* TRANSACTIONS */
    csv += "#TRANSACTIONS\n";
    csv += "id,date,stock,type,qty,price,brokerage,dpCharge\n";

    transactions.forEach(t => {
      csv += `${t.id},${t.date},${t.stock},${t.type},${t.qty},${t.price},${t.brokerage},${t.dpCharge}\n`;
    });

    downloadCSV(csv);
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
  const file = document.getElementById("importFile").files[0];
  if (!file) return alert("Select a CSV file");

  if (!confirm("This will ERASE existing data. Continue?")) return;

  const reader = new FileReader();
  reader.onload = e => processCSV(e.target.result);
  reader.readAsText(file);
}

function processCSV(text) {
  const lines = text.split(/\r?\n/);
  let mode = "";

  const settings = [];
  const transactions = [];

  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    if (line.startsWith("#")) {
      if (line === "#SETTINGS") mode = "SETTINGS";
      else if (line === "#TRANSACTIONS") mode = "TRANSACTIONS";
      return;
    }

    if (line.startsWith("id,")) return;

    const cols = line.split(",");

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
  });

  restoreDatabase(settings[0], transactions);
}

/* ---------------- RESTORE ---------------- */
function restoreDatabase(setting, transactions) {
  const tx = db.transaction(["settings", "transactions"], "readwrite");

  tx.objectStore("settings").clear();
  tx.objectStore("transactions").clear();

  tx.oncomplete = () => {
    const tx2 = db.transaction(["settings", "transactions"], "readwrite");

    tx2.objectStore("settings").add(setting);
    transactions.forEach(t => tx2.objectStore("transactions").add(t));

    tx2.oncomplete = () => {
      alert("Import completed successfully");
      location.reload();
    };
  };
}
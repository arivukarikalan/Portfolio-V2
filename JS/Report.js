let reportRows = [];

function reportTxnBrokerage(txn, settings) {
  const tradeValue = Number(txn.qty) * Number(txn.price);
  if (txn.type === "BUY") {
    return (Number(settings.brokerageBuyPct || 0) / 100) * tradeValue;
  }
  return (Number(settings.brokerageSellPct || 0) / 100) * tradeValue + Number(settings.dpCharge || 0);
}

function txnDateTimeIso(txn) {
  if (txn.createdAt) return txn.createdAt;
  if (txn.updatedAt) return txn.updatedAt;
  return `${txn.date}T00:00:00`;
}

function toDateValue(dateObj) {
  const pad = n => String(n).padStart(2, "0");
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
}

function formatDateOnly(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString();
}

function loadReportPage() {
  const fromEl = document.getElementById("repFrom");
  const toEl = document.getElementById("repTo");
  const stockEl = document.getElementById("repStock");
  if (!fromEl || !toEl || !stockEl) return;

  const now = new Date();
  const past = new Date();
  past.setMonth(now.getMonth() - 3);
  fromEl.value = toDateValue(past);
  toEl.value = toDateValue(now);

  ["input", "change"].forEach(evt => {
    fromEl.addEventListener(evt, renderReportRows);
    toEl.addEventListener(evt, renderReportRows);
    stockEl.addEventListener(evt, renderReportRows);
  });

  refreshReportData();
}

function refreshReportData() {
  getSettings(settings => {
    db.transaction("transactions", "readonly")
      .objectStore("transactions")
      .getAll().onsuccess = e => {
        const data = e.target.result || [];
        reportRows = data.map(t => ({
          ...t,
          dateTime: txnDateTimeIso(t),
          brokerageCalc: reportTxnBrokerage(t, settings)
        }))
          .sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime));

        renderReportRows();
      };
  });
}

function renderReportRows() {
  const body = document.getElementById("reportBody");
  const summary = document.getElementById("reportSummary");
  const fromEl = document.getElementById("repFrom");
  const toEl = document.getElementById("repTo");
  const stockEl = document.getElementById("repStock");
  if (!body || !summary || !fromEl || !toEl || !stockEl) return;

  const from = fromEl.value ? new Date(`${fromEl.value}T00:00:00`).getTime() : null;
  const to = toEl.value ? new Date(`${toEl.value}T23:59:59`).getTime() : null;
  const stock = stockEl.value.trim().toLowerCase();

  const filtered = reportRows.filter(r => {
    const t = new Date(r.dateTime).getTime();
    if (from != null && t < from) return false;
    if (to != null && t > to) return false;
    if (stock && !String(r.stock || "").toLowerCase().includes(stock)) return false;
    return true;
  });

  body.innerHTML = filtered.length
    ? filtered.map(r => `
        <tr>
          <td>${formatDateOnly(r.dateTime)}</td>
          <td>${r.stock}</td>
          <td>${r.type}</td>
          <td class="text-end">${r.qty}</td>
          <td class="text-end">₹${Number(r.price).toFixed(2)}</td>
          <td class="text-end">₹${Number(r.brokerageCalc).toFixed(2)}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="6" class="text-center text-muted">No matching transactions</td></tr>`;

  const totalBrokerage = filtered.reduce((a, r) => a + Number(r.brokerageCalc || 0), 0);
  summary.textContent = `Rows: ${filtered.length} | Total Brokerage: ₹${totalBrokerage.toFixed(2)}`;
}

function exportReportCSV() {
  const body = document.getElementById("reportBody");
  if (!body) return;

  const from = document.getElementById("repFrom")?.value ? new Date(`${document.getElementById("repFrom").value}T00:00:00`).getTime() : null;
  const to = document.getElementById("repTo")?.value ? new Date(`${document.getElementById("repTo").value}T23:59:59`).getTime() : null;
  const stock = document.getElementById("repStock")?.value.trim().toLowerCase() || "";

  const filtered = reportRows.filter(r => {
    const t = new Date(r.dateTime).getTime();
    if (from != null && t < from) return false;
    if (to != null && t > to) return false;
    if (stock && !String(r.stock || "").toLowerCase().includes(stock)) return false;
    return true;
  });

  let csv = "date,stock,type,qty,price,brokerage\n";
  filtered.forEach(r => {
    csv += `${formatDateOnly(r.dateTime)},${r.stock},${r.type},${r.qty},${Number(r.price).toFixed(2)},${Number(r.brokerageCalc).toFixed(2)}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "transaction_report.csv";
  a.click();
  URL.revokeObjectURL(url);

  if (typeof showToast === "function") {
    showToast("Report CSV exported successfully");
  }
}

let debtCombinedTxns = [];

function debtToday() {
  return new Date().toISOString().split("T")[0];
}

function debtLoadArray(storeName) {
  return new Promise(resolve => {
    db.transaction(storeName, "readonly").objectStore(storeName).getAll().onsuccess = e => {
      resolve(e.target.result || []);
    };
  });
}

function debtCsvCell(value) {
  const v = value == null ? "" : String(value);
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function debtCsvJoin(values) {
  return values.map(debtCsvCell).join(",");
}

function debtParseCsvRow(line) {
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

function debtSaveLocalPlan() {
  localStorage.setItem("debt_monthly_budget", document.getElementById("monthlyDebtBudget")?.value || "");
  localStorage.setItem("debt_invest_floor", document.getElementById("monthlyInvestFloor")?.value || "");
  renderDebtData();
}

async function debtExportCSV() {
  const [borrows, repays] = await Promise.all([
    debtLoadArray("debt_borrows"),
    debtLoadArray("debt_repays")
  ]);

  let csv = "#DEBT_TRACKER_EXPORT_V1\n\n";
  csv += "#DEBT_BORROWS\n";
  csv += "id,date,lender,category,amount,interestPct,note,createdAt\n";
  borrows.forEach(b => {
    csv += `${debtCsvJoin([b.id, b.date, b.lender, b.category, b.amount, b.interestPct, b.note, b.createdAt])}\n`;
  });

  csv += "\n#DEBT_REPAYS\n";
  csv += "id,date,lender,amount,note,createdAt\n";
  repays.forEach(r => {
    csv += `${debtCsvJoin([r.id, r.date, r.lender, r.amount, r.note, r.createdAt])}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `debt_backup_${debtToday()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  if (typeof showToast === "function") showToast("Debt CSV exported successfully");
}

async function debtImportCSV() {
  const fileInput = document.getElementById("debtImportFile");
  const file = fileInput?.files?.[0];
  if (!file) {
    if (typeof showToast === "function") showToast("Please select a debt CSV file first", "error");
    return;
  }
  const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
    ? await window.appConfirmDialog("This will overwrite debt borrowing and repayment records. Continue?", { title: "Confirm Import", okText: "Overwrite" })
    : window.confirm("This will overwrite debt borrowing and repayment records. Continue?");
  if (!ok) return;

  const reader = new FileReader();
  reader.onload = e => debtProcessCSV(String(e.target?.result || ""));
  reader.readAsText(file);
}

function debtProcessCSV(text) {
  const lines = text.split(/\r?\n/);
  let mode = "";
  const borrows = [];
  const repays = [];

  lines.forEach(raw => {
    const line = raw.trim();
    if (!line) return;

    if (line.startsWith("#")) {
      if (line === "#DEBT_BORROWS") mode = "DEBT_BORROWS";
      else if (line === "#DEBT_REPAYS") mode = "DEBT_REPAYS";
      return;
    }

    if (line.toLowerCase().startsWith("id,")) return;
    const cols = debtParseCsvRow(line);

    if (mode === "DEBT_BORROWS") {
      borrows.push({
        id: Number(cols[0]),
        date: cols[1] || "",
        lender: cols[2] || "",
        category: cols[3] || "Other",
        amount: Number(cols[4] || 0),
        interestPct: Number(cols[5] || 0),
        note: cols[6] || "",
        createdAt: cols[7] || ""
      });
    }

    if (mode === "DEBT_REPAYS") {
      repays.push({
        id: Number(cols[0]),
        date: cols[1] || "",
        lender: cols[2] || "",
        amount: Number(cols[3] || 0),
        note: cols[4] || "",
        createdAt: cols[5] || ""
      });
    }
  });

  const tx = db.transaction(["debt_borrows", "debt_repays"], "readwrite");
  tx.objectStore("debt_borrows").clear();
  tx.objectStore("debt_repays").clear();

  tx.oncomplete = () => {
    const tx2 = db.transaction(["debt_borrows", "debt_repays"], "readwrite");
    borrows.forEach(b => tx2.objectStore("debt_borrows").add(b));
    repays.forEach(r => tx2.objectStore("debt_repays").add(r));
    tx2.oncomplete = () => {
      if (typeof showToast === "function") showToast("Debt CSV imported successfully");
      renderDebtData();
      const fileInput = document.getElementById("debtImportFile");
      if (fileInput) fileInput.value = "";
    };
  };
}

function buildDebtTransactions(borrows, repays) {
  const borrowRows = borrows.map(b => ({
    date: b.date || "",
    lender: String(b.lender || "").trim(),
    type: "BORROW",
    amount: Number(b.amount || 0),
    interestPct: Number(b.interestPct || 0),
    category: b.category || "",
    note: b.note || ""
  }));

  const repayRows = repays.map(r => ({
    date: r.date || "",
    lender: String(r.lender || "").trim(),
    type: "REPAY",
    amount: Number(r.amount || 0),
    interestPct: 0,
    category: "",
    note: r.note || ""
  }));

  return [...borrowRows, ...repayRows].sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderDebtTxnTable() {
  const tbody = document.getElementById("debtTxnTableBody");
  if (!tbody) return;

  const type = document.getElementById("debtTxnType")?.value || "ALL";
  const from = document.getElementById("debtTxnFrom")?.value || "";
  const to = document.getElementById("debtTxnTo")?.value || "";
  const lenderFilter = (document.getElementById("debtTxnLender")?.value || "").trim().toLowerCase();

  const filtered = debtCombinedTxns.filter(t => {
    if (type !== "ALL" && t.type !== type) return false;
    if (from && new Date(t.date) < new Date(from)) return false;
    if (to && new Date(t.date) > new Date(to)) return false;
    if (lenderFilter && !t.lender.toLowerCase().includes(lenderFilter)) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No debt transactions</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(t => `
    <tr>
      <td>${t.date}</td>
      <td>${t.lender || "-"}</td>
      <td><span class="badge ${t.type === "BORROW" ? "text-bg-warning" : "text-bg-success"}">${t.type}</span></td>
      <td class="text-end">₹${t.amount.toFixed(2)}</td>
    </tr>
  `).join("");
}

async function renderDebtData() {
  const [borrows, repays] = await Promise.all([
    debtLoadArray("debt_borrows"),
    debtLoadArray("debt_repays")
  ]);

  debtCombinedTxns = buildDebtTransactions(borrows, repays);
  renderDebtTxnTable();

  const map = {};
  borrows.forEach(b => {
    const key = String(b.lender || "").trim().toUpperCase();
    if (!key) return;
    map[key] ??= { lender: b.lender, borrowed: 0, repaid: 0, interestMax: 0, earliestDate: b.date };
    map[key].borrowed += Number(b.amount || 0);
    map[key].interestMax = Math.max(map[key].interestMax, Number(b.interestPct || 0));
    if (!map[key].earliestDate || (b.date && b.date < map[key].earliestDate)) map[key].earliestDate = b.date;
  });

  repays.forEach(r => {
    const key = String(r.lender || "").trim().toUpperCase();
    if (!key) return;
    map[key] ??= { lender: r.lender, borrowed: 0, repaid: 0, interestMax: 0, earliestDate: r.date };
    map[key].repaid += Number(r.amount || 0);
    if (!map[key].earliestDate || (r.date && r.date < map[key].earliestDate)) map[key].earliestDate = r.date;
  });

  const rows = Object.values(map)
    .map(x => ({ ...x, remaining: Math.max(0, x.borrowed - x.repaid) }))
    .filter(x => x.borrowed > 0 || x.repaid > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const totalBorrowed = rows.reduce((a, r) => a + r.borrowed, 0);
  const totalRepaid = rows.reduce((a, r) => a + r.repaid, 0);
  const outstanding = rows.reduce((a, r) => a + r.remaining, 0);

  const summary = document.getElementById("debtSummary");
  if (summary) {
    summary.innerHTML = `
      <div class="stat-card"><div class="stat-label">Total Borrowed</div><div class="stat-value">₹${totalBorrowed.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Repaid</div><div class="stat-value">₹${totalRepaid.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">₹${outstanding.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Lenders</div><div class="stat-value">${rows.length}</div></div>
    `;
  }

  const debtList = document.getElementById("debtList");
  if (debtList) {
    debtList.innerHTML = rows.length ? rows.map(r => `
      <div class="txn-card">
        <div class="split-row">
          <div class="left-col">
            <div class="txn-name">${r.lender}</div>
            <div class="tiny-label">Borrowed: ₹${r.borrowed.toFixed(2)} | Repaid: ₹${r.repaid.toFixed(2)}</div>
          </div>
          <div class="right-col">
            <div class="metric-strong ${r.remaining > 0 ? "loss" : "profit"}">₹${r.remaining.toFixed(2)}</div>
            <div class="tiny-label">Outstanding</div>
          </div>
        </div>
      </div>
    `).join("") : `<div class="txn-card text-center text-muted">No debt records</div>`;
  }

  const lenderOptions = document.getElementById("lenderOptions");
  if (lenderOptions) lenderOptions.innerHTML = rows.map(r => `<option value="${r.lender}"></option>`).join("");

  const planEl = document.getElementById("debtPlan");
  const monthlyBudget = Number(localStorage.getItem("debt_monthly_budget") || 0);
  const investFloor = Number(localStorage.getItem("debt_invest_floor") || 0);
  const available = Math.max(0, monthlyBudget - investFloor);

  if (planEl) {
    if (!outstanding || !available) {
      planEl.innerHTML = `<div class="tiny-label">Set monthly budget and investment floor to see closure estimate.</div>`;
    } else {
      const months = Math.ceil(outstanding / available);
      const priority = rows
        .filter(r => r.remaining > 0)
        .sort((a, b) => (b.interestMax - a.interestMax) || (a.earliestDate || "").localeCompare(b.earliestDate || ""))
        .slice(0, 3);

      planEl.innerHTML = `
        <div class="txn-card">
          <div class="tiny-label">Available for debt/month: ₹${available.toFixed(2)} | Estimated closure: ${months} month(s)</div>
          <div class="status-inline mt-2">
            ${priority.map((p, i) => `<span class="status-pill-mini bad">${i + 1}. ${p.lender} (₹${p.remaining.toFixed(0)})</span>`).join("")}
          </div>
        </div>
      `;
    }
  }
}

function debtAddBorrow(e) {
  e.preventDefault();
  const lender = (document.getElementById("borLender")?.value || "").trim();
  const amount = Number(document.getElementById("borAmount")?.value || 0);
  if (!lender || amount <= 0) return;

  const data = {
    date: document.getElementById("borDate")?.value || debtToday(),
    lender,
    category: document.getElementById("borCategory")?.value || "Other",
    amount,
    interestPct: Number(document.getElementById("borInterest")?.value || 0),
    note: document.getElementById("borNote")?.value || "",
    createdAt: new Date().toISOString()
  };

  const tx = db.transaction("debt_borrows", "readwrite");
  tx.objectStore("debt_borrows").add(data);
  tx.oncomplete = () => {
    document.getElementById("borrowForm")?.reset();
    document.getElementById("borDate").value = debtToday();
    if (typeof showToast === "function") showToast("Borrowing saved");
    renderDebtData();
  };
}

function debtAddRepay(e) {
  e.preventDefault();
  const lender = (document.getElementById("repLender")?.value || "").trim();
  const amount = Number(document.getElementById("repAmount")?.value || 0);
  if (!lender || amount <= 0) return;

  const data = {
    date: document.getElementById("repDate")?.value || debtToday(),
    lender,
    amount,
    note: document.getElementById("repNote")?.value || "",
    createdAt: new Date().toISOString()
  };

  const tx = db.transaction("debt_repays", "readwrite");
  tx.objectStore("debt_repays").add(data);
  tx.oncomplete = () => {
    document.getElementById("repayForm")?.reset();
    document.getElementById("repDate").value = debtToday();
    if (typeof showToast === "function") showToast("Repayment saved");
    renderDebtData();
  };
}

function bindDebtTxnFilters() {
  ["debtTxnType", "debtTxnFrom", "debtTxnTo", "debtTxnLender"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", renderDebtTxnTable);
    el.addEventListener("change", renderDebtTxnTable);
  });
}

function loadDebtPage() {
  const borDate = document.getElementById("borDate");
  const repDate = document.getElementById("repDate");
  if (borDate) borDate.value = debtToday();
  if (repDate) repDate.value = debtToday();

  const monthlyBudget = document.getElementById("monthlyDebtBudget");
  const investFloor = document.getElementById("monthlyInvestFloor");
  if (monthlyBudget) monthlyBudget.value = localStorage.getItem("debt_monthly_budget") || "";
  if (investFloor) investFloor.value = localStorage.getItem("debt_invest_floor") || "";

  const exportBtn = document.getElementById("debtExportBtn");
  exportBtn?.addEventListener("click", debtExportCSV);

  bindDebtTxnFilters();

  document.getElementById("borrowForm")?.addEventListener("submit", debtAddBorrow);
  document.getElementById("repayForm")?.addEventListener("submit", debtAddRepay);
  monthlyBudget?.addEventListener("input", debtSaveLocalPlan);
  investFloor?.addEventListener("input", debtSaveLocalPlan);

  renderDebtData();
}

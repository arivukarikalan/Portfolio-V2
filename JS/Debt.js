let debtCombinedTxns = [];

function debtToday() {
  return new Date().toISOString().split("T")[0];
}

function debtLoadArray(storeName) {
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

function parseMaybeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function normalizeLegacyBorrowRow(r) {
  if (!r) return null;
  const lender = String(r.lender || r.name || "").trim();
  const amount = Number(r.amount || r.borrowed || 0);
  if (!lender || amount <= 0) return null;
  return {
    date: String(r.date || debtToday()),
    lender,
    side: String(r.side || "payable"),
    category: String(r.category || "Other"),
    amount,
    interestPct: Number(r.interestPct || r.interest || 0),
    note: String(r.note || ""),
    createdAt: String(r.createdAt || new Date().toISOString())
  };
}

function normalizeLegacyRepayRow(r) {
  if (!r) return null;
  const lender = String(r.lender || r.name || "").trim();
  const amount = Number(r.amount || r.repaid || 0);
  if (!lender || amount <= 0) return null;
  return {
    date: String(r.date || debtToday()),
    lender,
    side: String(r.side || "payable"),
    amount,
    note: String(r.note || ""),
    createdAt: String(r.createdAt || new Date().toISOString())
  };
}

async function debtMigrateLegacyLocalIfNeeded() {
  const [existingBorrows, existingRepays] = await Promise.all([
    debtLoadArray("debt_borrows"),
    debtLoadArray("debt_repays")
  ]);
  if ((existingBorrows?.length || 0) > 0 || (existingRepays?.length || 0) > 0) return false;

  const legacyKeys = [
    "debt_data",
    "debtData",
    "debt_borrows",
    "debtBorrows",
    "borrowings",
    "debt_borrowings",
    "debt_repays",
    "debtRepays",
    "repayments"
  ];

  let borrows = [];
  let repays = [];
  for (const k of legacyKeys) {
    const parsed = parseMaybeJson(localStorage.getItem(k));
    if (!parsed) continue;
    if (Array.isArray(parsed)) {
      if (k.toLowerCase().includes("repay")) repays = repays.concat(parsed);
      else borrows = borrows.concat(parsed);
      continue;
    }
    if (Array.isArray(parsed?.borrows)) borrows = borrows.concat(parsed.borrows);
    if (Array.isArray(parsed?.repays)) repays = repays.concat(parsed.repays);
  }

  const normalizedBorrows = borrows.map(normalizeLegacyBorrowRow).filter(Boolean);
  const normalizedRepays = repays.map(normalizeLegacyRepayRow).filter(Boolean);
  if (!normalizedBorrows.length && !normalizedRepays.length) return false;

  const tx = db.transaction(["debt_borrows", "debt_repays"], "readwrite");
  const bStore = tx.objectStore("debt_borrows");
  const rStore = tx.objectStore("debt_repays");
  normalizedBorrows.forEach(r => bStore.add(r));
  normalizedRepays.forEach(r => rStore.add(r));

  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error("legacy_migration_failed"));
  });
  return true;
}

function buildDebtTransactions(borrows, repays) {
  const borrowRows = borrows.map(b => {
    const side = String(b.side || "payable");
    return {
      id: Number(b.id || 0),
      store: "debt_borrows",
      date: b.date || "",
      lender: String(b.lender || "").trim(),
      side,
      type: side === "receivable" ? "LEND" : "BORROW",
      amount: Number(b.amount || 0),
      interestPct: Number(b.interestPct || 0),
      category: b.category || "",
      note: b.note || ""
    };
  });

  const repayRows = repays.map(r => {
    const side = String(r.side || "payable");
    return {
      id: Number(r.id || 0),
      store: "debt_repays",
      date: r.date || "",
      lender: String(r.lender || "").trim(),
      side,
      type: side === "receivable" ? "RECEIVE" : "REPAY",
      amount: Number(r.amount || 0),
      interestPct: 0,
      category: "",
      note: r.note || ""
    };
  });

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
    if (lenderFilter && !String(t.lender || "").toLowerCase().includes(lenderFilter)) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No debt transactions</td></tr>`;
    return;
  }

  const badgeClass = {
    BORROW: "text-bg-warning",
    LEND: "text-bg-primary",
    REPAY: "text-bg-success",
    RECEIVE: "text-bg-info"
  };

  tbody.innerHTML = filtered.map(t => `
    <tr data-id="${t.id}" data-store="${t.store}">
      <td>${t.date}</td>
      <td>${t.lender || "-"}</td>
      <td><span class="badge ${badgeClass[t.type] || "text-bg-secondary"}">${t.type}</span></td>
      <td class="text-end">Rs ${Number(t.amount || 0).toFixed(2)}</td>
      <td class="text-end">
        <button type="button" class="btn btn-sm btn-outline-primary debt-txn-edit" data-id="${t.id}" data-store="${t.store}" title="Edit"><i class="bi bi-pencil"></i></button>
        <button type="button" class="btn btn-sm btn-outline-danger debt-txn-del" data-id="${t.id}" data-store="${t.store}" title="Delete"><i class="bi bi-trash"></i></button>
      </td>
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
    map[key] ??= {
      lender: b.lender,
      borrowed: 0,
      repaid: 0,
      lent: 0,
      received: 0,
      interestMax: 0,
      earliestDate: b.date
    };
    const side = String(b.side || "payable");
    if (side === "receivable") map[key].lent += Number(b.amount || 0);
    else map[key].borrowed += Number(b.amount || 0);

    map[key].interestMax = Math.max(map[key].interestMax, Number(b.interestPct || 0));
    if (!map[key].earliestDate || (b.date && b.date < map[key].earliestDate)) map[key].earliestDate = b.date;
  });

  repays.forEach(r => {
    const key = String(r.lender || "").trim().toUpperCase();
    if (!key) return;
    map[key] ??= {
      lender: r.lender,
      borrowed: 0,
      repaid: 0,
      lent: 0,
      received: 0,
      interestMax: 0,
      earliestDate: r.date
    };
    const side = String(r.side || "payable");
    if (side === "receivable") map[key].received += Number(r.amount || 0);
    else map[key].repaid += Number(r.amount || 0);

    if (!map[key].earliestDate || (r.date && r.date < map[key].earliestDate)) map[key].earliestDate = r.date;
  });

  const rows = Object.values(map)
    .map(x => ({
      ...x,
      payableRemaining: Math.max(0, x.borrowed - x.repaid),
      receivableRemaining: Math.max(0, x.lent - x.received)
    }))
    .filter(x => x.borrowed > 0 || x.repaid > 0 || x.lent > 0 || x.received > 0)
    .sort((a, b) => (b.payableRemaining + b.receivableRemaining) - (a.payableRemaining + a.receivableRemaining));

  const totalBorrowed = rows.reduce((a, r) => a + r.borrowed, 0);
  const totalRepaid = rows.reduce((a, r) => a + r.repaid, 0);
  const totalLent = rows.reduce((a, r) => a + r.lent, 0);
  const totalReceived = rows.reduce((a, r) => a + r.received, 0);
  const payableTotal = rows.reduce((a, r) => a + r.payableRemaining, 0);
  const receivableTotal = rows.reduce((a, r) => a + r.receivableRemaining, 0);

  const summary = document.getElementById("debtSummary");
  if (summary) {
    summary.innerHTML = `
      <div class="stat-card"><div class="stat-label">Total Borrowed</div><div class="stat-value">Rs ${totalBorrowed.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Repaid</div><div class="stat-value">Rs ${totalRepaid.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Lent</div><div class="stat-value">Rs ${totalLent.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Total Received</div><div class="stat-value">Rs ${totalReceived.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Payable</div><div class="stat-value">Rs ${payableTotal.toFixed(2)}</div></div>
      <div class="stat-card"><div class="stat-label">Receivable</div><div class="stat-value">Rs ${receivableTotal.toFixed(2)}</div></div>
    `;
  }

  const debtList = document.getElementById("debtList");
  if (debtList) {
    debtList.innerHTML = rows.length ? rows.map(r => `
      <div class="txn-card">
        <div class="split-row">
          <div class="left-col">
            <div class="txn-name">${r.lender}</div>
            <div class="tiny-label">Borrowed: Rs ${r.borrowed.toFixed(2)} | Repaid: Rs ${r.repaid.toFixed(2)}</div>
            <div class="tiny-label">Lent: Rs ${r.lent.toFixed(2)} | Received: Rs ${r.received.toFixed(2)}</div>
          </div>
          <div class="right-col">
            <div class="metric-strong ${r.payableRemaining > 0 ? "loss" : "profit"}">Rs ${r.payableRemaining.toFixed(2)}</div>
            <div class="tiny-label">Payable</div>
            <div class="metric-strong ${r.receivableRemaining > 0 ? "profit" : "loss"}">Rs ${r.receivableRemaining.toFixed(2)}</div>
            <div class="tiny-label">Receivable</div>
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
    if (!payableTotal || !available) {
      planEl.innerHTML = `<div class="tiny-label">Set monthly budget and investment floor to see closure estimate.</div>`;
    } else {
      const months = Math.ceil(payableTotal / available);
      const priority = rows
        .filter(r => r.payableRemaining > 0)
        .sort((a, b) => (b.interestMax - a.interestMax) || (a.earliestDate || "").localeCompare(b.earliestDate || ""))
        .slice(0, 3);

      planEl.innerHTML = `
        <div class="txn-card">
          <div class="tiny-label">Available for debt/month: Rs ${available.toFixed(2)} | Estimated closure: ${months} month(s)</div>
          <div class="status-inline mt-2">
            ${priority.map((p, i) => `<span class="status-pill-mini bad">${i + 1}. ${p.lender} (Rs ${p.payableRemaining.toFixed(0)})</span>`).join("")}
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
    side: document.getElementById("borSide")?.value || "payable",
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
    const borSide = document.getElementById("borSide");
    if (borSide) borSide.value = "payable";
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
    side: document.getElementById("repSide")?.value || "payable",
    amount,
    note: document.getElementById("repNote")?.value || "",
    createdAt: new Date().toISOString()
  };

  const tx = db.transaction("debt_repays", "readwrite");
  tx.objectStore("debt_repays").add(data);
  tx.oncomplete = () => {
    document.getElementById("repayForm")?.reset();
    const repSide = document.getElementById("repSide");
    if (repSide) repSide.value = "payable";
    document.getElementById("repDate").value = debtToday();
    if (typeof showToast === "function") showToast("Repayment saved");
    renderDebtData();
  };
}

async function debtPromptValue(title, message, defaultValue, opts = {}) {
  if (typeof window !== "undefined" && typeof window.appPromptDialog === "function") {
    return window.appPromptDialog({
      title,
      message,
      defaultValue: String(defaultValue || ""),
      placeholder: opts.placeholder || "",
      inputType: opts.inputType || "text",
      required: opts.required !== false,
      minLength: opts.minLength || 0
    });
  }
  const v = window.prompt(message, String(defaultValue || ""));
  return v == null ? null : String(v);
}

async function debtEditTxn(storeName, id) {
  const store = db.transaction(storeName, "readonly").objectStore(storeName);
  const row = await new Promise(resolve => {
    const req = store.get(Number(id));
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror = () => resolve(null);
  });
  if (!row) return;

  const date = await debtPromptValue("Edit Debt", "Date (YYYY-MM-DD)", row.date || debtToday(), { placeholder: "YYYY-MM-DD" });
  if (date === null) return;
  const lender = await debtPromptValue("Edit Debt", "Lender / Person name", row.lender || "", { minLength: 1 });
  if (lender === null) return;
  const amountStr = await debtPromptValue("Edit Debt", "Amount", row.amount || "", { inputType: "number" });
  if (amountStr === null) return;

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    if (typeof showToast === "function") showToast("Invalid amount", "error");
    return;
  }

  const note = await debtPromptValue("Edit Debt", "Note (optional)", row.note || "", { required: false });
  if (note === null) return;

  row.date = String(date).trim();
  row.lender = String(lender).trim();
  row.amount = amount;
  row.note = String(note || "");

  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).put(row);
  tx.oncomplete = () => {
    if (typeof showToast === "function") showToast("Debt transaction updated", "success");
    renderDebtData();
  };
}

async function debtDeleteTxn(storeName, id) {
  const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
    ? await window.appConfirmDialog("Delete this debt transaction?", { title: "Confirm Delete", okText: "Delete" })
    : window.confirm("Delete this debt transaction?");
  if (!ok) return;

  const tx = db.transaction(storeName, "readwrite");
  tx.objectStore(storeName).delete(Number(id));
  tx.oncomplete = () => {
    if (typeof showToast === "function") showToast("Debt transaction deleted", "success");
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

  const tbody = document.getElementById("debtTxnTableBody");
  if (tbody && tbody.dataset.wired !== "1") {
    tbody.dataset.wired = "1";
    tbody.addEventListener("click", e => {
      const editBtn = e.target.closest(".debt-txn-edit");
      if (editBtn) {
        debtEditTxn(editBtn.getAttribute("data-store"), editBtn.getAttribute("data-id"));
        return;
      }
      const delBtn = e.target.closest(".debt-txn-del");
      if (delBtn) {
        debtDeleteTxn(delBtn.getAttribute("data-store"), delBtn.getAttribute("data-id"));
      }
    });
  }
}

function debtSaveLocalPlan() {
  localStorage.setItem("debt_monthly_budget", document.getElementById("monthlyDebtBudget")?.value || "");
  localStorage.setItem("debt_invest_floor", document.getElementById("monthlyInvestFloor")?.value || "");
  renderDebtData();
}

function initDebtTxnFilters() {
  const from = document.getElementById("debtTxnFrom");
  const to = document.getElementById("debtTxnTo");
  if (!from || !to) return;
  const today = new Date();
  const last3Months = new Date();
  last3Months.setMonth(today.getMonth() - 3);
  from.value = last3Months.toISOString().split("T")[0];
  to.value = today.toISOString().split("T")[0];
}

function loadDebtPage() {
  const borDate = document.getElementById("borDate");
  const repDate = document.getElementById("repDate");
  if (borDate) borDate.value = debtToday();
  if (repDate) repDate.value = debtToday();

  const borSide = document.getElementById("borSide");
  const repSide = document.getElementById("repSide");
  if (borSide && !borSide.value) borSide.value = "payable";
  if (repSide && !repSide.value) repSide.value = "payable";

  const monthlyBudget = document.getElementById("monthlyDebtBudget");
  const investFloor = document.getElementById("monthlyInvestFloor");
  if (monthlyBudget) monthlyBudget.value = localStorage.getItem("debt_monthly_budget") || "";
  if (investFloor) investFloor.value = localStorage.getItem("debt_invest_floor") || "";

  initDebtTxnFilters();
  bindDebtTxnFilters();

  document.getElementById("borrowForm")?.addEventListener("submit", debtAddBorrow);
  document.getElementById("repayForm")?.addEventListener("submit", debtAddRepay);
  monthlyBudget?.addEventListener("input", debtSaveLocalPlan);
  investFloor?.addEventListener("input", debtSaveLocalPlan);

  debtMigrateLegacyLocalIfNeeded()
    .then(migrated => {
      if (migrated && typeof showToast === "function") {
        showToast("Recovered debt data from legacy storage", "success", 3000);
      }
    })
    .catch(() => {})
    .finally(() => {
      renderDebtData();
    });

  if (typeof window !== "undefined") {
    window.__debtDebug = async function () {
      const [b, r] = await Promise.all([debtLoadArray("debt_borrows"), debtLoadArray("debt_repays")]);
      const info = { borrows: b.length, repays: r.length, sampleBorrow: b[0] || null, sampleRepay: r[0] || null };
      console.log("[Debt Debug]", info);
      return info;
    };
  }
}

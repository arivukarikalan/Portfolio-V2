function expenseNum(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}

function expenseDateValue(value) {
  const d = String(value || "").trim();
  return d || new Date().toISOString().slice(0, 10);
}

function normalizeExpenseCategory(value) {
  const raw = String(value || "").trim();
  return raw || "Other";
}

function normalizeExpensePaymentMode(value) {
  const raw = String(value || "").trim();
  return raw || "Cash";
}

function normalizeExpenseTxnType(value) {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "CREDIT" ? "CREDIT" : "DEBIT";
}

function normalizeExpenseFundingSource(value) {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "COMPANY" ? "COMPANY" : "PERSONAL";
}

function normalizeExpenseRow(row) {
  const r = row || {};
  return {
    ...r,
    date: expenseDateValue(r.date),
    amount: expenseNum(r.amount, 0),
    category: normalizeExpenseCategory(r.category),
    paymentMode: normalizeExpensePaymentMode(r.paymentMode),
    txnType: normalizeExpenseTxnType(r.txnType),
    fundingSource: normalizeExpenseFundingSource(r.fundingSource)
  };
}

function formatMoneyInr(value) {
  return "\u20B9" + expenseNum(value, 0).toFixed(2);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

function isToday(dateStr) {
  return String(dateStr || "") === todayIso();
}

function renderExpenseCategoryBreakdown(rows) {
  const host = document.getElementById("expCategoryBars");
  if (!host) return;

  const debitRows = (rows || []).filter(r => r.txnType === "DEBIT" && r.fundingSource === "PERSONAL");
  if (!debitRows.length) {
    host.innerHTML = '<div class="txn-card text-center text-muted">No personal debit expenses for this month</div>';
    return;
  }

  const agg = {};
  debitRows.forEach(r => {
    agg[r.category] = (agg[r.category] || 0) + expenseNum(r.amount, 0);
  });
  const list = Object.keys(agg)
    .map(k => ({ category: k, amount: agg[k] }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);

  const max = Math.max(1, ...list.map(x => expenseNum(x.amount, 0)));
  host.innerHTML = list.map(x => {
    const width = (expenseNum(x.amount, 0) / max) * 100;
    return `
      <div class="adv-bar-row">
        <div class="adv-bar-label">${x.category}</div>
        <div class="adv-bar-track"><div class="adv-bar loss" style="width:${width.toFixed(2)}%"></div></div>
        <div class="adv-bar-value loss">${formatMoneyInr(x.amount)}</div>
      </div>
    `;
  }).join("");
}

function loadExpenseSummary(allRows) {
  const todayDebitEl = document.getElementById("expTodayDebit");
  const monthDebitEl = document.getElementById("expMonthDebit");
  const monthCreditEl = document.getElementById("expMonthCredit");
  const monthNetEl = document.getElementById("expMonthNet");
  const companySpendEl = document.getElementById("expCompanySpend");
  const topCatEl = document.getElementById("expTopCategory");
  const countEl = document.getElementById("expEntries");
  if (!todayDebitEl || !monthDebitEl || !monthCreditEl || !monthNetEl || !companySpendEl || !topCatEl || !countEl) return;

  const all = Array.isArray(allRows) ? allRows.map(normalizeExpenseRow) : [];
  const currentMonth = monthKey(todayIso());
  const monthRows = all.filter(r => monthKey(r.date) === currentMonth);

  const todayDebit = all
    .filter(r => isToday(r.date) && r.txnType === "DEBIT" && r.fundingSource === "PERSONAL")
    .reduce((sum, r) => sum + expenseNum(r.amount, 0), 0);

  const monthDebitPersonal = monthRows
    .filter(r => r.txnType === "DEBIT" && r.fundingSource === "PERSONAL")
    .reduce((sum, r) => sum + expenseNum(r.amount, 0), 0);

  const monthCredit = monthRows
    .filter(r => r.txnType === "CREDIT")
    .reduce((sum, r) => sum + expenseNum(r.amount, 0), 0);

  const monthCompanySpend = monthRows
    .filter(r => r.txnType === "DEBIT" && r.fundingSource === "COMPANY")
    .reduce((sum, r) => sum + expenseNum(r.amount, 0), 0);

  const monthNet = monthCredit - monthDebitPersonal;

  const catAgg = {};
  monthRows
    .filter(r => r.txnType === "DEBIT" && r.fundingSource === "PERSONAL")
    .forEach(r => {
      catAgg[r.category] = (catAgg[r.category] || 0) + expenseNum(r.amount, 0);
    });
  const topCategory = Object.keys(catAgg)
    .map(k => ({ category: k, amount: catAgg[k] }))
    .sort((a, b) => b.amount - a.amount)[0] || null;

  todayDebitEl.textContent = formatMoneyInr(todayDebit);
  monthDebitEl.textContent = formatMoneyInr(monthDebitPersonal);
  monthCreditEl.textContent = formatMoneyInr(monthCredit);
  monthNetEl.textContent = formatMoneyInr(monthNet);
  monthNetEl.classList.remove("profit", "loss");
  if (monthNet > 0) monthNetEl.classList.add("profit");
  if (monthNet < 0) monthNetEl.classList.add("loss");
  companySpendEl.textContent = formatMoneyInr(monthCompanySpend);
  topCatEl.textContent = topCategory ? `${topCategory.category} (${formatMoneyInr(topCategory.amount)})` : "-";
  countEl.textContent = String(all.length);

  renderExpenseCategoryBreakdown(monthRows);
}

function getExpenseFilterState() {
  const month = String(document.getElementById("expFilterMonth")?.value || "").trim();
  const type = String(document.getElementById("expFilterType")?.value || "ALL").trim().toUpperCase();
  const source = String(document.getElementById("expFilterSource")?.value || "ALL").trim().toUpperCase();
  return { month, type, source };
}

function applyExpenseFilters(rows) {
  const f = getExpenseFilterState();
  return (rows || []).filter(r => {
    if (f.month && monthKey(r.date) !== f.month) return false;
    if (f.type !== "ALL" && r.txnType !== f.type) return false;
    if (f.source !== "ALL" && r.fundingSource !== f.source) return false;
    return true;
  });
}

function expenseBadge(type, source) {
  const typeCls = type === "CREDIT" ? "ok" : "bad";
  const typeLabel = type === "CREDIT" ? "Credit" : "Debit";
  const srcLabel = source === "COMPANY" ? "Company" : "Personal";
  return `<span class="status-pill-mini ${typeCls}">${typeLabel}</span> <span class="status-pill-mini info">${srcLabel}</span>`;
}

function renderExpenses(rows) {
  const list = document.getElementById("expenseList");
  if (!list) return;
  list.innerHTML = "";

  const all = (Array.isArray(rows) ? rows : [])
    .map(normalizeExpenseRow)
    .slice()
    .sort((a, b) => {
      const d = String(b.date || "").localeCompare(String(a.date || ""));
      if (d !== 0) return d;
      return expenseNum(b.id, 0) - expenseNum(a.id, 0);
    });

  loadExpenseSummary(all);

  const data = applyExpenseFilters(all);
  if (!data.length) {
    list.innerHTML = `<div class="txn-card text-center text-muted">No entries for selected filters</div>`;
    return;
  }

  list.innerHTML = data.map(r => {
    const note = String(r.note || "").trim();
    const mode = String(r.paymentMode || "").trim();
    const amountCls = r.txnType === "CREDIT" ? "profit" : "loss";
    const sign = r.txnType === "CREDIT" ? "+" : "-";
    return `
      <div class="txn-card">
        <div class="txn-top">
          <div>
            <div class="txn-name">${r.category}</div>
            <div class="txn-sub">${r.date} | ${mode || "-"} | ${note || "No note"}</div>
            <div class="status-inline mt-1">${expenseBadge(r.txnType, r.fundingSource)}</div>
          </div>
          <div class="right-col">
            <div class="metric-strong ${amountCls}">${sign}${formatMoneyInr(r.amount)}</div>
            <div class="txn-actions mt-1">
              <button class="btn btn-sm btn-warning" onclick="editExpense(${r.id})" aria-label="Edit entry">
                <i class="bi bi-pencil"></i>
              </button>
              <button class="btn btn-sm btn-danger" onclick="deleteExpense(${r.id})" aria-label="Delete entry">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function loadExpenses() {
  const list = document.getElementById("expenseList");
  if (!list) return;
  try {
    const tx = db.transaction("expenses", "readonly");
    tx.objectStore("expenses").getAll().onsuccess = e => {
      renderExpenses(e.target.result || []);
    };
  } catch (e) {
    list.innerHTML = `<div class="txn-card text-center text-danger">Failed to load entries</div>`;
  }
}

function resetExpenseForm() {
  const form = document.getElementById("expenseForm");
  const editId = document.getElementById("editExpenseId");
  const dateEl = document.getElementById("expenseDate");
  const typeEl = document.getElementById("expenseTxnType");
  const sourceEl = document.getElementById("expenseFundingSource");
  if (form) form.reset();
  if (editId) editId.value = "";
  if (dateEl) dateEl.value = todayIso();
  if (typeEl) typeEl.value = "DEBIT";
  if (sourceEl) sourceEl.value = "PERSONAL";
}

function syncExpenseFormByType() {
  const typeEl = document.getElementById("expenseTxnType");
  const catEl = document.getElementById("expenseCategory");
  const sourceEl = document.getElementById("expenseFundingSource");
  if (!typeEl || !catEl || !sourceEl) return;
  const type = normalizeExpenseTxnType(typeEl.value);
  if (type === "CREDIT") {
    if (!["Salary", "Bonus", "Other"].includes(String(catEl.value || ""))) catEl.value = "Salary";
    sourceEl.value = "PERSONAL";
  }
}

function initExpenseFilters() {
  const monthEl = document.getElementById("expFilterMonth");
  const typeEl = document.getElementById("expFilterType");
  const sourceEl = document.getElementById("expFilterSource");
  if (monthEl && !monthEl.value) monthEl.value = monthKey(todayIso());
  [monthEl, typeEl, sourceEl].forEach(el => {
    if (!el || el.dataset.wired === "1") return;
    el.dataset.wired = "1";
    el.addEventListener("change", loadExpenses);
    el.addEventListener("input", loadExpenses);
  });
}

function initExpenseForm() {
  const form = document.getElementById("expenseForm");
  if (!form || form.dataset.wired === "1") return;
  form.dataset.wired = "1";

  resetExpenseForm();
  initExpenseFilters();
  syncExpenseFormByType();

  const txnTypeEl = document.getElementById("expenseTxnType");
  if (txnTypeEl && txnTypeEl.dataset.wired !== "1") {
    txnTypeEl.dataset.wired = "1";
    txnTypeEl.addEventListener("change", syncExpenseFormByType);
  }

  form.addEventListener("submit", e => {
    e.preventDefault();
    const editId = document.getElementById("editExpenseId")?.value || "";
    const date = expenseDateValue(document.getElementById("expenseDate")?.value);
    const txnType = normalizeExpenseTxnType(document.getElementById("expenseTxnType")?.value);
    const amount = expenseNum(document.getElementById("expenseAmount")?.value, 0);
    const category = normalizeExpenseCategory(document.getElementById("expenseCategory")?.value);
    const paymentMode = normalizeExpensePaymentMode(document.getElementById("expensePaymentMode")?.value);
    const fundingSource = normalizeExpenseFundingSource(document.getElementById("expenseFundingSource")?.value);
    const note = String(document.getElementById("expenseNote")?.value || "").trim();

    if (amount <= 0) {
      if (typeof showToast === "function") showToast("Amount should be greater than zero", "error");
      return;
    }

    const payload = {
      date,
      txnType,
      amount,
      category,
      paymentMode,
      fundingSource,
      note,
      updatedAt: new Date().toISOString()
    };

    const tx = db.transaction("expenses", "readwrite");
    const store = tx.objectStore("expenses");
    if (editId) {
      store.get(Number(editId)).onsuccess = ev => {
        const prev = ev.target.result || {};
        store.put({
          ...normalizeExpenseRow(prev),
          ...payload,
          id: Number(editId),
          createdAt: prev.createdAt || payload.updatedAt
        });
      };
    } else {
      store.add({
        ...payload,
        createdAt: payload.updatedAt
      });
    }

    tx.oncomplete = () => {
      resetExpenseForm();
      loadExpenses();
      if (typeof showToast === "function") {
        showToast(editId ? "Entry updated" : "Entry saved", "success");
      }
    };
    tx.onerror = () => {
      if (typeof showToast === "function") showToast("Failed to save entry", "error");
    };
  });
}

function editExpense(id) {
  try {
    db.transaction("expenses", "readonly")
      .objectStore("expenses")
      .get(id).onsuccess = e => {
        const raw = e.target.result;
        if (!raw) return;
        const r = normalizeExpenseRow(raw);
        const editId = document.getElementById("editExpenseId");
        const dateEl = document.getElementById("expenseDate");
        const amountEl = document.getElementById("expenseAmount");
        const typeEl = document.getElementById("expenseTxnType");
        const catEl = document.getElementById("expenseCategory");
        const modeEl = document.getElementById("expensePaymentMode");
        const sourceEl = document.getElementById("expenseFundingSource");
        const noteEl = document.getElementById("expenseNote");
        if (editId) editId.value = String(r.id);
        if (dateEl) dateEl.value = expenseDateValue(r.date);
        if (amountEl) amountEl.value = expenseNum(r.amount, 0);
        if (typeEl) typeEl.value = normalizeExpenseTxnType(r.txnType);
        if (catEl) catEl.value = normalizeExpenseCategory(r.category);
        if (modeEl) modeEl.value = normalizeExpensePaymentMode(r.paymentMode);
        if (sourceEl) sourceEl.value = normalizeExpenseFundingSource(r.fundingSource);
        if (noteEl) noteEl.value = String(r.note || "");
        if (typeof showToast === "function") showToast("Editing entry", "info");
      };
  } catch (e) {
    if (typeof showToast === "function") showToast("Failed to load entry", "error");
  }
}

async function deleteExpense(id) {
  const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
    ? await window.appConfirmDialog("Delete this entry?", { title: "Delete Entry", okText: "Delete" })
    : window.confirm("Delete this entry?");
  if (!ok) return;
  try {
    const tx = db.transaction("expenses", "readwrite");
    tx.objectStore("expenses").delete(id);
    tx.oncomplete = () => {
      loadExpenses();
      if (typeof showToast === "function") showToast("Entry deleted", "success");
    };
  } catch (e) {
    if (typeof showToast === "function") showToast("Failed to delete entry", "error");
  }
}

if (typeof window !== "undefined") {
  window.initExpenseForm = initExpenseForm;
  window.loadExpenses = loadExpenses;
  window.editExpense = editExpense;
  window.deleteExpense = deleteExpense;
}

function expenseNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function formatMoneyInr(value) {
  return `₹${expenseNum(value, 0).toFixed(2)}`;
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

function loadExpenseSummary(rows) {
  const todayEl = document.getElementById("expToday");
  const monthEl = document.getElementById("expMonth");
  const topCatEl = document.getElementById("expTopCategory");
  const countEl = document.getElementById("expEntries");
  if (!todayEl || !monthEl || !topCatEl || !countEl) return;

  const all = Array.isArray(rows) ? rows : [];
  const currentMonth = monthKey(todayIso());
  const todayTotal = all
    .filter(r => isToday(r.date))
    .reduce((sum, r) => sum + expenseNum(r.amount, 0), 0);
  const monthRows = all.filter(r => monthKey(r.date) === currentMonth);
  const monthTotal = monthRows.reduce((sum, r) => sum + expenseNum(r.amount, 0), 0);

  const catAgg = {};
  monthRows.forEach(r => {
    const c = normalizeExpenseCategory(r.category);
    catAgg[c] = (catAgg[c] || 0) + expenseNum(r.amount, 0);
  });
  const topCategory = Object.keys(catAgg)
    .map(k => ({ category: k, amount: catAgg[k] }))
    .sort((a, b) => b.amount - a.amount)[0] || null;

  todayEl.textContent = formatMoneyInr(todayTotal);
  monthEl.textContent = formatMoneyInr(monthTotal);
  topCatEl.textContent = topCategory ? `${topCategory.category} (${formatMoneyInr(topCategory.amount)})` : "-";
  countEl.textContent = String(all.length);
}

function renderExpenses(rows) {
  const list = document.getElementById("expenseList");
  if (!list) return;
  list.innerHTML = "";

  const data = (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => {
      const d = String(b.date || "").localeCompare(String(a.date || ""));
      if (d !== 0) return d;
      return expenseNum(b.id, 0) - expenseNum(a.id, 0);
    });

  loadExpenseSummary(data);

  if (!data.length) {
    list.innerHTML = `<div class="txn-card text-center text-muted">No expenses yet</div>`;
    return;
  }

  data.forEach(r => {
    const note = String(r.note || "").trim();
    const mode = String(r.paymentMode || "").trim();
    list.innerHTML += `
      <div class="txn-card">
        <div class="txn-top">
          <div>
            <div class="txn-name">${normalizeExpenseCategory(r.category)}</div>
            <div class="txn-sub">
              ${r.date} | ${mode || "-"} | ${note || "No note"}
            </div>
          </div>
          <div class="right-col">
            <div class="metric-strong">${formatMoneyInr(r.amount)}</div>
            <div class="txn-actions mt-1">
              <button class="btn btn-sm btn-warning" onclick="editExpense(${r.id})" aria-label="Edit expense">
                <i class="bi bi-pencil"></i>
              </button>
              <button class="btn btn-sm btn-danger" onclick="deleteExpense(${r.id})" aria-label="Delete expense">
                <i class="bi bi-trash"></i>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  });
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
    list.innerHTML = `<div class="txn-card text-center text-danger">Failed to load expenses</div>`;
  }
}

function resetExpenseForm() {
  const form = document.getElementById("expenseForm");
  const editId = document.getElementById("editExpenseId");
  const dateEl = document.getElementById("expenseDate");
  if (form) form.reset();
  if (editId) editId.value = "";
  if (dateEl) dateEl.value = todayIso();
}

function initExpenseForm() {
  const form = document.getElementById("expenseForm");
  if (!form || form.dataset.wired === "1") return;
  form.dataset.wired = "1";

  resetExpenseForm();

  form.addEventListener("submit", e => {
    e.preventDefault();
    const editId = document.getElementById("editExpenseId")?.value || "";
    const date = expenseDateValue(document.getElementById("expenseDate")?.value);
    const amount = expenseNum(document.getElementById("expenseAmount")?.value, 0);
    const category = normalizeExpenseCategory(document.getElementById("expenseCategory")?.value);
    const paymentMode = normalizeExpensePaymentMode(document.getElementById("expensePaymentMode")?.value);
    const note = String(document.getElementById("expenseNote")?.value || "").trim();

    if (amount <= 0) {
      if (typeof showToast === "function") showToast("Amount should be greater than zero", "error");
      return;
    }

    const payload = {
      date,
      amount,
      category,
      paymentMode,
      note,
      updatedAt: new Date().toISOString()
    };

    const tx = db.transaction("expenses", "readwrite");
    const store = tx.objectStore("expenses");
    if (editId) {
      store.get(Number(editId)).onsuccess = ev => {
        const prev = ev.target.result || {};
        store.put({
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
        showToast(editId ? "Expense updated" : "Expense added", "success");
      }
    };
    tx.onerror = () => {
      if (typeof showToast === "function") showToast("Failed to save expense", "error");
    };
  });
}

function editExpense(id) {
  try {
    db.transaction("expenses", "readonly")
      .objectStore("expenses")
      .get(id).onsuccess = e => {
        const r = e.target.result;
        if (!r) return;
        const editId = document.getElementById("editExpenseId");
        const dateEl = document.getElementById("expenseDate");
        const amountEl = document.getElementById("expenseAmount");
        const catEl = document.getElementById("expenseCategory");
        const modeEl = document.getElementById("expensePaymentMode");
        const noteEl = document.getElementById("expenseNote");
        if (editId) editId.value = String(r.id);
        if (dateEl) dateEl.value = expenseDateValue(r.date);
        if (amountEl) amountEl.value = expenseNum(r.amount, 0);
        if (catEl) catEl.value = normalizeExpenseCategory(r.category);
        if (modeEl) modeEl.value = normalizeExpensePaymentMode(r.paymentMode);
        if (noteEl) noteEl.value = String(r.note || "");
        if (typeof showToast === "function") showToast("Editing expense", "info");
      };
  } catch (e) {
    if (typeof showToast === "function") showToast("Failed to load expense", "error");
  }
}

async function deleteExpense(id) {
  const ok = (typeof window !== "undefined" && typeof window.appConfirmDialog === "function")
    ? await window.appConfirmDialog("Delete this expense entry?", { title: "Delete Expense", okText: "Delete" })
    : window.confirm("Delete this expense entry?");
  if (!ok) return;
  try {
    const tx = db.transaction("expenses", "readwrite");
    tx.objectStore("expenses").delete(id);
    tx.oncomplete = () => {
      loadExpenses();
      if (typeof showToast === "function") showToast("Expense deleted", "success");
    };
  } catch (e) {
    if (typeof showToast === "function") showToast("Failed to delete expense", "error");
  }
}

if (typeof window !== "undefined") {
  window.initExpenseForm = initExpenseForm;
  window.loadExpenses = loadExpenses;
  window.editExpense = editExpense;
  window.deleteExpense = deleteExpense;
}

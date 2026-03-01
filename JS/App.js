// Expose explicit app bootstrap so DB opens only after auth checks.
window.startApp = async function startApp() {
  const uid = localStorage.getItem('activeUserId');
  if (!uid) {
    throw new Error('No active user. Login required before app bootstrap.');
  }

  await openDB();
  await seedSettings();

  if (typeof initTransactionForm === 'function') initTransactionForm();
  if (typeof loadTransactions === 'function') loadTransactions();
  if (typeof calculateHoldings === 'function') calculateHoldings();
  if (typeof calculatePnL === 'function') calculatePnL();
  if (typeof loadDashboard === 'function') loadDashboard();
  if (typeof loadTotalLoss === 'function') loadTotalLoss();
};

// Make centralized logout available on app pages without loading auth module upfront.
if (typeof window !== 'undefined' && typeof window.appLogout !== 'function') {
  window.appLogout = async function appLogout() {
    const mod = await import('../client/profileManager.js');
    return mod.logout();
  };
}

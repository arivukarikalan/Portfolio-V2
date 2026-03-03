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
  if (typeof initLivePrices === 'function') initLivePrices();
};

// Make centralized logout available on app pages without loading auth module upfront.
if (typeof window !== 'undefined' && typeof window.appLogout !== 'function') {
  window.appLogout = async function appLogout() {
    const mod = await import('../client/profileManager.js');
    return mod.logout();
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('live-prices-updated', () => {
    if (typeof calculateHoldings === 'function') calculateHoldings();
    if (typeof loadDashboard === 'function') loadDashboard();
  });
}
const DEFAULT_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzkSMNGyDU7yk-pMSvF1wsEVetBJaQepnqOV8DbjbdoxS37TfszxMeGNufhe3N9viw/exec";

if (typeof window !== 'undefined') {
  if (!window.APP_APPS_SCRIPT_URL) {
    window.APP_APPS_SCRIPT_URL = DEFAULT_APPS_SCRIPT_URL;
  }
  if (!window.APP_LIVE_PRICE_URL) {
    window.APP_LIVE_PRICE_URL = window.APP_APPS_SCRIPT_URL;
  }
}


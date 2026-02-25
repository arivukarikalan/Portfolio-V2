document.addEventListener("DOMContentLoaded", () => {
    openDB()
      .then(seedSettings)
      .then(() => {
        initTransactionForm();
        loadTransactions();
        calculateHoldings();
        calculatePnL();
      });
  });
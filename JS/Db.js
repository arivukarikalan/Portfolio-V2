/* =========================================================
   FILE: db.js
   FEATURE: IndexedDB Initialization & Connection
   PURPOSE:
   - Create / open Portfolio Tracker database
   - Define all object stores
   - Provide a single db connection for the app
   ========================================================= */

/* Global DB reference */
let db;

/* =========================================================
   FEATURE: Open IndexedDB
   - Database Name: PortfolioDB
   - Version: 1
   - Stores:
     1. transactions → All BUY / SELL records
     2. settings     → App configuration (brokerage, rates, etc.)
   ========================================================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("PortfolioDB", 3);

    /* ===== Database Schema Creation / Upgrade ===== */
    request.onupgradeneeded = event => {
      db = event.target.result;

      /* Store: Transactions */
      if (!db.objectStoreNames.contains("transactions")) {
        db.createObjectStore("transactions", {
          keyPath: "id",
          autoIncrement: true
        });
      }

      /* Store: Settings */
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", {
          keyPath: "id"
        });
      }

      /* Store: Debt Borrows */
      if (!db.objectStoreNames.contains("debt_borrows")) {
        db.createObjectStore("debt_borrows", {
          keyPath: "id",
          autoIncrement: true
        });
      }

      /* Store: Debt Repays */
      if (!db.objectStoreNames.contains("debt_repays")) {
        db.createObjectStore("debt_repays", {
          keyPath: "id",
          autoIncrement: true
        });
      }
    };

    /* ===== DB Open Success ===== */
    request.onsuccess = event => {
      db = event.target.result;
      resolve();
    };

    /* ===== DB Open Error ===== */
    request.onerror = () => {
      reject("Failed to open IndexedDB");
    };
  });
}

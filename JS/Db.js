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

/* Helper to get current DB name */
function getDbName() {
  return 'PortfolioDB';
}

/* =========================================================
   FEATURE: Open IndexedDB
   - Database Name: PortfolioDB
   - Version: 1
   - Stores:
     1. transactions â†’ All BUY / SELL records
     2. settings     â†’ App configuration (brokerage, rates, etc.)
   ========================================================= */
function openDB() {
  // Lifecycle guard: DB must never exist without a logged-in user.
  try {
    const activeUserId = (typeof localStorage !== 'undefined') ? localStorage.getItem('activeUserId') : null;
    if (!activeUserId) {
      return Promise.reject(new Error('activeUserId required before opening PortfolioDB'));
    }
  } catch (e) {
    return Promise.reject(new Error('Unable to validate login session before opening PortfolioDB'));
  }
  return new Promise((resolve, reject) => {
    const DB_NAME = getDbName();
    const VERSION = 3;

    const request = indexedDB.open(DB_NAME, VERSION);

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

      // Expose a reference on window so other modules can close it before deleteDatabase
      try {
        if (typeof window !== 'undefined') {
          window.db = db;
          // safe close helper for other modules to call
          window.closePortfolioDB = function() {
            try {
              if (db && typeof db.close === 'function') {
                db.close();
              }
            } catch (e) { /* ignore close errors */ }
            try { db = null; } catch (e) { /* ignore */ }
            try { if (typeof window !== 'undefined') delete window.db; } catch (e) { /* ignore */ }
          };

          // helper that returns a Promise resolved after close attempt (useful to await)
          window.closePortfolioDBAsync = function(timeout = 200) {
            return new Promise((res) => {
              try { window.closePortfolioDB(); } catch (e) {}
              // short wait for browser internals to finalize close
              setTimeout(() => res(), timeout);
            });
          };
        }
      } catch (e) {
        // ignore if environment doesn't allow window writes
      }

      // Ensure DB closes automatically if another context requests a version change
      try {
        if (db && typeof db.addEventListener === 'function') {
          db.onversionchange = function() {
            try { db.close(); } catch (e) {}
            try { if (typeof window !== 'undefined') delete window.db; } catch (e) {}
            try { db = null; } catch (e) {}
          };
        }
      } catch (e) { /* ignore */ }

      resolve();
    };

    /* ===== DB Open Error ===== */
    request.onerror = () => {
      reject("Failed to open IndexedDB");
    };
  });
}


(function () {
  if (window.__APP_UI_SHELL_INIT__) return;
  window.__APP_UI_SHELL_INIT__ = true;

  function currentFileName() {
    var p = String(window.location.pathname || "");
    var name = p.split("/").pop() || "index.html";
    return name.toLowerCase();
  }

  function isProfilePage() {
    return currentFileName() === "profile.html";
  }

  function getPageTitle(file) {
    var map = {
      "index.html": "Portfolio Home",
      "transactions.html": "Transactions",
      "holdings.html": "Holdings",
      "pnl.html": "P/L",
      "insights.html": "Insights",
      "advanced.html": "Advanced Dashboard",
      "discipline.html": "Discipline Coach",
      "settings.html": "Settings",
      "debt.html": "Debt Management",
      "lossreport.html": "Loss Report",
      "stockmappings.html": "Stock Mapping",
      "expenses.html": "Expenses",
      "advisor.html": "AI Advisor"
    };
    return map[file] || "Portfolio";
  }

  function buildNavItems() {
    return [
      { href: "index.html", icon: "bi-house-door", label: "Home" },
      { href: "Transactions.html", icon: "bi-journal-check", label: "Transactions" },
      { href: "Holdings.html", icon: "bi-pie-chart", label: "Holdings" },
      { href: "Pnl.html", icon: "bi-graph-up", label: "P/L" },
      { href: "Insights.html", icon: "bi-stars", label: "Insights" },
      { href: "Advanced.html", icon: "bi-speedometer2", label: "Advanced" },
      { href: "Discipline.html", icon: "bi-shield-check", label: "Coach" },
      { href: "Advisor.html", icon: "bi-robot", label: "Advisor" },
      { href: "Debt.html", icon: "bi-wallet2", label: "Debt" },
      { href: "Expenses.html", icon: "bi-receipt-cutoff", label: "Expenses" },
      { href: "StockMappings.html", icon: "bi-link-45deg", label: "Stock Mapping" },
      { href: "Settings.html", icon: "bi-sliders", label: "Settings" }
    ];
  }

  function goToProfile() {
    window.location.href = "./client/profile.html";
  }

  function doLogout() {
    if (typeof window.appLogout === "function") {
      return Promise.resolve(window.appLogout());
    }
    return import("../client/profileManager.js")
      .then(function (mod) {
        if (mod && typeof mod.logout === "function") return mod.logout();
        goToProfile();
        return null;
      })
      .catch(function () {
        goToProfile();
        return null;
      });
  }

  function getAppsScriptUrl() {
    return (typeof window !== "undefined" && window.APP_APPS_SCRIPT_URL)
      ? window.APP_APPS_SCRIPT_URL
      : "https://script.google.com/macros/s/AKfycbzkSMNGyDU7yk-pMSvF1wsEVetBJaQepnqOV8DbjbdoxS37TfszxMeGNufhe3N9viw/exec";
  }

  function isLocalDevOrigin() {
    try {
      var host = String(window.location.hostname || "").toLowerCase();
      return host === "127.0.0.1" || host === "localhost" || host === "";
    } catch (e) {
      return false;
    }
  }

  function jsonpRequest(url) {
    return new Promise(function (resolve, reject) {
      var cb = "__app_shell_jsonp_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      var u = new URL(url.toString());
      u.searchParams.set("callback", cb);
      var s = document.createElement("script");
      var done = false;
      function cleanup() {
        try { delete window[cb]; } catch (e) { window[cb] = undefined; }
        try { s.remove(); } catch (e) {}
      }
      window[cb] = function (data) {
        if (done) return;
        done = true;
        cleanup();
        resolve(data);
      };
      s.onerror = function () {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("jsonp_failed"));
      };
      s.src = u.toString();
      document.head.appendChild(s);
      setTimeout(function () {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("jsonp_timeout"));
      }, 15000);
    });
  }

  async function fetchCloudStatusForUser(userId) {
    var appsUrl = getAppsScriptUrl();
    var url = new URL(appsUrl);
    url.searchParams.set("mode", "all");
    url.searchParams.set("userId", userId);

    var parsed = null;
    try {
      var res = await fetch(url.toString(), { method: "GET" });
      if (!res.ok) throw new Error("cloud_http_" + res.status);
      var txt = await res.text();
      parsed = JSON.parse(txt);
    } catch (e) {
      if (!isLocalDevOrigin()) throw e;
      parsed = await jsonpRequest(url);
    }

    var rows = Array.isArray(parsed && parsed.rows) ? parsed.rows : [];
    rows.sort(function (a, b) {
      return new Date(a.exportedAt || 0).getTime() - new Date(b.exportedAt || 0).getTime();
    });
    var latest = rows.length ? rows[rows.length - 1] : null;
    var txCount = "-";
    if (latest && latest.jsonPayload) {
      try {
        var p = JSON.parse(String(latest.jsonPayload));
        txCount = Array.isArray(p && p.data && p.data.transactions) ? p.data.transactions.length : "-";
      } catch (e2) {}
    }
    return {
      totalSnapshots: rows.length,
      latestEvent: latest ? (latest.eventType || "-") : "-",
      latestExport: latest ? (latest.exportedAt || "-") : "-",
      latestTxCount: txCount,
      hasRecoveryHash: !!(latest && String(latest.recoveryKeyHash || "").trim())
    };
  }

  function closeProfileMenu() {
    var m = document.getElementById("appShellProfileMenu");
    if (m) m.classList.remove("show");
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function openCloudStatusModal(userId, status) {
    var modal = document.getElementById("appShellCloudModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "appShellCloudModal";
      modal.className = "cloud-status-modal";
      modal.innerHTML =
        '<div class="cloud-status-card">' +
          '<div class="d-flex justify-content-between align-items-center mb-2">' +
            '<h5 class="mb-0"><i class="bi bi-cloud-check"></i> Cloud Status</h5>' +
            '<button type="button" class="btn btn-sm btn-outline-secondary" id="appShellCloudClose">Close</button>' +
          "</div>" +
          '<div id="appShellCloudBody"></div>' +
        "</div>";
      document.body.appendChild(modal);
      modal.addEventListener("click", function (e) {
        if (e.target === modal) modal.style.display = "none";
      });
      var closeBtn = document.getElementById("appShellCloudClose");
      if (closeBtn) closeBtn.addEventListener("click", function () { modal.style.display = "none"; });
    }
    var body = document.getElementById("appShellCloudBody");
    var s = status || {};
    var statusError = String(s.error || "").trim();
    if (body) {
      body.innerHTML =
        "<div><strong>User:</strong> " + escapeHtml(userId) + "</div>" +
        "<div><strong>Total snapshots:</strong> " + escapeHtml(s.totalSnapshots || "-") + "</div>" +
        "<div><strong>Latest event:</strong> " + escapeHtml(s.latestEvent || "-") + "</div>" +
        "<div><strong>Latest export:</strong> " + escapeHtml(s.latestExport || "-") + "</div>" +
        "<div><strong>Latest tx count:</strong> " + escapeHtml(s.latestTxCount || "-") + "</div>" +
        "<div><strong>Recovery hash:</strong> " + (s.hasRecoveryHash ? "Present" : "<span class='text-danger'>Missing</span>") + "</div>" +
        (statusError ? ("<div class='text-danger mt-2'>" + escapeHtml(statusError) + "</div>") : "");
    }
    modal.style.display = "block";
  }

  function init() {
    if (isProfilePage()) return;
    if (!document.body) return;

    var file = currentFileName();
    var activeUser = String(localStorage.getItem("activeUserId") || "").trim();
    var titleText = file === "index.html" && activeUser ? activeUser : getPageTitle(file);
    var navItems = buildNavItems();

    var topbar = document.createElement("header");
    topbar.className = "app-shell-topbar";
    topbar.innerHTML =
      '<div class="app-shell-left">' +
        '<button type="button" class="app-shell-menu-btn" id="appShellMenuBtn" aria-label="Open navigation">' +
          '<i class="bi bi-layout-sidebar-inset"></i>' +
        "</button>" +
        '<div class="app-shell-title" id="appShellTitle"></div>' +
      "</div>" +
      '<div class="app-shell-right" id="appShellActions">' +
        '<button type="button" class="app-shell-action-btn" id="appShellThemeBtn" title="Toggle theme"><i class="bi bi-circle-half"></i></button>' +
        '<button type="button" class="app-shell-action-btn" id="appShellSettingsBtn" title="Settings"><i class="bi bi-sliders"></i></button>' +
        '<button type="button" class="app-shell-action-btn" id="appShellLogoutBtn" title="Sign out"><i class="bi bi-box-arrow-right"></i></button>' +
      "</div>";

    var overlay = document.createElement("div");
    overlay.className = "app-shell-overlay";
    overlay.id = "appShellOverlay";

    var drawer = document.createElement("aside");
    drawer.className = "app-shell-drawer";
    drawer.id = "appShellDrawer";

    var navHtml = navItems
      .map(function (item) {
        var active = file === String(item.href || "").toLowerCase() ? "active" : "";
        return (
          '<a class="' + active + '" href="' + item.href + '">' +
            '<i class="bi ' + item.icon + '"></i>' +
            "<span>" + item.label + "</span>" +
          "</a>"
        );
      })
      .join("");

    drawer.innerHTML =
      '<div class="app-shell-drawer-head">' +
        '<div class="app-shell-brand-row">' +
          '<div class="app-shell-brand">Finance App</div>' +
          '<button type="button" class="app-shell-close-btn" id="appShellDrawerClose" aria-label="Close menu"><i class="bi bi-x-lg"></i></button>' +
        '</div>' +
        '<div class="app-shell-user-row">' +
          '<div class="app-shell-user">' + (activeUser || "Guest") + "</div>" +
          '<div class="app-shell-profile-wrap">' +
            '<button type="button" class="app-shell-action-btn app-shell-drawer-profile-btn" id="appShellProfileBtn" title="Profile actions"><i class="bi bi-person-circle"></i></button>' +
            '<div class="app-shell-profile-menu" id="appShellProfileMenu">' +
              '<button type="button" class="app-shell-profile-item" id="appShellCloudBtn"><i class="bi bi-cloud-check"></i> Cloud Status</button>' +
              '<button type="button" class="app-shell-profile-item danger" id="appShellDeleteTxBtn"><i class="bi bi-trash3"></i> Delete Transactions</button>' +
              '<button type="button" class="app-shell-profile-item danger" id="appShellDeleteProfileBtn"><i class="bi bi-person-x"></i> Delete Profile + Transactions</button>' +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>" +
      '<nav class="app-shell-nav">' + navHtml + "</nav>";

    document.body.insertBefore(topbar, document.body.firstChild);
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    document.body.classList.add("app-shell-legacy-hide");

    var titleEl = document.getElementById("appShellTitle");
    if (titleEl) titleEl.textContent = titleText;

    var menuBtn = document.getElementById("appShellMenuBtn");
    function closeDrawer() {
      drawer.classList.remove("show");
      overlay.classList.remove("show");
    }
    function openDrawer() {
      drawer.classList.add("show");
      overlay.classList.add("show");
    }

    if (menuBtn) {
      menuBtn.addEventListener("click", function () {
        if (drawer.classList.contains("show")) closeDrawer();
        else openDrawer();
      });
    }
    var drawerCloseBtn = document.getElementById("appShellDrawerClose");
    if (drawerCloseBtn) drawerCloseBtn.addEventListener("click", closeDrawer);
    overlay.addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });

    var themeBtn = document.getElementById("appShellThemeBtn");
    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        if (typeof window.toggleTheme === "function") window.toggleTheme();
      });
    }

    var settingsBtn = document.getElementById("appShellSettingsBtn");
    if (settingsBtn) {
      settingsBtn.addEventListener("click", function () {
        if (file !== "settings.html") window.location.href = "Settings.html";
      });
    }

    var logoutBtn = document.getElementById("appShellLogoutBtn");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async function () {
        logoutBtn.disabled = true;
        try {
          var beforePath = String(window.location.pathname || "");
          if (typeof window.appShowActionProgress === "function") window.appShowActionProgress("Signing out...");
          else if (typeof window.appShowLoading === "function") window.appShowLoading("Signing out...");
          await doLogout();
          // Safety fallback: if logout resolved but navigation did not happen, force redirect.
          setTimeout(function () {
            var nowPath = String(window.location.pathname || "");
            if (nowPath === beforePath) {
              goToProfile();
            }
          }, 1200);
        } catch (e) {
          if (typeof window.appHideActionProgress === "function") window.appHideActionProgress();
          else if (typeof window.appHideLoading === "function") window.appHideLoading();
          logoutBtn.disabled = false;
        }
      });
    }

    drawer.querySelectorAll("a[href]").forEach(function (lnk) {
      lnk.addEventListener("click", closeDrawer);
    });

    var profileBtn = document.getElementById("appShellProfileBtn");
    var profileMenu = document.getElementById("appShellProfileMenu");
    if (profileBtn && profileMenu) {
      profileBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        profileMenu.classList.toggle("show");
      });
      document.addEventListener("click", function (e) {
        if (!profileMenu.classList.contains("show")) return;
        if (profileMenu.contains(e.target) || profileBtn.contains(e.target)) return;
        closeProfileMenu();
      });
    }

    var cloudBtn = document.getElementById("appShellCloudBtn");
    if (cloudBtn) {
      cloudBtn.addEventListener("click", async function () {
        closeProfileMenu();
        closeDrawer();
        var uid = String(localStorage.getItem("activeUserId") || "").trim();
        if (!uid) return;
        cloudBtn.disabled = true;
        openCloudStatusModal(uid, {
          totalSnapshots: "...",
          latestEvent: "Loading",
          latestExport: "...",
          latestTxCount: "...",
          hasRecoveryHash: false
        });
        if (typeof window.appShowActionProgress === "function") {
          window.appShowActionProgress("Checking cloud status...");
        } else if (typeof window.appShowLoading === "function") {
          window.appShowLoading("Checking cloud status...");
        }
        try {
          var status = await fetchCloudStatusForUser(uid);
          openCloudStatusModal(uid, status);
        } catch (e) {
          openCloudStatusModal(uid, {
            totalSnapshots: "-",
            latestEvent: "Unavailable",
            latestExport: "-",
            latestTxCount: "-",
            hasRecoveryHash: false,
            error: "Failed to load cloud status. Please try again."
          });
          if (typeof window.showToast === "function") window.showToast("Failed to load cloud status", "error", 3000);
        } finally {
          if (typeof window.appHideActionProgress === "function") window.appHideActionProgress();
          else if (typeof window.appHideLoading === "function") window.appHideLoading();
          cloudBtn.disabled = false;
        }
      });
    }

    var delTxBtn = document.getElementById("appShellDeleteTxBtn");
    if (delTxBtn) {
      delTxBtn.addEventListener("click", async function () {
        closeProfileMenu();
        try {
          var ok = true;
          if (typeof window.appConfirmDialog === "function") {
            ok = await window.appConfirmDialog("Delete all transactions for current user?", { title: "Delete Transactions", okText: "Delete" });
          } else {
            ok = window.confirm("Delete all transactions for current user?");
          }
          if (!ok) return;
          if (typeof window.appShowLoading === "function") window.appShowLoading("Deleting transactions...");
          var mod = await import("../client/profileManager.js");
          await mod.deleteTransactionsOnly();
          if (typeof window.showToast === "function") window.showToast("Transactions deleted", "success");
          if (typeof window.startApp === "function") {
            try { await window.startApp(); } catch (e) {}
          }
        } catch (e) {
          if (typeof window.showToast === "function") window.showToast("Delete failed", "error");
        } finally {
          if (typeof window.appHideLoading === "function") window.appHideLoading();
        }
      });
    }

    var delProfileBtn = document.getElementById("appShellDeleteProfileBtn");
    if (delProfileBtn) {
      delProfileBtn.addEventListener("click", async function () {
        closeProfileMenu();
        try {
          var ok = true;
          if (typeof window.appConfirmDialog === "function") {
            ok = await window.appConfirmDialog("Delete profile and all local data?", { title: "Delete Profile", okText: "Delete Profile" });
          } else {
            ok = window.confirm("Delete profile and all local data?");
          }
          if (!ok) return;
          if (typeof window.appShowLoading === "function") window.appShowLoading("Deleting profile...");
          var mod = await import("../client/profileManager.js");
          await mod.deleteProfileAndData();
        } catch (e) {
          if (typeof window.showToast === "function") window.showToast("Delete profile failed", "error");
          if (typeof window.appHideLoading === "function") window.appHideLoading();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

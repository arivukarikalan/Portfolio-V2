(function(){
  function ensureToastHost(){
    var host = document.getElementById('toastHost');
    if(host) return host;
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'true');
    document.body.appendChild(host);
    return host;
  }

  if (typeof window.showToast !== 'function') {
    window.showToast = function(message, type, durationMs){
      var text = String(message || '').trim();
      if(!text) return;
      var t = type || 'info';
      var life = Number.isFinite(Number(durationMs)) ? Number(durationMs) : (t === 'error' ? 4200 : 2600);
      var host = ensureToastHost();
      var icon = t === 'success' ? 'bi-check2-circle' : (t === 'error' ? 'bi-exclamation-octagon' : 'bi-info-circle');
      var toast = document.createElement('div');
      toast.className = 'app-toast ' + t;
      toast.innerHTML = '<div class="app-toast-inner"><span class="app-toast-icon"><i class="bi '+icon+'"></i></span><span class="app-toast-text"></span></div><span class="app-toast-progress"></span>';
      var txt = toast.querySelector('.app-toast-text');
      if (txt) txt.textContent = text;
      host.appendChild(toast);
      while (host.children.length > 3) host.removeChild(host.firstChild);
      setTimeout(function(){ toast.classList.add('hide'); setTimeout(function(){ toast.remove(); }, 220); }, life);
    };
  }

  window.toggleTheme = function(){
    document.body.classList.toggle('dark');
    localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  };

  window.__applyThemeAndFont = function(){
    if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');
    var s = localStorage.getItem('uiFontSize') || 'medium';
    document.documentElement.classList.remove('size-small','size-medium','size-large');
    document.documentElement.classList.add('size-' + s);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.__applyThemeAndFont);
  } else {
    window.__applyThemeAndFont();
  }

  // Fallback loading helpers for pages where Settings.js may not be loaded yet.
  if (typeof window.appShowLoading !== 'function') {
    var __loadingTimer = null;
    function __stopTimer() {
      if (__loadingTimer) {
        clearInterval(__loadingTimer);
        __loadingTimer = null;
      }
    }
    function __setProgress(p) {
      var bar = document.getElementById('appLoadingBarFill');
      var pct = document.getElementById('appLoadingPercent');
      var v = Math.max(0, Math.min(100, Number(p || 0)));
      if (bar) bar.style.width = v + '%';
      if (pct) pct.textContent = Math.round(v) + '%';
    }
    window.appShowLoading = function(message, opts) {
      var el = document.getElementById('appLoadingOverlay');
      if (!el) {
        el = document.createElement('div');
        el.id = 'appLoadingOverlay';
        el.className = 'app-loading-overlay';
        el.innerHTML = '<div class=\"app-loading-card\"><div class=\"app-loading-spinner\" aria-hidden=\"true\"></div><div class=\"app-loading-main\"><div class=\"app-loading-text\" id=\"appLoadingText\"></div><div class=\"app-loading-progress-wrap\" id=\"appLoadingProgressWrap\" style=\"display:none\"><div class=\"app-loading-progress-track\"><div class=\"app-loading-progress-fill\" id=\"appLoadingBarFill\"></div></div><div class=\"app-loading-percent\" id=\"appLoadingPercent\">0%</div></div></div></div>';
        document.body.appendChild(el);
      }
      __stopTimer();
      var textEl = document.getElementById('appLoadingText');
      var wrap = document.getElementById('appLoadingProgressWrap');
      if (textEl) textEl.textContent = String(message || 'Please wait...');
      if (wrap) wrap.style.display = (opts && opts.showProgress) ? 'block' : 'none';
      if (opts && opts.showProgress) __setProgress(Number(opts.progress || 0));
      el.style.display = 'flex';
    };
    window.appHideLoading = function() {
      __stopTimer();
      var el = document.getElementById('appLoadingOverlay');
      if (el) el.style.display = 'none';
    };
    window.appShowActionProgress = function(message) {
      var p = 3;
      window.appShowLoading(message || 'Please wait...', { showProgress: true, progress: p });
      __stopTimer();
      __loadingTimer = setInterval(function() {
        if (p >= 92) return;
        p += Math.max(1, Math.floor((100 - p) / 8));
        __setProgress(p);
      }, 700);
    };
    window.appHideActionProgress = function() {
      __setProgress(100);
      __stopTimer();
      setTimeout(function() {
        window.appHideLoading();
      }, 180);
    };
    window.appUpdateActionProgress = function(percent, message) {
      var textEl = document.getElementById('appLoadingText');
      if (textEl && message) textEl.textContent = String(message);
      __setProgress(percent);
    };
  }
})();

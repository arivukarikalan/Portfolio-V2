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
})();

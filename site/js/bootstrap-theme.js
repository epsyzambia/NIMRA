// Adds Bootstrap 5 classes to what app.js draws, so app.js can stay plain HTML. Runs after every render. Basic JS, no library.
(function () {
  var app = document.getElementById('app');
  function add(el, names) { names.split(' ').forEach(function (n) { el.classList.add(n); }); }
  function style(root) {
    root.querySelectorAll('button').forEach(function (b) {
      if (b.classList.contains('burger')) return;
      if (b.closest('.foot')) { add(b, 'btn btn-sm'); return; }
      add(b, 'btn');
      add(b, b.classList.contains('warn') ? 'btn-danger' : b.classList.contains('ghost') ? 'btn-outline-success' : 'btn-success');
      if (b.classList.contains('sm')) add(b, 'btn-sm');
    });
    root.querySelectorAll('input,textarea').forEach(function (i) {
      if (i.type === 'checkbox' || i.type === 'radio') add(i, 'form-check-input'); else add(i, 'form-control');
    });
    root.querySelectorAll('select').forEach(function (s) { add(s, 'form-select'); });
    root.querySelectorAll('label').forEach(function (l) { if (!l.querySelector('input[type=checkbox],input[type=radio]')) add(l, 'form-label'); });
    root.querySelectorAll('table').forEach(function (t) { add(t, 'table table-sm table-hover'); });
    root.querySelectorAll('.flash').forEach(function (f) { add(f, 'alert'); add(f, f.classList.contains('err') ? 'alert-danger' : 'alert-success'); });
    root.querySelectorAll('.chip').forEach(function (c) { add(c, 'btn btn-sm rounded-pill'); add(c, c.classList.contains('on') ? 'btn-success' : 'btn-outline-success'); });
    root.querySelectorAll('.pill').forEach(function (p) { add(p, 'badge rounded-pill'); });
  }
  var busy = false;
  new MutationObserver(function () {
    if (busy) return; busy = true;
    try { style(app); } finally { setTimeout(function () { busy = false; }, 0); }
  }).observe(app, { childList: true, subtree: true });
  style(app);
})();

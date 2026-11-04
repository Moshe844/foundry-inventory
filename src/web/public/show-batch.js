'use strict';
// A long list shows a few at a time, with a button for the next few.
// The whole list is in the page, so with no script everything is simply visible.
(function () {
  function setUp(list) {
    if (list.dataset.showBatchReady) return;
    list.dataset.showBatchReady = '1';
    var size = Number(list.dataset.showBatch) || 6;
    var rows = Array.prototype.slice.call(list.children);
    if (rows.length <= size) return;
    var key = 'stockchief:show-batch:' + location.pathname + location.search;
    var shown = size;
    try { shown = Math.max(size, Number(sessionStorage.getItem(key)) || size); } catch (e) { /* still works */ }
    if (list.dataset.showFocus) {
      var focused = list.querySelector(list.dataset.showFocus);
      if (focused) shown = Math.max(shown, Math.ceil((rows.indexOf(focused) + 1) / size) * size);
    }
    var bar = document.createElement('div'), more = document.createElement('button'), less = document.createElement('button'), count = document.createElement('span');
    bar.className = 'show-batch__more'; more.type = less.type = 'button'; more.setAttribute('data-show-more', ''); less.setAttribute('data-show-less', ''); less.textContent = 'Show less';
    bar.append(more, less, count); list.after(bar);
    function draw() {
      rows.forEach(function (row, index) { row.hidden = index >= shown; });
      var left = rows.length - shown;
      more.hidden = left <= 0; more.textContent = 'Show ' + Math.min(size, left) + ' more';
      less.hidden = shown <= size;
      count.textContent = Math.min(shown, rows.length) + ' of ' + rows.length;
      try { if (shown > size) sessionStorage.setItem(key, String(shown)); else sessionStorage.removeItem(key); } catch (e) { /* still works */ }
    }
    more.addEventListener('click', function () { var next = rows[shown]; shown = Math.min(rows.length, shown + size); draw(); var link = next && next.querySelector('a,button'); if (link) link.focus({ preventScroll: true }); });
    less.addEventListener('click', function () { shown = size; draw(); list.scrollIntoView({ block: 'nearest' }); });
    draw();
  }
  function run() { document.querySelectorAll('[data-show-batch]').forEach(setUp); }
  run();
  document.addEventListener('stockchief:content-updated', run);
})();

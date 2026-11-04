'use strict';
// Choosing several decisions to approve together. Delegated, because live search replaces the rows.
(function () {
  function form() { return document.querySelector('[data-bulk-approve]'); }
  function draw() {
    var f = form(); if (!f) return;
    var picked = f.querySelectorAll('[data-bulk-row]:checked').length, all = f.querySelectorAll('[data-bulk-row]').length;
    f.querySelector('[data-bulk-count]').textContent = picked ? picked + ' selected' : 'None selected';
    f.querySelector('[data-bulk-submit]').disabled = !picked;
    var where = f.querySelector('[data-bulk-where]'); if (where) where.required = picked > 0;
    var box = f.querySelector('[data-bulk-all]'); box.checked = picked > 0 && picked === all; box.indeterminate = picked > 0 && picked < all;
  }
  document.addEventListener('change', function (event) {
    var f = form(); if (!f || !f.contains(event.target)) return;
    if (event.target.matches('[data-bulk-all]')) f.querySelectorAll('[data-bulk-row]').forEach(function (row) { row.checked = event.target.checked; });
    if (event.target.matches('[data-bulk-all],[data-bulk-row],[data-bulk-where]')) draw();
  });
  document.addEventListener('stockchief:content-updated', draw);
  draw();
})();

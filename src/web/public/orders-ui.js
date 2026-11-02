/*
 * Orders list, the order page header and the after-create toast.
 *
 * Progressive: the list works without this file (links and a GET form). The
 * order entry form has its own script, order-entry-ui.js.
 */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------------- Orders list ---------------- */
  function ordersList() {
    $$('.ox-row[data-href]').forEach(function (row) {
      row.addEventListener('click', function (event) {
        if (event.target.closest('a, button, input')) return;
        if (window.getSelection && String(window.getSelection())) return;
        window.location.href = row.getAttribute('data-href');
      });
    });
    var form = $('[data-ox-search]');
    if (!form) return;
    var input = $('input[name="q"]', form);
    var initial = input.value;
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (input.value.trim() === initial.trim()) return;
        form.submit();
      }, 300);
    });
    if (initial) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  /* ---------------- After create ---------------- */
  function afterCreate() {
    var raw = null;
    try { raw = sessionStorage.getItem('ox-created'); sessionStorage.removeItem('ox-created'); } catch (ignore) { return; }
    if (!raw || !/^\/(sales\/)?orders\/so_/.test(window.location.pathname)) return;
    var flash = $('[data-flash-stack] .flash--success');
    if (!flash) return;
    var info = JSON.parse(raw);
    var said = flash.textContent;
    var held = /reserved|held/i.test(said) && !/draft|no stock (was )?reserved|not committed/i.test(said);
    var text = held
      ? 'Order created. ' + info.count + ' item' + (info.count === 1 ? '' : 's') + ' held' + (info.where ? ' from ' + info.where : '') + '.'
      : /fulfilled/i.test(said) ? 'Pickup completed.' : 'Order saved as a draft. Nothing is held yet.';
    // The server's own message becomes the toast, so its exact wording stays
    // on the page; the short headline is drawn above it.
    flash.setAttribute('data-ox-title', text);
    flash.classList.add('ox-toast');
    setTimeout(function () { flash.classList.add('is-gone'); }, 5000);
  }

  /* Order page: put the action buttons on the header row. */
  function orderHeader() {
    var actions = $('[data-ox-order-actions]');
    var head = $('.ox-ohead-wrap ~ .page-head');
    if (!actions) return;
    if (head) head.appendChild(actions);
  }

  function start() {
    orderHeader();
    var page = $('[data-ox-page]');
    if (page && page.getAttribute('data-ox-page') === 'orders') ordersList();
    afterCreate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());

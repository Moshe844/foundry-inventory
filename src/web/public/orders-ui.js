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
    document.addEventListener('click', function (event) {
      var row = event.target.closest && event.target.closest('.ox-row[data-href]');
      if (!row || event.target.closest('a, button, input')) return;
      if (window.getSelection && String(window.getSelection())) return;
      window.location.href = row.getAttribute('data-href');
    });
  }

  var ORDER_PAGE = /^\/(sales\/)?orders\/so_[^/]+$/;

  /*
   * What a button did, said where it happened. On an order page the server's
   * message floats over the page instead of pushing it down, so the page can
   * stay where the person was working.
   */
  function toasts() {
    if (!ORDER_PAGE.test(window.location.pathname) && !$('.ox-buy')) return;
    $$('[data-flash-stack] .flash').forEach(function (flash) {
      flash.classList.add('ox-toast');
      var close = document.createElement('button');
      close.type = 'button'; close.className = 'ox-toast__x'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×';
      close.addEventListener('click', function () { flash.classList.add('is-gone'); });
      flash.appendChild(close);
      if (!flash.classList.contains('flash--error')) setTimeout(function () { flash.classList.add('is-gone'); }, 6000);
    });
  }

  /*
   * Back where you were. After a button on the order page the server sends
   * the same order page, and navigation-state.js puts the scroll and the open
   * panels back. It finds a panel by id, or else by its position — and the
   * positions move as soon as a step is done, so a pickup that disappeared
   * handed its "open" to the returns form below it. Every panel here gets a
   * name taken from its own heading, so only the same panel is reopened.
   */
  function namePanels() {
    if (!ORDER_PAGE.test(window.location.pathname)) return;
    $$('main details:not([id])').forEach(function (panel) {
      var summary = $('summary', panel);
      var words = (panel.hasAttribute('data-order-lines') ? 'order lines' : summary ? summary.textContent : '')
        .toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').slice(0, 4).join('-');
      if (words && !document.getElementById('ox-' + words)) panel.id = 'ox-' + words;
    });
    // What was ordered is a table, not a choice: it stays open.
    $$('[data-order-lines]').forEach(function (lines) {
      lines.open = true;
      lines.addEventListener('toggle', function () { if (!lines.open) lines.open = true; });
    });
  }

  /* ---------------- After create ---------------- */
  function afterCreate() {
    var raw = null;
    try { raw = sessionStorage.getItem('ox-created'); sessionStorage.removeItem('ox-created'); } catch (ignore) { return; }
    if (!raw || !ORDER_PAGE.test(window.location.pathname)) return;
    var info = JSON.parse(raw);
    var flash = $('[data-flash-stack] .flash--success');
    if (!flash) {
      // A price check still running when Create was pressed can finish after
      // it and save the session without the server's message. The order was
      // made all the same, so say so from the page and carry on to payment.
      var badge = $('.page-head .badge');
      flash = document.createElement('div');
      flash.className = 'flash flash--success ox-toast';
      flash.setAttribute('role', 'status');
      flash.textContent = badge ? badge.textContent.trim() : '';
      document.body.appendChild(flash);
      setTimeout(function () { flash.classList.add('is-gone'); }, 6000);
    }
    var said = flash.textContent;
    var held = /reserved|held/i.test(said) && !/draft|no stock (was )?reserved|not committed/i.test(said);
    var text = held
      ? 'Order created. ' + info.count + ' item' + (info.count === 1 ? '' : 's') + ' held' + (info.where ? ' from ' + info.where : '') + '.'
      : /fulfilled/i.test(said) ? 'Pickup completed.' : /draft/i.test(said) ? 'Order saved as a draft. Nothing is held yet.' : '';
    // The server's own message becomes the toast, so its exact wording stays
    // on the page; the short headline is drawn above it.
    // A message about something else (a shipping account just connected) stands as it is.
    if (text) flash.setAttribute('data-ox-title', text);
    // The payment choice made on the order form opens that payment.
    if (info.pay === 'collect') openPay('cash');
    else if (info.pay === 'link') openPay('card');
  }

  /* ---------------- Order page ---------------- */
  function orderHeader() {
    var actions = $('[data-ox-order-actions]');
    var head = $('.ox-ohead-wrap ~ .page-head');
    if (actions && head) head.appendChild(actions);
  }

  function openSection(id) {
    var section = document.getElementById(id);
    if (!section || section.tagName !== 'DETAILS') return false;
    section.open = true;
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
    var first = $('input:not([type="hidden"]), select, textarea, button[type="submit"]', section);
    if (first) first.focus({ preventScroll: true });
    return true;
  }

  /*
   * Collect payment. Each tab is its own small form; cash works out the
   * change from what was handed over and records only what the order is owed.
   */
  var money = function (minor, currency) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(minor / 100); }
    catch (e) { return (minor / 100).toFixed(2); }
  };
  function payDialog() {
    var dialog = $('[data-ox-pay]');
    if (!dialog) return;
    var owed = Number(dialog.getAttribute('data-owed')) || 0;
    var currency = dialog.getAttribute('data-currency') || 'USD';
    var tabs = $$('[data-ox-pay-tab]', dialog);
    function show(name) {
      tabs.forEach(function (tab) {
        var on = tab.getAttribute('data-ox-pay-tab') === name;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
      });
      $$('[data-ox-pay-panel]', dialog).forEach(function (panel) { panel.hidden = panel.getAttribute('data-ox-pay-panel') !== name; });
    }
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () { show(tab.getAttribute('data-ox-pay-tab')); });
      tab.addEventListener('keydown', function (event) {
        var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        var next = tabs[(index + step + tabs.length) % tabs.length];
        show(next.getAttribute('data-ox-pay-tab'));
        next.focus();
      });
    });
    dialog.oxShow = show;
    var cash = $('[data-ox-cash]', dialog);
    if (cash) {
      var received = $('[data-ox-cash-received]', cash);
      var amount = $('[data-ox-cash-amount]', cash);
      var note = $('[data-ox-cash-note]', cash);
      var extra = $('[data-ox-cash-extra]', cash);
      function calc() {
        var given = Math.round((Number(received.value) || 0) * 100);
        var applied = Math.max(0, Math.min(given, owed));
        var change = Math.max(0, given - owed);
        amount.value = (applied / 100).toFixed(2);
        $('[data-ox-cash-applied]', cash).textContent = money(applied, currency);
        $('[data-ox-cash-change]', cash).textContent = money(change, currency);
        $('[data-ox-cash-change]', cash).closest('div').classList.toggle('is-on', change > 0);
        $('[data-ox-cash-left]', cash).textContent = money(owed - applied, currency);
        $('[data-ox-cash-submit]', cash).textContent = applied ? 'Record ' + money(applied, currency) + ' cash' : 'Enter the cash received';
        $('[data-ox-cash-submit]', cash).disabled = !applied;
        var parts = [];
        if (change > 0) parts.push('Cash received ' + money(given, currency) + ', change ' + money(change, currency));
        if (extra && extra.value.trim()) parts.push(extra.value.trim());
        note.value = parts.join(' · ').slice(0, 160);
      }
      received.addEventListener('input', calc);
      if (extra) extra.addEventListener('input', calc);
      calc();
    }
  }
  function openPay(tab) {
    var dialog = $('[data-ox-pay]');
    if (!dialog) return false;
    if (dialog.oxShow) dialog.oxShow(tab || 'cash');
    if (!dialog.open && dialog.showModal) dialog.showModal();
    var field = $('[data-ox-pay-panel]:not([hidden]) input:not([type="hidden"])', dialog);
    if (field) field.focus();
    return true;
  }

  function start() {
    orderHeader();
    namePanels();
    toasts();
    payDialog();
    if (window.location.hash === '#record-left') openSection('record-left');
    $$('a[href="#record-left"]').forEach(function (link) { link.addEventListener('click', function () { openSection('record-left'); }); });
    // Back from saving bank details: carry on with the transfer.
    var pay = (window.location.search.match(/[?&]pay=(cash|card|transfer|cheque)/) || [])[1];
    if (pay) openPay(pay);
    var page = $('[data-ox-page]');
    // Every list page in the kit: rows open their record, the search box searches as you type.
    if (page && ['orders', 'purchase-orders', 'suppliers', 'supplier-returns'].indexOf(page.getAttribute('data-ox-page')) >= 0) ordersList();
    afterCreate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());

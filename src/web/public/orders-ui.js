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
    // The payment choice made on the order form: take them straight to it.
    if (info.pay === 'collect') { if (!openCollect(true)) openMoney(); }
    else if (info.pay === 'link') {
      var secure = $('#secure-payment');
      if (secure) { secure.scrollIntoView({ block: 'center' }); var go = $('button, a.btn', secure); if (go) go.focus(); }
      else openCollect(true);
    }
  }

  /* Order page: put the action buttons on the header row. */
  function orderHeader() {
    var actions = $('[data-ox-order-actions]');
    var head = $('.ox-ohead-wrap ~ .page-head');
    if (!actions) return;
    if (head) head.appendChild(actions);
    var strip = $('[data-ox-order-money]');
    if (strip && head) head.insertAdjacentElement('afterend', strip);
    // The provider's own payment card lower down is where a link is made.
    $$('.card-head h2').forEach(function (h2) {
      if (/^Secure customer payment$/.test(h2.textContent.trim())) h2.closest('.card').id = 'secure-payment';
    });
    var collect = $('#ox-collect');
    // The links navigate as written (their destination is the contract); the
    // page opens the form on arrival. Opening also on click covers a click on
    // the hash that is already in the address bar.
    $$('[data-ox-collect-open]').forEach(function (link) {
      if (collect && link.getAttribute('href') === '#ox-collect') {
        link.setAttribute('aria-controls', 'ox-collect');
        // Always opens: the page may already have restored it open.
        link.addEventListener('click', function () { openCollect(true); });
      } else {
        // Same address as now: the browser only scrolls, so open the form here.
        link.addEventListener('click', function () {
          if (link.pathname === window.location.pathname && link.search === window.location.search) openMoney();
        });
      }
    });
    var linkOpen = $('[data-ox-link-open]');
    if (linkOpen && !$('#secure-payment')) linkOpen.hidden = true;
  }

  /* Sections the header points at by name. */
  var SECTIONS = { 'record-left': /^Record what physically left/, 'change-order': /^Change or cancel this order/ };
  function nameSections() {
    $$('details > summary').forEach(function (summary) {
      var text = summary.textContent.replace(/\s+/g, ' ').trim();
      Object.keys(SECTIONS).forEach(function (id) {
        if (SECTIONS[id].test(text) && !document.getElementById(id)) summary.parentElement.id = id;
      });
    });
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
   * How the customer paid. A dropdown that changed nothing became a choice
   * that asks for what that kind of payment needs (the transfer reference,
   * the cheque number, the card approval code) and says what it records.
   * The select stays as the posted field.
   */
  var METHODS = [
    { value: 'cash', label: 'Cash', ref: null, hint: 'Cash in hand.', button: 'Record cash payment' },
    { value: 'card', label: 'Card', ref: 'Approval code or last 4 digits', hint: 'Already charged on your own card machine.', button: 'Record card payment' },
    { value: 'bank transfer', label: 'Bank transfer', ref: 'Transfer reference', placeholder: 'What the transfer said', hint: 'Record it once the money is in your bank account.', button: 'Record bank transfer' },
    { value: 'cheque', label: 'Cheque', ref: 'Cheque number', hint: 'Record it when you have the cheque.', button: 'Record cheque' },
    { value: 'other', label: 'Other', ref: 'What was it?', required: true, hint: '', button: 'Record payment' },
  ];
  function paymentMethods(form, online, renameSubmit) {
    var select = $('select[name="method"]', form);
    if (!select || select.dataset.oxMethods) return;
    select.dataset.oxMethods = '1';
    var ref = $('input[name="reference"]', form);
    var refField = ref && (ref.closest('label') || ref.parentElement);
    var refLabel = refField && $('span', refField);
    var submit = $('button[type="submit"], button:not([type])', form);
    var group = document.createElement('div');
    group.className = 'ox-methods';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'How did they pay?');
    var hint = document.createElement('p');
    hint.className = 'ox-help ox-method-hint';
    METHODS.forEach(function (method) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ox-method';
      button.setAttribute('role', 'radio');
      button.dataset.value = method.value;
      button.textContent = method.label;
      button.addEventListener('click', function () { choose(method.value); button.focus(); });
      group.appendChild(button);
    });
    group.addEventListener('keydown', function (event) {
      var index = METHODS.findIndex(function (m) { return m.value === select.value; });
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (index + 1) % METHODS.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = (index + METHODS.length - 1) % METHODS.length;
      else return;
      event.preventDefault();
      choose(METHODS[index].value);
      $('[data-value="' + METHODS[index].value + '"]', group).focus();
    });
    select.classList.add('ox-native');
    select.tabIndex = -1;
    // Not inside the select's <label>: buttons there would also activate it.
    (select.closest('label') || select).insertAdjacentElement('afterend', group);
    group.insertAdjacentElement('afterend', hint);
    function choose(value) {
      var method = METHODS.filter(function (m) { return m.value === value; })[0] || METHODS[0];
      if (select.value !== method.value) { select.value = method.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
      $$('.ox-method', group).forEach(function (b) {
        var on = b.dataset.value === method.value;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      });
      if (refField) {
        refField.hidden = !method.ref;
        if (refLabel && method.ref) refLabel.textContent = method.ref + (method.required ? '' : ' (optional)');
        ref.placeholder = method.placeholder || '';
        ref.required = Boolean(method.required);
        if (!method.ref) ref.value = '';
      }
      hint.textContent = method.hint + (method.value === 'card' && online ? ' To charge the card from here instead, use the secure payment page.' : '');
      hint.hidden = !hint.textContent;
      // The page's own form keeps its button wording; other code clicks it by name.
      if (submit && renameSubmit) submit.textContent = method.button;
    }
    select.addEventListener('change', function () { choose(select.value); });
    choose(select.value || 'cash');
  }

  function openMoney() {
    var money = $('details#money');
    if (!money) return false;
    money.open = true;
    var take = $('details.take-payment', money);
    var online = $('#pay-online button, #pay-online a.btn', money);
    if (take && !online) take.open = true;
    money.scrollIntoView({ block: 'start', behavior: 'smooth' });
    var focus = take && take.open ? $('input[name="amount"]', take) : online;
    if (focus) focus.focus({ preventScroll: true });
    return true;
  }

  function openCollect(open) {
    var collect = $('#ox-collect');
    if (!collect) return false;
    collect.open = open !== false;
    if (collect.open) {
      collect.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      var amount = $('[data-ox-collect-amount]');
      if (amount) amount.focus();
    }
    return true;
  }

  function start() {
    orderHeader();
    nameSections();
    var online = Boolean($('#secure-payment, #pay-online .pay-buttons, #pay-online .pay-live'));
    var early = $('#ox-collect form');
    if (early) paymentMethods(early, online, true);
    var late = $('details.take-payment form');
    if (late) paymentMethods(late, online, false);
    ['record-left', 'change-order'].forEach(function (id) {
      if (window.location.hash === '#' + id) openSection(id);
      $$('a[href="#' + id + '"]').forEach(function (link) { link.addEventListener('click', function () { openSection(id); }); });
    });
    // "Record payment" on the Orders list lands here: open the form, not just the panel.
    if (window.location.hash === '#money' && /[?&]open=money/.test(window.location.search)) openMoney();
    // A click on "Collect payment" before this script ran only changed the hash.
    if (window.location.hash === '#ox-collect') openCollect(true);
    window.addEventListener('hashchange', function () { if (window.location.hash === '#ox-collect') openCollect(true); });
    var page = $('[data-ox-page]');
    if (page && page.getAttribute('data-ox-page') === 'orders') ordersList();
    afterCreate();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());

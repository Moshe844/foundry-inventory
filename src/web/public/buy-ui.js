/*
 * Buy pages: the supplier picker, the one-page purchase order, and the small
 * shared pieces (payment-terms select, variant grid as a side panel).
 *
 * Progressive: every form posts the same fields without this file; the
 * script only hides rows nobody added, keeps totals live and moves focus.
 */
(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------- A list that filters as you type and answers the arrow keys ---------- */
  function listbox(input, list, options) {
    var items = function () { return $$('[role="option"]', list).filter(function (li) { return !li.hidden; }); };
    var active = -1;
    function mark(index) {
      var all = items();
      all.forEach(function (li, i) { li.classList.toggle('is-active', i === index); li.setAttribute('aria-selected', String(i === index)); });
      active = index;
      if (all[index]) { all[index].scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', all[index].id || ''); }
    }
    function filter() {
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      $$('[role="option"]', list).forEach(function (li) {
        if (li.hasAttribute('data-ox-pick-keep')) return;
        var text = (li.querySelector('[data-ox-search-text]') || li).getAttribute('data-ox-search-text') || li.textContent.toLowerCase();
        li.hidden = Boolean(q) && text.indexOf(q) < 0;
        if (!li.hidden) shown += 1;
      });
      if (options.onFilter) options.onFilter(shown);
      mark(shown && q ? 0 : -1);
    }
    function open() { if (options.alwaysOpen) return; list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function close() { if (options.alwaysOpen) return; list.hidden = true; input.setAttribute('aria-expanded', 'false'); mark(-1); }
    $$('[role="option"]', list).forEach(function (li, i) { if (!li.id) li.id = list.id + '-o' + i; });
    input.addEventListener('focus', function () { open(); filter(); });
    input.addEventListener('input', function () { open(); filter(); });
    input.addEventListener('keydown', function (event) {
      var all = items();
      if (event.key === 'ArrowDown') { event.preventDefault(); open(); mark(Math.min(all.length - 1, active + 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); mark(Math.max(0, active - 1)); }
      else if (event.key === 'Enter') {
        var pick = all[active >= 0 ? active : 0];
        if (pick && (active >= 0 || input.value.trim())) { event.preventDefault(); options.choose(pick); }
      } else if (event.key === 'Escape') { input.value = ''; filter(); close(); }
    });
    list.addEventListener('mousedown', function (event) { if (event.target.closest('[role="option"]')) event.preventDefault(); });
    list.addEventListener('click', function (event) {
      var li = event.target.closest('[role="option"]');
      if (li && !event.target.closest('a, button')) options.choose(li);
    });
    document.addEventListener('click', function (event) { if (!event.target.closest('.ox-combo')) close(); });
    return { close: close, filter: filter };
  }

  /* ---------- Supplier picker on a new purchase order ---------- */
  function supplierPicker() {
    var root = $('[data-ox-pick]');
    if (!root) return;
    var input = $('[data-ox-pick-input]', root);
    var none = $('[data-ox-pick-none]', root);
    listbox(input, $('[data-ox-pick-list]', root), {
      alwaysOpen: true,
      onFilter: function (shown) { if (none) none.hidden = shown > 0; },
      choose: function (li) { var target = $('a, button', li); if (target) target.click(); },
    });
  }

  /* ---------- Payment terms: a short list, or the supplier's own words ---------- */
  function paymentTerms() {
    $$('[data-ox-terms-form]').forEach(function (form) {
      var select = $('[data-ox-terms]', form);
      var other = $('[data-ox-terms-other]', form);
      if (!select || !other) return;
      var text = $('input', other);
      function sync() {
        var isOther = select.value === '__other';
        other.hidden = !isOther;
        text.disabled = !isOther;
        select.disabled = isOther;
        if (isOther) text.focus();
      }
      select.addEventListener('change', sync);
      // Going back to the list from "Other…" is one click on the label above it.
      other.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') { select.disabled = false; select.value = ''; sync(); select.focus(); }
      });
    });
  }

  /* ---------- One-page purchase order ---------- */
  function purchaseEntry() {
    var form = $('[data-purchase-entry]');
    if (!form || !$('[data-ox-po-input]', form) && !$('[data-purchase-line]', form)) return;
    var exponent = Number(form.dataset.currencyExponent || 2);
    var currency = form.dataset.currency || 'USD';
    var date = form.elements.namedItem('expectedDate');
    var auto = form.elements.namedItem('expectedDateAuto');
    var deliver = $('[data-ox-deliver]', form);
    var scaled = function (value) { var m = String(value == null ? '' : value).trim().match(/^(\d+)(?:\.(\d{1,6}))?$/); return m ? BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0') || '0') : null; };
    var minor = function (value) { var m = String(value || '').trim().match(/^(\d+)(?:\.(\d*))?$/); if (!m || (m[2] && m[2].length > exponent)) return null; return BigInt(m[1]) * 10n ** BigInt(exponent) + BigInt((m[2] || '').padEnd(exponent, '0') || '0'); };
    var format = function (n) {
      var base = 10n ** BigInt(exponent);
      var whole = BigInt(n / base).toLocaleString('en-US');
      var frac = exponent ? '.' + (n % base).toString().padStart(exponent, '0') : '';
      return (currency === 'USD' ? '$' : currency + ' ') + whole + frac;
    };
    var rows = function () { return $$('[data-purchase-line]', form); };
    var qtyInput = function (row) { return $('[name^="quantity["]', row); };
    var isOn = function (row) { var q = String(qtyInput(row).value || '').trim(); return q !== '' && Number(q) !== 0; };
    var zero = $('[data-ox-zero]', form);
    var empty = $('[data-ox-lines-empty]', form);
    var dateTouched = false;
    if (date) date.addEventListener('input', function () { dateTouched = true; if (auto) auto.value = '0'; });

    function weekday(iso) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
      return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    function update() {
      var total = 0n;
      var units = 0;
      var valid = true;
      var days = [];
      var firstZero = null;
      var shown = 0;
      rows().forEach(function (row) {
        var on = isOn(row) || row.dataset.added === '1';
        row.hidden = !on;
        if (on) shown += 1;
        var out = $('[data-line-total]', row);
        var q = String(qtyInput(row).value || '').trim();
        var hint = $('[data-ox-packhint]', row);
        if (!q || Number(q) === 0) { if (out) out.textContent = format(0n); if (hint) hint.textContent = ''; return; }
        var costInput = $('[name^="unitCost["]', row);
        var c = minor(costInput && costInput.value);
        var pack = scaled(row.dataset.packUnits || 1);
        var count = scaled(q);
        var weightField = $('[name^="secondaryQuantity["]', row);
        var weightText = weightField && weightField.value;
        var weight = weightText ? scaled(weightText) : null;
        if (hint) hint.textContent = '= ' + (Number(q) * Number(row.dataset.packUnits || 1)).toLocaleString('en-US') + ' units';
        if (c === 0n && !firstZero) firstZero = row;
        if (count === null || pack === null || c === null || (weightText && weight === null)) { valid = false; if (out) out.textContent = 'Check quantity and cost'; return; }
        var denominator = weight === null ? 1000000000000n : 1000000n;
        var numerator = (weight === null ? count * pack : weight) * c;
        var amount = (numerator * 2n + denominator) / (denominator * 2n);
        total += amount;
        units += Number(q) * Number(row.dataset.packUnits || 1);
        if (out) out.textContent = format(amount);
        if (row.dataset.leadDays !== '') days.push(Number(row.dataset.leadDays));
      });
      var text = valid ? format(total) : 'Check the selected lines';
      $$('[data-purchase-total], [data-ox-subtotal], [data-ox-mbar-total]', form).forEach(function (node) { node.textContent = text; });
      var u = $('[data-ox-units]', form);
      if (u) u.textContent = units.toLocaleString('en-US') + ' unit' + (units === 1 ? '' : 's');
      if (empty) empty.hidden = shown > 0;
      if (zero) {
        zero.hidden = !firstZero;
        var home = firstZero && $('.ox-line__pc', firstZero);
        if (home && zero.parentNode !== home) home.appendChild(zero);
      }
      if (date && auto && auto.value === '1' && days.length && !dateTouched) {
        var value = new Date(form.dataset.today + 'T12:00:00Z');
        value.setUTCDate(value.getUTCDate() + Math.max.apply(null, days));
        date.value = value.toISOString().slice(0, 10);
      }
      var arrives = $('[data-ox-arrives]', form);
      if (arrives) {
        var where = deliver && deliver.options[deliver.selectedIndex] ? deliver.options[deliver.selectedIndex].text : '';
        arrives.textContent = !shown ? 'Add items to see when they arrive'
          : date && date.value ? 'Arrives about ' + weekday(date.value) + (where ? ' at ' + where : '')
            : 'Arrival date worked out from the lead time' + (where ? ', at ' + where : '');
      }
    }

    function add(skuId, quantity) {
      var row = $('[data-purchase-line][data-sku="' + skuId + '"]', form);
      if (!row) return null;
      var input = qtyInput(row);
      var current = Number(input.value || 0);
      input.value = String(quantity != null ? Math.max(current, Number(quantity)) : current + 1);
      row.dataset.added = '1';
      update();
      return row;
    }

    form.addEventListener('click', function (event) {
      var step = event.target.closest('[data-ox-inc], [data-ox-dec]');
      if (step) {
        var input = $('input', step.closest('.ox-step'));
        var n = Number(input.value || 0) + (step.hasAttribute('data-ox-inc') ? 1 : -1);
        input.value = String(Math.max(0, n));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
      var remove = event.target.closest('[data-ox-remove]');
      if (remove) {
        var row = remove.closest('[data-purchase-line]');
        qtyInput(row).value = '';
        delete row.dataset.added;
        update();
        var search = $('[data-ox-po-input]', form);
        if (search) search.focus();
        return;
      }
      var chip = event.target.closest('[data-ox-suggest]');
      if (chip) { add(chip.getAttribute('data-ox-suggest'), chip.getAttribute('data-qty')); chip.disabled = true; return; }
      if (event.target.closest('[data-ox-suggest-all]')) {
        $$('[data-ox-suggest]', form).forEach(function (c) { add(c.getAttribute('data-ox-suggest'), c.getAttribute('data-qty')); c.disabled = true; });
        event.target.closest('[data-ox-suggest-all]').disabled = true;
      }
    });
    form.addEventListener('input', update);
    form.addEventListener('change', update);

    var search = $('[data-ox-po-input]', form);
    if (search) {
      var picker = listbox(search, $('#' + search.getAttribute('aria-controls')), {
        choose: function (li) {
          var row = add(li.getAttribute('data-ox-po-option'));
          search.value = '';
          picker.close();
          if (row) { var q = qtyInput(row); q.focus(); q.select(); }
        },
      });
    }

    // The variant grid copies quantities in; rows for products not yet listed are added as before.
    form.addEventListener('stockchief:variant-quantities', function (event) {
      if (event.detail.kind !== 'purchase') return;
      event.detail.rows.forEach(function (entry) {
        var row = $('[data-purchase-line][data-sku="' + entry.product.id + '"]', form);
        if (!row && Number(entry.quantity) > 0) row = newLine(entry.product);
        if (row) { qtyInput(row).value = entry.quantity; row.dataset.added = '1'; }
      });
      update();
      event.preventDefault();
    });

    function newLine(product) {
      var body = $('.ox-polines tbody', form);
      if (!body) return null;
      var row = document.createElement('tr');
      row.className = 'ox-line';
      row.dataset.purchaseLine = '';
      row.dataset.sku = product.id;
      row.dataset.packUnits = String(product.packUnits || 1);
      row.dataset.leadDays = product.leadTimeDays == null ? '' : String(product.leadTimeDays);
      var cell = function (cls) { var td = document.createElement('td'); if (cls) td.className = cls; row.appendChild(td); return td; };
      var name = cell('ox-line__pc');
      var strong = document.createElement('strong');
      strong.textContent = product.display_name + ' · ' + product.code;
      name.appendChild(strong);
      if (product.secondary_unit_label) {
        var weight = document.createElement('input');
        weight.name = 'secondaryQuantity[' + product.id + ']';
        weight.inputMode = 'decimal';
        weight.placeholder = 'Actual ' + product.secondary_unit_label;
        weight.setAttribute('aria-label', 'Actual weight for ' + product.display_name);
        name.appendChild(weight);
      }
      var qty = document.createElement('input');
      qty.type = 'number'; qty.min = '0'; qty.step = 'any';
      qty.name = 'quantity[' + product.id + ']';
      qty.setAttribute('aria-label', 'Packs of ' + product.display_name);
      cell('ox-line__qty').appendChild(qty);
      var cost = document.createElement('input');
      cost.className = 'ox-input ox-price';
      cost.name = 'unitCost[' + product.id + ']';
      cost.inputMode = 'decimal';
      cost.placeholder = '$0.00';
      cost.value = product.supplierUnitCost == null ? '' : Number(product.supplierUnitCost).toFixed(exponent);
      cost.setAttribute('aria-label', 'Unit cost for ' + product.display_name);
      cell('ox-r').appendChild(cost);
      var total = cell('ox-r ox-num ox-line__tot');
      total.dataset.lineTotal = '';
      cell('ox-r');
      body.appendChild(row);
      return row;
    }

    if (deliver) deliver.addEventListener('change', update);
    update();
  }

  /* ---------- The variant grid, as a side panel with a product list ---------- */
  function gridPanel() {
    $$('.ox-buy [data-quantity-grid]').forEach(function (root) {
      var dialog = $('[data-grid-dialog]', root);
      var select = $('[data-grid-product]', root);
      var search = $('[data-grid-search]', root);
      if (!dialog || !select || !search) return;
      dialog.classList.add('ox', 'ox-drawer', 'ox-gridpanel');
      select.classList.add('ox-native');
      select.tabIndex = -1;
      var label = select.closest('label');
      if (label) label.classList.add('ox-gridpanel__native');
      search.setAttribute('role', 'combobox');
      search.setAttribute('aria-autocomplete', 'list');
      search.setAttribute('aria-controls', 'ox-grid-products');
      search.placeholder = 'Search products';
      var list = document.createElement('ul');
      list.className = 'ox-gridlist';
      list.id = 'ox-grid-products';
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', 'Products');
      search.closest('label').after(list);
      function render() {
        list.replaceChildren();
        Array.prototype.forEach.call(select.options, function (option) {
          if (!option.value) return;
          var li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.setAttribute('aria-selected', String(option.value === select.value));
          li.tabIndex = 0;
          li.textContent = option.textContent;
          li.addEventListener('click', function () { choose(option.value); });
          li.addEventListener('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(option.value); }
            else if (event.key === 'ArrowDown' && li.nextElementSibling) { event.preventDefault(); li.nextElementSibling.focus(); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); (li.previousElementSibling || search).focus(); }
          });
          list.appendChild(li);
        });
      }
      function choose(value) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        render();
      }
      search.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown' && list.firstElementChild) { event.preventDefault(); list.firstElementChild.focus(); }
      });
      new MutationObserver(render).observe(select, { childList: true });
      render();
    });
  }

  /* ---------- Receive a delivery: live count, good and damaged ---------- */
  function receive() {
    var form = $('[data-ox-receive]');
    if (!form) return;
    var rows = $$('[data-ox-rcv-line]', form);
    var qty = function (row) { return $('[name^="qty_"]', row); };
    var damaged = function (row) { var r = $('input[value="damaged"]', row); return Boolean(r && r.checked); };
    function update() {
      var n = 0; var bad = 0; var left = 0;
      rows.forEach(function (row) {
        var q = Math.max(0, Number(qty(row).value || 0));
        var max = Number(row.dataset.left || 0);
        n += q;
        if (damaged(row)) bad += q;
        left += Math.max(0, max - q);
        // Weights, batches and serials are needed only for a line that is arriving.
        $$('[data-receipt-measure]', row).forEach(function (field) { field.required = q > 0; });
        row.classList.toggle('is-off', q === 0);
      });
      $$('[data-ox-rcv-n]').forEach(function (node) { node.textContent = n; });
      var good = $('[data-ox-rcv-good]', form); if (good) good.textContent = n - bad;
      var badOut = $('[data-ox-rcv-bad]', form); if (badOut) badOut.textContent = bad;
      var leftOut = $('[data-ox-rcv-left]', form); if (leftOut) leftOut.textContent = left;
      $$('[data-ox-rcv-label]').forEach(function (b) { b.textContent = n ? 'Receive ' + n + ' unit' + (n === 1 ? '' : 's') : 'Enter what arrived'; b.disabled = !n; });
      var status = $('[data-ox-rcv-status]', form);
      if (status) status.textContent = !n ? 'Nothing entered yet.' : left ? left + ' still to come. ' + form.dataset.po + ' stays open.' : 'This completes ' + form.dataset.po + '.';
    }
    form.addEventListener('click', function (event) {
      var step = event.target.closest('[data-ox-inc], [data-ox-dec]');
      if (step) {
        var input = $('input', step.closest('.ox-step'));
        var max = Number(input.max || Infinity);
        input.value = String(Math.min(max, Math.max(0, Number(input.value || 0) + (step.hasAttribute('data-ox-inc') ? 1 : -1))));
        update();
        return;
      }
      if (event.target.closest('[data-ox-rcv-fill]')) { rows.forEach(function (row) { qty(row).value = row.dataset.left; }); update(); }
      if (event.target.closest('[data-ox-rcv-clear]')) { rows.forEach(function (row) { qty(row).value = '0'; }); update(); }
    });
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    update();
  }

  /* ---------- What to order: choose groups and rows, costs follow the numbers ---------- */
  function reorder() {
    var form = $('[data-ox-reorder]');
    if (!form) return;
    var money = function (minor) { return '$' + (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var groups = $$('[data-ox-ro-group]', form);
    function update() {
      var selected = 0; var total = 0;
      groups.forEach(function (group) {
        var on = $('[data-ox-ro-groupchk]', group).checked;
        var sum = 0;
        $$('[data-ox-ro-row]', group).forEach(function (row) {
          var include = $('input[type="checkbox"]', row).checked;
          var qty = Math.max(0, Number($('input[type="number"]', row).value || 0));
          var unit = row.dataset.unitCost === '' ? null : Number(row.dataset.unitCost);
          var cost = unit == null ? null : Math.round(qty * Number(row.dataset.pack || 1) * unit);
          var cell = $('[data-ox-ro-cost]', row);
          if (cell) cell.textContent = cost == null ? '—' : money(cost);
          row.classList.toggle('is-off', !include || !qty);
          if (include && cost) sum += cost;
        });
        $('[data-ox-ro-gtotal]', group).textContent = money(sum);
        group.classList.toggle('is-off', !on);
        if (on) { selected += 1; total += sum; }
      });
      var make = $('[data-ox-ro-make]');
      if (make) { make.textContent = selected ? 'Create ' + selected + ' draft PO' + (selected === 1 ? '' : 's') : 'Choose a supplier'; make.disabled = !selected; }
      var out = $('[data-ox-ro-selected]', form);
      if (out) out.textContent = money(total);
    }
    form.addEventListener('change', function (event) {
      var groupBox = event.target.closest('[data-ox-ro-groupchk]');
      if (groupBox) $$('[data-ox-ro-row] input[type="checkbox"]', groupBox.closest('[data-ox-ro-group]')).forEach(function (box) { box.checked = groupBox.checked; });
      update();
    });
    form.addEventListener('input', update);
    form.addEventListener('click', function (event) {
      var all = event.target.closest('[data-ox-ro-all]');
      if (!all) return;
      var group = all.closest('[data-ox-ro-group]');
      $$('[data-ox-ro-more]', group).forEach(function (row) { row.hidden = false; });
      var showing = $('[data-ox-ro-showing]', group);
      if (showing) showing.textContent = 'Showing all ' + $$('[data-ox-ro-row]', group).length;
      all.remove();
    });
    update();
  }

  /* ---------- Tabs that switch a card's content (Products / Orders / Bills) ---------- */
  function panes() {
    $$('[data-ox-panes]').forEach(function (root) {
      var tabs = $$('[data-ox-pane]', root);
      function show(name, focus) {
        tabs.forEach(function (tab) {
          var on = tab.getAttribute('data-ox-pane') === name;
          tab.classList.toggle('is-on', on);
          tab.setAttribute('aria-selected', String(on));
          tab.tabIndex = on ? 0 : -1;
          if (on && focus) tab.focus();
        });
        $$('[data-ox-pane-body]', root).forEach(function (body) { body.hidden = body.getAttribute('data-ox-pane-body') !== name; });
      }
      tabs.forEach(function (tab, index) {
        tab.addEventListener('click', function () { show(tab.getAttribute('data-ox-pane')); });
        tab.addEventListener('keydown', function (event) {
          var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          if (step) { event.preventDefault(); show(tabs[(index + step + tabs.length) % tabs.length].getAttribute('data-ox-pane'), true); }
        });
      });
    });
  }

  /* ---------- A searchable list in front of a native select (it stays the posted field) ---------- */
  function selectCombos() {
    $$('[data-ox-select-combo]').forEach(function (root) {
      var input = $('[data-ox-select-input]', root);
      var list = $('[role="listbox"]', root);
      var select = $('select', root);
      if (!input || !list || !select) return;
      Array.prototype.forEach.call(select.options, function (option, i) {
        if (!option.value) return;
        var li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');
        li.id = list.id + '-' + i;
        li.textContent = option.textContent;
        li.setAttribute('data-ox-search-text', option.textContent.toLowerCase());
        li.dataset.value = option.value;
        list.appendChild(li);
      });
      function pick(li) {
        select.value = li.dataset.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = li.textContent;
        combo.close();
      }
      var combo = listbox(input, list, { choose: pick });
      if (select.value && select.selectedOptions[0]) input.value = select.selectedOptions[0].textContent;
    });
  }

  // Record payment from the purchase order list lands here with ?pay=1: open the first bill's panel.
  function openFromQuery() {
    // "Add email" on the supplier list opens the supplier's Edit panel.
    // + New return on Supplier returns lands here with ?return=1: open this order's return panel.
    if (/[?&]return=1(&|$)/.test(window.location.search)) { var ret = $('#ox-return'); if (ret && ret.showModal && !ret.open) ret.showModal(); }
    if (/[?&]edit=1(&|$)/.test(window.location.search)) { var edit = $('#ox-supplier-drawer'); if (edit && edit.showModal && !edit.open) edit.showModal(); }
    if (!/[?&]pay=1(&|$)/.test(window.location.search)) return;
    var dialog = $('[data-ox-pay-bill]');
    if (dialog && dialog.showModal && !dialog.open) dialog.showModal();
  }

  function start() {
    openFromQuery();
    supplierPicker();
    paymentTerms();
    purchaseEntry();
    receive();
    reorder();
    panes();
    selectCombos();
    gridPanel();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
}());

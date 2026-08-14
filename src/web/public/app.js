/* Foundry Inventory — client behaviour.

   Every page renders, navigates and validates on the server. This file adds
   the conveniences: search suggestions, the action dialogs, live "on hand"
   hints, and filter auto-submit. The dialogs do need JavaScript to open;
   everything else degrades to plain pages and form posts. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ search -- */

  function initSearch() {
    const input = document.querySelector('[data-search]');
    const panel = document.querySelector('[data-search-results]');
    if (!input || !panel) return;

    let timer = null;
    let controller = null;
    let activeIndex = -1;

    const close = () => {
      panel.hidden = true;
      panel.innerHTML = '';
      activeIndex = -1;
    };

    const render = (results) => {
      if (!results.length) {
        panel.innerHTML = '<div class="search-empty">No matches yet.</div>';
        panel.hidden = false;
        return;
      }
      panel.innerHTML = results
        .map(
          (r) =>
            `<a class="search-hit" href="${r.href}"><span><strong>${escapeHtml(r.title)}</strong>` +
            `<span class="sub"> ${escapeHtml(r.subtitle)}</span></span>` +
            `<span class="meta">${escapeHtml(r.meta || '')}</span></a>`
        )
        .join('');
      panel.hidden = false;
      activeIndex = -1;
    };

    input.addEventListener('input', () => {
      const term = input.value.trim();
      window.clearTimeout(timer);
      if (term.length < 2) return close();
      timer = window.setTimeout(() => {
        if (controller) controller.abort();
        controller = new AbortController();
        fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
          .then((res) => (res.ok ? res.json() : { results: [] }))
          .then((data) => render(data.results || []))
          .catch(() => {});
      }, 160);
      return undefined;
    });

    input.addEventListener('keydown', (event) => {
      const hits = [...panel.querySelectorAll('.search-hit')];
      if (event.key === 'Escape') return close();
      if (!hits.length) return undefined;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        activeIndex += event.key === 'ArrowDown' ? 1 : -1;
        if (activeIndex < 0) activeIndex = hits.length - 1;
        if (activeIndex >= hits.length) activeIndex = 0;
        hits.forEach((hit, index) => hit.classList.toggle('is-active', index === activeIndex));
        hits[activeIndex].scrollIntoView({ block: 'nearest' });
      }
      if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        window.location.href = hits[activeIndex].getAttribute('href');
      }
      return undefined;
    });

    document.addEventListener('click', (event) => {
      if (!panel.contains(event.target) && event.target !== input) close();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && document.activeElement === document.body) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  /* ------------------------------------------------------------ modals -- */

  function initModals() {
    document.addEventListener('click', (event) => {
      const opener = event.target.closest('[data-modal-open]');
      if (opener) {
        const dialog = document.getElementById(opener.getAttribute('data-modal-open'));
        if (dialog && typeof dialog.showModal === 'function') {
          event.preventDefault();
          const preset = opener.getAttribute('data-preset-sku');
          if (preset) {
            const select = dialog.querySelector('[name="skuId"]');
            if (select) {
              select.value = preset;
              select.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          dialog.showModal();
          const focusable = dialog.querySelector('select, input:not([type=hidden]), textarea');
          if (focusable) window.setTimeout(() => focusable.focus(), 30);
        }
        return;
      }
      const closer = event.target.closest('[data-modal-close]');
      if (closer) {
        const dialog = closer.closest('dialog');
        if (dialog) {
          event.preventDefault();
          dialog.close();
        }
      }
    });

    // Clicking the backdrop closes the dialog.
    document.querySelectorAll('dialog.modal').forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    });

    // Open a modal named in the query string (?action=receive).
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');
    if (action) {
      const dialog = document.getElementById(`modal-${action}`);
      if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    }
  }

  /* -------------------------------------------------------------- tabs -- */

  function initTabs() {
    document.querySelectorAll('[data-tabs]').forEach((group) => {
      const tabs = [...group.querySelectorAll('[data-tab]')];
      const panels = [...document.querySelectorAll('[data-tab-panel]')];
      if (!tabs.length) return;
      const select = (name) => {
        tabs.forEach((tab) => tab.classList.toggle('is-active', tab.getAttribute('data-tab') === name));
        panels.forEach((panel) => {
          panel.hidden = panel.getAttribute('data-tab-panel') !== name;
        });
      };
      tabs.forEach((tab) => {
        tab.addEventListener('click', (event) => {
          event.preventDefault();
          select(tab.getAttribute('data-tab'));
        });
      });
      select(tabs[0].getAttribute('data-tab'));
    });
  }

  /* --------------------------------------------- stock-aware modal hints -- */

  function initStockHints() {
    const dataEl = document.getElementById('item-data');
    if (!dataEl) return;
    let data;
    try {
      data = JSON.parse(dataEl.textContent);
    } catch (err) {
      return;
    }

    // Some readouts are <input readonly>, some are plain text.
    const show = (el, text) => {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = text;
      else el.textContent = text;
    };

    const onHand = (skuId, locationId) => {
      const sku = data.skus.find((s) => s.id === skuId);
      if (!sku) return 0;
      const row = sku.perLocation.find((l) => l.locationId === locationId);
      return row ? row.onHand : 0;
    };

    document.querySelectorAll('[data-stock-form]').forEach((form) => {
      const skuSelect = form.querySelector('[name="skuId"]');
      const locationSelect = form.querySelector('[name="locationId"], [name="fromLocationId"]');
      const output = form.querySelector('[data-onhand]');
      const expected = form.querySelector('[data-expected]');
      const lotSelect = form.querySelector('[name="lotId"]');
      const unitList = form.querySelectorAll('[data-unit]');

      const update = () => {
        const skuId = skuSelect ? skuSelect.value : data.skus[0] && data.skus[0].id;
        const locationId = locationSelect ? locationSelect.value : null;
        if (output && locationId) {
          const value = onHand(skuId, locationId);
          show(output, `${value} on hand here`);
        }
        if (expected && locationId) {
          const value = data.trackingMode === 'lot' && lotSelect && lotSelect.value
            ? lotQuantity(lotSelect.value, locationId)
            : onHand(skuId, locationId);
          show(expected, String(value));
          const countedInput = form.querySelector('[name="countedQty"]');
          if (countedInput && !countedInput.dataset.touched) countedInput.value = String(value);
        }
        if (lotSelect) {
          [...lotSelect.options].forEach((option) => {
            if (!option.value) return;
            const lot = data.lots.find((l) => l.id === option.value);
            if (!lot) return;
            const qty = locationId ? lotQuantity(lot.id, locationId) : lot.total;
            option.textContent = `${lot.code} — ${qty} here${lot.expiresAt ? ` · expires ${lot.expiresAt.slice(0, 10)}` : ''}`;
            option.hidden = lot.skuId !== skuId;
          });
          if (lotSelect.selectedOptions[0] && lotSelect.selectedOptions[0].hidden) lotSelect.value = '';
        }
        unitList.forEach((row) => {
          const matchesSku = !skuId || row.getAttribute('data-sku') === skuId;
          const matchesLocation = !locationId || row.getAttribute('data-location') === locationId;
          const visible = matchesSku && matchesLocation;
          row.hidden = !visible;
          const checkbox = row.querySelector('input[type="checkbox"]');
          if (checkbox && !visible) checkbox.checked = false;
        });
        const emptyNote = form.querySelector('[data-unit-empty]');
        if (emptyNote) {
          const anyVisible = [...unitList].some((row) => !row.hidden);
          emptyNote.hidden = anyVisible;
        }
      };

      const lotQuantity = (lotId, locationId) => {
        const lot = data.lots.find((l) => l.id === lotId);
        if (!lot) return 0;
        const row = lot.perLocation.find((l) => l.locationId === locationId);
        return row ? row.quantity : 0;
      };

      [skuSelect, locationSelect, lotSelect].forEach((el) => {
        if (el) el.addEventListener('change', update);
      });
      const counted = form.querySelector('[name="countedQty"]');
      if (counted) counted.addEventListener('input', () => { counted.dataset.touched = '1'; });
      update();
    });
  }

  /* ------------------------------------------------------- misc helpers -- */

  function initConfirms() {
    document.addEventListener('submit', (event) => {
      const form = event.target;
      const message = form.getAttribute('data-confirm');
      if (message && !window.confirm(message)) {
        event.preventDefault();
        return;
      }
      // Stop double submits on slow connections.
      const submit = form.querySelector('button[type="submit"]:not([data-no-lock])');
      if (submit) {
        window.setTimeout(() => {
          submit.disabled = true;
        }, 0);
        window.setTimeout(() => {
          submit.disabled = false;
        }, 4000);
      }
    });
  }

  /** The example prompts on Foundry's screens fill the box rather than submit. */
  function initFoundry() {
    document.addEventListener('click', (event) => {
      const filler = event.target.closest('[data-fill]');
      if (filler) {
        const box = document.getElementById('description');
        if (box) {
          box.value = filler.getAttribute('data-fill');
          box.focus();
        }
        return;
      }
      const asker = event.target.closest('[data-fill-ask]');
      if (asker) {
        const input = document.querySelector('[data-ask-input]');
        if (input) {
          input.value = asker.getAttribute('data-fill-ask');
          input.focus();
        }
      }
    });
  }

  /**
   * The progress page for a long Foundry job. Polls the real stage the server
   * is in, so the steps reflect actual work rather than a timer.
   */
  function initThinking() {
    const panel = document.querySelector('[data-job]');
    if (!panel) return;

    const jobId = panel.getAttribute('data-job');
    const steps = [...panel.querySelectorAll('[data-step]')];
    const elapsed = panel.querySelector('[data-elapsed]');
    const order = steps.map((step) => step.getAttribute('data-step'));
    const startedAt = Date.now();
    let stopped = false;

    const paint = (stage) => {
      const current = order.indexOf(stage);
      steps.forEach((step, index) => {
        step.classList.toggle('is-done', current > index);
        step.classList.toggle('is-current', current === index);
      });
    };

    const tick = () => {
      if (elapsed) elapsed.textContent = `${Math.round((Date.now() - startedAt) / 1000)}s elapsed`;
    };
    const timer = window.setInterval(tick, 1000);

    const poll = () => {
      if (stopped) return;
      fetch(`/api/foundry/jobs/${encodeURIComponent(jobId)}`, { headers: { accept: 'application/json' } })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('gone'))))
        .then((job) => {
          if (job.redirectTo) {
            stopped = true;
            window.clearInterval(timer);
            window.location.href = job.redirectTo;
            return;
          }
          if (job.status === 'failed') {
            stopped = true;
            window.clearInterval(timer);
            window.location.reload();
            return;
          }
          paint(job.stage);
          window.setTimeout(poll, 1500);
        })
        .catch(() => {
          // The server may have restarted; let the page reload and decide.
          stopped = true;
          window.clearInterval(timer);
          window.location.reload();
        });
    };

    window.setTimeout(poll, 800);
  }

  /** Short Foundry calls (seconds) just need the button to look busy. */
  function initBusyButtons() {
    document.addEventListener('submit', (event) => {
      const form = event.target.closest('[data-busy]');
      if (!form) return;
      const button = form.querySelector('button[type=submit]');
      if (button && !button.disabled) {
        button.classList.add('is-busy');
        button.setAttribute('aria-busy', 'true');
      }
    });
  }

  /**
   * Ask Foundry runs a real model call before the page can answer. Saying so is
   * the difference between "thinking" and "broken".
   */
  function initAskPending() {
    const form = document.querySelector('[data-ask-form]');
    if (!form) return;

    // Choosing a file is the whole instruction — nobody wants to pick a
    // spreadsheet and then hunt for a second button.
    const attach = form.querySelector('.ask-attach input[type="file"]');
    if (attach) {
      attach.addEventListener('change', () => {
        if (!attach.files || !attach.files.length) return;
        const label = attach.closest('.ask-attach');
        if (label) {
          label.classList.add('is-chosen');
          const text = label.querySelector('span');
          if (text) text.textContent = attach.files[0].name;
        }
        form.requestSubmit();
      });
    }

    form.addEventListener('submit', () => {
      const pending = form.parentElement.querySelector('[data-ask-pending]');
      if (pending) pending.hidden = false;
      const button = form.querySelector('[data-ask-submit]');
      if (button) {
        button.classList.add('is-busy');
        button.setAttribute('aria-busy', 'true');
      }
    });
  }

  /**
   * The inventory switcher. It is a real form per option, so switching works
   * with JavaScript off too — this only collapses the list until it is wanted.
   */
  function initSwitcher() {
    const root = document.querySelector('[data-switcher]');
    if (!root) return;
    const toggle = root.querySelector('[data-switcher-toggle]');
    const menu = root.querySelector('[data-switcher-menu]');
    if (!toggle || !menu) return;

    const close = () => {
      menu.hidden = true;
      root.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    };
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      root.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (event) => {
      if (!root.contains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });
  }

  function initAutoFilters() {
    document.querySelectorAll('[data-auto-submit]').forEach((el) => {
      el.addEventListener('change', () => el.form && el.form.submit());
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSearch();
    initModals();
    initTabs();
    initStockHints();
    initConfirms();
    initAutoFilters();
    initFoundry();
    initThinking();
    initBusyButtons();
    initAskPending();
    initSwitcher();
  });
})();

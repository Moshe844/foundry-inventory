/* Foundry Inventory — client behaviour.

   Every page renders, navigates and validates on the server. This file adds
   the conveniences: search suggestions, the action dialogs, live "on hand"
   hints, and filter auto-submit. The dialogs do need JavaScript to open;
   everything else degrades to plain pages and form posts. */
(function () {
  'use strict';

  // Foundry has a long home page and many links return to a specific section
  // on it. Browser scroll restoration can win the race against a fragment and
  // leave the person at an unrelated position from a previous visit. Foundry
  // owns that landing behaviour instead: full pages start at the top, while a
  // fragment reveals the named section.
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';

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
    /**
   * Open a dialog straight from the address bar: /inventory/abc#modal-receive.
   *
   * Lets a page elsewhere link to the thing that would actually change what it
   * is describing — "this product has no stock" pointing at the receive form —
   * rather than dropping somebody on a screen to find it themselves.
   */
  function openModalFromHash() {
    const id = (window.location.hash || '').replace(/^#/, '');
    if (!id) return;
    const dialog = document.getElementById(id);
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
  }
  window.addEventListener('hashchange', openModalFromHash);
  openModalFromHash();

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
    //
    // Any remaining parameter fills the field of the same name inside that
    // modal, so a link that says "receive these 40" can arrive with the
    // product, location and quantity already in it. Somebody sent here from an
    // investigation has already told Foundry all three; asking again is how a
    // one-click fix turns back into a form. Only fields the form already has
    // are touched, and nothing is submitted — the person still presses the
    // button.
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');
    if (action) {
      const dialog = document.getElementById(`modal-${action}`);
      if (dialog) {
        params.forEach((value, key) => {
          if (key === 'action' || key === '_csrf') return;
          const field = dialog.querySelector(`[name="${CSS.escape(key)}"]`);
          if (!field || field.type === 'hidden') return;
          field.value = value;
          field.dispatchEvent(new Event('change', { bubbles: true }));
        });
        if (typeof dialog.showModal === 'function') dialog.showModal();
      }
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

  function initNavigationLanding() {
    let scheduledFrame = null;

    const hashTarget = () => {
      if (!window.location.hash) return null;
      try {
        return document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      } catch {
        return null;
      }
    };

    const land = () => {
      if (scheduledFrame !== null) window.cancelAnimationFrame(scheduledFrame);
      scheduledFrame = window.requestAnimationFrame(() => {
        scheduledFrame = null;
        const target = hashTarget();

        // Modal fragments are handled by initModals. Moving the document
        // behind an open dialog would be surprising and serves no purpose.
        if (target && target.tagName === 'DIALOG') return;

        if (target) {
          // A response to Tell Foundry belongs beside the request box. The
          // global message area is above a long home page; scrolling to the
          // input used to hide the answer that had just arrived. Move that
          // one rendered message stack into the command body before landing.
          if (target.id === 'tell-foundry') {
            const feedback = document.querySelector('[data-flash-stack]');
            const body = target.querySelector('.operator-command__body');
            const form = body && body.querySelector('.operator-command__form');
            if (feedback && body && form && !target.contains(feedback)) body.insertBefore(feedback, form);
          }
          target.scrollIntoView({ block: 'start', inline: 'nearest' });

          // "Tell Foundry" is an input destination, not merely a heading. Put
          // the cursor where the person can immediately type, without letting
          // focus undo the carefully offset scroll position.
          const input = target.matches('input:not([type="hidden"]), textarea, select')
            ? target
            : target.id === 'tell-foundry' ? target.querySelector('[data-ask-input]') : null;
          if (input && !input.disabled) input.focus({ preventScroll: true });
          return;
        }

        window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      });
    };

    // New documents and restored documents use the same truthful destination.
    window.addEventListener('pageshow', land);
    window.addEventListener('hashchange', land);

    // Re-clicking the current fragment does not fire hashchange, so make that
    // common case deterministic too.
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href]');
      if (!link) return;
      let destination;
      try {
        destination = new URL(link.href, window.location.href);
      } catch {
        return;
      }
      const sameDocument = destination.origin === window.location.origin
        && destination.pathname === window.location.pathname
        && destination.search === window.location.search;
      if (sameDocument && destination.hash) window.setTimeout(land, 0);
    });

    land();
  }

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
      if (event.defaultPrevented) return;
      const form = event.target.closest('form');
      if (!form || form.hasAttribute('data-no-busy')) return;
      // Use the control the person actually chose. Forms with two decisions
      // must never make the first button look selected when the second one was
      // clicked.
      const button = event.submitter && event.submitter.matches('button[type=submit]')
        ? event.submitter
        : form.querySelector('button[type=submit]');
      if (button && !button.disabled) {
        button.classList.add('is-busy');
        button.setAttribute('aria-busy', 'true');
      }
    });
  }

  function initSetupSource() {
    const source = document.querySelector('.foundry-source input[type="file"]');
    if (!source) return;
    const picker = document.querySelector('[data-source-picker]');
    if (picker) picker.addEventListener('click', () => source.click());
    source.addEventListener('change', () => {
      const name = document.querySelector('[data-source-name]');
      if (name && source.files && source.files[0]) name.textContent = source.files[0].name;
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

  function initVendorVocabulary() {
    const input = document.querySelector('[data-vendor-code-label-input]');
    if (!input) return;
    const sync = () => {
      const label = input.value.trim() || 'Product code';
      document.querySelectorAll('[data-vendor-code-label]').forEach((node) => { node.textContent = label; });
      document.querySelectorAll('[data-vendor-code-cell]').forEach((node) => { node.dataset.label = label; });
    };
    input.addEventListener('input', sync);
    sync();
  }

  /** Make the compact Home attachment control tell the truth before submit. */
  function initOperatorAttachment() {
    document.querySelectorAll('[data-operator-command-form]').forEach((form) => {
      const input = form.querySelector('[data-operator-attachment]');
      const status = form.parentElement.querySelector('[data-operator-attachment-status]');
      const name = status && status.querySelector('[data-operator-attachment-name]');
      if (!input || !status || !name) return;

      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        status.hidden = !file;
        name.textContent = file ? file.name : '';
        const label = input.closest('.operator-command__attach');
        if (label) label.classList.toggle('is-chosen', Boolean(file));
      });
    });
  }

  // Home follows the manager rather than requiring a refresh. It deliberately
  // waits while somebody is typing, so a new automatic result never steals a
  // half-written Tell Foundry instruction.
  function initLiveHome() {
    const marker = document.querySelector('[data-live-home]');
    if (!marker) return;
    let signature = marker.dataset.signature || '';
    const tick = () => {
      if (document.hidden) return;
      fetch('/api/home-state', { headers: { Accept: 'application/json' } })
        .then((response) => response.ok ? response.json() : null)
        .then((state) => {
          if (!state || !state.signature || state.signature === signature) return;
          const command = document.querySelector('#ask-question');
          if (command && (command.value.trim() || document.activeElement === command)) {
            return;
          }
          window.location.reload();
        })
        .catch(() => {});
    };
    window.setInterval(tick, 3000);
  }

  /** Turn server-rendered upload warnings into a real blocking modal. */
  function initScopeWarnings() {
    document.querySelectorAll('dialog[data-scope-warning]').forEach((dialog) => {
      if (typeof dialog.showModal !== 'function') return;
      if (dialog.open) dialog.close();
      dialog.showModal();
    });
  }

  /** Reusable multi-record picker: choose any subset, or select/clear all. */
  function initSelectionGroups() {
    document.querySelectorAll('[data-selection-group]').forEach((group) => {
      const items = [...group.querySelectorAll('[data-selection-item]')];
      const count = group.querySelector('[data-selection-count]');
      const submit = group.querySelector('[data-remove-selected]');
      const update = () => {
        const selected = items.filter((item) => item.checked).length;
        if (count) count.textContent = `${selected} selected`;
        if (submit) submit.disabled = selected === 0;
      };
      items.forEach((item) => item.addEventListener('change', update));
      const all = group.querySelector('[data-select-all]');
      if (all) all.addEventListener('click', () => {
        items.forEach((item) => { item.checked = true; });
        update();
      });
      const clear = group.querySelector('[data-clear-selection]');
      if (clear) clear.addEventListener('click', () => {
        items.forEach((item) => { item.checked = false; });
        update();
      });
      update();
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNavigationLanding();
    initSearch();
    initModals();
    initTabs();
    initStockHints();
    initConfirms();
    initAutoFilters();
    initFoundry();
    initThinking();
    initBusyButtons();
    initSetupSource();
    initOperatorAttachment();
    initAskPending();
    initSwitcher();
    initVendorVocabulary();
    initLiveHome();
    initScopeWarnings();
    initSelectionGroups();
  });
})();

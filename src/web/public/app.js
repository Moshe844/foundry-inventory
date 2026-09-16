/* StockChief Inventory — client behaviour.

   Every page renders, navigates and validates on the server. This file adds
   the conveniences: search suggestions, the action dialogs, live "on hand"
   hints, and filter auto-submit. The dialogs do need JavaScript to open;
   everything else degrades to plain pages and form posts. */
(function () {
  'use strict';

  // StockChief has a long home page and many links return to a specific section
  // on it. Browser scroll restoration can win the race against a fragment and
  // leave the person at an unrelated position from a previous visit. StockChief
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
    // investigation has already told StockChief all three; asking again is how a
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
          // A destination is not reached when it is still hidden inside a
          // closed disclosure. Open the exact <details> target and every
          // containing disclosure before scrolling. This is intentionally
          // generic: every Needs You, Accounting, order, and capability link
          // that uses a real element id gets the same arrival contract.
          let disclosure = target.tagName === 'DETAILS' ? target : target.closest('details');
          while (disclosure) {
            disclosure.open = true;
            disclosure = disclosure.parentElement && disclosure.parentElement.closest('details');
          }
          // The persistent “What can I do here?” link points at a compact
          // disclosure. Landing on a closed disclosure would move the page
          // without answering the question the person just clicked.
          if (target.id === 'context-help') {
            const help = target.querySelector('details');
            if (help) help.open = true;
          }
          // A response to Tell StockChief belongs beside the request box. The
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

          // "Tell StockChief" is an input destination, not merely a heading. Put
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

  /* ------------------------------------------------------- saying something

     StockChief's own voice, in StockChief's own window.

     The browser's alert, confirm and prompt open a grey box headed
     "localhost:4000 says" — the operating system's typography, the operating
     system's buttons, and a title naming the port. It is the one place in the
     product where the thing talking to somebody is visibly not StockChief, and it
     turns up on exactly the actions that matter most: archiving a product,
     disconnecting a mailbox, pausing StockChief itself.

     Two shapes replace them, because they are two different acts. A statement
     is a toast: it appears, it is read, it goes. A question is a dialog: it
     waits, it can be refused, and until it is answered nothing has happened.
     Turning the questions into toasts would have removed the gate that is the
     entire reason they exist. */

  var toastHost = null;

  function toastRoot() {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'rm-toasts';
    // Polite: a toast is never the only place a fact appears, so it must not
    // interrupt somebody mid-sentence in a screen reader.
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
    return toastHost;
  }

  /**
   * Says one thing, briefly.
   *
   * `tone` is 'info' (default), 'ok' or 'warn'. `copy` puts the value in a
   * selectable box inside the toast — the honest replacement for the prompt
   * that used to show a link when the clipboard was unavailable, because the
   * point of that box was never the message, it was that you could take the
   * text out of it.
   */
  function toast(message, options) {
    var settings = options || {};
    var node = document.createElement('div');
    node.className = 'rm-toast rm-toast--' + (settings.tone || 'info');

    var text = document.createElement('span');
    text.className = 'rm-toast__t';
    text.textContent = message;
    node.appendChild(text);

    if (settings.copy) {
      var field = document.createElement('input');
      field.className = 'rm-toast__copy';
      field.type = 'text';
      field.readOnly = true;
      field.value = settings.copy;
      field.setAttribute('aria-label', message);
      node.appendChild(field);
    }

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'rm-toast__x';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    node.appendChild(close);

    var host = toastRoot();
    host.appendChild(node);
    // A frame between insertion and the class that animates it, so the browser
    // has a starting position to move from.
    window.requestAnimationFrame(function () { node.classList.add('is-in'); });

    var leaving = false;
    var timer = null;
    function leave() {
      if (leaving) return;
      leaving = true;
      if (timer) window.clearTimeout(timer);
      node.classList.remove('is-in');
      window.setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 220);
    }
    close.addEventListener('click', leave);

    // A toast holding something to copy waits to be dismissed: taking the text
    // out of it is the whole job, and four seconds is not long enough to do it.
    if (!settings.copy) {
      timer = window.setTimeout(leave, settings.forMs || 4500);
      node.addEventListener('mouseenter', function () {
        if (timer) window.clearTimeout(timer);
      });
      node.addEventListener('mouseleave', function () {
        if (!leaving) timer = window.setTimeout(leave, 1800);
      });
    }

    if (settings.copy) {
      var box = node.querySelector('.rm-toast__copy');
      window.setTimeout(function () { box.focus(); box.select(); }, 40);
    }
    return leave;
  }

  /*
   * The question, asked in the product's own window.
   *
   * One dialog, built once and reused, because there is only ever one question
   * on screen at a time. The confirming button carries the words off the button
   * that was pressed — "Archive", "Disconnect", "Pause StockChief" — so the answer
   * names the act rather than saying "OK" and leaving somebody to remember what
   * they clicked.
   */
  var askDialog = null;

  function askRoot() {
    if (askDialog && document.body.contains(askDialog)) return askDialog;
    askDialog = document.createElement('dialog');
    askDialog.className = 'rm-ask';
    askDialog.innerHTML = '<div class="rm-ask__b">'
      + '<span class="rm-ask__ic" aria-hidden="true">!</span>'
      + '<div><p class="rm-ask__t" data-ask-text></p>'
      + '<p class="rm-ask__d">Nothing happens until you choose.</p></div></div>'
      + '<div class="rm-ask__f">'
      + '<button type="button" class="rm-btn rm-btn--ghost" data-ask-no>Cancel</button>'
      + '<button type="button" class="rm-btn rm-btn--danger" data-ask-yes></button>'
      + '</div>';
    document.body.appendChild(askDialog);
    return askDialog;
  }

  /**
   * Asks, and calls back only on yes.
   *
   * Cancel holds the focus, and Escape closes without answering, because the
   * cheap accident to make on a destructive question is agreeing to it.
   */
  function ask(message, label, onYes) {
    var dialog = askRoot();
    if (typeof dialog.showModal !== 'function') {
      // Older browser: the native question is worse-looking than this one but
      // it is still a question, and losing the gate is not an option.
      if (window.confirm(message)) onYes();
      return;
    }
    dialog.querySelector('[data-ask-text]').textContent = message;
    var yes = dialog.querySelector('[data-ask-yes]');
    var no = dialog.querySelector('[data-ask-no]');
    yes.textContent = label || 'Yes, do it';

    var answered = false;
    function close() {
      yes.removeEventListener('click', agree);
      no.removeEventListener('click', refuse);
      dialog.removeEventListener('cancel', refuse);
      if (dialog.open) dialog.close();
    }
    function agree() {
      if (answered) return;
      answered = true;
      close();
      onYes();
    }
    // Escape reaches here as the dialog's own `cancel` event, which closes it
    // natively; `close` only has the listeners left to take down.
    function refuse() {
      answered = true;
      close();
    }
    yes.addEventListener('click', agree);
    no.addEventListener('click', refuse);
    dialog.addEventListener('cancel', refuse);
    dialog.showModal();
    window.setTimeout(function () { no.focus(); }, 30);
  }

  /* Inline scripts on a handful of pages want to say something too. */
  window.StockChief = window.StockChief || {};
  window.StockChief.toast = toast;
  window.StockChief.ask = ask;

  function initConfirms() {
    document.addEventListener('submit', (event) => {
      const form = event.target;
      const message = form.getAttribute('data-confirm');
      /*
       * The question, then the submit — in that order, and not in one turn.
       *
       * `window.confirm` blocked the thread and handed back an answer, so the
       * whole thing fitted in the submit handler. A dialog cannot: it returns
       * immediately and answers later. So a form carrying a question is
       * stopped, asked, and — on yes — submitted again with the same button,
       * which is what carries a two-decision form's name and value.
       */
      if (message && !form.hasAttribute('data-confirmed')) {
        event.preventDefault();
        const presser = event.submitter && event.submitter.matches('button[type=submit], input[type=submit]')
          ? event.submitter
          : form.querySelector('button[type="submit"]');
        const label = presser ? (presser.textContent || '').trim() : '';
        ask(message, label, () => {
          form.setAttribute('data-confirmed', '');
          if (typeof form.requestSubmit === 'function') form.requestSubmit(presser || undefined);
          else form.submit();
        });
        return;
      }
      form.removeAttribute('data-confirmed');
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

  /** The example prompts on StockChief's screens fill the box rather than submit. */
  function initStockChief() {
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
   * The progress page for a long StockChief job. Polls the real stage the server
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

    /*
     * A finished step keeps the time it took, taken from the server's own
     * timeline rather than measured in the browser — the page may have been
     * opened after the work started, or reloaded halfway through.
     */
    const paint = (stage, timeline) => {
      const current = order.indexOf(stage);
      steps.forEach((step, index) => {
        step.classList.toggle('is-done', current > index);
        step.classList.toggle('is-current', current === index);

        if (!timeline || current <= index) return;
        const began = timeline[order[index]];
        const ended = index + 1 < order.length ? timeline[order[index + 1]] : timeline.done;
        if (began === undefined || ended === undefined) return;
        const stamp = step.querySelector('[data-step-time]');
        if (stamp) stamp.textContent = `${Math.max(1, Math.round((ended - began) / 1000))}s`;
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
          paint(job.stage, job.timeline);
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

  /** A visible continuation may open a deliberately collapsed evidence block. */
  function initOpenDetailsButtons() {
    document.querySelectorAll('[data-open-details]').forEach((button) => {
      button.addEventListener('click', () => {
        const details = document.getElementById(button.getAttribute('data-open-details'));
        if (!details) return;
        details.open = true;
        details.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const input = details.querySelector('textarea, input, select');
        if (input) window.setTimeout(() => input.focus(), 250);
      });
    });
  }

  /*
   * What the option boxes will actually become.
   *
   * A shop typing its size run as "25 27 29 31 33" used to get one variant
   * carrying one number for five different shoes, and only found out on the
   * item page afterwards. The same reading the server does is shown here while
   * they type, so a size run that has not been understood as five sizes is
   * visible before anything is created.
   */
  function initVariantPreview() {
    const target = document.querySelector('[data-variant-preview]');
    if (!target) return;

    const host = target.closest('[data-reveal]') || document;
    const rows = [...host.querySelectorAll('.option-row')];
    if (!rows.length) return;

    const ATOMIC = /^(?:\d{1,4}(?:\.\d{1,2})?|[2-6]?X{0,3}[SML]|OS)$/i;
    const SEPARATORS = new RegExp('[,;/|\r\n]+');

    const split = (raw) => {
      const text = String(raw || '').trim();
      if (!text) return [];
      const parts = SEPARATORS.test(text) ? text.split(SEPARATORS) : null;
      if (parts) return parts.map((p) => p.trim()).filter(Boolean);
      const tokens = text.split(/\s+/);
      if (tokens.length > 1 && tokens.every((t) => ATOMIC.test(t))) return tokens;
      return [text];
    };

    const paint = () => {
      const axes = rows
        .map((row) => {
          const inputs = row.querySelectorAll('input');
          return { name: (inputs[0] || {}).value || '', values: split((inputs[1] || {}).value) };
        })
        .filter((axis) => axis.values.length);

      if (!axes.length) {
        target.hidden = true;
        return;
      }

      const total = axes.reduce((n, axis) => n * axis.values.length, 1);
      const detail = axes
        .map((axis) => `${axis.name || 'Option'}: ${axis.values.join(' · ')}`)
        .join('  |  ');
      target.textContent = `${total} variant${total === 1 ? '' : 's'} will be created — ${detail}`;
      target.hidden = false;
    };

    host.addEventListener('input', paint);
    paint();
  }

  /** Short StockChief calls (seconds) just need the button to look busy. */
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
        if (form.hasAttribute('data-long-action')) {
          button.disabled = true;
          button.classList.add('is-working-label');
          button.setAttribute('aria-busy','true');
          button.textContent = button.getAttribute('data-busy-label') || 'Working…';
          return;
        }
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
      const chosen = source.files && source.files[0];
      if (name && chosen) name.textContent = chosen.name;
      // The control says what it is holding, so the slot stops looking empty.
      const slot = source.closest('.rm-composer__attach');
      if (slot) slot.classList.toggle('has-file', Boolean(chosen));
    });
  }

  /**
   * A migration may contain dozens of exports and hundreds of megabytes. Keep
   * the evidence visible, name every selected file, and show real transport
   * progress instead of replacing the button with an indefinite spinner.
   */
  function initMigrationUpload() {
    const form = document.querySelector('[data-migration-upload]');
    if (!form) return;
    const input = form.querySelector('[data-migration-files]');
    const selected = form.querySelector('[data-migration-selection]');
    const progress = form.querySelector('[data-migration-progress]');
    const bar = form.querySelector('[data-migration-progress-bar]');
    const title = form.querySelector('[data-migration-progress-title]');
    const detail = form.querySelector('[data-migration-progress-detail]');
    const errorBox = form.querySelector('[data-migration-error]');
    const submit = form.querySelector('[data-migration-submit]');
    if (!input || !selected || !progress || !bar || !errorBox || !submit) return;

    const bytes = (value) => {
      if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
      if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
      if (value >= 1024) return `${Math.round(value / 1024)} KB`;
      return `${value} bytes`;
    };

    const paint = () => {
      const files = [...(input.files || [])];
      selected.hidden = files.length === 0;
      if (!files.length) { selected.replaceChildren(); return; }
      const total = files.reduce((sum,file) => sum + file.size,0);
      const head = document.createElement('div'); head.className = 'rm-upload-selection__head';
      const strong = document.createElement('strong'); strong.textContent = `${files.length} file${files.length === 1 ? '' : 's'} ready`;
      const amount = document.createElement('span'); amount.textContent = bytes(total);
      head.append(strong,amount);
      const list = document.createElement('ul'); list.className = 'rm-upload-files';
      files.forEach((file) => {
        const row = document.createElement('li'); row.className = 'rm-upload-file';
        const name = document.createElement('strong'); name.textContent = file.name;
        const size = document.createElement('span'); size.textContent = bytes(file.size);
        row.append(name,size); list.append(row);
      });
      selected.replaceChildren(head,list);
      submit.textContent = `Read ${files.length} file${files.length === 1 ? '' : 's'} safely`;
      errorBox.hidden = true;
    };
    input.addEventListener('change',paint);

    form.addEventListener('submit',(event) => {
      if (event.defaultPrevented) return;
      const hasFiles = input.files && input.files.length;
      const pasted = form.querySelector('[name="pasted"]');
      if (!hasFiles && !(pasted && pasted.value.trim())) return;
      event.preventDefault();
      const payload = new FormData(form);
      submit.disabled = true;
      submit.classList.add('is-working-label');
      submit.setAttribute('aria-busy','true');
      submit.textContent = 'Reading — please wait';
      input.disabled = true;
      errorBox.hidden = true;
      progress.hidden = false;
      bar.value = 0;
      title.textContent = 'Uploading securely…';
      detail.textContent = '0%';
      progress.scrollIntoView({ behavior:'smooth',block:'nearest' });

      const request = new XMLHttpRequest();
      request.open('POST',form.action);
      request.setRequestHeader('Accept','application/json');
      request.upload.addEventListener('progress',(upload) => {
        if (!upload.lengthComputable) return;
        const percent = Math.min(100,Math.round((upload.loaded / upload.total) * 100));
        bar.value = percent;
        detail.textContent = `${percent}% · ${bytes(upload.loaded)} of ${bytes(upload.total)}`;
        if (percent === 100) {
          title.textContent = 'Reading and reconciling your records…';
          detail.textContent = `Upload complete. StockChief is identifying the worksheets in ${input.files.length} file${input.files.length === 1 ? '' : 's'}.`;
          submit.textContent = 'Reading worksheets…';
        }
      });
      request.addEventListener('load',() => {
        let result = null;
        try { result = JSON.parse(request.responseText); } catch (_) {}
        if (request.status >= 200 && request.status < 300 && result && result.location) {
          window.location.assign(result.location);
          return;
        }
        progress.hidden = true;
        submit.disabled = false;
        input.disabled = false;
        submit.classList.remove('is-busy','is-working-label');
        submit.removeAttribute('aria-busy');
        errorBox.textContent = result && result.message
          ? result.message
          : 'StockChief could not read that upload. The selected filenames remain above so you can correct the exact file.';
        errorBox.hidden = false;
      });
      request.addEventListener('error',() => {
        progress.hidden = true;
        submit.disabled = false;
        input.disabled = false;
        submit.classList.remove('is-busy','is-working-label');
        submit.removeAttribute('aria-busy');
        errorBox.textContent = 'The upload was interrupted. Your source files were not activated; choose Retry when the connection is stable.';
        errorBox.hidden = false;
      });
      request.send(payload);
    });
    paint();
  }

  /** Deterministic migration work should continue without turning the owner
   * into a workflow engine. The page states what is starting before posting,
   * then the durable worker owns the rest. */
  function initMigrationAutoStart() {
    const form = document.querySelector('[data-migration-auto-start]');
    if (!form) return;
    window.setTimeout(() => {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    },250);
  }

  /**
   * Ask StockChief may need interpretation, but many questions resolve directly
   * from local records. Show honest progress without implying every question
   * must wait for an external model.
   */
  function initAskPending() {
    const forms = [...document.querySelectorAll('[data-ask-form]')];
    if (!forms.length) return;

    forms.forEach((form) => {
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

        /*
         * The conversation continues on screen while the answer is computed.
         *
         * What happened before: the Send button lost its label — is-busy makes
         * the text transparent, so it became a blank blue pill — and the only
         * sign anything was happening was a 12px line under the box. For the
         * seconds a model call takes, the page looked broken.
         *
         * Now the sentence somebody typed appears as their turn, and StockChief's
         * turn appears beneath it with a live indicator, in the same place the
         * answer will land. The button keeps its words. Nothing here is a
         * request; the form still posts and the page still arrives — this is
         * only what the person sees in the meantime.
         */
        const input = form.querySelector('[data-ask-input]');
        const typed = input && input.value.trim();
        if (typed && !form.querySelector('.rm-turn--pending')) {
          const you = document.createElement('div');
          you.className = 'rm-turn rm-turn--you rm-turn--pending';
          you.innerHTML = '<p class="rm-turn__who">You</p><p class="rm-turn__said"></p>';
          you.querySelector('.rm-turn__said').textContent = typed;

          const foundry = document.createElement('div');
          foundry.className = 'rm-turn rm-turn--foundry rm-turn--pending rm-turn--thinking';
          foundry.setAttribute('role', 'status');
          foundry.setAttribute('aria-live', 'polite');
          foundry.innerHTML = '<p class="rm-turn__who">StockChief</p>'
            + '<p class="rm-turn__said rm-chat-thinking"><span class="rm-thinking__dots" aria-hidden="true"><i></i><i></i><i></i></span>'
            + '<span data-thinking-text>Reading your records…</span></p>';

          form.parentElement.insertBefore(you, form);
          form.parentElement.insertBefore(foundry, form);
          if (pending) pending.hidden = true;

          // The phrasing moves so a long wait reads as progress, not a hang.
          const text = foundry.querySelector('[data-thinking-text]');
          const stages = ['Reading your records…', 'Working out what you mean…', 'Checking the figures…'];
          let stage = 0;
          window.setInterval(() => {
            stage = Math.min(stage + 1, stages.length - 1);
            if (text) text.textContent = stages[stage];
          }, 2500);
          window.setTimeout(() => {
            if (!text || text.dataset.escaped) return;
            text.dataset.escaped = '1';
            text.textContent = 'Still going. ';
            const out = document.createElement('a');
            out.href = '/';
            out.textContent = 'Leave it — nothing has changed yet';
            text.append(out);
          }, 12000);
        }

        if (input) {
          /*
           * Native form serialization happens after this event. Preserve the
           * submitted value in a hidden field, then clear the visible composer
           * immediately so it behaves like a chat instead of looking unsent.
           */
          if (input.name) {
            const submitted = document.createElement('input');
            submitted.type = 'hidden';
            submitted.name = input.name;
            submitted.value = input.value;
            submitted.setAttribute('data-ask-submitted-message', '');
            form.appendChild(submitted);
            input.removeAttribute('name');
          }
          input.value = '';
          input.placeholder = 'Message sent';
          input.readOnly = true;
          input.setAttribute('aria-busy', 'true');
        }
        const button = form.querySelector('[data-ask-submit]');
        if (button) {
          // Words, not a blank pill.
          button.disabled = true;
          button.classList.remove('is-busy');
          button.classList.add('is-working-label');
          button.setAttribute('aria-busy', 'true');
          button.textContent = 'Sending…';
        }
        /*
         * A wait with no end and no exit.
         *
         * A model call is seconds, usually. When it is not, the page says
         * "StockChief is working out what that means…" and offers nothing — no
         * way to tell whether to keep waiting or to leave. After ten seconds
         * it says both: that it is still going, and that leaving costs
         * nothing, which is true because nothing is written until it is
         * approved.
         */
        if (!pending) return;
        window.setTimeout(() => {
          if (pending.hidden || pending.dataset.escaped) return;
          pending.dataset.escaped = '1';
          pending.append(' Still going. ');
          const out = document.createElement('a');
          out.href = '/';
          out.textContent = 'Leave it — nothing has changed yet';
          pending.append(out);
        }, 10000);
      });
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
  // half-written Tell StockChief instruction.
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
    // Browsers heavily throttle timers in background tabs. Check immediately
    // when the owner comes back from Gmail so a message already captured by
    // StockChief appears now, not on the browser's delayed timer schedule.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) tick();
    });
    window.addEventListener('focus', tick);
    tick();
  }

  /** Keep an open mailbox page in step with unattended provider checks. */
  function initLiveMailbox() {
    const marker = document.querySelector('[data-live-mailbox]');
    if (!marker) return;
    const connectorId = marker.dataset.connectorId;
    let signature = marker.dataset.signature || '';
    let reloading = false;
    const tick = () => {
      if (document.hidden || reloading) return;
      const active = document.activeElement;
      if (active && active.matches('input, select, textarea')) return;
      fetch(`/settings/connections/${encodeURIComponent(connectorId)}/state`, {
        headers: { Accept: 'application/json' },
      })
        .then((response) => response.ok ? response.json() : null)
        .then((state) => {
          if (!state || !state.signature || state.signature === signature) return;
          reloading = true;
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

  /*
   * Copy a payment link without leaving the order.
   *
   * The link used to be a word inside a sentence, which meant getting it into
   * a text message was a right-click, a menu, and a hope. It is the thing the
   * customer needs, so taking it should be one press that says it worked.
   */
  function initCopyButtons() {
    document.addEventListener('click', function (event) {
      var button = event.target.closest('[data-copy]');
      if (!button) return;
      event.preventDefault();
      var value = button.getAttribute('data-copy');
      var said = button.textContent;
      var done = function () {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = said; }, 2000);
      };
      var offer = function () {
        // No clipboard permission, so show it rather than silently doing
        // nothing. The point of the old prompt was never its message — it was
        // that the text could be selected out of it, so the toast carries a
        // box that is focused and selected already.
        toast('Copy this link', { copy: value, tone: 'info' });
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, offer);
      } else {
        offer();
      }
    });
  }

  /*
   * Taking a payment without losing the order.
   *
   * The page the customer pays on is Stripe's, and it has to stay Stripe's:
   * StockChief never sees a card number and never will. The question is only
   * where it appears. A plain link threw the merchant into whatever browser
   * the operating system felt like opening — a fresh window, signed out,
   * three windows away, with a customer standing at the counter.
   *
   * Embedding it was tried first and does not work: Stripe's hosted invoice
   * page declines to render inside a frame, and a blank rectangle is worse
   * than the link was. So it opens as a payment window sized like a card
   * terminal, over the order, and the order stays underneath waiting for it —
   * saying what is being paid, and closing itself when the window closes.
   *
   * Some browsers refuse to open a window at all. That is not an error to
   * report; it is the same job done one click differently, so the panel says
   * so plainly and hands over a button that opens the page instead. Either
   * way the order is still on screen behind it, and either way StockChief learns
   * about the payment from Stripe rather than from anybody remembering.
   */
  /* A receipt is printed from the page it is shown on. */
  function initPrintButtons() {
    document.addEventListener('click', function (event) {
      if (!event.target.closest('[data-print]')) return;
      event.preventDefault();
      window.print();
    });
  }

  function initPaymentWindow() {
    var modal = document.getElementById('pay-window');
    if (!modal) return;
    var blocked = document.getElementById('pay-window-blocked');
    var watching = document.getElementById('pay-window-watching');
    var front = document.getElementById('pay-window-front');
    var tab = document.getElementById('pay-window-tab');
    var done = document.getElementById('pay-window-done');
    var doneAmount = document.getElementById('pay-window-done-amount');
    var receipt = document.getElementById('pay-window-receipt');
    var invoice = document.getElementById('pay-window-invoice');
    var sheet = modal.querySelector('[data-order]');
    var orderId = sheet && sheet.getAttribute('data-order');
    var paying = null;
    var watch = null;
    var asking = null;
    var settled = false;

    function popup(url) {
      var width = 520;
      var height = Math.min(820, Math.max(560, window.screen.availHeight - 120));
      var left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
      var top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
      return window.open(url, 'foundry-payment',
        'popup=yes,width=' + width + ',height=' + height + ',left=' + Math.round(left) + ',top=' + Math.round(top));
    }

    /*
     * Only ever somewhere a payment can actually be taken.
     *
     * A relative value here would be opened against StockChief's own origin, and
     * a merchant standing at the counter would get a StockChief page saying "We
     * could not find that" instead of a card form. That is exactly what a
     * broken attribute did once, so the check is here as well as in the
     * template: a wrong address should look wrong, not be visited.
     */
    function payable(url) {
      if (!url) return null;
      try {
        var parsed = new URL(String(url), window.location.href);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
        if (parsed.origin === window.location.origin) return null;
        return parsed.href;
      } catch (error) { return null; }
    }

    function open(candidate) {
      var url = payable(candidate);
      if (!url) return;
      clearInterval(asking);
      clearInterval(watch);
      asking = null;
      watch = null;
      tab.href = url;
      modal.hidden = false;
      document.body.classList.add('is-paying');
      // A window if the browser allows one, a tab if it does not, and if it
      // allows neither the panel offers the page as a button.
      // Deliberately no 'noopener': that makes window.open return nothing, and
      // then StockChief cannot tell when the payment window is closed again.
      paying = popup(url) || window.open(url, '_blank');
      blocked.hidden = Boolean(paying);
      watching.hidden = !paying;
      tab.hidden = Boolean(paying);
      // Nothing to bring forward when nothing opened.
      front.hidden = !paying;

      /*
       * Asked every few seconds while the panel is open, whichever way the
       * customer is paying — a window StockChief can watch, a tab it cannot, or
       * a link they opened on their phone.
       */
      asking = setInterval(ask, 3000);
      window.setTimeout(ask, 1200);

      if (!paying) return;
      watch = setInterval(function () {
        if (paying.closed) close();
      }, 700);
    }

    function money(minor) {
      return '$' + (Number(minor || 0) / 100).toFixed(2);
    }

    /*
     * Waiting for the money, and knowing when it has arrived.
     *
     * The merchant is standing at the counter with the customer. Before this,
     * the panel could only say "the window is open" and the person had to
     * guess when to close it, then reload and hope. StockChief asks the payment
     * provider directly, so the answer arrives whether or not a webhook does.
     */
    function finish(state) {
      settled = true;
      clearInterval(asking);
      clearInterval(watch);
      asking = null;
      watch = null;
      if (paying && !paying.closed) paying.close();
      paying = null;

      watching.hidden = true;
      blocked.hidden = true;
      front.hidden = true;
      tab.hidden = true;
      doneAmount.textContent = money(state.paidMinor) + ' paid.';
      done.hidden = false;
      if (state.receipt) {
        receipt.href = state.receipt.href;
        receipt.hidden = false;
      }
      if (invoice && state.invoice) {
        invoice.href = state.invoice.href;
        invoice.hidden = false;
      }
      // The Stripe window closes immediately. Re-read the order promptly and
      // leave the receipt and invoice actions on the fresh, visibly-paid page.
      window.setTimeout(function () {
        var here = new URL(window.location.href);
        here.searchParams.delete('pay');
        here.searchParams.set('payment', 'paid');
        here.hash = 'money';
        window.location.replace(here.toString());
      }, 900);
    }

    function ask() {
      if (!orderId || settled) return;
      window.fetch('/sales/orders/' + orderId + '/payment-state', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      }).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (state) {
        if (state && state.paid) finish(state);
      }).catch(function () {
        // Not being able to ask is not news about the customer. The next tick
        // asks again, and Done still checks before it closes.
      });
    }

    function close() {
      clearInterval(asking);
      asking = null;
      clearInterval(watch);
      watch = null;
      if (paying && !paying.closed) paying.close();
      paying = null;
      watching.hidden = false;
      watching.textContent = 'Confirming the final payment status with Stripe…';
      blocked.hidden = true;
      front.hidden = true;
      // One final uncached check covers the normal case where Stripe closes
      // just after the last three-second poll. Only then reload an unpaid
      // order; a paid answer takes the finish path above.
      window.fetch('/sales/orders/' + orderId + '/payment-state', {
        headers: { Accept: 'application/json' }, credentials: 'same-origin',
      }).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (state) {
        if (state && state.paid) return finish(state);
        modal.hidden = true;
        document.body.classList.remove('is-paying');
        var here = new URL(window.location.href);
        here.searchParams.delete('pay');
        window.location.replace(here.toString());
      }).catch(function () {
        window.location.reload();
      });
    }

    document.addEventListener('click', function (event) {
      var opener = event.target.closest('[data-pay-open]');
      if (opener) {
        event.preventDefault();
        open(opener.getAttribute('data-pay-open'));
        return;
      }
      if (event.target.closest('[data-pay-front]')) {
        event.preventDefault();
        if (paying && !paying.closed) paying.focus();
        return;
      }
      // A user click gives the browser a fresh chance to allow a closable
      // popup. A noopener tab cannot be watched or closed automatically.
      if (event.target.closest('#pay-window-tab')) {
        event.preventDefault();
        open(tab.href);
        return;
      }
      if (event.target.closest('[data-pay-close]') || event.target === modal) close();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !modal.hidden) close();
    });

    open(modal.getAttribute('data-open-now'));
  }

  /**
   * Enter sends; Shift+Enter starts a new line.
   *
   * The command box is a textarea because what people type is often more than
   * one line, but a textarea swallows Enter — so the box that is meant to be
   * the fastest way to talk to StockChief was the one thing on the page you could
   * not send from the keyboard.
   */
  function initComposerSend() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      const box = event.target.closest('.rm-composer textarea');
      if (!box) return;
      const form = box.closest('form');
      if (!form) return;
      event.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    });
  }

  /**
   * Turn catalogue corrections into a short conversation instead of exposing
   * a wall of validation output. The server remains the source of truth; this
   * only reveals one evidence-backed question at a time and never submits a
   * partial answer.
   */
  function initClarificationWizard() {
    document.querySelectorAll('[data-clarification-wizard]').forEach((form) => {
      const steps = [...form.querySelectorAll('[data-clarification-step]')];
      const counter = form.querySelector('[data-clarification-count]');
      if (!steps.length) return;
      let active = 0;

      const syncFollowups = () => {
        form.querySelectorAll('[data-show-for]').forEach((panel) => {
          const name = panel.getAttribute('data-show-for');
          const wanted = panel.getAttribute('data-show-value');
          const selected = form.querySelector(`input[name="${CSS.escape(name)}"]:checked`);
          const shown = Boolean(selected && selected.value === wanted);
          panel.hidden = !shown;
          panel.querySelectorAll('[data-required-when-shown]').forEach((field) => {
            field.required = shown;
          });
        });
      };

      const show = (index) => {
        active = Math.max(0, Math.min(index, steps.length - 1));
        steps.forEach((step, stepIndex) => { step.hidden = stepIndex !== active; });
        if (counter) counter.textContent = `Question ${active + 1} of ${steps.length}`;
        syncFollowups();
        const heading = steps[active].querySelector('h2');
        if (heading && index !== 0) heading.focus({ preventScroll: true });
        steps[active].scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      const finishCurrentAnswer = () => {
        syncFollowups();
        const invalid = steps[active].querySelector(':invalid');
        if (!invalid) return true;
        invalid.reportValidity();
        return false;
      };

      form.addEventListener('change', syncFollowups);
      form.querySelectorAll('[data-clarification-next]').forEach((button) => {
        button.addEventListener('click', () => {
          if (finishCurrentAnswer()) show(active + 1);
        });
      });
      form.querySelectorAll('[data-clarification-back]').forEach((button) => {
        button.addEventListener('click', () => show(active - 1));
      });
      form.addEventListener('submit', (event) => {
        if (finishCurrentAnswer()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);

      syncFollowups();
      show(0);
    });
  }

  /** Keep a long verified cutover visible without repeatedly reloading the page. */
  function initMigrationProgress() {
    const panel = document.querySelector('[data-migration-progress]');
    if (!panel) return;
    const count = document.querySelector('[data-migration-progress-count]');
    const copy = panel.querySelector('[data-migration-progress-copy]');
    const phase = panel.querySelector('[data-migration-progress-phase]');
    const fraction = panel.querySelector('[data-migration-progress-fraction]');
    const bar = panel.querySelector('[data-migration-job-bar]');
    const endpoint = panel.getAttribute('data-migration-progress');
    const format = new Intl.NumberFormat();
    let checking = false;

    async function check() {
      if (checking || document.hidden) return;
      checking = true;
      try {
        const response = await window.fetch(endpoint,{ headers:{ Accept:'application/json' },credentials:'same-origin' });
        if (!response.ok) return;
        const progress = await response.json();
        if (progress.preparationStatus === 'RUNNING') {
          if (copy) copy.textContent = progress.preparationDetail || 'StockChief is preparing the saved source evidence.';
          if (phase) phase.textContent = String(progress.preparationStage || 'preparing').replaceAll('_',' ').toLowerCase();
          if (fraction) fraction.textContent = progress.preparationTotal
            ? `${format.format(progress.preparationCompleted || 0)} of ${format.format(progress.preparationTotal)} datasets`
            : 'Starting…';
          if (bar) {
            bar.max = Math.max(1,progress.preparationTotal || 1);
            bar.value = progress.preparationCompleted || 0;
          }
          return;
        }
        if (progress.status !== 'APPLYING') {
          window.location.reload();
          return;
        }
        if (count) count.textContent = format.format(progress.appliedCount || 0);
        const entity = String(progress.currentEntityType || 'verified records').replaceAll('_',' ');
        if (copy) copy.textContent = 'Applying ' + entity + ' through its normal business service. ' + format.format(progress.appliedCount || 0) + ' of ' +
          format.format(progress.stagedCount || 0) +
          ' prepared records are safely applied. StockChief will reconcile the live totals before it calls the switch complete.';
        if (phase) phase.textContent = `Applying ${entity}`;
        if (fraction) fraction.textContent = `${format.format(progress.appliedCount || 0)} of ${format.format(progress.stagedCount || 0)}`;
        if (bar) { bar.max = Math.max(1,progress.stagedCount || 1); bar.value = progress.appliedCount || 0; }
      } catch (error) {
        // A transient read failure does not stop the durable cutover. The next
        // tick asks again without turning a harmless network blip into an alert.
      } finally {
        checking = false;
      }
    }

    window.setInterval(check,3000);
    window.setTimeout(check,600);
  }

  /*
   * The rail is fixed and the page is padded by --rail-h to sit under it. On
   * a phone the rail wraps to three rows (brand, tabs, search) and is taller
   * than the constant, so the top of every page — the way back and the title
   * — sat hidden underneath it. Measure the rail and tell the page.
   */
  function initRailHeight() {
    const rail = document.querySelector('.rm-rail');
    if (!rail) return;
    const apply = () => {
      const h = Math.ceil(rail.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--rail-h', h + 'px');
    };
    apply();
    window.addEventListener('resize', apply);
    if (window.ResizeObserver) new ResizeObserver(apply).observe(rail);
  }

  document.addEventListener('DOMContentLoaded', () => {
    initRailHeight();
    initNavigationLanding();
    initSearch();
    initModals();
    initTabs();
    initStockHints();
    initConfirms();
    initAutoFilters();
    initStockChief();
    initThinking();
    initOpenDetailsButtons();
    initBusyButtons();
    initSetupSource();
    initMigrationUpload();
    initMigrationAutoStart();
    initOperatorAttachment();
    initAskPending();
    initSwitcher();
    initVendorVocabulary();
    initLiveHome();
    initLiveMailbox();
    initScopeWarnings();
    initSelectionGroups();
    initCopyButtons();
    initPaymentWindow();
    initPrintButtons();
    initComposerSend();
    initClarificationWizard();
    initMigrationProgress();
    initVariantPreview();
  });
})();

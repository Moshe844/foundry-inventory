'use strict';
// A search box on a page filters as you type, without reloading the page, so
// the cursor stays where it is. The form still works by pressing Enter, or with
// no script at all. The search at the top of every page has its own behaviour.
(function () {
  var WAIT_MS = 280;
  var FIELD = 'input[type=search][name],input[name=q]';
  function isSearchForm(form) {
    return (form.getAttribute('method') || 'get').toLowerCase() === 'get' && !form.closest('dialog') && !form.querySelector('[data-no-live]') && !form.hasAttribute('data-pager-size') && form.querySelector(FIELD);
  }
  var forms = Array.prototype.filter.call(document.querySelectorAll('main form'), isSearchForm);
  var request = null, timer = null;

  function target(form) {
    var url = new URL(form.getAttribute('action') || location.pathname, location.href);
    url.search = '';
    new FormData(form).forEach(function (value, key) { if (typeof value === 'string' && value !== '') url.searchParams.append(key, value); });
    return url;
  }
  // Which form this is on the page, so the same one can be found in the new copy.
  function twin(form, doc) {
    var index = forms.indexOf(form);
    return Array.prototype.filter.call(doc.querySelectorAll('main form'), isSearchForm)[index] || null;
  }
  function keepsItsPlace(node) {
    return node.nodeType === 1 && (node.matches('script,link,style,.sc-toolbar,[data-live-keep]'));
  }
  // Replace everything around the form and leave the form itself alone, one
  // level at a time up to <main>, so the box being typed in is never touched.
  function swapAround(oldNode, newNode) {
    var oldParent = oldNode.parentNode, newParent = newNode.parentNode;
    if (!oldParent || !newParent || oldNode.tagName === 'MAIN') return;
    var before = true;
    Array.prototype.slice.call(oldParent.childNodes).forEach(function (child) {
      if (child !== oldNode && !keepsItsPlace(child)) oldParent.removeChild(child);
    });
    Array.prototype.slice.call(newParent.childNodes).forEach(function (child) {
      if (child === newNode) { before = false; return; }
      if (keepsItsPlace(child)) return;
      var copy = document.importNode(child, true);
      if (before) oldParent.insertBefore(copy, oldNode); else oldParent.appendChild(copy);
    });
    swapAround(oldParent, newParent);
  }
  function update(form) {
    if (request) request.abort();
    var controller = request = new AbortController(), url = target(form);
    form.setAttribute('aria-busy', 'true');
    fetch(url.pathname + url.search, { credentials: 'same-origin', headers: { accept: 'text/html' }, signal: controller.signal })
      .then(function (response) {
        // Signed out, or anything else unexpected: let the browser handle it normally.
        if (!response.ok) { form.submit(); return null; }
        url = new URL(response.url);
        return response.text();
      })
      .then(function (html) {
        if (html === null || controller !== request) return;
        var doc = new DOMParser().parseFromString(html, 'text/html'), next = twin(form, doc);
        if (!next) { form.submit(); return; }
        swapAround(form, next);
        history.replaceState(history.state, '', url.pathname + url.search + location.hash);
        document.dispatchEvent(new CustomEvent('stockchief:content-updated'));
      })
      .catch(function (error) { if (error.name !== 'AbortError') form.submit(); })
      .finally(function () { if (controller === request) { form.removeAttribute('aria-busy'); request = null; } });
  }
  forms.forEach(function (form) {
    form.classList.add('is-live-search');
    // Nothing left to press. It stays in the page for keyboards and for no-script use.
    form.querySelectorAll('button[type=submit],button:not([type])').forEach(function (button) { if (/^(search|apply|apply filters|filter|find stock)$/i.test(button.textContent.trim())) button.classList.add('live-search__submit'); });
    form.querySelectorAll(FIELD).forEach(function (input) {
      input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { update(form); }, WAIT_MS); });
    });
    // Every other filter in the same form applies straight away too.
    form.addEventListener('change', function (event) {
      if (event.target.matches(FIELD)) return;
      clearTimeout(timer); update(form);
    });
    form.addEventListener('submit', function () { clearTimeout(timer); if (request) request.abort(); });
  });
  // Choosing how many rows to see opens that many straight away.
  document.addEventListener('change', function (event) {
    var form = event.target.closest && event.target.closest('form[data-pager-size]');
    if (form) form.submit();
  });
})();

'use strict';
// Every back link goes to the page this tab actually came from. A page's own
// link ("← Orders") is only the fallback when there is no previous page.
(function () {
  var SELECTOR = '.page-back,.back-link,.rm-head__back,.ox-back,.rm-back';
  var KEY = 'stockchief:came-from', RETURNING = 'stockchief:returning', LIMIT = 60;
  var here = location.pathname + location.search;
  var store;
  try { store = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (e) { return; }
  store = store && typeof store === 'object' ? store : {};
  store.from = store.from || {}; store.titles = store.titles || {};
  var title = document.title.replace(/\s*·\s*StockChief\s*$/, '').trim();
  if (title) store.titles[here] = title;

  var navigation = performance.getEntriesByType('navigation')[0];
  var returning = false;
  try { returning = sessionStorage.getItem(RETURNING) === here; sessionStorage.removeItem(RETURNING); } catch (e) { /* still works */ }
  var ref = null;
  try { var url = new URL(document.referrer); if (url.origin === location.origin) ref = url.pathname + url.search; } catch (e) { ref = null; }
  // Going back, reloading, or a form returning to its own page keeps the existing way back.
  if (ref && ref !== here && !returning && !(navigation && navigation.type !== 'navigate')) {
    var isForm = /\/(new|edit)$/.test(ref.split('?')[0]);
    var chosen = isForm ? store.from[ref] : { href: ref, label: store.titles[ref] };
    if (chosen && chosen.href !== here) store.from[here] = chosen;
  }
  // Opened directly, with no page before it: the page's own link is the right way back.
  if (!ref && !returning && navigation && navigation.type === 'navigate') delete store.from[here];
  var urls = Object.keys(store.titles);
  urls.slice(0, Math.max(0, urls.length - LIMIT)).forEach(function (u) { delete store.titles[u]; delete store.from[u]; });
  try { sessionStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* still works */ }

  var links = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  var back = store.from[here];
  var samePlace = function (link) { var to = new URL(link.href); return to.pathname === back.href.split('?')[0]; };
  if (back && back.label) links.forEach(function (link) {
    // Same page as the link already names: keep its words, but return to the
    // exact list page, filter and sort that was open.
    if (samePlace(link)) {
      link.setAttribute('href', back.href);
      if (link.hasAttribute('data-dest')) link.setAttribute('data-dest', back.href);
      return;
    }
    link.setAttribute('href', back.href);
    if (link.hasAttribute('data-dest')) link.setAttribute('data-dest', back.href);
    link.setAttribute('data-return-to', '');
    link.innerHTML = '<span aria-hidden="true">←</span> ';
    link.appendChild(document.createTextNode((link.classList.contains('page-back') ? 'Back to ' : '') + back.label));
  });
  // Two links saying the same thing on one page is one too many.
  var seen = {};
  links.forEach(function (link) {
    var target = link.getAttribute('href');
    if (seen[target]) link.hidden = true; else seen[target] = true;
  });
  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest(SELECTOR);
    if (!link) return;
    try { var target = new URL(link.href); sessionStorage.setItem(RETURNING, target.pathname + target.search); } catch (e) { /* still works */ }
  }, true);
})();

'use strict';
// Conversation rows (Ask and All conversations): one row menu open at a time, and
// Rename turns the row's title into a box in place. Enter saves, Escape cancels.
(function () {
  function closeMenus(except) {
    document.querySelectorAll('.ask-menu[open]').forEach(function (menu) { if (menu !== except) menu.open = false; });
  }
  document.addEventListener('toggle', function (event) {
    var menu = event.target;
    if (menu.classList && menu.classList.contains('ask-menu') && menu.open) closeMenus(menu);
  }, true);
  document.addEventListener('click', function (event) {
    document.querySelectorAll('.ask-menu[open]').forEach(function (menu) { if (!menu.contains(event.target)) menu.open = false; });
    var start = event.target.closest && event.target.closest('[data-chat-rename]');
    if (!start) return;
    var row = start.closest('[data-chat-row]'), form = row && row.querySelector('[data-chat-rename-form]');
    if (!form) return;
    closeMenus();
    row.classList.add('is-renaming');
    form.hidden = false;
    var box = form.querySelector('input[name=title]');
    box.dataset.original = box.value;
    box.focus();
    box.select();
  });
  function stop(form) {
    var row = form.closest('[data-chat-row]'), box = form.querySelector('input[name=title]');
    if (box.dataset.original !== undefined) box.value = box.dataset.original;
    form.hidden = true;
    row.classList.remove('is-renaming');
  }
  document.addEventListener('keydown', function (event) {
    var form = event.target.closest && event.target.closest('[data-chat-rename-form]');
    if (form && event.key === 'Escape') { event.preventDefault(); stop(form); }
    if (!form && event.key === 'Escape') closeMenus();
  });
  // Leaving the box without saving puts the old name back.
  document.addEventListener('focusout', function (event) {
    var form = event.target.closest && event.target.closest('[data-chat-rename-form]');
    if (!form || form.hidden) return;
    setTimeout(function () { if (!form.contains(document.activeElement) && !form.dataset.saving) stop(form); }, 120);
  });
  document.addEventListener('submit', function (event) {
    var form = event.target.closest && event.target.closest('[data-chat-rename-form]');
    if (form) form.dataset.saving = '1';
  });
}());

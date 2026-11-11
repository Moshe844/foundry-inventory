'use strict';
// Integrations: any connection card opens its window with what it does and how
// to connect it. Close with ×, Escape, or a click outside the window.
(function () {
  document.addEventListener('click', function (event) {
    var opener = event.target.closest('[data-integration-open]');
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute('data-integration-open'));
      if (dialog && typeof dialog.showModal === 'function') { dialog.showModal(); dialog.querySelector('[data-integration-close]').focus(); }
      return;
    }
    if (event.target.closest('[data-integration-close]')) { event.target.closest('dialog').close(); return; }
    // A click on the dimmed backdrop lands on the dialog element itself.
    if (event.target.matches('dialog.pub-integration-dialog[open]')) {
      var box = event.target.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
    }
  });
}());

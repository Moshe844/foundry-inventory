'use strict';
// What StockChief does: a choice saves the moment it is picked, so there is no
// Save button to forget. Without this script the Save buttons stay and work.
(function () {
  document.querySelectorAll('form[data-autosave]').forEach(function (form) {
    var save = form.querySelector('.ap-save');
    if (save) save.hidden = true;
    form.addEventListener('change', function (event) {
      var picked = event.target;
      if (!picked || picked.type !== 'radio') return;
      form.querySelectorAll('label').forEach(function (label) {
        var input = label.querySelector('input[type=radio]');
        if (input) label.classList.toggle('is-on', input.checked);
      });
      form.classList.add('is-saving');
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    });
  });
}());

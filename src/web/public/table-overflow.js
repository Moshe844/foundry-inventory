(function () {
  'use strict';
  function enhance() {
    document.querySelectorAll('.rm-scroll, .table-scroll, .table-wrap').forEach(function (box) {
      if (!box.querySelector('table') || box.dataset.overflowEnhanced) return;
      box.dataset.overflowEnhanced = 'true';
      var hint = document.createElement('p');
      hint.className = 'table-overflow-hint';
      hint.textContent = 'More columns to the right — swipe or scroll to see them.';
      hint.hidden = true;
      box.parentNode.insertBefore(hint, box);
      function update() {
        var overflows = box.scrollWidth > box.clientWidth + 2;
        hint.hidden = !overflows;
        if (overflows && !box.hasAttribute('tabindex')) {
          box.tabIndex = 0;
          box.dataset.overflowTabindex = 'true';
        } else if (!overflows && box.dataset.overflowTabindex) {
          box.removeAttribute('tabindex');
          delete box.dataset.overflowTabindex;
        }
      }
      if (window.ResizeObserver) new ResizeObserver(update).observe(box);
      window.addEventListener('resize', update);
      update();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhance);
  else enhance();
}());

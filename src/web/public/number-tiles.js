'use strict';
// The numbers in the boxes at the top of Home, Orders, Buy, Stock and Money count up to
// their value as the page opens. The real number stays in the page the whole time (for
// screen readers, copying and search); only a painted copy over it counts. A number
// written in a form this cannot read back exactly is left still.
(function () {
  if (!window.requestAnimationFrame || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
  document.querySelectorAll('[data-count-up],.hm-tile > [data-home-number]').forEach(function (number) {
    var text = number.textContent.trim(), parts = /^([^\d-]*)(-?\d{1,3}(?:,\d{3})*|-?\d+)(\.\d+)?([^\d]*)$/.exec(text);
    if (!parts) return;
    var target = Number(parts[2].replace(/,/g, '') + (parts[3] || '')), places = parts[3] ? parts[3].length - 1 : 0;
    if (!isFinite(target) || target === 0) return;
    var format = new Intl.NumberFormat('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
    var show = function (value) { number.setAttribute('data-count', parts[1] + format.format(value) + parts[4]); };
    number.style.setProperty('--count-ink', getComputedStyle(number).color);
    show(0); number.classList.add('is-counting');
    var started = null, length = 900;
    var step = function (now) {
      if (started === null) started = now;
      var done = Math.min(1, (now - started) / length);
      show(target * (1 - Math.pow(1 - done, 3)));
      if (done < 1) window.requestAnimationFrame(step);
      else { number.classList.remove('is-counting'); number.removeAttribute('data-count'); }
    };
    window.requestAnimationFrame(step);
  });
}());

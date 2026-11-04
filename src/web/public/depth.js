'use strict';
// The number tiles lean toward the pointer, and a soft light follows it.
(function () {
  if (!window.matchMedia('(hover:hover)').matches || window.matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  var LEAN = 2.5;
  document.querySelectorAll('.hm-metrics .sc-metric').forEach(function (tile) {
    tile.style.transition = 'transform .25s cubic-bezier(.2,.8,.2,1),box-shadow .25s';
    tile.addEventListener('pointermove', function (event) {
      var box = tile.getBoundingClientRect(), x = (event.clientX - box.left) / box.width, y = (event.clientY - box.top) / box.height;
      tile.style.setProperty('--ry', ((x - 0.5) * LEAN * 2).toFixed(2) + 'deg');
      tile.style.setProperty('--rx', ((0.5 - y) * LEAN * 2).toFixed(2) + 'deg');
      tile.style.setProperty('--ty', '-2px');
      tile.style.setProperty('--mx', (x * 100).toFixed(0) + '%');
      tile.style.setProperty('--my', (y * 100).toFixed(0) + '%');
      tile.style.setProperty('--sheen', '1');
    });
    tile.addEventListener('pointerleave', function () {
      ['--rx', '--ry', '--ty', '--sheen'].forEach(function (name) { tile.style.removeProperty(name); });
    });
  });
})();

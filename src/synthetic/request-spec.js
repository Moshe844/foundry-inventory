'use strict';

function number(value) { return Number(String(value).replace(/,/g, '')); }

function representative(text, labels, fallback, limits) {
  const names = labels.join('|');
  const range = new RegExp(`(?:~|about|around|approximately)?\\s*(\\d[\\d,]*)\\s*[–—-]\\s*(\\d[\\d,]*)\\s*(?:${names})\\b`, 'i').exec(text);
  let value;
  if (range) value = Math.round((number(range[1]) + number(range[2])) / 2);
  else {
    const exact = new RegExp(`(?:~|about|around|approximately)?\\s*(\\d[\\d,]*)\\s*(?:${names})\\b`, 'i').exec(text);
    value = exact ? number(exact[1]) : fallback;
  }
  return Math.max(limits[0], Math.min(limits[1], value));
}

function parse(text) {
  const request = String(text || '');
  const products = representative(request, ['products?', 'items?'], 120, [1, 500]);
  const skus = Math.max(products, representative(request, ['SKUs?', 'variants?'], products * 4, [1, 3000]));
  return {
    products,
    skus,
    suppliers: representative(request, ['suppliers?', 'vendors?'], 12, [1, 50]),
    historyMonths: representative(request, ['months?'], 6, [1, 24]),
  };
}

module.exports = { parse, representative };

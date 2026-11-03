'use strict';

/*
 * Towns for a US ZIP or Canadian postal prefix, to fill an address's city and
 * state. Only the postal code leaves StockChief (to the free Zippopotam
 * service); answers are kept in memory, and any failure simply returns no
 * towns, so the person types them as before.
 */

const { providerFetch } = require('./provider-http');

const cache = new Map();
const PATTERN = { US: /^\d{5}$/, CA: /^[A-Z]\d[A-Z]$/ };

async function towns(countryInput, codeInput, options = {}) {
  const country = String(countryInput || '').toUpperCase(), code = String(codeInput || '').trim().toUpperCase();
  if (!PATTERN[country] || !PATTERN[country].test(code)) return [];
  const key = country + ':' + code;
  if (cache.has(key)) return cache.get(key);
  let places = [];
  try {
    const response = await providerFetch(`https://api.zippopotam.us/${country.toLowerCase()}/${code}`,
      { headers: { accept: 'application/json' } }, { provider: 'Zippopotam', retries: 0, timeoutMs: 3000, fetch: options.fetch });
    if (response.ok) {
      const body = await response.json();
      places = (Array.isArray(body?.places) ? body.places : []).map((p) => ({ city: String(p['place name'] || '').trim(), state: String(p['state abbreviation'] || '').trim() }))
        .filter((p) => p.city).slice(0, 25);
    }
  } catch { return []; }
  cache.set(key, places);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return places;
}

module.exports = { towns };

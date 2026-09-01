'use strict';

/*
 * Carriers, without pretending to be integrated with any of them.
 *
 * Foundry has no carrier account and no rate contract, so it cannot buy a
 * label, quote a real price, or poll a delivery scan. What it can do is stop
 * a tracking number from being a dead string: hold the carrier's own tracking
 * URL, recognise a number the owner pasted, and hand the customer a link that
 * works.
 *
 * This is deliberately a table and not an API client. When a real carrier
 * account is connected later, `lookup` is the seam: the shape a carrier
 * already has here is the shape an integration would fill in, so nothing
 * above this file has to learn a second vocabulary.
 */

const CARRIERS = [
  {
    code: 'ups',
    name: 'UPS',
    trackingUrl: 'https://www.ups.com/track?tracknum={number}',
    // 1Z, then a six-character shipper number, then service and package digits.
    pattern: /^1Z[0-9A-Z]{16}$/i,
    services: ['Ground', 'Next Day Air', '2nd Day Air', '3 Day Select'],
  },
  {
    code: 'fedex',
    name: 'FedEx',
    trackingUrl: 'https://www.fedex.com/fedextrack/?trknbr={number}',
    pattern: /^(\d{12}|\d{15}|\d{20})$/,
    services: ['Ground', 'Home Delivery', 'Express Saver', '2Day', 'Priority Overnight'],
  },
  {
    code: 'usps',
    name: 'USPS',
    trackingUrl: 'https://tools.usps.com/go/TrackConfirmAction?tLabels={number}',
    pattern: /^(9[2-5]\d{20}|\d{20}|[A-Z]{2}\d{9}US)$/i,
    services: ['Ground Advantage', 'Priority Mail', 'Priority Mail Express', 'First-Class'],
  },
  {
    code: 'dhl',
    name: 'DHL',
    trackingUrl: 'https://www.dhl.com/en/express/tracking.html?AWB={number}',
    pattern: /^\d{10,11}$/,
    services: ['Express Worldwide', 'Economy Select'],
  },
];

const OTHER = {
  code: 'other',
  name: 'Other carrier',
  trackingUrl: null,
  pattern: null,
  services: [],
};

function list() {
  return CARRIERS.map((carrier) => ({ ...carrier })).concat([{ ...OTHER }]);
}

function lookup(code) {
  if (!code) return null;
  const wanted = String(code).trim().toLowerCase();
  const found = CARRIERS.find((carrier) => carrier.code === wanted
    || carrier.name.toLowerCase() === wanted);
  if (found) return { ...found };
  return wanted === 'other' ? { ...OTHER } : null;
}

/**
 * The carrier a tracking number belongs to, or null.
 *
 * Only used to offer a default the owner can overrule. A number that matches
 * two carriers' formats — plenty of them are just a run of digits — resolves
 * to nothing rather than to a coin toss, because a wrong carrier produces a
 * tracking link that fails in the customer's hands.
 */
function detect(trackingNumber) {
  const clean = String(trackingNumber || '').replace(/[\s-]/g, '');
  if (!clean) return null;
  const matches = CARRIERS.filter((carrier) => carrier.pattern && carrier.pattern.test(clean));
  return matches.length === 1 ? { ...matches[0] } : null;
}

function trackingUrlFor(code, trackingNumber) {
  const carrier = lookup(code);
  const clean = String(trackingNumber || '').replace(/[\s-]/g, '');
  if (!carrier || !carrier.trackingUrl || !clean) return null;
  return carrier.trackingUrl.replace('{number}', encodeURIComponent(clean));
}

function displayName(code) {
  const carrier = lookup(code);
  return carrier ? carrier.name : (code ? String(code) : null);
}

module.exports = { list, lookup, detect, trackingUrlFor, displayName };

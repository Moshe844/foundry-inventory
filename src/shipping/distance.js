'use strict';

/*
 * How far a parcel travels, roughly, from one address to another.
 *
 * A carrier prices a parcel by zone: the farther apart the two postcodes, the
 * higher the zone. StockChief has no carrier zone chart of its own, so it
 * estimates the distance from the state each address is in, measured between
 * the approximate centre of each state, and turns it into the same distance
 * bands carriers use. Two addresses in the same postcode area (the first three
 * digits) count as local. It only answers when both addresses name a US state;
 * otherwise it says it does not know, and the caller must not guess.
 *
 * These centres are public geography, not business data.
 */
const CENTRES = {
  AL: [32.8, -86.8], AK: [64.7, -152.5], AZ: [34.3, -111.7], AR: [34.9, -92.4], CA: [37.2, -119.4],
  CO: [39.0, -105.5], CT: [41.6, -72.7], DE: [39.0, -75.5], DC: [38.9, -77.0], FL: [28.6, -82.4],
  GA: [32.7, -83.4], HI: [20.3, -156.4], ID: [44.4, -114.6], IL: [40.0, -89.2], IN: [39.9, -86.3],
  IA: [42.1, -93.5], KS: [38.5, -98.4], KY: [37.5, -85.3], LA: [31.1, -92.0], ME: [45.4, -69.2],
  MD: [39.0, -76.8], MA: [42.3, -71.8], MI: [44.3, -85.4], MN: [46.3, -94.3], MS: [32.7, -89.7],
  MO: [38.4, -92.5], MT: [47.0, -109.6], NE: [41.5, -99.8], NV: [39.3, -116.6], NH: [43.7, -71.6],
  NJ: [40.2, -74.7], NM: [34.4, -106.1], NY: [42.9, -75.5], NC: [35.6, -79.4], ND: [47.5, -100.5],
  OH: [40.3, -82.8], OK: [35.6, -97.5], OR: [43.9, -120.6], PA: [40.9, -77.8], RI: [41.7, -71.5],
  SC: [33.9, -80.9], SD: [44.4, -100.2], TN: [35.9, -86.4], TX: [31.5, -99.3], UT: [39.3, -111.7],
  VT: [44.1, -72.7], VA: [37.5, -78.9], WA: [47.4, -120.5], WV: [38.6, -80.6], WI: [44.6, -89.9],
  WY: [43.0, -107.6], PR: [18.2, -66.5], VI: [18.3, -64.9], GU: [13.4, 144.8], AS: [-14.3, -170.7],
  MP: [15.1, 145.7],
};
// The distance bands behind US parcel zones 1 to 8, in miles.
const BANDS = [[50, 1], [150, 2], [300, 3], [600, 4], [1000, 5], [1400, 6], [1800, 7]];

function miles([lat1, lon1], [lat2, lon2]) {
  const rad = (d) => d * Math.PI / 180, r = 3958.8;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)));
}

const domestic = (place) => place && (place.country || 'US') === 'US' && CENTRES[place.state];
const area = (place) => /^\d{5}/.test(place.postalCode || '') ? place.postalCode.slice(0, 3) : null;

/** Distance from one parsed address to another, or null when it cannot be told. */
function between(from, to) {
  if (!domestic(from) || !domestic(to)) return null;
  if (area(from) && area(from) === area(to)) return { miles: 0, zone: 1, label: 'Same area' };
  if (from.state === to.state) return { miles: 0, zone: 2, label: 'Same state' };
  const distance = Math.round(miles(CENTRES[from.state], CENTRES[to.state]));
  const zone = Math.max(2, (BANDS.find(([limit]) => distance <= limit) || [0, 8])[1]);
  return { miles: distance, zone, label: 'About ' + distance.toLocaleString('en-US') + ' miles' };
}

module.exports = { between, CENTRES };

'use strict';

/*
 * An address, from the way people actually write one.
 *
 * Foundry stores a destination as the text somebody typed or a customer wrote,
 * which is right: it is what was said, and a parcel is addressed in words.
 * A carrier, though, wants fields — street, city, state, postcode — and will
 * refuse or misdeliver anything else.
 *
 * So this reads the text and says what it found, including how sure it is. It
 * never fills a gap. An address with no postcode comes back as an address with
 * no postcode and `complete: false`, and Foundry asks once rather than shipping
 * to a guess. A parcel sent to an address software completed on somebody's
 * behalf is a parcel nobody can find, and the cost of asking is one question.
 */

const STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV',
  'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC', 'PR', 'VI', 'GU', 'AS', 'MP']);

const ZIP = /\b(\d{5})(?:-(\d{4}))?\b/;
/* A line that is only a street when it starts with a number or a PO box. */
const STREET = /^(\d+\s+\S|p\.?\s?o\.?\s+box\b|box\s+\d|unit\s+\d|apt\b|suite\b|ste\b)/i;

const clean = (value) => String(value || '').replace(/\r/g, '').trim();

/**
 * What the text says, field by field.
 *
 * Deliberately conservative and deliberately American: the shop this was built
 * for ships domestically, every carrier here quotes on a five-digit ZIP, and a
 * parser that half-understood six countries would be worse than one that is
 * honest about the one it knows. A country other than US comes back
 * `complete: false` with the raw text intact, which routes it to a person.
 */
function parse(text) {
  const raw = clean(text);
  const found = {
    raw, name: null, line1: null, line2: null, city: null,
    state: null, postalCode: null, country: 'US', complete: false, missing: [],
  };
  if (!raw) { found.missing = ['street', 'city', 'state', 'postcode']; return found; }

  // Commas and newlines are the same separator; people use both interchangeably.
  const parts = raw.split(/\n|,/).map((line) => line.trim()).filter(Boolean);

  const zipAt = parts.findIndex((line) => ZIP.test(line));
  if (zipAt >= 0) {
    const match = parts[zipAt].match(ZIP);
    found.postalCode = match[2] ? `${match[1]}-${match[2]}` : match[1];
    // "NY 10950" and "Monroe NY 10950" both put the state next to the postcode.
    const beside = parts[zipAt].replace(ZIP, ' ').trim().split(/\s+/).filter(Boolean);
    const state = beside.find((word) => STATES.has(word.toUpperCase().replace(/\./g, '')));
    if (state) found.state = state.toUpperCase().replace(/\./g, '');
    const rest = beside.filter((word) => word !== state).join(' ').trim();
    if (rest && rest.length > 1) found.city = rest;
  }

  if (!found.state) {
    for (const line of parts) {
      const words = line.split(/\s+/);
      const state = words.find((word) => STATES.has(word.toUpperCase().replace(/[.,]/g, '')));
      if (state) { found.state = state.toUpperCase().replace(/[.,]/g, ''); break; }
    }
  }

  const streets = parts.filter((line) => STREET.test(line));
  if (streets.length) {
    found.line1 = streets[0];
    if (streets.length > 1) found.line2 = streets[1];
  }

  if (!found.city) {
    /*
     * The city is what is left: not the street, not the state-and-postcode
     * line, and not the name at the top. Taking the last such line rather than
     * the first, because a name and a company both sit above the address and
     * the town never does.
     */
    const candidates = parts.filter((line) =>
      line !== found.line1 && line !== found.line2 && !ZIP.test(line)
      && !STATES.has(line.toUpperCase().replace(/[.,]/g, '')));
    const streetAt = parts.indexOf(found.line1);
    const after = streetAt >= 0 ? candidates.filter((line) => parts.indexOf(line) > streetAt) : candidates;
    if (after.length) found.city = after[0];
  }

  // A name is a line above the street that is not part of the address.
  const streetIndex = parts.indexOf(found.line1);
  if (streetIndex > 0) found.name = parts[0];

  if (!found.line1) found.missing.push('street');
  if (!found.city) found.missing.push('city');
  if (!found.state) found.missing.push('state');
  if (!found.postalCode) found.missing.push('postcode');
  found.complete = found.missing.length === 0;
  return found;
}

/** What to tell somebody when a parcel cannot be addressed yet. */
function why(parsed) {
  if (!parsed || parsed.complete) return null;
  if (!parsed.raw) return 'There is no delivery address on this order.';
  const list = parsed.missing.length === 1
    ? parsed.missing[0]
    : `${parsed.missing.slice(0, -1).join(', ')} and ${parsed.missing[parsed.missing.length - 1]}`;
  return `The delivery address is missing the ${list}. A carrier will not quote without it, and `
    + 'Foundry will not fill it in on the customer\'s behalf.';
}

/** One line, for a screen. */
function oneLine(parsed) {
  if (!parsed) return '';
  return [parsed.line1, parsed.line2, parsed.city,
    [parsed.state, parsed.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean).join(', ');
}

module.exports = { parse, why, oneLine, STATES };

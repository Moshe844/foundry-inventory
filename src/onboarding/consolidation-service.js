'use strict';

/**
 * Making one inventory out of several files that disagree.
 *
 * The customer with four spreadsheets is the normal case, not the edge case,
 * and the files never line up. The same product is written two ways, a location
 * is spelled three ways, and two files give different quantities for the same
 * SKU in the same warehouse.
 *
 * The rule that governs all of it: normalise what is unambiguous, and ask about
 * what is not. Two spellings of "Brooklyn Warehouse" are the same warehouse and
 * nobody needs to be consulted. Eighteen units in one file and fourteen in
 * another is a real disagreement about what the business physically owns, and
 * picking one silently would be inventing a stock figure. Foundry may recommend
 * — with a reason, when the files themselves establish which is newer — but a
 * conflict without a decision blocks the migration rather than resolving itself.
 *
 * Everything here is arithmetic and string comparison. No model decides which
 * number is true.
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const resolver = require('../actions/resolver');
const catalog = require('../imports/catalog-service');
const sourceService = require('./source-service');

/**
 * What a location is called when the file never says.
 *
 * Deliberately plain: it describes the only place the stock can be, and the
 * owner renames it the moment they have a better word for it.
 */
const DEFAULT_LOCATION_NAME = 'Main location';

const CONFLICT = {
  SAME_PRODUCT_DIFFERENT_NAMES: 'same_product_different_names',
  DUPLICATE_SKU: 'duplicate_sku',
  QUANTITY_CONFLICT: 'quantity_conflict',
  LOCATION_NAMING: 'location_naming',
  DUPLICATE_SERIAL: 'duplicate_serial',
  LOT_CONFLICT: 'lot_conflict',
  MISSING_IDENTIFIER: 'missing_identifier',
  POSSIBLE_STALE_SOURCE: 'possible_stale_source',
};

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

const normaliseKey = (text) => String(text || '').trim().toLowerCase();

/**
 * The real rows of a source, re-read from the bytes it was uploaded as.
 *
 * The stored profile summarises a file; it does not contain it. Consolidation
 * needs every row, so the original bytes are parsed again — deterministically,
 * by the same Mission 5 reader — which also means the rows being consolidated
 * are provably the ones the customer handed over.
 */
function readRows(db, workspaceId, source) {
  const sheetProfile =
    source.profile.sheets[source.profile.primarySheetIndex] || source.profile.sheets[0];
  if (!sheetProfile) return { sheet: null, rows: [], at: () => '' };

  const parser = require('../imports/parser');
  const { buffer, filename } = sourceService.contentOf(db, workspaceId, source.id);
  const parsed = parser.parse({ buffer, filename });
  const sheet = parsed.sheets[source.profile.primarySheetIndex] || parsed.sheets[0];

  const at = (cells, field) =>
    sheetProfile.mappings[field] === undefined
      ? ''
      : String(cells[sheetProfile.mappings[field]] ?? '').trim();

  // The parser's own row number is kept, not just the cells. It is what lets a
  // migration exclude exactly the rows consolidation decided against, matched
  // against the identical parse the import engine does.
  return { sheet: sheetProfile, rows: sheet ? sheet.rows : [], at };
}

/**
 * Groups the same product across files.
 *
 * A code is decisive — that is what a code is for. Names are only ever used
 * when there is no code, and a resemblance between names becomes a question
 * rather than a merge.
 */
function keyForRow(row) {
  if (row.code) return { key: `code:${normaliseKey(row.code)}`, by: 'code' };
  if (row.name) return { key: `name:${normaliseKey(row.name)}`, by: 'name' };
  return { key: null, by: null };
}

/**
 * Is `short` an abbreviation of `long`?
 *
 * "Whse" for "Warehouse", "Wrhs", "Bldg" for "Building". Businesses abbreviate
 * relentlessly and inconsistently, and treating those as different warehouses
 * would split one location's stock in two. The test is a subsequence: every
 * letter of the short form appears in the long one, in order, starting from the
 * same letter.
 */
function isAbbreviationOf(short, long) {
  const a = String(short).toLowerCase();
  const b = String(long).toLowerCase();
  if (a.length < 2 || a.length >= b.length) return false;
  if (a[0] !== b[0]) return false;

  let index = 0;
  for (const letter of a) {
    index = b.indexOf(letter, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

const tokensOf = (name) =>
  String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Whether two location names are the same place written differently. */
function sameLocation(a, b) {
  if (normaliseKey(a) === normaliseKey(b)) return true;

  const left = tokensOf(a);
  const right = tokensOf(b);
  if (!left.length || !right.length) return false;

  // Compare the parts that carry meaning. Every token of the shorter name has
  // to be matched by one of the longer's, as itself, a typo of it, or an
  // abbreviation of it.
  const [shortSide, longSide] = left.length <= right.length ? [left, right] : [right, left];
  const used = new Set();
  const matched = shortSide.every((token) =>
    longSide.some((candidate, index) => {
      if (used.has(index)) return false;
      const same =
        token === candidate ||
        isAbbreviationOf(token, candidate) ||
        isAbbreviationOf(candidate, token) ||
        (resolver.distance(token, candidate) > 0 &&
          resolver.distance(token, candidate) <= resolver.tolerance(token));
      if (same) used.add(index);
      return same;
    })
  );
  if (!matched) return false;

  // "Brooklyn" and "Brooklyn Warehouse" are the same place. "Brooklyn Store"
  // and "Brooklyn Warehouse" are not — the extra word has to be a generic one.
  const GENERIC = new Set(['warehouse', 'whse', 'wh', 'wrhs', 'depot', 'dc', 'site', 'facility', 'location', 'bldg', 'building']);
  const extras = longSide.filter((token, index) => !used.has(index));
  return extras.every((token) => GENERIC.has(token) || isAbbreviationOf(token, 'warehouse'));
}

/**
 * Location names that are obviously the same place.
 *
 * "Brooklyn", "Brooklyn Warehouse", "Brooklyn Whse" and "brooklyn warehouse "
 * are one location. The typo tolerance is the Mission 4 resolver's, so
 * onboarding and instructions agree about what counts as the same word.
 */
function groupLocations(names) {
  const groups = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;

    const match = groups.find((group) => group.variants.some((variant) => sameLocation(variant, name)));
    if (match) {
      if (!match.variants.includes(name)) match.variants.push(name);
      // The fullest spelling becomes the one Foundry uses.
      if (name.length > match.canonical.length) match.canonical = name;
    } else {
      groups.push({ canonical: name, variants: [name] });
    }
  }
  return groups;
}

/**
 * Builds the plan: what would be created, and what needs deciding first.
 */
function analyse(db, workspaceId, sources) {
  const usable = sources.filter((source) => !source.excluded);
  if (usable.length === 0) throw new ValidationError('There are no files to build an inventory from.');

  const products = new Map();      // key -> { names, codes, rows, sources }
  const quantities = new Map();    // key|location -> [{ sourceId, quantity }]
  const serials = new Map();       // serial -> [sourceId]
  const locationNames = [];
  const conflicts = [];
  const excluded = [];

  let totalRows = 0;

  // Read everything first. Locations have to be grouped before quantities are
  // bucketed, or "Brooklyn Whse" and "Brooklyn Warehouse" become two different
  // shelves and the disagreement between them is never noticed.
  const readSources = usable.map((source) => {
    const { sheet, rows, at } = readRows(db, workspaceId, source);
    return { source, sheet, rows, at };
  });

  for (const entry of readSources) {
    if (!entry.sheet) continue;
    for (const sourceRow of entry.rows) {
      if (entry.sheet.mappings.location === undefined) continue;
      const where = entry.at(sourceRow.cells, 'location');
      if (where) locationNames.push(where);
    }
  }
  const locationGroups = groupLocations(locationNames);

  /*
   * A stock file that never says where the stock is.
   *
   * Perfectly ordinary — a shop with one store room lists what it has, not
   * where, because there is only one answer. Foundry proposed no locations,
   * and then every row failed validation with "No location for this stock,
   * and no default chosen": forty good rows, nothing created, and a migration
   * that reported "There is nothing in that file Foundry can import" about a
   * file it had just read forty products and 751 units out of.
   *
   * Somewhere is required before stock can exist, so one is proposed. It is
   * named, shown on the review page before anything is created, and renameable
   * afterwards like any other location.
   */
  const quantitiesPresent = readSources.some((entry) => entry.sheet
    && entry.sheet.mappings.quantity !== undefined);
  if (!locationGroups.length && quantitiesPresent) {
    locationGroups.push({ canonical: DEFAULT_LOCATION_NAME, variants: [DEFAULT_LOCATION_NAME], invented: true });
  }
  const canonicalFor = (name) => {
    const group = locationGroups.find((candidate) => candidate.variants.includes(String(name).trim()));
    return group ? group.canonical : String(name || '').trim();
  };

  for (const { source, sheet, rows, at } of readSources) {
    if (!sheet) continue;
    totalRows += sheet.rows;

    for (const parsedRow of rows) {
      const cells = parsedRow.cells;
      const row = {
        sourceRow: parsedRow.sourceRow,
        name: at(cells, 'name'),
        code: at(cells, 'code'),
        location: at(cells, 'location'),
        quantityText: at(cells, 'quantity'),
        serial: at(cells, 'serial'),
        lotCode: at(cells, 'lotCode'),
        variants: ['variant1', 'variant2', 'variant3']
          .filter((field) => sheet.mappings[field] !== undefined)
          .map((field) => at(cells, field))
          .filter(Boolean),
      };

      const { key, by } = keyForRow(row);
      if (!key) {
        excluded.push({ sourceId: source.id, sourceName: source.name, because: 'no product name or code' });
        continue;
      }

      if (!products.has(key)) {
        products.set(key, { key, by, names: new Set(), codes: new Set(), sources: new Set(), rows: [] });
      }
      const product = products.get(key);
      if (row.name) product.names.add(row.name);
      if (row.code) product.codes.add(row.code);
      product.sources.add(source.id);
      product.rows.push({ ...row, sourceId: source.id, sourceName: source.name });

      const quantity = /^\d+$/.test(row.quantityText.replace(/[\s,]/g, ''))
        ? Number(row.quantityText.replace(/[\s,]/g, ''))
        : null;
      if (quantity !== null) {
        const variantKey = row.variants.length ? `|${row.variants.join('/')}`.toLowerCase() : '';
        // Bucketed by the canonical location, so two spellings of one
        // warehouse are compared with each other rather than side by side.
        const cell = `${key}${variantKey}|${normaliseKey(canonicalFor(row.location))}`;
        if (!quantities.has(cell)) quantities.set(cell, []);
        quantities.get(cell).push({
          sourceId: source.id,
          sourceName: source.name,
          sourceRow: row.sourceRow,
          quantity,
          observedAt: source.observedAt,
          purpose: source.inferredPurpose,
          product: [...product.names][0] || [...product.codes][0],
          variants: row.variants,
          location: canonicalFor(row.location),
        });
      }

      if (row.serial) {
        const serialKey = normaliseKey(row.serial);
        if (!serials.has(serialKey)) serials.set(serialKey, []);
        serials.get(serialKey).push({ sourceId: source.id, sourceName: source.name, serial: row.serial });
      }
    }
  }

  // --- the same product written two ways -----------------------------------
  for (const product of products.values()) {
    if (product.by === 'code' && product.names.size > 1) {
      const names = [...product.names];
      conflicts.push({
        kind: CONFLICT.SAME_PRODUCT_DIFFERENT_NAMES,
        severity: 'review',
        subject: `${[...product.codes][0]} — ${names.join(' / ')}`,
        detail: { key: product.key, code: [...product.codes][0], names },
        evidence: product.rows.slice(0, 6).map((row) => ({
          source: row.sourceName,
          says: `${row.code} — ${row.name}`,
        })),
        options: names.map((name) => ({ id: `name:${name}`, label: `Call it "${name}"` })),
        // Same code means same product. Which name to keep is a preference,
        // not a risk, so Foundry recommends the fullest one and moves on.
        recommendedOption: `name:${names.reduce((a, b) => (b.length > a.length ? b : a))}`,
        recommendationReason: 'Same SKU in both files, so these are one product. The longer name usually carries more detail.',
      });
    }
  }

  // --- two files disagreeing about a quantity -------------------------------
  for (const [cellKey, entries] of quantities) {
    const distinct = [...new Set(entries.map((entry) => entry.quantity))];
    if (entries.length < 2 || distinct.length < 2) continue;

    const first = entries[0];
    // A file that says when it was true beats one that does not — but only when
    // the file itself establishes it, never from an upload timestamp.
    const dated = entries.filter((entry) => entry.observedAt);
    const newest = dated.length
      ? dated.reduce((a, b) => (b.observedAt > a.observedAt ? b : a))
      : null;
    const counts = entries.filter((entry) => entry.purpose === sourceService.PURPOSES.STOCK_COUNT);

    let recommended = null;
    let reason = null;
    if (newest && dated.length === entries.length && new Set(dated.map((e) => e.observedAt)).size > 1) {
      recommended = `source:${newest.sourceId}`;
      reason = `${newest.sourceName} says it is from ${newest.observedAt}, which is the newer of the two.`;
    } else if (counts.length === 1) {
      recommended = `source:${counts[0].sourceId}`;
      reason = `${counts[0].sourceName} looks like a physical count, which normally beats an export of what the system believed.`;
    }

    conflicts.push({
      kind: CONFLICT.QUANTITY_CONFLICT,
      // Blocking without a recommendation: Foundry will not invent a stock
      // figure, and a migration that guessed here would be silently wrong.
      severity: recommended ? 'review' : 'blocking',
      subject: `${first.product}${first.variants.length ? ` ${first.variants.join('/')}` : ''} at ${first.location || 'no location'}`,
      detail: {
        cellKey,
        product: first.product,
        variants: first.variants,
        location: first.location,
        entries: entries.map((entry) => ({
          sourceId: entry.sourceId,
          sourceName: entry.sourceName,
          quantity: entry.quantity,
          observedAt: entry.observedAt,
        })),
      },
      evidence: entries.map((entry) => ({
        source: entry.sourceName,
        says: `${entry.quantity}`,
        when: entry.observedAt,
      })),
      options: entries.map((entry) => ({
        id: `source:${entry.sourceId}`,
        label: `Use ${entry.quantity} from ${entry.sourceName}`,
      })),
      recommendedOption: recommended,
      recommendationReason: reason,
    });
  }

  // --- the same serial number in two places ---------------------------------
  for (const [serial, entries] of serials) {
    if (entries.length < 2) continue;
    conflicts.push({
      kind: CONFLICT.DUPLICATE_SERIAL,
      severity: 'blocking',
      subject: `Serial ${entries[0].serial}`,
      detail: { serial, sources: entries.map((entry) => entry.sourceName) },
      evidence: entries.map((entry) => ({ source: entry.sourceName, says: entry.serial })),
      options: [
        { id: 'keep_one', label: 'Import it once' },
        { id: 'exclude', label: 'Leave it out until I check' },
      ],
      recommendedOption: null,
      recommendationReason: null,
    });
  }

  // --- locations spelled several ways ---------------------------------------
  const locationMappings = {};
  for (const group of locationGroups) {
    for (const variant of group.variants) locationMappings[variant] = group.canonical;
    if (group.variants.length > 1) {
      conflicts.push({
        kind: CONFLICT.LOCATION_NAMING,
        // Spellings of one warehouse are not a business decision.
        severity: 'resolved_automatically',
        subject: group.canonical,
        detail: { canonical: group.canonical, variants: group.variants },
        evidence: group.variants.map((variant) => ({ source: 'files', says: variant })),
        options: group.variants.map((variant) => ({ id: `name:${variant}`, label: `Call it "${variant}"` })),
        recommendedOption: `name:${group.canonical}`,
        recommendationReason: 'These are spellings of one place, so Foundry treats them as one location.',
      });
    }
  }

  /**
   * Two entries that are the same product told apart by a variant column.
   *
   * The sheet distinguishes them itself — black from white, small from medium —
   * so there is nothing for a person to decide. Only rows that actually carry
   * differing variant values count: two rows with no variants at all are not
   * siblings, they are candidates for a genuine duplicate.
   */
  function variantSiblings(left, right) {
    const valuesOf = (product) => product.rows
      .flatMap((row) => row.variants || [])
      .map((value) => normaliseKey(value))
      .filter(Boolean);
    const a = new Set(valuesOf(left));
    const b = new Set(valuesOf(right));
    if (!a.size || !b.size) return false;
    return [...a].some((value) => !b.has(value)) || [...b].some((value) => !a.has(value));
  }

  // --- products that only resemble each other -------------------------------
  const named = [...products.values()].filter((product) => product.names.size);
  for (let i = 0; i < named.length; i += 1) {
    for (let j = i + 1; j < named.length; j += 1) {
      const a = [...named[i].names][0];
      const b = [...named[j].names][0];
      const sameCode = [...named[i].codes].some((code) => named[j].codes.has(code));
      if (sameCode) continue;

      /*
       * This asks whether two products with *different* names are really one.
       * It was also firing when the names were identical, which is not a
       * question anybody can answer: a clothing sheet with one row per size
       * produced fifty-two of "Classic Crew T-Shirt / Classic Crew T-Shirt —
       * treat as the same product, or keep them separate?", each comparing a
       * product to itself. Forty rows, and setup asked fifty-two unanswerable
       * questions before it would create anything.
       *
       * Rows sharing a name and differing by a mapped variant column are the
       * ordinary shape of a product sheet — the same shirt in black and in
       * medium. Foundry had already recognised Color and Size as variant axes
       * on this very file, so the sheet had answered the question before it
       * was asked.
       */
      if (normaliseKey(a) === normaliseKey(b)) continue;
      if (variantSiblings(named[i], named[j])) continue;

      if (!catalog.looksLikeSameProduct(a, b)) continue;
      conflicts.push({
        kind: CONFLICT.SAME_PRODUCT_DIFFERENT_NAMES,
        severity: 'review',
        subject: `${a} / ${b}`,
        detail: { keys: [named[i].key, named[j].key], names: [a, b] },
        evidence: [
          { source: [...named[i].sources][0], says: a },
          { source: [...named[j].sources][0], says: b },
        ],
        options: [
          { id: 'merge', label: 'Treat as the same product' },
          { id: 'separate', label: 'Keep them separate' },
        ],
        // No code links these; only their names resemble each other. Merging
        // two real products would fuse their stock, so a person decides.
        recommendedOption: null,
        recommendationReason: null,
      });
    }
  }

  const expectedTotals = expectedFrom(usable, quantities, products, locationGroups);

  // Every position more than one row speaks to, and which row said what.
  //
  // Consolidation decides what the files add up to; the migration then imports
  // the files. Without this the two disagreed — the migration re-imported every
  // row of every file, so a product counted in two places was created twice and
  // a settled conflict was ignored entirely.
  const cells = [...quantities.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([key, entries]) => ({
      key,
      entries: entries.map((entry) => ({
        sourceId: entry.sourceId,
        sourceRow: entry.sourceRow,
        quantity: entry.quantity,
      })),
    }));

  return {
    cells,
    products: [...products.values()].map((product) => ({
      key: product.key,
      by: product.by,
      names: [...product.names],
      codes: [...product.codes],
      sourceCount: product.sources.size,
      rowCount: product.rows.length,
    })),
    locations: locationGroups,
    locationMappings,
    conflicts,
    excluded,
    expectedTotals,
    totalRows,
  };
}

/**
 * What the sources say, counted before anything is created.
 *
 * These are the figures the reconciliation compares against afterwards, which
 * is the whole point of computing them here rather than describing the result.
 */
function expectedFrom(sources, quantities, products, locationGroups) {
  let units = 0;
  for (const entries of quantities.values()) {
    // Where files disagree, the expectation cannot be known until the conflict
    // is settled; the highest is used as an upper bound and the reconciliation
    // recomputes from decisions before it judges anything.
    units += Math.max(...entries.map((entry) => entry.quantity));
  }
  return {
    products: products.size,
    locations: locationGroups.length,
    units,
    sources: sources.map((source) => ({
      id: source.id,
      name: source.name,
      hash: source.contentHash,
      rows: source.profile.totals ? source.profile.totals.rows : 0,
      units: source.profile.totals ? source.profile.totals.units : 0,
    })),
  };
}

module.exports = {
  CONFLICT,
  normaliseKey,
  isAbbreviationOf,
  sameLocation,
  keyForRow,
  groupLocations,
  readRows,
  analyse,
  expectedFrom,
};

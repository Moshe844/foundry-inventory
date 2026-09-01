'use strict';

/**
 * Reading each row of a file into records, and saying what is wrong with it.
 *
 * Entirely deterministic and entirely offline. The model proposed which column
 * was which; from here on it is arithmetic and lookups, because this is the
 * step that decides what quantity lands in a real balance.
 *
 * The rule that shapes all of this: a missing figure is never invented. A row
 * with no quantity creates the product and no opening stock, and says so. A
 * date Foundry cannot read is dropped and reported, not guessed at. A location
 * it does not recognise stops that row rather than picking the nearest.
 */

const resolver = require('../actions/resolver');
const fields = require('./fields');
const prices = require('../pricing/price-service');

const MAX_FUZZY_ROWS = 2000;

const PROBLEM = {
  NO_PRODUCT: 'no_product',
  BAD_QUANTITY: 'bad_quantity',
  NEGATIVE_QUANTITY: 'negative_quantity',
  FRACTIONAL_QUANTITY: 'fractional_quantity',
  NO_QUANTITY: 'no_quantity',
  UNKNOWN_LOCATION: 'unknown_location',
  NO_LOCATION: 'no_location',
  CORRECTED_LOCATION: 'corrected_location',
  DUPLICATE_CODE: 'duplicate_code',
  DUPLICATE_SERIAL: 'duplicate_serial',
  SERIAL_EXISTS: 'serial_exists',
  MISSING_SERIAL: 'missing_serial',
  MISSING_LOT: 'missing_lot',
  BAD_DATE: 'bad_date',
  EXISTING_PRODUCT: 'existing_product',
  POSSIBLE_DUPLICATE: 'possible_duplicate',
  INCONSISTENT_VARIANTS: 'inconsistent_variants',
  BAD_PRICE: 'bad_price',
  PRICE_REQUIRED: 'price_required',
  AMBIGUOUS_EXISTING_CODE: 'ambiguous_existing_code',
  PRICE_TARGET_NOT_FOUND: 'price_target_not_found',
};

/** Blocking problems stop a row; the rest annotate it. */
const BLOCKING = new Set([
  PROBLEM.NO_PRODUCT,
  PROBLEM.BAD_QUANTITY,
  PROBLEM.NEGATIVE_QUANTITY,
  PROBLEM.FRACTIONAL_QUANTITY,
  PROBLEM.UNKNOWN_LOCATION,
  PROBLEM.NO_LOCATION,
  PROBLEM.DUPLICATE_SERIAL,
  PROBLEM.SERIAL_EXISTS,
  PROBLEM.MISSING_SERIAL,
  PROBLEM.MISSING_LOT,
  PROBLEM.AMBIGUOUS_EXISTING_CODE,
  PROBLEM.PRICE_TARGET_NOT_FOUND,
  PROBLEM.PRICE_REQUIRED,
]);

/** Problems a person should see before approving, but which still import. */
const REVIEWABLE = new Set([
  PROBLEM.EXISTING_PRODUCT,
  PROBLEM.POSSIBLE_DUPLICATE,
  PROBLEM.CORRECTED_LOCATION,
  PROBLEM.DUPLICATE_CODE,
  PROBLEM.BAD_PRICE,
]);

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * "1,200" → 1200. "1 200" → 1200. "12.5" → fractional. "" → nothing.
 *
 * Foundry counts in whole units, so a fraction is refused rather than rounded:
 * rounding 12.5 to 12 quietly loses stock and rounding to 13 invents it.
 */
function readQuantity(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null, missing: true };

  const cleaned = text.replace(/[\s,](?=\d{3}\b)/g, '').replace(/^\+/, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: false, problem: PROBLEM.BAD_QUANTITY };

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { ok: false, problem: PROBLEM.BAD_QUANTITY };
  if (value < 0) return { ok: false, problem: PROBLEM.NEGATIVE_QUANTITY };
  if (!Number.isInteger(value)) return { ok: false, problem: PROBLEM.FRACTIONAL_QUANTITY };
  return { ok: true, value };
}

const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/;
const NAMED = /^(\d{1,2})[\s-]*([a-z]{3,})[\s-]*(\d{2,4})$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Which way round a column of slashed dates is written.
 *
 * 03/04/2025 is March or April depending on where the file came from, and there
 * is no way to know from one row. There usually is from the column: one value
 * with 25 in front settles it for every row beneath. When nothing settles it,
 * the column is reported as ambiguous rather than assumed to be American.
 */
function detectDateOrder(values) {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const value of values) {
    const match = SLASHED.exec(String(value || '').trim());
    if (!match) continue;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a > 12 && b <= 12) dayFirst += 1;
    else if (b > 12 && a <= 12) monthFirst += 1;
  }
  if (dayFirst && !monthFirst) return { order: 'dmy', certain: true };
  if (monthFirst && !dayFirst) return { order: 'mdy', certain: true };
  if (dayFirst && monthFirst) return { order: 'mixed', certain: false };
  return { order: 'unknown', certain: false };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** @returns {{ok, value?, ambiguous?}} an ISO date, or nothing readable. */
function readDate(raw, order) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null };

  const iso = ISO.exec(text);
  if (iso) {
    const [, y, m, d] = iso;
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      return { ok: true, value: `${y}-${pad(m)}-${pad(d)}` };
    }
    return { ok: false };
  }

  const named = NAMED.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (month >= 0) {
      const year = Number(named[3]) < 100 ? 2000 + Number(named[3]) : Number(named[3]);
      return { ok: true, value: `${year}-${pad(month + 1)}-${pad(named[1])}` };
    }
    return { ok: false };
  }

  const slashed = SLASHED.exec(text);
  if (slashed) {
    const a = Number(slashed[1]);
    const b = Number(slashed[2]);
    const year = Number(slashed[3]) < 100 ? 2000 + Number(slashed[3]) : Number(slashed[3]);
    let day;
    let month;
    if (a > 12) { day = a; month = b; }
    else if (b > 12) { month = a; day = b; }
    else if (order === 'dmy') { day = a; month = b; }
    else if (order === 'mdy') { month = a; day = b; }
    else return { ok: true, value: null, ambiguous: true };

    if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false };
    return { ok: true, value: `${year}-${pad(month)}-${pad(day)}` };
  }

  return { ok: false };
}

// ---------------------------------------------------------------------------
// Workspace context
// ---------------------------------------------------------------------------

/** Everything the validator needs to look up, read once instead of per row. */
function loadContext(db, workspaceId) {
  const items = db
    .prepare(
      `SELECT id, name, base_code, tracking_mode, has_variants, unit_label
         FROM items WHERE workspace_id = ? AND is_active = 1`
    )
    .all(workspaceId);

  const byCode = new Map();
  const byName = new Map();
  const byId = new Map();
  for (const item of items) {
    if (item.base_code) byCode.set(item.base_code.toLowerCase(), item);
    byName.set(item.name.toLowerCase(), item);
    byId.set(item.id, item);
  }

  const skuByCode = new Map();
  for (const sku of db
    .prepare(
      `SELECT s.id, s.code, s.item_id, s.variant_label FROM skus s
         WHERE s.workspace_id = ? AND s.is_active = 1`
    )
    .all(workspaceId)) {
    const key = String(sku.code).toLowerCase();
    const matches = skuByCode.get(key) || [];
    matches.push(sku);
    skuByCode.set(key, matches);
  }

  const serials = new Set(
    db
      .prepare('SELECT serial FROM serial_units WHERE workspace_id = ?')
      .all(workspaceId)
      .map((row) => String(row.serial).toLowerCase())
  );

  return { items, byId, byCode, byName, skuByCode, serials };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const cell = (row, index) => (index === undefined ? '' : String(row.cells[index] ?? '').trim());

/**
 * Reads and checks every row.
 *
 * @param {object} plan { mappings, axisNames, detectedType, defaultLocationId, locationMappings }
 * @returns {{ rows, summary, locationsNeeded, dateOrder }}
 */
function validateRows(db, workspaceId, sheet, plan) {
  const context = plan.context || loadContext(db, workspaceId);
  const mappings = plan.mappings || {};
  const locationMappings = plan.locationMappings || {};
  const fuzzy = sheet.rows.length <= MAX_FUZZY_ROWS;

  const dateColumns = {};
  for (const field of ['expiresAt', 'receivedAt']) {
    if (mappings[field] === undefined) continue;
    dateColumns[field] = detectDateOrder(sheet.rows.map((row) => cell(row, mappings[field])));
  }

  // Location wording appears over and over; each distinct one is resolved once.
  const locationCache = new Map();
  const resolveLocationText = (text) => {
    const key = text.toLowerCase();
    if (locationCache.has(key)) return locationCache.get(key);
    let result;
    if (locationMappings[text] || locationMappings[key]) {
      const id = locationMappings[text] || locationMappings[key];
      const row = db
        .prepare('SELECT * FROM locations WHERE id = ? AND workspace_id = ?')
        .get(id, workspaceId);
      result = row ? { ok: true, value: row } : { ok: false, message: 'That location no longer exists.' };
    } else {
      result = resolver.resolveLocation(db, workspaceId, text);
    }
    locationCache.set(key, result);
    return result;
  };

  const defaultLocation = plan.defaultLocationId
    ? db.prepare('SELECT * FROM locations WHERE id = ? AND workspace_id = ?').get(plan.defaultLocationId, workspaceId)
    : null;

  const seenCodes = new Map();
  const seenSerials = new Map();
  const locationsNeeded = new Map();
  const axisValues = new Map();
  const out = [];

  const priceUpdate = plan.operationScope === 'selling_price_update';
  const needsQuantity = !priceUpdate && ['inventory', 'variant_inventory', 'receiving', 'lots', 'serials'].includes(
    plan.detectedType
  );

  sheet.rows.forEach((row, position) => {
    const problems = [];
    const parsed = {};

    const name = cell(row, mappings.name);
    const code = cell(row, mappings.code);
    parsed.name = name;
    parsed.code = code;
    // The code a scanner reads, kept beside the business code rather than
    // instead of it. A file that carries both is stating two different facts.
    parsed.barcode = cell(row, mappings.barcode);
    parsed.description = cell(row, mappings.description);
    parsed.unitLabel = cell(row, mappings.unitLabel);
    parsed.notes = cell(row, mappings.notes);
    parsed.currency = (cell(row, mappings.currency) || 'USD').toUpperCase();
    const rawPrice = cell(row, mappings.sellingPrice);
    parsed.sellingPriceMinor = null;
    if (rawPrice) {
      try {
        parsed.sellingPriceMinor = prices.toMinor(rawPrice, 'Selling price');
        parsed.currency = prices.normaliseCurrency(parsed.currency);
      } catch (error) {
        problems.push({ code: PROBLEM.BAD_PRICE, message: priceUpdate
          ? `${error.message} This pricing row will not run.`
          : `${error.message} This row's stock can still import, but its selling price will be left blank.` });
        if (priceUpdate) problems.push({ code: PROBLEM.PRICE_REQUIRED, message: 'A valid selling price is required for a pricing update.' });
      }
    } else if (priceUpdate) {
      problems.push({ code: PROBLEM.PRICE_REQUIRED, message: 'No selling price was provided. This pricing row will not run.' });
    }

    // Variant axes: the column header names the axis, the cell gives the value.
    parsed.variants = [];
    for (const field of fields.VARIANT_FIELDS) {
      if (mappings[field] === undefined) continue;
      const value = cell(row, mappings[field]);
      if (!value) continue;
      const axis = (plan.axisNames && plan.axisNames[field]) || fields.FIELD_LABEL[field];
      parsed.variants.push({ axis, value });
      if (!axisValues.has(axis)) axisValues.set(axis, new Set());
      axisValues.get(axis).add(value);
    }

    if (!name && !code) {
      problems.push({ code: PROBLEM.NO_PRODUCT, message: 'No product name or code in this row.' });
    }

    // Quantity.
    // A pricing instruction has explicitly scoped the file to prices. Even if
    // the sheet also contains an on-hand column, those figures are evidence for
    // matching/review only and can never become stock movements in this run.
    const quantity = priceUpdate ? { ok: true, value: 0, missing: true } : readQuantity(cell(row, mappings.quantity));
    if (!quantity.ok) {
      const text = cell(row, mappings.quantity);
      problems.push({
        code: quantity.problem,
        message:
          quantity.problem === PROBLEM.BAD_QUANTITY
            ? `“${text}” is not a number Foundry can count.`
            : quantity.problem === PROBLEM.NEGATIVE_QUANTITY
              ? `Quantity is ${text}. Stock cannot start out negative.`
              : `Quantity is ${text}. Foundry counts in whole units.`,
      });
      parsed.quantity = null;
    } else {
      parsed.quantity = quantity.value;
      if (quantity.missing && needsQuantity && mappings.quantity !== undefined) {
        problems.push({
          code: PROBLEM.NO_QUANTITY,
          message: 'No quantity given — the product is created with no opening stock.',
        });
      }
    }

    // Location. Only matters when there is stock to place.
    const wantsStock = parsed.quantity !== null && parsed.quantity > 0;
    const locationText = cell(row, mappings.location);
    parsed.locationText = locationText;
    parsed.locationId = null;
    if (locationText) {
      const resolved = resolveLocationText(locationText);
      if (resolved.ok) {
        parsed.locationId = resolved.value.id;
        parsed.locationName = resolved.value.name;
        // Any difference at all is worth showing. A near-miss that resolves by
        // a partial match ("Sout Depot" → South Depot) is just as much Foundry
        // deciding something on the customer's behalf as a typo correction is,
        // and it is only safe if they can see it before approving.
        if (resolved.value.name.toLowerCase() !== locationText.toLowerCase()) {
          problems.push({
            code: PROBLEM.CORRECTED_LOCATION,
            message: `“${locationText}” read as ${resolved.value.name}.`,
          });
        }
      } else if (wantsStock) {
        problems.push({
          code: PROBLEM.UNKNOWN_LOCATION,
          message: resolved.message || `There is no location called “${locationText}”.`,
        });
        locationsNeeded.set(locationText, (locationsNeeded.get(locationText) || 0) + 1);
      }
    } else if (wantsStock) {
      if (defaultLocation) {
        parsed.locationId = defaultLocation.id;
        parsed.locationName = defaultLocation.name;
      } else {
        problems.push({
          code: PROBLEM.NO_LOCATION,
          message: 'No location for this stock, and no default chosen.',
        });
      }
    }

    // Serials and lots.
    const serial = cell(row, mappings.serial);
    parsed.serial = serial;
    if (serial) {
      const key = serial.toLowerCase();
      if (seenSerials.has(key)) {
        problems.push({
          code: PROBLEM.DUPLICATE_SERIAL,
          message: `Serial ${serial} also appears on row ${seenSerials.get(key)}.`,
        });
      } else if (context.serials.has(key)) {
        problems.push({ code: PROBLEM.SERIAL_EXISTS, message: `Serial ${serial} is already in this inventory.` });
      } else {
        seenSerials.set(key, row.sourceRow);
      }
    } else if (plan.detectedType === 'serials' && wantsStock) {
      problems.push({ code: PROBLEM.MISSING_SERIAL, message: 'This is a serial-numbered file and this row has no serial.' });
    }

    const lotCode = cell(row, mappings.lotCode);
    parsed.lotCode = lotCode;
    if (!lotCode && plan.detectedType === 'lots' && wantsStock) {
      problems.push({ code: PROBLEM.MISSING_LOT, message: 'This is a lot-tracked file and this row has no lot code.' });
    }

    // Dates. Never invented: unreadable means dropped and reported.
    for (const field of ['expiresAt', 'receivedAt']) {
      if (mappings[field] === undefined) continue;
      const order = (dateColumns[field] || {}).order;
      const date = readDate(cell(row, mappings[field]), order);
      parsed[field] = date.value || null;
      if (!date.ok) {
        problems.push({
          code: PROBLEM.BAD_DATE,
          message: `Foundry could not read the date “${cell(row, mappings[field])}” — it is left blank.`,
        });
      } else if (date.ambiguous) {
        problems.push({
          code: PROBLEM.BAD_DATE,
          message: `“${cell(row, mappings[field])}” could be a day or a month first — it is left blank.`,
        });
      }
    }

    // Duplicates within the file, and against what already exists.
    if (code) {
      // A variant file repeats the product's code on every size, which is not a
      // duplicate — those rows are different versions of one product. Only the
      // same code *and* the same version twice is two rows for one thing.
      const key = [code, ...parsed.variants.map((v) => v.value)].join(' ').toLowerCase();
      if (seenCodes.has(key)) {
        problems.push({
          code: PROBLEM.DUPLICATE_CODE,
          message: parsed.variants.length
            ? `${code} ${parsed.variants.map((v) => v.value).join(' / ')} also appears on row ${seenCodes.get(key)} — the stock is added together.`
            : `Code ${code} also appears on row ${seenCodes.get(key)} — the stock is added together.`,
        });
      } else {
        seenCodes.set(key, row.sourceRow);
      }
    }

    const exactSkus = code ? (context.skuByCode.get(code.toLowerCase()) || []) : [];
    if (exactSkus.length > 1) {
      problems.push({
        code: PROBLEM.AMBIGUOUS_EXISTING_CODE,
        message: `Code ${code} belongs to more than one active variant. Foundry will not guess which one to update.`,
      });
    }
    const exactSku = exactSkus.length === 1 ? exactSkus[0] : null;
    const existing =
      (exactSku && context.byId.get(exactSku.item_id)) ||
      (code && context.byCode.get(code.toLowerCase())) ||
      (name && context.byName.get(name.toLowerCase())) ||
      null;
    if (existing) {
      parsed.existingItemId = existing.id;
      if (exactSku) parsed.existingSkuId = exactSku.id;
      problems.push({
        code: PROBLEM.EXISTING_PRODUCT,
        message: exactSku && parsed.sellingPriceMinor !== null && !wantsStock
          ? `${code} matches an existing variant — its selling price will be updated and no product will be created.`
          : `${existing.name} already exists — its stock is added to, never replaced.`,
      });
    } else if (fuzzy && name) {
      // A resemblance is shown, never acted on. Merging two products because
      // their names look alike would fuse two real stock figures.
      const near = context.items.find(
        (item) => item.name.toLowerCase() !== name.toLowerCase() && looksClose(name, item.name)
      );
      if (near) {
        problems.push({
          code: PROBLEM.POSSIBLE_DUPLICATE,
          message: `This may be the same product as ${near.name.replace(/\.$/, '')}. Foundry creates it separately unless you say otherwise.`,
          itemId: near.id,
        });
      }
    }

    if (plan.operationScope === 'selling_price_update' && !exactSku) {
      problems.push({
        code: PROBLEM.PRICE_TARGET_NOT_FOUND,
        message: `Pricing update stopped: ${code || name || 'this row'} does not match exactly one active SKU code. No product will be created.`,
      });
    }

    const blocking = problems.filter((problem) => BLOCKING.has(problem.code));
    const reviewable = problems.filter((problem) => REVIEWABLE.has(problem.code));
    out.push({
      rowNumber: row.sourceRow,
      position,
      raw: row.cells,
      parsed,
      problems,
      status: blocking.length ? 'INVALID' : reviewable.length ? 'NEEDS_REVIEW' : 'VALID',
    });
  });

  const summary = {
    total: out.length,
    valid: out.filter((row) => row.status === 'VALID').length,
    needsReview: out.filter((row) => row.status === 'NEEDS_REVIEW').length,
    invalid: out.filter((row) => row.status === 'INVALID').length,
    withStock: out.filter((row) => row.status !== 'INVALID' && row.parsed.quantity > 0).length,
    units: out
      .filter((row) => row.status !== 'INVALID')
      .reduce((total, row) => total + (row.parsed.quantity || 0), 0),
  };

  return {
    rows: out,
    summary,
    locationsNeeded: [...locationsNeeded.entries()].map(([text, count]) => ({ text, count })),
    dateOrders: dateColumns,
    axes: [...axisValues.entries()].map(([axis, values]) => ({ axis, values: [...values] })),
  };
}

/** Same words rearranged, or one small typo apart. */
function looksClose(a, b) {
  const catalog = require('./catalog-service');
  return catalog.looksLikeSameProduct(a, b);
}

module.exports = {
  PROBLEM,
  BLOCKING,
  REVIEWABLE,
  MAX_FUZZY_ROWS,
  readQuantity,
  readDate,
  detectDateOrder,
  loadContext,
  validateRows,
};

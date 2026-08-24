'use strict';

const { escapeLike } = require('../lib/util');

/**
 * One search box over the whole operation.
 *
 * It used to search inventory only — items, variants, serial numbers and lots —
 * which is not what a box at the top of every page reads as. Typing "PO-1001"
 * or "ABC Apparel", both of them exact names of records the customer had just
 * created, returned nothing at all. A person cannot tell from looking at it
 * that this particular box only knows about stock.
 *
 * So it covers the records Missions 1–8 actually create and can navigate to:
 * products, variants, serial units, batches, locations, suppliers and purchase
 * orders. Every result says what kind of record it is and opens that record.
 *
 * Ranking is one scale across all of them rather than a fixed order of
 * sections, because the best answer to "PO-1001" is a purchase order and the
 * best answer to "Black Small" is a variant, and no arrangement of groups gets
 * both right. An identifier typed in full wins outright; after that, matching
 * every word inside the field that distinguishes the record beats matching the
 * same words scattered across its parents. That last rule is what stops
 * "Black Small" returning White/Small as an equal — every variant of a product
 * called "Black T-shirt" contains the word "black" somewhere.
 */

/**
 * Words that name nothing, so requiring them would find nothing. Kept in step
 * with the resolver's own list.
 */
const NAMES_NOTHING = new Set([
  'the', 'our', 'my', 'its', 'their', 'this', 'that', 'these', 'those', 'some', 'any', 'all',
]);

const TYPE_LABEL = {
  item: 'Product',
  sku: 'Product',
  variant: 'Variant',
  serial: 'Unit',
  lot: 'Batch',
  location: 'Location',
  supplier: 'Supplier',
  purchase_order: 'Purchase order',
};

/** How strongly a result answers the query. Higher comes first. */
const SCORE = {
  identifier: 100,   // the exact code, number, serial or name that was typed
  title: 90,         // the record's full name, exactly
  distinguishing: 80, // every word, inside the field that tells it from its siblings
  prefix: 65,        // an identifier the query starts
  allWords: 45,      // every word, somewhere in the record
  partial: 25,       // some of it appears
};

/**
 * The words worth matching, for a box people type sentences into.
 *
 * The query used to be matched as one literal string, so it only found text
 * stored in exactly that order. Somebody reading "Black / Small" off the screen
 * and typing "black small" got nothing, because of the slash between them.
 */
function wordsOf(term) {
  return String(term)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2 && !NAMES_NOTHING.has(word))
    .slice(0, 6);
}

const norm = (value) => String(value || '').trim().toLowerCase();
const squash = (value) => norm(value).replace(/[^a-z0-9]+/g, '');

/** Every word present somewhere in `text`. */
function hasAllWords(text, words) {
  if (!words.length) return false;
  const haystack = norm(text);
  return words.every((word) => haystack.includes(word));
}

/**
 * Scores one record against the query.
 *
 * `identifiers` are things somebody types in full and expects to land on —
 * a SKU code, a PO number, a serial. `distinguishing` is what separates this
 * record from its siblings: a variant's own label, not the product name it
 * shares with every other variant.
 */
function scoreOf(term, words, { identifiers = [], title = '', distinguishing = '', haystack = '' }) {
  const wanted = norm(term);
  const tight = squash(term);

  for (const identifier of identifiers) {
    if (!identifier) continue;
    if (norm(identifier) === wanted || squash(identifier) === tight) return SCORE.identifier;
  }
  if (title && norm(title) === wanted) return SCORE.title;

  if (distinguishing && hasAllWords(distinguishing, words)) return SCORE.distinguishing;

  for (const identifier of identifiers) {
    if (identifier && squash(identifier).startsWith(tight) && tight.length >= 2) return SCORE.prefix;
  }
  if (title && norm(title).startsWith(wanted)) return SCORE.prefix;

  const all = `${title} ${distinguishing} ${haystack}`;
  if (hasAllWords(all, words)) return SCORE.allWords;
  if (wanted && norm(all).includes(wanted)) return SCORE.partial;
  return 0;
}

/** Rows whose text mentions the query at all; scoring decides what survives. */
function likeClause(columns, term, words) {
  const params = [`%${escapeLike(term)}%`];
  const parts = [`${columns} LIKE ? ESCAPE '\\' COLLATE NOCASE`];
  for (const word of words) {
    parts.push(`${columns} LIKE ? ESCAPE '\\' COLLATE NOCASE`);
    params.push(`%${escapeLike(word)}%`);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

function search(db, workspaceId, rawTerm, { limit = 8 } = {}) {
  const term = String(rawTerm || '').trim();
  if (term.length < 1) return { term, results: [], total: 0 };
  const words = wordsOf(term);
  const found = [];

  const consider = (row, scoring) => {
    const score = scoreOf(term, words, scoring);
    if (score > 0) found.push({ ...row, score, typeLabel: TYPE_LABEL[row.type] || row.type });
  };

  // --- products -------------------------------------------------------------
  const itemText = "(i.name || ' ' || COALESCE(i.base_code, ''))";
  const itemLike = likeClause(itemText, term, words);
  for (const row of db
    .prepare(
      `SELECT i.id, i.name, i.base_code, i.tracking_mode,
              COALESCE((SELECT SUM(b.on_hand) FROM balances b JOIN skus s ON s.id = b.sku_id
                         WHERE s.item_id = i.id), 0) AS on_hand
         FROM items i
        WHERE i.workspace_id = ? AND ${itemLike.sql}
        LIMIT 50`
    )
    .all(workspaceId, ...itemLike.params)) {
    consider(
      {
        type: 'item',
        id: row.id,
        title: row.name,
        subtitle: row.base_code ? `Product · ${row.base_code}` : 'Product',
        meta: `${row.on_hand} on hand`,
        href: `/inventory/${row.id}`,
        trackingMode: row.tracking_mode,
      },
      { identifiers: [row.base_code], title: row.name, distinguishing: row.name }
    );
  }

  // --- variants and single-SKU products -------------------------------------
  const variantText = "(i.name || ' ' || COALESCE(s.variant_label, '') || ' ' || COALESCE(s.code, ''))";
  const variantLike = likeClause(variantText, term, words);
  for (const row of db
    .prepare(
      `SELECT s.id, s.code, s.variant_label, s.item_id, i.name AS item_name, i.tracking_mode,
              COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.sku_id = s.id), 0) AS on_hand
         FROM skus s
         JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND ${variantLike.sql}
        LIMIT 100`
    )
    .all(workspaceId, ...variantLike.params)) {
    const label = row.variant_label || '';
    consider(
      {
        type: row.variant_label ? 'variant' : 'sku',
        id: row.id,
        title: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
        subtitle: `${row.variant_label ? 'Variant' : 'Product'} · ${row.code}`,
        meta: `${row.on_hand} on hand`,
        href: `/inventory/${row.item_id}#sku-${row.id}`,
        trackingMode: row.tracking_mode,
      },
      {
        identifiers: [row.code],
        title: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
        // A variant is told apart by its own label. Matching "black" against
        // the product name every sibling shares is not telling them apart.
        distinguishing: label || row.item_name,
        haystack: `${row.item_name} ${row.code || ''}`,
      }
    );
  }

  // --- locations ------------------------------------------------------------
  const locationLike = likeClause('l.name', term, words);
  for (const row of db
    .prepare(
      `SELECT l.id, l.name, l.kind, l.is_active,
              COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.location_id = l.id), 0) AS on_hand
         FROM locations l
        WHERE l.workspace_id = ? AND ${locationLike.sql}
        LIMIT 50`
    )
    .all(workspaceId, ...locationLike.params)) {
    consider(
      {
        type: 'location',
        id: row.id,
        title: row.name,
        subtitle: row.is_active ? 'Location' : 'Location · archived',
        meta: `${row.on_hand} on hand`,
        href: `/inventory/locations#location-${row.id}`,
      },
      { identifiers: [row.name], title: row.name, distinguishing: row.name }
    );
  }

  // --- suppliers ------------------------------------------------------------
  const supplierLike = likeClause("(sp.name || ' ' || COALESCE(sp.code, ''))", term, words);
  for (const row of db
    .prepare(
      `SELECT sp.id, sp.name, sp.code, sp.status,
              (SELECT COUNT(*) FROM supplier_items si WHERE si.supplier_id = sp.id) AS product_count
         FROM suppliers sp
        WHERE sp.workspace_id = ? AND ${supplierLike.sql}
        LIMIT 50`
    )
    .all(workspaceId, ...supplierLike.params)) {
    consider(
      {
        type: 'supplier',
        id: row.id,
        title: row.name,
        subtitle: row.status === 'active' ? 'Supplier' : 'Supplier · inactive',
        meta: `${row.product_count} product${row.product_count === 1 ? '' : 's'}`,
        href: `/suppliers/${row.id}`,
      },
      { identifiers: [row.name, row.code], title: row.name, distinguishing: row.name }
    );
  }

  // --- purchase orders ------------------------------------------------------
  const orderLike = likeClause("(po.po_number || ' ' || COALESCE(sp.name, ''))", term, words);
  for (const row of db
    .prepare(
      `SELECT po.id, po.po_number, po.status, po.expected_date, sp.name AS supplier_name,
              COALESCE((SELECT SUM(pol.quantity_units) FROM purchase_order_lines pol
                         WHERE pol.purchase_order_id = po.id), 0) AS units
         FROM purchase_orders po
         LEFT JOIN suppliers sp ON sp.id = po.supplier_id
        WHERE po.workspace_id = ? AND ${orderLike.sql}
        LIMIT 50`
    )
    .all(workspaceId, ...orderLike.params)) {
    consider(
      {
        type: 'purchase_order',
        id: row.id,
        title: row.po_number,
        subtitle: `Purchase order · ${row.supplier_name || 'no supplier'}`,
        meta: `${String(row.status || '').toLowerCase().replace(/_/g, ' ')} · ${row.units} unit(s)`
          + (row.expected_date ? ` · expected ${row.expected_date}` : ''),
        href: `/purchasing/orders/${row.id}`,
      },
      {
        identifiers: [row.po_number],
        title: row.po_number,
        distinguishing: row.po_number,
        haystack: row.supplier_name || '',
      }
    );
  }

  // --- serial units ---------------------------------------------------------
  const serialLike = likeClause('su.serial', term, words);
  for (const row of db
    .prepare(
      `SELECT su.id, su.serial, su.status, s.item_id, s.variant_label,
              i.name AS item_name, l.name AS location_name
         FROM serial_units su
         JOIN skus s ON s.id = su.sku_id
         JOIN items i ON i.id = s.item_id
         LEFT JOIN locations l ON l.id = su.location_id
        WHERE su.workspace_id = ? AND ${serialLike.sql}
        LIMIT 50`
    )
    .all(workspaceId, ...serialLike.params)) {
    consider(
      {
        type: 'serial',
        id: row.id,
        title: row.serial,
        subtitle: `Unit · ${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''}`,
        meta: row.status === 'in_stock' ? `In stock · ${row.location_name}` : 'Issued',
        href: `/inventory/${row.item_id}#unit-${row.id}`,
      },
      { identifiers: [row.serial], title: row.serial, distinguishing: row.serial }
    );
  }

  // --- batches --------------------------------------------------------------
  const lotLike = likeClause('lo.code', term, words);
  for (const row of db
    .prepare(
      `SELECT lo.id, lo.code, lo.expires_at, s.item_id, s.variant_label, i.name AS item_name,
              COALESCE((SELECT SUM(lb.quantity) FROM lot_balances lb WHERE lb.lot_id = lo.id), 0) AS quantity
         FROM lots lo
         JOIN skus s ON s.id = lo.sku_id
         JOIN items i ON i.id = s.item_id
        WHERE lo.workspace_id = ? AND ${lotLike.sql}
        LIMIT 50`
    )
    .all(workspaceId, ...lotLike.params)) {
    consider(
      {
        type: 'lot',
        id: row.id,
        title: `Lot ${row.code}`,
        subtitle: `${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''}`,
        meta: `${row.quantity} on hand${row.expires_at ? ` · expires ${row.expires_at.slice(0, 10)}` : ''}`,
        href: `/inventory/${row.item_id}#lot-${row.id}`,
      },
      { identifiers: [row.code], title: row.code, distinguishing: row.code }
    );
  }

  // Once something of a given kind has matched properly — the identifier typed
  // in full, or every word inside the field that tells it from its siblings —
  // the weaker records of that same kind are noise, not alternatives.
  //
  // Ranking them lower was not enough. Searching "Black Small" still listed
  // White / Small underneath the right answer, and a person who has named both
  // dimensions has said which one they mean; offering the other reads as
  // Foundry not being sure. The sibling only matched at all because the product
  // they share is called "Black T-shirt".
  //
  // Deliberately per kind. A supplier's orders are worth seeing under the
  // supplier's name, so an exact supplier match does not hide purchase orders —
  // those are a different kind of record answering a different question.
  const strongestByType = new Map();
  for (const row of found) {
    const best = strongestByType.get(row.type) || 0;
    if (row.score > best) strongestByType.set(row.type, row.score);
  }
  const kept = found.filter((row) => {
    const best = strongestByType.get(row.type) || 0;
    return best < SCORE.distinguishing || row.score >= SCORE.distinguishing;
  });

  const results = kept
    .sort((a, b) => (b.score - a.score) || String(a.title).localeCompare(String(b.title)))
    .slice(0, limit);

  return { term, results, total: results.length, scores: SCORE };
}

module.exports = { search, wordsOf, TYPE_LABEL, SCORE };

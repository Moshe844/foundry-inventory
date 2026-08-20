'use strict';

/**
 * Turning what a person named into exactly which records they meant.
 *
 * Everything here is deterministic SQL against one workspace. The model may
 * suggest the words ("navy size 8", "New Jersey", "lot L240812") but it never
 * supplies an id and never decides which record matched — that would let a
 * confident sentence move the wrong stock.
 *
 * Ambiguity fails closed: two candidates is a question for the person, not a
 * coin toss. Nothing outside the workspace can ever be reached, because every
 * query is scoped by workspace_id and there is no unscoped path.
 */

const { searchTerms } = require('../attention/query-service');
const repo = require('../domain/repository');

const like = (text) => `%${String(text).replace(/[%_]/g, (c) => `\\${c}`)}%`;

/**
 * Edit distance that counts a swapped pair of letters as one mistake.
 *
 * "Mornoe" for "Monroe" is a single transposition — the commonest typo there
 * is — and plain Levenshtein scores it 2, the same as two unrelated errors.
 * Counting it as 1 lets the threshold below stay tight enough to be safe.
 */
function distance(a, b) {
  const s1 = String(a).toLowerCase();
  const s2 = String(b).toLowerCase();
  if (s1 === s2) return 0;
  const rows = s1.length + 1;
  const cols = s2.length + 1;
  const d = Array.from({ length: rows }, (_, i) => [i, ...new Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j += 1) d[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s1[i - 1] === s2[j - 2] && s1[i - 2] === s2[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[rows - 1][cols - 1];
}

/** How wrong a word may be and still count as the same word. */
function tolerance(text) {
  const length = String(text).trim().length;
  if (length <= 3) return 0;   // too short to tell a typo from a different word
  if (length <= 5) return 1;
  return 2;
}

/**
 * The one close-enough name, when there is exactly one.
 *
 * Deliberately strict: a second candidate within tolerance means Foundry has no
 * business choosing, because picking wrong here moves real stock to the wrong
 * place. Every match it does make is reported, never applied silently.
 */
function closestMatch(query, candidates, nameOf) {
  const limit = tolerance(query);
  if (limit === 0) return { ok: false, reason: 'not_found' };

  const scored = candidates
    .map((candidate) => ({ candidate, distance: distance(query, nameOf(candidate)) }))
    .filter((row) => row.distance <= limit)
    .sort((a, b) => a.distance - b.distance);

  if (scored.length === 0) return { ok: false, reason: 'not_found' };
  // A clear winner, or a tie nobody should break by guessing.
  if (scored.length > 1 && scored[0].distance === scored[1].distance) {
    return { ok: false, reason: 'ambiguous', candidates: scored.map((r) => r.candidate) };
  }
  return { ok: true, value: scored[0].candidate, distance: scored[0].distance };
}

/** "Size 8 Colour Navy" for one SKU, so an axis name matches as well as a value. */
function optionText(db, skuId) {
  return db
    .prepare(
      `SELECT o.name, v.value FROM sku_option_values v
         JOIN item_options o ON o.id = v.option_id
        WHERE v.sku_id = ?
        ORDER BY o.position`
    )
    .all(skuId)
    .map((row) => `${row.name} ${row.value}`)
    .join(' ');
}

/** A resolution either found exactly one thing, nothing, or too many. */
function found(value) {
  return { ok: true, value, candidates: [value] };
}
function none(message) {
  return { ok: false, reason: 'not_found', message, candidates: [] };
}
function ambiguous(message, candidates) {
  return { ok: false, reason: 'ambiguous', message, candidates };
}

/** Locations, by name. */
function resolveLocation(db, workspaceId, text, { role = 'location' } = {}) {
  const query = String(text || '').trim();
  if (!query) {
    // Nothing named. An inventory with one location has already answered
    // "which location?", and asking anyway is how a perfectly clear
    // instruction — "receive 20" in a business with a single warehouse —
    // becomes a question with one possible answer. Transfers never reach this
    // shortcut: they are refused earlier for having nowhere to move to.
    const places = repo.listLocations(db, workspaceId);
    if (places.length === 1) return found(places[0]);
    return none(`Which ${role}?`);
  }

  const exact = db
    .prepare(
      `SELECT * FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1`
    )
    .get(workspaceId, query);
  if (exact) return found(exact);

  const terms = searchTerms(query);
  const clauses = terms.length ? terms.map(() => 'name LIKE ? ESCAPE \'\\\'').join(' AND ') : 'name LIKE ? ESCAPE \'\\\'';
  const params = terms.length ? terms.map(like) : [like(query)];
  const matches = db
    .prepare(
      `SELECT * FROM locations WHERE workspace_id = ? AND is_active = 1 AND ${clauses} ORDER BY name`
    )
    .all(workspaceId, ...params);

  if (matches.length === 1) return found(matches[0]);
  if (matches.length > 1) {
    return ambiguous(
      `“${query}” could mean ${matches.map((m) => m.name).join(' or ')}. Which did you mean?`,
      matches
    );
  }

  // Nothing matched as written. A near miss is almost always a typo, so it is
  // offered — named, so the preview shows what Foundry read it as.
  const all = db
    .prepare('SELECT * FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name')
    .all(workspaceId);
  const close = closestMatch(query, all, (l) => l.name);
  if (close.ok) {
    return { ...found(close.value), note: `You wrote “${query}” — Foundry took that as ${close.value.name}.` };
  }
  if (close.reason === 'ambiguous') {
    return ambiguous(
      `“${query}” is close to ${close.candidates.map((c) => c.name).join(' and ')}. Which did you mean?`,
      close.candidates
    );
  }
  return none(
    `There is no ${role} called “${query}” in this inventory.` +
      (all.length ? ` You have ${all.map((l) => l.name).join(', ')}.` : '')
  );
}

/**
 * Sizes as people say them, against how catalogues store them.
 *
 * Small enough to read at a glance and stop there. This is not a general
 * synonym engine: it exists because "small" and "S" are the same size in every
 * clothing business, and refusing an instruction over that is indefensible.
 */
const SIZE_WORDS = {
  small: 's',
  medium: 'm',
  large: 'l',
  xsmall: 'xs',
  xlarge: 'xl',
  xxlarge: 'xxl',
};

/**
 * SKUs, by product wording plus optional variant wording.
 *
 * A quantity item has one SKU, so naming the product is enough. A variant item
 * has several, and naming only the product is genuinely ambiguous — which is a
 * question, not something to resolve to the first row.
 */
function resolveSku(db, workspaceId, itemText, variantText) {
  // "Move 15 Navy 4 to the store" names no product at all — "Navy 4" is the
  // whole identifier. Searching on the variant wording when that is all there
  // is beats refusing to look, and the narrowing below still applies.
  const query = String(itemText || '').trim() || String(variantText || '').trim();
  if (!query) {
    // Nothing named at all. An inventory with a single product has already
    // answered "which product?", exactly as a single location answers "which
    // location?". A variant range is deliberately excluded: naming one of six
    // t-shirts is a real choice, and picking the first row would be a guess
    // dressed up as an answer.
    const only = db
      .prepare(
        `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
           FROM skus s JOIN items i ON i.id = s.item_id
          WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1 LIMIT 2`
      )
      .all(workspaceId);
    if (only.length === 1) return found(only[0]);
    return none('Which product?');
  }

  const columns = `(i.name LIKE ? ESCAPE '\\' OR i.base_code LIKE ? ESCAPE '\\'
                    OR s.code LIKE ? ESCAPE '\\' OR s.variant_label LIKE ? ESCAPE '\\')`;
  const terms = searchTerms(query);
  const clause = terms.length ? terms.map(() => columns).join(' AND ') : columns;
  const params = terms.length
    ? terms.flatMap((t) => [like(t), like(t), like(t), like(t)])
    : [like(query), like(query), like(query), like(query)];

  let rows = db
    .prepare(
      `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1 AND ${clause}
        ORDER BY i.name, s.position`
    )
    .all(workspaceId, ...params);

  if (rows.length === 0) {
    const items = db
      .prepare(
        `SELECT DISTINCT i.id, i.name FROM items i
          WHERE i.workspace_id = ? AND i.is_active = 1 ORDER BY i.name`
      )
      .all(workspaceId);
    const close = closestMatch(query, items, (i) => i.name);
    if (close.ok) {
      const corrected = resolveSku(db, workspaceId, close.value.name, variantText);
      if (corrected.ok) {
        return { ...corrected, note: `You wrote “${query}” — Foundry took that as ${close.value.name}.` };
      }
      return corrected;
    }
    if (close.reason === 'ambiguous') {
      return ambiguous(
        `“${query}” is close to ${close.candidates.map((c) => c.name).join(' and ')}. Which did you mean?`,
        close.candidates
      );
    }
    return none(`There is nothing called “${query}” in this inventory.`);
  }

  // Narrow by the variant wording. Tokens are matched whole and include single
  // characters: sizes are exactly the case where "4" and "5" are the entire
  // difference between two products. The haystack includes the option *axis*
  // names too, so "size 8" works as naturally as "8".
  const narrowBy = (candidates, wording) => {
    const terms = String(wording || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return candidates;

    // Every option value across the whole range, gathered once. Deciding this
    // per row lets a row that simply lacks the value discard the term and match
    // on whatever is left — so asking for "S white" would return the medium and
    // large whites as well, each having quietly ignored the size.
    const vocabulary = new Set(
      candidates.flatMap((row) =>
        `${row.variant_label || ''} ${optionText(db, row.id)}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
      )
    );

    return candidates.filter((row) => {
      const label = `${row.variant_label || ''} ${row.code || ''} ${optionText(db, row.id)}`.toLowerCase();
      const labelTokens = label.split(/[^a-z0-9]+/).filter(Boolean);
      const nameTokens = String(row.item_name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

      // A word that is part of the product's own name is not a variant value.
      // "Navy Oxford size 8" can be split as item "Oxford" + variant "Navy 8"
      // — the split is a matter of taste and the product really is called Navy
      // Oxford, so requiring "navy" to appear in the size label would refuse a
      // perfectly clear instruction.
      // ...unless it is genuinely one of this variant's option values. The
      // product "Children's t-shirt" contains the token "s", which would
      // otherwise discard the size S and match every white shirt in the range.
      // What the catalogue calls an option beats what the name happens to spell.
      const meaningful = terms.filter((term) => vocabulary.has(term) || !nameTokens.includes(term));
      if (!meaningful.length) return true;

      // A short token must match a whole token; a longer one may match inside.
      //
      // A written-out size also matches its abbreviation. People say "white
      // small"; catalogues store "S / White". Deliberately only the other way
      // round — a spelt-out word standing in for a single letter — because the
      // reverse would let "S" claim "Silver".
      return meaningful.every((term) => {
        if (term.length <= 2) return labelTokens.includes(term);
        if (label.includes(term)) return true;
        const abbreviation = SIZE_WORDS[term];
        return Boolean(abbreviation) && labelTokens.includes(abbreviation);
      });
    });
  };

  const variant = String(variantText || '').trim();
  if (variant) {
    const narrowed = narrowBy(rows, variant);
    if (narrowed.length === 1) return found(narrowed[0]);
    if (narrowed.length === 0) {
      return none(
        `“${query}” exists, but not in ${variant}. Options: ${rows
          .map((r) => r.variant_label)
          .filter(Boolean)
          .join(', ')}.`
      );
    }
    rows = narrowed;

    // Every axis value the person supplied narrows the choice, wherever in the
    // sentence it landed.
    //
    // Which words become the "product" and which become the "version" is a
    // reading of one sentence, and the reading varies: "move 5 Black Small"
    // can arrive as item "Black T-shirt" with version "Small". Narrowing on
    // the version alone then left Black / Small and White / Small and asked
    // which — about a colour the person had already named. Only tokens that
    // are genuinely option values of the remaining candidates survive
    // narrowBy's vocabulary check, so the product's own words cannot filter
    // anything out, and a narrowing that matches nothing is discarded rather
    // than turned into a refusal.
    if (rows.length > 1) {
      const alsoNamed = narrowBy(rows, itemText);
      if (alsoNamed.length && alsoNamed.length < rows.length) rows = alsoNamed;
    }
  } else if (rows.length > 1) {
    // No separate variant wording, but the name they used may itself name one —
    // "move 15 Navy 4" has no product in it at all. Narrowing on the same words
    // is only kept when it resolves things; otherwise the ambiguity is real.
    const narrowed = narrowBy(rows, query);
    if (narrowed.length === 1) return found(narrowed[0]);
  }

  if (rows.length === 1) return found(rows[0]);

  const labels = rows.map((r) => r.variant_label || r.code).filter(Boolean);
  return ambiguous(
    `“${query}” comes in ${labels.length} versions: ${labels.join(', ')}. Which one?`,
    rows
  );
}

/** A lot, by code, optionally constrained to a SKU. */
function resolveLot(db, workspaceId, code, skuId) {
  const query = String(code || '').trim();
  if (!query) return none('Which lot?');

  const rows = db
    .prepare(
      `SELECT lo.*, s.id AS sku_id, i.name AS item_name
         FROM lots lo JOIN skus s ON s.id = lo.sku_id JOIN items i ON i.id = s.item_id
        WHERE lo.workspace_id = ? AND lo.code = ? COLLATE NOCASE
          ${skuId ? 'AND lo.sku_id = ?' : ''}`
    )
    .all(...(skuId ? [workspaceId, query, skuId] : [workspaceId, query]));

  if (rows.length === 1) return found(rows[0]);
  if (rows.length === 0) return none(`There is no lot “${query}” in this inventory.`);
  return ambiguous(
    `Lot “${query}” exists on ${rows.length} products. Which product did you mean?`,
    rows
  );
}

/** A serialized unit, by serial number. */
function resolveSerialUnit(db, workspaceId, serial) {
  const query = String(serial || '').trim();
  if (!query) return none('Which unit?');

  const rows = db
    .prepare(
      `SELECT su.*, s.item_id, i.name AS item_name, l.name AS location_name
         FROM serial_units su
         JOIN skus s ON s.id = su.sku_id
         JOIN items i ON i.id = s.item_id
         LEFT JOIN locations l ON l.id = su.location_id
        WHERE su.workspace_id = ? AND su.serial = ? COLLATE NOCASE AND su.status = 'in_stock'`
    )
    .all(workspaceId, query);

  if (rows.length === 1) return found(rows[0]);
  if (rows.length === 0) {
    const issued = db
      .prepare(
        `SELECT 1 FROM serial_units WHERE workspace_id = ? AND serial = ? COLLATE NOCASE`
      )
      .get(workspaceId, query);
    return none(
      issued
        ? `${query} is not in stock — it has already been issued.`
        : `There is no unit ${query} in this inventory.`
    );
  }
  return ambiguous(`More than one unit is recorded as ${query}.`, rows);
}

/** Several serials at once; every one must resolve. */
function resolveSerialUnits(db, workspaceId, serials) {
  const list = Array.isArray(serials) ? serials.filter(Boolean) : [];
  if (list.length === 0) return none('Which units?');
  const units = [];
  for (const serial of list) {
    const result = resolveSerialUnit(db, workspaceId, serial);
    if (!result.ok) return result;
    units.push(result.value);
  }
  const skus = new Set(units.map((u) => u.sku_id));
  if (skus.size > 1) {
    return none('Those units are different products. Move them one product at a time.');
  }
  return found(units);
}

// --- current truth, read fresh -----------------------------------------------

function balanceAt(db, workspaceId, skuId, locationId) {
  if (!skuId || !locationId) return 0;
  const row = db
    .prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
    .get(workspaceId, skuId, locationId);
  return row ? row.on_hand : 0;
}

function lotBalanceAt(db, workspaceId, lotId, locationId) {
  if (!lotId || !locationId) return 0;
  const row = db
    .prepare(
      `SELECT lb.quantity FROM lot_balances lb
        WHERE lb.workspace_id = ? AND lb.lot_id = ? AND lb.location_id = ?`
    )
    .get(workspaceId, lotId, locationId);
  return row ? row.quantity : 0;
}

function skuTotal(db, workspaceId, skuId) {
  if (!skuId) return 0;
  return db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?')
    .get(workspaceId, skuId).n;
}

function lotTotal(db, workspaceId, lotId) {
  if (!lotId) return 0;
  return db
    .prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM lot_balances WHERE workspace_id = ? AND lot_id = ?')
    .get(workspaceId, lotId).n;
}

module.exports = {
  distance,
  tolerance,
  closestMatch,
  optionText,
  resolveLocation,
  resolveSku,
  resolveLot,
  resolveSerialUnit,
  resolveSerialUnits,
  balanceAt,
  lotBalanceAt,
  skuTotal,
  lotTotal,
};

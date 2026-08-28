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
function ambiguous(message, candidates, clarification = null) {
  return { ok: false, reason: 'ambiguous', message, candidates, clarification };
}

const words = (text) => String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const comparableWord = (word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);

/** Structured choices that can be carried through the UI and appended to the original request. */
function choiceClarification(dimension, candidates, labelOf, valueOf = labelOf) {
  return {
    dimension,
    choices: candidates.slice(0, 20).map((candidate) => ({
      label: labelOf(candidate),
      value: valueOf(candidate),
    })),
  };
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
    if (places.length > 1) {
      return ambiguous(
        `Which ${role}?`,
        places,
        choiceClarification(role.replace(/\s+/g, '_'), places, (place) => place.name)
      );
    }
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
      matches,
      choiceClarification(role.replace(/\s+/g, '_'), matches, (place) => place.name)
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
      close.candidates,
      choiceClarification(role.replace(/\s+/g, '_'), close.candidates, (place) => place.name)
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

function skuOptionRows(db, skuIds) {
  if (!skuIds.length) return [];
  return db
    .prepare(
      `SELECT v.sku_id, o.name, o.position, v.value
         FROM sku_option_values v JOIN item_options o ON o.id = v.option_id
        WHERE v.sku_id IN (${skuIds.map(() => '?').join(', ')})
        ORDER BY o.position`
    )
    .all(...skuIds);
}

function instructionMentionsValue(instruction, value) {
  const said = new Set(words(instruction));
  const valueWords = words(value);
  if (valueWords.length && valueWords.every((word) => said.has(word))) return true;
  if (valueWords.length === 1 && valueWords[0].length <= 3) {
    return Object.entries(SIZE_WORDS).some(([written, short]) => short === valueWords[0] && said.has(written));
  }
  return false;
}

/**
 * Keep only option values that the person actually wrote in this action's
 * verified source slice. A parser-provided product name is never provenance:
 * only the person's own clause may settle an axis.
 */
function narrowSkuRowsByInstruction(db, candidates, instruction) {
  let narrowed = candidates;
  const options = skuOptionRows(db, candidates.map((row) => row.id));
  const axes = [...new Set(options.map((row) => row.name))];
  for (const axis of axes) {
    const values = [...new Set(options.filter((row) => row.name === axis).map((row) => row.value))];
    const named = values.filter((value) => instructionMentionsValue(instruction, value));
    if (named.length !== 1) continue;
    const allowed = new Set(options
      .filter((row) => row.name === axis && row.value === named[0])
      .map((row) => row.sku_id));
    narrowed = narrowed.filter((row) => allowed.has(row.id));
  }
  return narrowed;
}

/**
 * Narrow attributes that an imported catalogue encoded in the item name.
 *
 * Foundry supports both common catalogue shapes:
 *
 *   one item + Colour/Size option rows
 *   Classic Cotton T-Shirt - White + one Size option per imported row
 *
 * The first shape is handled by narrowSkuRowsByInstruction. In the second,
 * White is not an option value at all, so looking only at option rows puts the
 * Black products back into a request that explicitly said White. Treat item
 * names with the same normalized wording as one family, find the words that
 * distinguish those families, and keep a family only when one of those words
 * was actually present in both the parsed identity and the person's clause.
 * If the reader did not supply identity fields (a generic model question), the
 * original clause remains the fallback evidence. A tie is never broken.
 */
function narrowSkuRowsByItemFamily(candidates, instruction, suppliedIdentity = '') {
  const grouped = new Map();
  for (const row of candidates) {
    const family = String(row.item_name || '').trim().toLowerCase();
    if (!grouped.has(family)) grouped.set(family, []);
    grouped.get(family).push(row);
  }
  const groups = [...grouped.values()];
  if (groups.length <= 1) return candidates;

  const groupTokens = groups.map((group) =>
    new Set(words(group[0].item_name).map(comparableWord))
  );
  const common = new Set([...groupTokens[0]].filter((token) =>
    groupTokens.every((tokens) => tokens.has(token))
  ));
  const distinctive = groupTokens.map((tokens) =>
    new Set([...tokens].filter((token) => !common.has(token)))
  );
  const said = new Set(words(instruction).map(comparableWord));
  const supplied = new Set(
    words(suppliedIdentity).map(comparableWord).filter((token) => said.has(token))
  );

  const choose = (evidence) => {
    const scored = groups.map((group, index) => ({
      group,
      score: [...distinctive[index]].filter((token) => evidence.has(token)).length,
    })).sort((a, b) => b.score - a.score);
    return scored[0].score > 0 && (!scored[1] || scored[0].score > scored[1].score)
      ? scored[0].group
      : null;
  };

  // Parsed identity that is also verbatim in the request is the strongest
  // evidence. The full clause is used only when the reader returned no useful
  // identity at all, preserving the grounded generic-question path.
  return choose(supplied) || choose(said) || candidates;
}

/**
 * Describes the exact remaining SKU ambiguity from catalogue axes.
 *
 * Shared values are already resolved (for example Size = Small); axes whose
 * values differ are what the person still needs to choose (Colour). The UI
 * receives the real SKU labels as answer values, never a generic product ask.
 */
function skuAmbiguity(db, rows) {
  const optionRows = skuOptionRows(db, rows.map((row) => row.id));
  const bySku = new Map(rows.map((row) => [row.id, new Map()]));
  for (const option of optionRows) bySku.get(option.sku_id)?.set(option.name, option.value);
  const axes = [...new Map(optionRows.map((row) => [row.name, row.position])).entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
  const shared = [];
  const unresolved = [];
  for (const axis of axes) {
    const values = [...new Set(rows.map((row) => bySku.get(row.id)?.get(axis)).filter(Boolean))];
    if (values.length === 1) shared.push(values[0]);
    else if (values.length > 1) unresolved.push({ axis, values });
  }

  const itemNames = [...new Set(rows.map((row) => row.item_name))];
  if (itemNames.length > 1) {
    return ambiguous(
      'Which product do you mean?',
      rows,
      choiceClarification('product', rows,
        (row) => `${row.item_name}${row.variant_label ? ` — ${row.variant_label}` : ''}`,
        (row) => `${row.item_name}${row.variant_label ? ` ${row.variant_label}` : ''}`)
    );
  }

  // A product name can itself contain an option value ("Black T-shirt"). If
  // Colour is unresolved, leaving Black in the noun makes the question claim
  // a choice the person has not made. Strip only values on unresolved axes.
  const unresolvedWords = new Set(unresolved.flatMap((entry) => entry.values.flatMap(words)));
  const baseName = String(itemNames[0] || 'product')
    .split(/\s+/)
    .filter((part) => !unresolvedWords.has(String(part).toLowerCase().replace(/[^a-z0-9]/g, '')))
    .join(' ') || String(itemNames[0] || 'product');
  const subject = [...shared, baseName].join(' ').trim();
  const dimension = unresolved.length === 1
    ? `variant:${unresolved[0].axis.toLowerCase()}`
    : 'variant';
  const question = unresolved.length === 1
    ? `Which ${unresolved[0].axis.toLowerCase()} of ${subject} do you mean?`
    : `Which ${subject} do you mean?`;
  return ambiguous(
    question,
    rows,
    choiceClarification(dimension, rows,
      (row) => row.variant_label || row.code,
      (row) => row.variant_label || row.code)
  );
}

/**
 * Uses the original sentence only to narrow real catalogue records. This is a
 * safety net for a reader that returned an empty item/variant field: it cannot
 * invent a record, and it still refuses whenever more than one remains.
 */
function clarifySkuFromInstruction(db, workspaceId, instruction) {
  const rows = db
    .prepare(
      `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        ORDER BY i.name, s.position`
    )
    .all(workspaceId);
  if (!rows.length) return null;

  // Imports do not all model variants the same way. One catalogue may hold
  // one product with six SKUs; another may contain separate item rows for each
  // colour and size. Resolve both representations through the same two-stage
  // identity narrowing before deciding what is genuinely still ambiguous.
  let candidates = narrowSkuRowsByItemFamily(rows, instruction);
  candidates = narrowSkuRowsByInstruction(db, candidates, instruction);
  if (candidates.length === 1) return found(candidates[0]);
  return skuAmbiguity(db, candidates);
}

/**
 * SKUs, by product wording plus optional variant wording.
 *
 * A quantity item has one SKU, so naming the product is enough. A variant item
 * has several, and naming only the product is genuinely ambiguous — which is a
 * question, not something to resolve to the first row.
 */
function resolveSku(db, workspaceId, itemText, variantText, options = {}) {
  // "Move 15 Navy 4 to the store" names no product at all — "Navy 4" is the
  // whole identifier. Searching on the variant wording when that is all there
  // is beats refusing to look, and the narrowing below still applies.
  const query = String(itemText || '').trim() || String(variantText || '').trim();
  if (!query) {
    const grounded = options.instruction
      ? clarifySkuFromInstruction(db, workspaceId, options.instruction)
      : null;
    if (grounded) return grounded;
    // Nothing named at all. An inventory with a single product has already
    // answered "which product?", exactly as a single location answers "which
    // location?". A variant range is deliberately excluded: naming one of six
    // t-shirts is a real choice, and picking the first row would be a guess
    // dressed up as an answer.
    const products = db
      .prepare(
        `SELECT i.id, i.name FROM items i
          WHERE i.workspace_id = ? AND i.is_active = 1 ORDER BY i.name LIMIT 21`
      )
      .all(workspaceId);
    if (products.length === 1) {
      const only = db
        .prepare(
          `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
             FROM skus s JOIN items i ON i.id = s.item_id
            WHERE s.workspace_id = ? AND s.item_id = ? AND s.is_active = 1 AND i.is_active = 1
            ORDER BY s.position`
        )
        .all(workspaceId, products[0].id);
      if (only.length === 1) return found(only[0]);
      if (only.length > 1) return skuAmbiguity(db, only);
    }
    if (products.length > 1) {
      return ambiguous(
        'Which product do you mean?',
        products,
        choiceClarification('product', products, (product) => product.name)
      );
    }
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
        close.candidates,
        choiceClarification('product', close.candidates, (item) => item.name)
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
  if ((options.groundIdentity || options.instruction) && rows.length > 1) {
    // The reader may fill the catalogue's canonical product name even when the
    // person used a generic noun. A product called "Black T-shirt" must not
    // make Black look user-supplied when the request only said "Small
    // T-shirts". Only option values present in the original request may narrow
    // a variant axis.
    let grounded = narrowSkuRowsByItemFamily(
      rows,
      options.instruction || '',
      `${itemText || ''} ${variantText || ''}`
    );
    grounded = narrowSkuRowsByInstruction(db, grounded, options.instruction || '');
    if (grounded.length === 1) return found(grounded[0]);
    if (grounded.length && grounded.length < rows.length) rows = grounded;
  } else if (variant) {
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
    // is also kept when it resolves one axis but leaves another genuinely open.
    // "Black T-shirt" should ask which size among the Black records, not put
    // White back into the candidate list merely because size is still missing.
    const narrowed = narrowBy(rows, query);
    if (narrowed.length === 1) return found(narrowed[0]);
    if (narrowed.length && narrowed.length < rows.length) rows = narrowed;
  }

  if (rows.length === 1) return found(rows[0]);

  return skuAmbiguity(db, rows);
}

/**
 * An exact catalogue identifier is stronger evidence than the field a language
 * model happened to put it in. This is intentionally separate from fuzzy name
 * matching: callers use it to recover a SKU code that was mistaken for a lot
 * or serial number without guessing from similar-looking identifiers.
 */
function resolveExactSkuCode(db, workspaceId, code) {
  const query = String(code || '').trim();
  if (!query) return null;
  return db
    .prepare(
      `SELECT s.*, i.name AS item_name, i.tracking_mode, i.unit_label, i.has_variants
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
          AND s.code = ? COLLATE NOCASE`
    )
    .get(workspaceId, query) || null;
}

function hasExactItemCode(db, workspaceId, code) {
  const query = String(code || '').trim();
  if (!query) return false;
  return Boolean(db
    .prepare(
      `SELECT 1 FROM items
        WHERE workspace_id = ? AND is_active = 1 AND base_code = ? COLLATE NOCASE`
    )
    .get(workspaceId, query));
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
    rows,
    choiceClarification('product', rows,
      (row) => `${row.item_name} — lot ${row.code}`,
      (row) => `${row.item_name} lot ${row.code}`)
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
  return ambiguous(
    `More than one unit is recorded as ${query}. Which unit do you mean?`,
    rows,
    choiceClarification('serial_unit', rows, (row) => `${row.serial} — ${row.item_name}`,
      (row) => row.serial)
  );
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

/**
 * The item behind a sku, including the rules it carries.
 *
 * Whether stock may go below zero is the item's answer, so anything enforcing
 * that rule has to read it from here rather than assume one way or the other.
 */
function skuById(db, workspaceId, skuId) {
  if (!skuId) return null;
  return db
    .prepare(
      `SELECT s.id, s.item_id, s.variant_label, i.name, i.tracking_mode, i.allow_negative
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.id = ?`
    )
    .get(workspaceId, skuId) || null;
}

/**
 * Where else this sku is, most-stocked first, excluding one location.
 *
 * A refusal that says only "there are not enough here" leaves the reader to go
 * looking. If the stock exists somewhere else, that is the next action, and it
 * is cheap to know at the moment of refusing.
 */
function stockElsewhere(db, workspaceId, skuId, exceptLocationId) {
  if (!skuId) return [];
  return db
    .prepare(
      `SELECT b.location_id AS id, l.name, b.on_hand AS onHand
         FROM balances b JOIN locations l ON l.id = b.location_id
        WHERE b.workspace_id = ? AND b.sku_id = ? AND b.on_hand > 0
          AND (@except IS NULL OR b.location_id != @except)
        ORDER BY b.on_hand DESC, l.name`
    )
    .all(workspaceId, skuId, { except: exceptLocationId || null });
}

module.exports = {
  distance,
  tolerance,
  closestMatch,
  optionText,
  resolveLocation,
  resolveSku,
  resolveExactSkuCode,
  hasExactItemCode,
  clarifySkuFromInstruction,
  resolveLot,
  resolveSerialUnit,
  resolveSerialUnits,
  balanceAt,
  lotBalanceAt,
  skuTotal,
  lotTotal,
  skuById,
  stockElsewhere,
};

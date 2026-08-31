'use strict';

const crypto = require('node:crypto');
const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const resolver = require('../actions/resolver');
const prices = require('./price-service');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['operation', 'itemText', 'variantText', 'amount', 'currency', 'reason'],
  properties: {
    operation: { type: 'string', enum: ['set', 'remove'] },
    itemText: { type: 'string' }, variantText: { type: 'string' },
    amount: { type: 'number' }, currency: { type: 'string' }, reason: { type: 'string' },
  },
};

const SYSTEM = `Read one requested customer selling-price change.

This is the price charged to customers, never supplier purchase cost. Preserve
the named product, variant, amount and currency. amount is the price per one
inventory unit. Use -1 only for remove. Do not calculate margin, tax or a price
from cost. Return the structured instruction only.`;

const BULK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['changes'],
  properties: {
    changes: {
      type: 'array', minItems: 2, maxItems: 300,
      items: {
        type: 'object', additionalProperties: false,
        required: ['itemText', 'variantText', 'amount', 'currency'],
        properties: {
          itemText: { type: 'string' }, variantText: { type: 'string' },
          amount: { type: 'number' }, currency: { type: 'string' },
        },
      },
    },
  },
};

const BULK_SYSTEM = `Read a requested list of customer selling-price changes.

Return one change for every product or variant explicitly given a price. This
is the price charged to customers, never supplier purchase cost. Preserve each
named product, variant, amount and currency. Every amount is the price per one
inventory unit. Do not invent a price or apply one line's amount to another
line. Return the structured list only.`;

function matchesInstruction(message) {
  const text = String(message || '');
  const changesValue = /\b(?:add|set|change|make|update|remove|clear|is|to)\b/i.test(text);
  const namesSellingPrice = /\b(?:price|priced|selling price|retail price|sale price|msrp)\b/i.test(text);
  const assignsMoney = /\b(?:add|set|change|make|update)\b[\s\S]{0,240}(?:[$£€¥]\s*[\d,]+(?:\.\d{1,2})?|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s*[\d,]+(?:\.\d{1,2})?)/i.test(text);
  const namesPurchaseCost = /\b(?:supplier|purchase|wholesale|landed)\s+(?:price|cost)\b|\b(?:unit\s+)?cost\b/i.test(text);

  // Ordinary instructions often assign a customer price without saying the
  // word "price" — for example, "set JEANS-BLACK-S to $12 each". A change
  // verb plus an explicit currency amount is sufficiently specific to enter
  // the selling-price preview. Supplier costs remain a separate concept and
  // must never be silently turned into customer pricing.
  return !namesPurchaseCost && changesValue && (namesSellingPrice || assignsMoney);
}

function matchesBulkInstruction(message) {
  if (!matchesInstruction(message)) return false;
  const amounts = String(message || '').match(/(?:[$£€¥]\s*[\d,]+(?:\.\d{1,2})?|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s*[\d,]+(?:\.\d{1,2})?)/gi) || [];
  return amounts.length > 1;
}

function catalogue(db, workspaceId) {
  return db.prepare(`SELECT i.name, s.code, s.variant_label
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name, s.position LIMIT 300`).all(workspaceId);
}

function symbolCurrency(symbol) {
  return ({ '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' }[symbol]) || 'USD';
}

function fallbackMany(db, ctx, message) {
  const text = String(message || '');
  const found = [];
  for (const sku of catalogue(db, ctx.workspaceId)) {
    const escaped = String(sku.code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nearby = text.match(new RegExp(`${escaped}[^\\r\\n;]{0,80}?(?:([$£€¥])\\s*([\\d,]+(?:\\.\\d{1,2})?)|\\b(USD|EUR|GBP|CAD|AUD|JPY)\\s*([\\d,]+(?:\\.\\d{1,2})?))`, 'i'));
    if (!nearby) continue;
    found.push({
      itemText: sku.code,
      variantText: sku.variant_label || '',
      amount: Number(String(nearby[2] || nearby[4]).replace(/,/g, '')),
      currency: nearby[3] ? nearby[3].toUpperCase() : symbolCurrency(nearby[1]),
    });
  }
  return found;
}

function identityFromMessage(message, catalogueRows = []) {
  const text = String(message || '');
  const lower = text.toLowerCase();

  // A catalogue code written in the request is stronger than the surrounding
  // prose. Also accept an incomplete code prefix such as ZIP-HOODIE-NAVY-:
  // that does not identify one SKU, but it does identify the exact product
  // family so the resolver can ask which remaining size instead of claiming
  // the whole sentence is a product name.
  const exact = catalogueRows.filter((row) => row.code
    && lower.includes(String(row.code).toLowerCase()));
  if (exact.length === 1) return exact[0].code;

  const codeFragments = text.match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]*)+/g) || [];
  const prefix = codeFragments
    .sort((a, b) => b.length - a.length)
    .find((fragment) => fragment.length >= 3 && catalogueRows.some((row) =>
      String(row.code || '').toLowerCase().startsWith(fragment.toLowerCase())));
  if (prefix) return prefix;

  const namedItems = [...new Set(catalogueRows
    .filter((row) => row.name && lower.includes(String(row.name).toLowerCase()))
    .map((row) => row.name))]
    .sort((a, b) => b.length - a.length);
  if (namedItems.length) return namedItems[0];

  // Last-resort grammar for a name that has not been encoded as a code. Stop
  // before the monetary assignment so "Please set price for Hat to $12" gives
  // the resolver "Hat", never the entire instruction.
  const described = text.match(/\b(?:price\s+for|for)\s+(.+?)\s+(?:to|at|is)\s*(?=[$£€¥]|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\b)/i);
  return described ? described[1].trim() : text;
}

function fallback(message, catalogueRows = []) {
  const text = String(message || '');
  const remove = /\b(?:remove|clear|no)\b[^.]{0,30}\bprice\b|\bprice\b[^.]{0,30}\b(?:remove|clear)\b/i.test(text);
  const symbol = text.match(/([$£€¥])\s*([\d,]+(?:\.\d{1,2})?)/);
  const coded = text.match(/\b(USD|EUR|GBP|CAD|AUD|JPY)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const plain = text.match(/\b(?:price(?:\s+is)?|at|to)\s*(?:is\s*)?([\d,]+(?:\.\d{1,2})?)/i);
  const amount = remove ? -1 : Number((symbol && symbol[2]) || (coded && coded[2]) || (plain && plain[1]) || -1);
  const currency = coded ? coded[1].toUpperCase() : symbol ? ({ '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' }[symbol[1]]) : 'USD';
  return { operation: remove ? 'remove' : 'set', itemText: identityFromMessage(text, catalogueRows), variantText: '', amount, currency,
    reason: 'The owner stated a customer selling price.' };
}

function clarificationError(resolved, data, statedAs) {
  const sameItem = resolved.candidates && resolved.candidates.length > 1
    && resolved.candidates.every((candidate) => candidate.item_id
      && candidate.item_id === resolved.candidates[0].item_id);
  const dimension = resolved.clarification && resolved.clarification.dimension;
  const axis = dimension && dimension.startsWith('variant:') ? dimension.slice('variant:'.length) : null;
  const choices = [ ...((resolved.clarification && resolved.clarification.choices) || []) ];
  if (sameItem) {
    choices.push({
      label: axis ? `All ${axis}${axis.endsWith('s') ? '' : 's'}` : 'All variants',
      value: '__all_candidates__',
    });
  }
  return new ValidationError(
    resolved.question || resolved.message || 'Which product or variant is this price for?',
    {
      kind: 'price_clarification',
      choices: choices.length ? choices : null,
      continuation: {
        data: {
          operation: data.operation,
          itemText: data.itemText,
          variantText: data.variantText || '',
          amount: data.amount,
          currency: data.currency || 'USD',
          reason: data.reason || 'The owner stated a customer selling price.',
        },
        sourceText: statedAs,
        candidateSkuIds: sameItem ? resolved.candidates.map((candidate) => candidate.id) : [],
      },
    }
  );
}

function proposalFromInterpreted(db, ctx, data, statedAs) {
  if (data.operation === 'set' && Number(data.amount) < 0) {
    throw new ValidationError('What selling price should Foundry use?');
  }
  const resolved = resolver.resolveSku(db, ctx.workspaceId, data.itemText, data.variantText, {
    instruction: statedAs,
  });
  if (!resolved.ok) throw clarificationError(resolved, data, statedAs);
  return createProposal(db, ctx, {
    skuId: resolved.value.id,
    amountMinor: data.operation === 'remove' ? null : prices.toMinor(String(data.amount)),
    currency: data.currency || 'USD', sourceText: statedAs,
  });
}

async function interpret(db, ctx, message, options = {}) {
  const statedAs = requireText(message, 'Price instruction', { max: 1200 });
  const catalogueRows = catalogue(db, ctx.workspaceId);
  let data;
  try {
    const response = await (options.provider || createProviderForTier('fast')).complete({
      system: SYSTEM,
      prompt: `Inventory products:\n${JSON.stringify(db.prepare(`SELECT i.name, s.code, s.variant_label
        FROM skus s JOIN items i ON i.id = s.item_id WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        ORDER BY i.name, s.position LIMIT 300`).all(ctx.workspaceId))}\n\nOwner request:\n${statedAs}`,
      schema: SCHEMA, schemaName: 'selling_price_change',
    });
    const checked = validate(toWireSchema(SCHEMA), response.data, { key: 'selling-price-change-wire' });
    if (!checked.ok) throw new Error('invalid price instruction');
    data = checked.data;
  } catch { data = fallback(statedAs, catalogueRows); }
  return proposalFromInterpreted(db, ctx, data, statedAs);
}

function continueInterpret(db, ctx, continuation, answer) {
  if (!continuation || !continuation.data || !continuation.sourceText) {
    throw new ValidationError('That selling-price question is no longer waiting. Please send the price again.');
  }
  const selected = requireText(answer, 'Your choice', { max: 200 });
  if (selected === '__all_candidates__') {
    const candidateSkuIds = Array.isArray(continuation.candidateSkuIds)
      ? [...new Set(continuation.candidateSkuIds)]
      : [];
    if (candidateSkuIds.length < 2) {
      throw new ValidationError('That group of variants is no longer available. Please send the price again.');
    }
    const amountMinor = continuation.data.operation === 'remove'
      ? null
      : prices.toMinor(String(continuation.data.amount));
    const currency = prices.normaliseCurrency(continuation.data.currency || 'USD');
    const prepared = candidateSkuIds.filter((skuId) => {
      const sku = prices.requireSku(db, ctx.workspaceId, skuId);
      const current = prices.currentForSku(db, ctx.workspaceId, sku.id);
      return continuation.data.operation === 'remove'
        ? current.isSet
        : current.amount_minor !== amountMinor || current.currency !== currency;
    });
    if (!prepared.length) throw new ValidationError('Every selected variant already has that selling price.');
    const proposals = db.transaction(() => prepared.map((skuId) => createProposal(db, ctx, {
      skuId,
      amountMinor,
      currency,
      sourceText: `${continuation.sourceText} — Clarification: All variants`,
    })))();
    return { kind: 'batch', proposals };
  }
  const data = { ...continuation.data, variantText: selected };
  const statedAs = `${continuation.sourceText} — Clarification: ${selected}`;
  return proposalFromInterpreted(db, ctx, data, statedAs);
}

async function interpretMany(db, ctx, message, options = {}) {
  const statedAs = requireText(message, 'Price instruction', { max: 12000 });
  let changes;
  try {
    const response = await (options.provider || createProviderForTier('fast')).complete({
      system: BULK_SYSTEM,
      prompt: `Inventory products:\n${JSON.stringify(catalogue(db, ctx.workspaceId))}\n\nOwner request:\n${statedAs}`,
      schema: BULK_SCHEMA, schemaName: 'selling_price_changes',
    });
    const checked = validate(toWireSchema(BULK_SCHEMA), response.data, { key: 'selling-price-changes-wire' });
    if (!checked.ok) throw new Error('invalid price instructions');
    changes = checked.data.changes;
  } catch {
    changes = fallbackMany(db, ctx, statedAs);
  }
  if (!Array.isArray(changes) || changes.length < 2) {
    throw new ValidationError('List each product code with its selling price, one per line. Foundry did not find at least two complete price changes.');
  }

  const prepared = [];
  const seen = new Set();
  for (const change of changes) {
    if (!Number.isFinite(Number(change.amount)) || Number(change.amount) < 0) {
      throw new ValidationError('Every listed product needs a valid selling price.');
    }
    let resolved = resolver.resolveSku(db, ctx.workspaceId, change.itemText, change.variantText, { instruction: statedAs });
    if (!resolved.ok) {
      const exactCode = catalogue(db, ctx.workspaceId)
        .filter((sku) => String(sku.code).toLowerCase() === String(change.itemText || '').trim().toLowerCase());
      if (exactCode.length === 1) {
        const row = db.prepare(`SELECT s.*, i.name AS item_name FROM skus s JOIN items i ON i.id = s.item_id
          WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE AND s.is_active = 1 AND i.is_active = 1`).get(ctx.workspaceId, exactCode[0].code);
        resolved = { ok: true, value: row };
      }
    }
    if (!resolved.ok) throw new ValidationError(resolved.question || resolved.message || `Which product is “${change.itemText}”?`);
    if (seen.has(resolved.value.id)) throw new ValidationError(`${resolved.value.code || change.itemText} is listed more than once.`);
    seen.add(resolved.value.id);
    const amountMinor = prices.toMinor(String(change.amount));
    const currency = prices.normaliseCurrency(change.currency || 'USD');
    const current = prices.currentForSku(db, ctx.workspaceId, resolved.value.id);
    if (current.amount_minor === amountMinor && current.currency === currency) continue;
    prepared.push({ skuId: resolved.value.id, amountMinor, currency, sourceText: statedAs });
  }
  if (!prepared.length) throw new ValidationError('Every listed product already has that selling price.');
  return db.transaction(() => prepared.map((entry) => createProposal(db, ctx, entry)))();
}

function hash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function createProposal(db, ctx, input) {
  const sku = prices.requireSku(db, ctx.workspaceId, input.skuId);
  const amountMinor = input.amountMinor !== undefined ? input.amountMinor : prices.toMinor(input.amount, 'Selling price');
  const currency = prices.normaliseCurrency(input.currency);
  const current = prices.currentForSku(db, ctx.workspaceId, sku.id);
  if (current.amount_minor === amountMinor && current.currency === currency) {
    throw new ValidationError(`${sku.display_name} already has that selling price.`);
  }
  const id = newId('pcp');
  const createdAt = nowIso();
  const integrityHash = hash({ workspaceId: ctx.workspaceId, skuId: sku.id, amountMinor, currency, currentPriceId: current.id });
  db.prepare(`INSERT INTO price_change_proposals
    (id, workspace_id, sku_id, amount_minor, currency, source_text, status, current_price_id,
     integrity_hash, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, sku.id, amountMinor, currency, requireText(input.sourceText || 'Manual price change', 'Source'),
      current.id, integrityHash, ctx.actorId, createdAt);
  return get(db, ctx.workspaceId, id);
}

function get(db, workspaceId, id) {
  const row = db.prepare(`SELECT p.*, s.code, s.variant_label, i.name AS item_name, i.unit_label
    FROM price_change_proposals p JOIN skus s ON s.id = p.sku_id JOIN items i ON i.id = s.item_id
    WHERE p.id = ? AND p.workspace_id = ?`).get(id, workspaceId);
  if (!row) throw new NotFoundError('That price change is not in this inventory.');
  const current = row.current_price_id
    ? db.prepare('SELECT * FROM sku_prices WHERE id = ? AND workspace_id = ?').get(row.current_price_id, workspaceId)
    : null;
  return { ...row, item_id: db.prepare('SELECT item_id FROM skus WHERE id = ?').get(row.sku_id).item_id,
    displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
    current, currentFormatted: current ? prices.formatMinor(current.amount_minor, current.currency) : 'Not set',
    proposedFormatted: row.amount_minor === null ? 'Remove selling price' : prices.formatMinor(row.amount_minor, row.currency) };
}

function approve(db, ctx, id, expectedHash) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status === 'COMPLETED') return proposal;
  if (proposal.status !== 'PENDING') throw new ValidationError('That price change is no longer waiting for approval.');
  if (expectedHash && expectedHash !== proposal.integrity_hash) throw new ValidationError('That price preview changed. Review it again.');
  const current = prices.currentForSku(db, ctx.workspaceId, proposal.sku_id);
  if ((current.id || null) !== (proposal.current_price_id || null)) {
    throw new ValidationError('The current selling price changed after this preview was prepared. Start again from the latest price.');
  }
  prices.setPrice(db, ctx, { skuId: proposal.sku_id, amountMinor: proposal.amount_minor, currency: proposal.currency,
    source: 'approved_instruction', sourceDetail: { proposalId: proposal.id, statedAs: proposal.source_text } });
  db.prepare(`UPDATE price_change_proposals SET status = 'COMPLETED', approved_by_user_id = ?, completed_at = ?
    WHERE id = ? AND workspace_id = ?`).run(ctx.actorId, nowIso(), id, ctx.workspaceId);
  return get(db, ctx.workspaceId, id);
}

function cancel(db, workspaceId, id) {
  const proposal = get(db, workspaceId, id);
  if (proposal.status === 'PENDING') db.prepare(`UPDATE price_change_proposals SET status = 'CANCELLED', cancelled_at = ?
    WHERE id = ? AND workspace_id = ?`).run(nowIso(), id, workspaceId);
  return get(db, workspaceId, id);
}

function approveBatch(db, ctx, proposals) {
  if (!Array.isArray(proposals) || !proposals.length) throw new ValidationError('That price list is no longer waiting for approval.');
  return db.transaction(() => proposals.map((entry) => approve(db, ctx, entry.id, entry.integrityHash)))();
}

function cancelBatch(db, workspaceId, ids) {
  return db.transaction(() => (ids || []).map((id) => cancel(db, workspaceId, id)))();
}

module.exports = {
  SCHEMA, SYSTEM, BULK_SCHEMA, BULK_SYSTEM,
  matchesInstruction, matchesBulkInstruction, fallback, fallbackMany,
  interpret, continueInterpret, interpretMany, createProposal, get, approve, approveBatch, cancel, cancelBatch,
};

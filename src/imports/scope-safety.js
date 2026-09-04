'use strict';

/**
 * Detect when an uploaded catalogue appears to belong somewhere other than the
 * inventory currently open. This is deliberately evidence based: product
 * names and identifiers from the file are compared with the real catalogue.
 * No clothing, footwear, hardware, or other industry vocabulary lives here.
 */

const IGNORED = new Set(['a', 'an', 'and', 'for', 'of', 'the', 'to', 'with']);

function words(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(/\s+/).filter((word) => word && !IGNORED.has(word));
}

function key(value) { return words(value).join(' '); }

function similarName(left, right) {
  const a = key(left);
  const b = key(right);
  if (!a || !b) return false;
  if (a === b || (a.length >= 8 && b.includes(a)) || (b.length >= 8 && a.includes(b))) return true;
  const aa = new Set(a.split(' '));
  const bb = new Set(b.split(' '));
  const overlap = [...aa].filter((word) => bb.has(word)).length;
  return overlap >= 2 && overlap / Math.min(aa.size, bb.size) >= 0.6;
}

function uniqueRecords(records) {
  const seen = new Set();
  return (records || []).map((record) => ({
    name: String(record.name || '').trim(),
    code: String(record.code || '').trim().toLowerCase(),
  })).filter((record) => {
    const identity = `${key(record.name)}|${record.code}`;
    if ((!record.name && !record.code) || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * A few products, named once each.
 *
 * The list shown to a person is drawn from rows that are one per SKU, so an
 * inventory whose first product came in seven sizes introduced itself as
 * "loafer, loafer, loafer, loafer". Four slots spent saying one word, on the
 * one screen whose whole job is to let somebody recognise their own data.
 *
 * De-duplicated on the name as a reader sees it, not on the identity used for
 * matching, because two SKUs of the same product are two records and one
 * product.
 */
function examples(records, limit = 4) {
  const seen = new Set();
  const shown = [];
  for (const record of records) {
    const label = record.name || record.code;
    if (!label) continue;
    const identity = key(label) || label.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    shown.push(label);
    if (shown.length >= limit) break;
  }
  return shown;
}

function evaluate(db, workspaceId, incomingRecords) {
  const incoming = uniqueRecords(incomingRecords);
  const current = uniqueRecords(db.prepare(`SELECT i.name, s.code FROM items i
    JOIN skus s ON s.item_id = i.id AND s.workspace_id = i.workspace_id
    WHERE i.workspace_id = ? AND i.is_active = 1 AND s.is_active = 1`).all(workspaceId));
  const supplierCodes = new Set(db.prepare(`SELECT LOWER(supplier_sku) AS code FROM supplier_items
    WHERE workspace_id = ? AND supplier_sku IS NOT NULL AND supplier_sku <> ''`).all(workspaceId)
    .map((row) => row.code));

  if (!incoming.length || !current.length) return { needsConfirmation: false };

  let matches = 0;
  for (const record of incoming) {
    const matched = (record.code && (supplierCodes.has(record.code)
      || current.some((existing) => existing.code === record.code)))
      || current.some((existing) => similarName(record.name, existing.name));
    if (matched) matches += 1;
  }
  const overlap = matches / incoming.length;
  const needsConfirmation = matches === 0 || (incoming.length >= 4 && overlap < 0.25);
  if (!needsConfirmation) return { needsConfirmation: false, matches, incomingCount: incoming.length };

  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId);
  return {
    needsConfirmation: true,
    workspaceName: workspace ? workspace.name : 'this inventory',
    incomingCount: incoming.length,
    matches,
    incomingExamples: examples(incoming),
    currentExamples: examples(current),
    /*
     * How many distinct products each side actually has. "4 of 5" is the
     * difference between "this is the wrong inventory" and "this file adds to
     * it", and the counts above are per SKU, which cannot say either.
     */
    currentProductCount: examples(current, Infinity).length,
    incomingProductCount: examples(incoming, Infinity).length,
    message: `The file's products do not appear to match the products already in ${workspace ? workspace.name : 'this inventory'}.`,
  };
}

function fromDocument(db, workspaceId, interpretation) {
  return evaluate(db, workspaceId, (interpretation.lines || []).map((line) => ({
    name: [line.styleName, line.color].filter(Boolean).join(' - '), code: line.supplierSku,
  })));
}

function fromImportRows(db, workspaceId, rows) {
  return evaluate(db, workspaceId, (rows || []).map((row) => ({
    name: row.parsed && row.parsed.name, code: row.parsed && row.parsed.code,
  })));
}

module.exports = { words, similarName, evaluate, fromDocument, fromImportRows };

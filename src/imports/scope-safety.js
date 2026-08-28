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
    incomingExamples: incoming.slice(0, 4).map((record) => record.name || record.code),
    currentExamples: current.slice(0, 4).map((record) => record.name || record.code),
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

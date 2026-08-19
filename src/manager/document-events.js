'use strict';

/**
 * Read an operational document and connect it to work Foundry already knows
 * about.  The model extracts bounded document evidence; matching to a purchase
 * order is deterministic and may only select records from this workspace.
 */

const documentIntake = require('../foundry/document-intake');
const poService = require('../purchasing/po-service');
const supplierService = require('../purchasing/supplier-service');

const OPEN = ['APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'];

const key = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function lineMatches(documentLine, orderLine) {
  const supplierSku = key(documentLine.supplierSku);
  if (supplierSku && supplierSku === key(orderLine.supplierSku)) return true;
  const product = key([documentLine.styleName, documentLine.color].filter(Boolean).join(' '));
  const item = key(orderLine.itemName);
  const variant = key(orderLine.variantLabel);
  const size = key(documentLine.size);
  return Boolean(product && (product.includes(item) || item.includes(product)) && (!size || !variant || size === variant));
}

function scoreOrder(interpretation, order) {
  let score = 0;
  const reasons = [];
  if (interpretation.documentNumber && key(interpretation.documentNumber) === key(order.poNumber)) {
    score += 100;
    reasons.push(`document number matches ${order.poNumber}`);
  }
  if (interpretation.supplierName && key(interpretation.supplierName) === key(order.supplierName)) {
    score += 35;
    reasons.push(`supplier matches ${order.supplierName}`);
  }
  if (interpretation.destinationName && order.destinationLocationName &&
      key(interpretation.destinationName) === key(order.destinationLocationName)) {
    score += 15;
    reasons.push(`destination matches ${order.destinationLocationName}`);
  }

  const receiptLines = [];
  for (const documentLine of interpretation.lines) {
    const candidates = order.lines.filter((line) => line.outstandingUnits > 0 && lineMatches(documentLine, line));
    if (candidates.length !== 1) continue;
    const line = candidates[0];
    score += 12;
    receiptLines.push({
      lineId: line.id,
      quantityUnits: documentLine.quantity,
      locationId: line.destinationLocationId || order.destinationLocationId,
      documentDescription: documentLine.description,
      supplierSku: documentLine.supplierSku,
    });
  }
  if (receiptLines.length) reasons.push(`${receiptLines.length} line${receiptLines.length === 1 ? '' : 's'} matched`);
  return { order, score, reasons, receiptLines };
}

function matchPurchaseOrder(db, workspaceId, interpretation) {
  const orders = poService.list(db, workspaceId, { status: OPEN, limit: 100 });
  const ranked = orders.map((order) => scoreOrder(interpretation, order)).sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const next = ranked[1];
  if (!best || best.score < 35 || (next && best.score - next.score < 15)) {
    return { matched: false, candidates: ranked.slice(0, 3).map((entry) => ({
      purchaseOrderId: entry.order.id, poNumber: entry.order.poNumber, supplierName: entry.order.supplierName,
      score: entry.score, reasons: entry.reasons,
    })) };
  }
  return {
    matched: true,
    purchaseOrderId: best.order.id,
    supplierId: best.order.supplierId,
    poNumber: best.order.poNumber,
    supplierName: best.order.supplierName,
    preferredItemCodeLabel: best.order.supplierItemCodeLabel || 'Supplier code',
    confidence: best.score >= 75 ? 'high' : 'medium',
    reasons: best.reasons,
    receiptLines: best.receiptLines,
  };
}

async function understand(db, ctx, file, options = {}) {
  const text = await documentIntake.extractText(file);
  const interpretation = await documentIntake.interpret(text, {
    ...options,
    supplierVocabulary: supplierService.documentVocabulary(db, ctx.workspaceId),
  });
  const match = matchPurchaseOrder(db, ctx.workspaceId, interpretation);
  if (match.matched && interpretation.supplierCodeLabel) {
    supplierService.rememberItemCodeAlias(db, ctx.workspaceId, match.supplierId, interpretation.supplierCodeLabel);
  }
  return { interpretation, match, extractedText: text };
}

module.exports = { OPEN, lineMatches, scoreOrder, matchPurchaseOrder, understand };

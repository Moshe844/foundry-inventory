'use strict';

/**
 * Turns trusted supplier messages into purchasing evidence.
 *
 * This service is intentionally deterministic. Extractors may propose `facts`,
 * but only exact supplier/PO/SKU matches and explicit tolerances can update
 * purchasing expectations. Physical stock remains behind the existing
 * receiving engine. The only automatic receiving path is the explicit
 * advanced trusted-delivery policy below, with an exact PO, exact SKU lines,
 * usable quantities and a replay-safe receipt key.
 */
const crypto = require('node:crypto');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const connections = require('../connections/service');
const poService = require('./po-service');
const managerEvents = require('../manager/events');

const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const number = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const date = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
};

function classify(subject, body, attachments = []) {
  const text = `${subject || ''} ${body || ''} ${attachments.map((entry) => `${entry.filename || ''} ${entry.extractedText || ''}`).join(' ')}`.toLowerCase();
  if (/credit\s*(memo|note)|correction/.test(text)) return 'credit';
  if (/packing\s*slip|proof\s*of\s*delivery|delivery\s*(confirmation|note)|\bdelivered\b/.test(text)) return 'delivery_confirmation';
  if (/back[ -]?order|remaining.+(next|expected)/.test(text)) return 'backorder_notice';
  if (/shipment|shipping\s+now|tracking|dispatch/.test(text)) return 'shipment_notice';
  if (/order\s*(acknowledg|confirm)|\bconfirmed\b|accepted\s+(your\s+)?order/.test(text)) return 'order_acknowledgement';
  if (/invoice|\bbill\b/.test(text)) return 'invoice';
  if (/quotation|\bquote\b|estimate/.test(text)) return 'quotation';
  if (/price\s*(change|update|increase)|new\s+price/.test(text)) return 'price_update';
  return 'supplier_message';
}

const DOCUMENT_TYPES = new Set([
  'supplier_message', 'order_acknowledgement', 'invoice', 'packing_slip', 'shipment_notice',
  'delivery_confirmation', 'backorder_notice', 'quotation', 'price_update', 'credit',
]);

function validatedDocumentType(value) {
  const candidate = String(value || '').trim();
  return DOCUMENT_TYPES.has(candidate) ? candidate : null;
}

function conservativeFacts(message, supplied = {}) {
  const text = `${message.subject || ''}\n${message.body_text || ''}`;
  const po = text.match(/\bPO[-\s#:]*(\d{2,})\b/i);
  const invoice = text.match(/\b(?:invoice|inv)[-\s#:]*(\w[\w-]{1,40})\b/i);
  const tracking = text.match(/\btracking[-\s#:]*(\w[\w-]{3,80})\b/i);
  return {
    ...supplied,
    poNumber: trimOrNull(supplied.poNumber) || (po ? `PO-${po[1]}` : null),
    invoiceNumber: trimOrNull(supplied.invoiceNumber) || (invoice ? invoice[1] : null),
    trackingNumber: trimOrNull(supplied.trackingNumber) || (tracking ? tracking[1] : null),
    expectedShipDate: date(supplied.expectedShipDate),
    expectedArrivalDate: date(supplied.expectedArrivalDate || supplied.eta),
    lines: Array.isArray(supplied.lines) ? supplied.lines : [],
  };
}

function orderFor(db, message, facts) {
  if (facts.poNumber) {
    return db.prepare(`SELECT * FROM purchase_orders WHERE workspace_id = ? AND supplier_id = ?
      AND po_number = ? COLLATE NOCASE`).get(message.workspace_id, message.supplier_id, facts.poNumber) || null;
  }
  if (message.external_thread_id) {
    return db.prepare(`SELECT po.* FROM supplier_documents d
      JOIN connection_email_messages m ON m.id = d.message_id
      JOIN purchase_orders po ON po.id = d.purchase_order_id
      WHERE d.workspace_id = ? AND d.supplier_id = ? AND m.external_thread_id = ?
        AND d.purchase_order_id IS NOT NULL ORDER BY d.processed_at DESC LIMIT 1`)
      .get(message.workspace_id, message.supplier_id, message.external_thread_id) || null;
  }
  return null;
}

function orderLines(db, orderId) {
  return db.prepare(`SELECT pol.*, s.code AS sku_code, s.variant_label, i.name AS item_name, i.tracking_mode,
      si.supplier_sku AS mapped_supplier_sku
    FROM purchase_order_lines pol JOIN skus s ON s.id = pol.sku_id
    JOIN items i ON i.id = s.item_id
    LEFT JOIN supplier_items si ON si.id = pol.supplier_item_id
    WHERE pol.purchase_order_id = ? ORDER BY pol.line_number`).all(orderId);
}

function receiveTrustedDelivery(db, message, supplier, order, documentId, matched) {
  if (!supplier?.trusted_delivery_receipt || !order || !matched.length) return null;
  if (matched.length !== matched.filter(({ quantity }) => Number.isInteger(quantity) && quantity > 0).length) return null;
  if (matched.some(({ line }) => ['lot', 'serial'].includes(line.tracking_mode))) return null;
  const actor = db.prepare(`SELECT u.id AS actor_id, u.account_id
    FROM workspace_connectors c JOIN users u ON u.id = c.authorized_by_user_id
    WHERE c.workspace_id = ? AND c.id = ?`).get(message.workspace_id, message.connector_id);
  if (!actor) return null;
  const membership = require('../domain/auth-service').getMembership(db, message.workspace_id, actor.account_id);
  const input = {
    idempotencyKey: `trusted-supplier-delivery:${documentId}`,
    lines: matched.map(({ line, quantity }) => ({
      lineId: line.id,
      quantityUnits: quantity,
      locationId: line.destination_location_id || order.destination_location_id,
    })),
  };
  try {
    return require('./receiving-service').receive(db, {
      workspaceId: message.workspace_id, actorId: actor.actor_id, accountId: actor.account_id,
    }, membership, order.id, input);
  } catch {
    // A tracked item, over-receipt, closed order, or any other failed
    // deterministic receiving guard falls back to a human confirmation.
    return null;
  }
}

function matchLine(lines, proposed) {
  const keys = [proposed.purchaseOrderLineId, proposed.supplierSku, proposed.sku, proposed.skuCode]
    .filter(Boolean).map((entry) => String(entry).trim().toLowerCase());
  const coded = lines.find((line) => keys.includes(String(line.id).toLowerCase())
    || [line.supplier_sku, line.mapped_supplier_sku, line.sku_code].filter(Boolean)
      .some((entry) => keys.includes(String(entry).trim().toLowerCase()))) || null;
  if (coded) return coded;

  // A supplier does not need to repeat its SKU when an exact product name on
  // an already-identified PO resolves to one line. This is deliberately exact
  // and unique: similar wording or two same-named lines still asks the owner.
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const description = normalize(proposed.description || proposed.displayName || proposed.name);
  if (!description) return null;
  const described = lines.filter((line) => [
    line.description,
    line.item_name,
    line.variant_label ? `${line.item_name} / ${line.variant_label}` : null,
  ].some((candidate) => normalize(candidate) === description));
  return described.length === 1 ? described[0] : null;
}

function issue(db, message, type, fingerprint, title, detail, resolutionHint, candidates = []) {
  return connections.issue(db, { workspaceId: message.workspace_id, connectorId: message.connector_id,
    externalEventId: message.external_message_id, issueType: type, fingerprint, title, detail, resolutionHint,
    candidates });
}

function process(db, messageId, proposedFacts = {}) {
  const message = db.prepare('SELECT * FROM connection_email_messages WHERE id = ?').get(messageId);
  if (!message || message.trust_status !== 'TRUSTED') return null;
  const attachments = db.prepare('SELECT * FROM connection_email_attachments WHERE message_id = ?').all(messageId)
    .map((row) => ({ ...row, extractedText: row.extracted_text }));
  // In the normal connected flow the model proposes one closed document type.
  // The deterministic engine accepts only that enum. The legacy classifier is
  // retained strictly for installations without an extractor so existing
  // ingestion does not stop working.
  const documentType = validatedDocumentType(proposedFacts.documentType)
    || classify(message.subject, message.body_text, attachments);
  const facts = conservativeFacts(message, proposedFacts);
  const documentReference = facts.invoiceNumber || facts.supplierOrderNumber || facts.poNumber || null;
  const contentHash = message.content_hash || crypto.createHash('sha256')
    .update(`${message.sender}\n${message.subject || ''}\n${message.body_text || ''}\n${attachments.map((a) => a.content_hash).join(':')}`)
    .digest('hex');
  // Provider notifications and model extraction can be replayed independently.
  // Identity is therefore based on the trusted supplier plus the original
  // message/attachment bytes and business reference, never on a model label.
  const attachmentHash = attachments[0]?.content_hash || null;
  // If the owner already approved these exact bytes as an inventory import,
  // the same attachment cannot simultaneously become a supplier invoice that
  // asks for purchasing decisions. Preserve the email, mark the resend, and
  // do not create a second interpretation of the same file.
  const appliedInventory = attachmentHash ? db.prepare(`SELECT id FROM setup_documents
    WHERE workspace_id = ? AND content_hash = ? AND status = 'APPLIED' LIMIT 1`)
    .get(message.workspace_id, attachmentHash) : null;
  if (appliedInventory) {
    db.prepare(`UPDATE connection_email_attachments SET setup_document_id = ?
      WHERE workspace_id = ? AND message_id = ? AND content_hash = ? AND setup_document_id IS NULL`)
      .run(appliedInventory.id, message.workspace_id, message.id, attachmentHash);
    db.prepare(`UPDATE connection_email_messages SET classification = 'inventory_document_duplicate',
      processing_status = 'DUPLICATE_IGNORED', processed_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(nowIso(), message.id, message.workspace_id);
    return null;
  }
  const existing = db.prepare(`SELECT d.* FROM supplier_documents d
    LEFT JOIN connection_email_attachments a ON a.id = d.attachment_id
    WHERE d.workspace_id = ? AND d.connector_id = ?
      AND IFNULL(d.supplier_id, '') = IFNULL(?, '')
      AND IFNULL(d.document_reference, '') = IFNULL(?, '')
      AND (d.content_hash = ? OR (? IS NOT NULL AND a.content_hash = ?))
    ORDER BY d.processed_at DESC LIMIT 1`)
    .get(message.workspace_id, message.connector_id, message.supplier_id, documentReference,
      contentHash, attachmentHash, attachmentHash);
  if (existing) {
    db.prepare("UPDATE connection_email_messages SET processing_status = 'DUPLICATE', processed_at = ? WHERE id = ?")
      .run(nowIso(), messageId);
    return existing;
  }

  const supplier = message.supplier_id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ? AND workspace_id = ?').get(message.supplier_id, message.workspace_id)
    : null;
  const order = supplier ? orderFor(db, message, facts) : null;
  const discrepancies = [];
  if (!supplier) discrepancies.push({ type: 'supplier', message: 'No approved supplier is associated with this sender.' });
  if (supplier && !order && !['price_update', 'quotation', 'supplier_message'].includes(documentType)) {
    discrepancies.push({ type: 'purchase_order', message: facts.poNumber
      ? `${facts.poNumber} was not found for ${supplier.name}.` : 'No purchase order could be matched confidently.' });
  }

  const lines = order ? orderLines(db, order.id) : [];
  const matched = [];
  for (const proposed of facts.lines) {
    const line = matchLine(lines, proposed);
    if (!line) {
      discrepancies.push({ type: 'unknown_sku', supplierSku: proposed.supplierSku || proposed.skuCode || proposed.sku || null,
        message: `Supplier line ${proposed.supplierSku || proposed.skuCode || proposed.sku || '(unnamed)'} needs a Foundry match.` });
      continue;
    }
    const unitPrice = number(proposed.unitPrice ?? (proposed.unitPriceMinor == null ? null : Number(proposed.unitPriceMinor) / 100));
    const quantity = number(proposed.quantity ?? proposed.confirmedQuantity);
    let priceWithinTolerance = unitPrice !== null && line.unit_cost !== null;
    if (unitPrice !== null && line.unit_cost !== null) {
      const change = line.unit_cost === 0 ? (unitPrice === 0 ? 0 : 100) : ((unitPrice - line.unit_cost) / line.unit_cost) * 100;
      if (Math.abs(change) > Number(supplier.price_tolerance_percent ?? 5)) {
        priceWithinTolerance = false;
        discrepancies.push({ type: 'price', lineId: line.id, skuId: line.sku_id, previous: line.unit_cost,
          current: unitPrice, changePercent: Math.round(change * 10) / 10,
          message: `${line.description || line.sku_code} changed from ${line.unit_cost} to ${unitPrice} (${change >= 0 ? '+' : ''}${change.toFixed(1)}%).` });
      }
    }
    if (quantity !== null) {
      const changed = Math.abs(quantity - Number(line.quantity_units));
      const percent = Number(line.quantity_units) ? changed / Number(line.quantity_units) * 100 : 100;
      if (percent > Number(supplier.quantity_tolerance_percent ?? 0)) {
        discrepancies.push({ type: 'quantity', lineId: line.id, ordered: line.quantity_units, current: quantity,
          message: `${line.description || line.sku_code} changed from ${line.quantity_units} to ${quantity} units.` });
      }
    }
    matched.push({ proposed, line, unitPrice, quantity, priceWithinTolerance });
  }

  const now = nowIso();
  const documentId = newId('sdoc');
  const status = discrepancies.length ? 'NEEDS_REVIEW' : order ? 'MATCHED' : 'RECORDED';
  db.prepare(`INSERT INTO supplier_documents
    (id, workspace_id, connector_id, message_id, attachment_id, supplier_id, purchase_order_id,
     document_type, document_reference, content_hash, facts, discrepancies, confidence, status, created_at, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(documentId, message.workspace_id, message.connector_id, message.id, attachments[0]?.id || null,
      supplier?.id || null, order?.id || null, documentType, documentReference, contentHash,
      JSON.stringify(facts), JSON.stringify(discrepancies), order ? 1 : supplier ? 0.6 : 0,
      status, message.received_at, now);

  if (order) {
    for (const { proposed, line, unitPrice, quantity, priceWithinTolerance } of matched) {
      if (unitPrice !== null) db.prepare(`INSERT OR IGNORE INTO supplier_price_history
        (id, workspace_id, supplier_id, sku_id, supplier_item_id, unit_cost, currency, source_document_id,
         observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('sprice'), message.workspace_id, supplier.id, line.sku_id, line.supplier_item_id,
          unitPrice, order.currency || supplier.currency || 'USD', documentId, message.received_at, now);
      // A saved price tolerance is deterministic authority to accept routine
      // supplier price movement. Keep the PO and the supplier's current known
      // cost aligned with that evidence. Outside the tolerance remains a
      // review and is never applied here.
      if (priceWithinTolerance && Number(unitPrice) !== Number(line.unit_cost)) {
        db.prepare(`UPDATE purchase_order_lines SET unit_cost = ?, line_total = ?
          WHERE id = ? AND workspace_id = ?`)
          .run(unitPrice, unitPrice * Number(line.quantity_units), line.id, message.workspace_id);
        if (line.supplier_item_id) db.prepare(`UPDATE supplier_items SET last_unit_cost = ?, last_cost_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`)
          .run(unitPrice, message.received_at, now, line.supplier_item_id, message.workspace_id);
      }
      if (['order_acknowledgement', 'shipment_notice', 'packing_slip', 'backorder_notice'].includes(documentType)) {
        const confirmed = number(proposed.confirmedQuantity ?? quantity);
        const shipping = number(proposed.shippedQuantity
          ?? (['shipment_notice', 'packing_slip'].includes(documentType) ? quantity : null));
        const backordered = number(proposed.backorderedQuantity);
        db.prepare(`INSERT INTO purchase_order_line_expectations
          (id, workspace_id, purchase_order_id, purchase_order_line_id, confirmed_units, shipping_units,
           backordered_units, expected_ship_date, expected_arrival_date, source_document_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, purchase_order_line_id) DO UPDATE SET
            confirmed_units = COALESCE(excluded.confirmed_units, confirmed_units),
            shipping_units = COALESCE(excluded.shipping_units, shipping_units),
            backordered_units = COALESCE(excluded.backordered_units, backordered_units),
            expected_ship_date = COALESCE(excluded.expected_ship_date, expected_ship_date),
            expected_arrival_date = COALESCE(excluded.expected_arrival_date, expected_arrival_date),
            source_document_id = excluded.source_document_id, updated_at = excluded.updated_at`)
          .run(newId('poexp'), message.workspace_id, order.id, line.id, confirmed, shipping, backordered,
            date(proposed.expectedShipDate || facts.expectedShipDate),
            date(proposed.expectedArrivalDate || proposed.eta || facts.expectedArrivalDate), documentId, now);
      }
    }
    if (facts.expectedArrivalDate) db.prepare(`UPDATE purchase_orders SET expected_date = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(facts.expectedArrivalDate, now, order.id, message.workspace_id);
    poService.recordEvent(db, message.workspace_id, order.id,
      discrepancies.length ? 'supplier_message_needs_review' : `supplier_${documentType}`,
      { documentId, reference: documentReference, sender: message.sender, facts, discrepancies }, null);
    managerEvents.publish(db, message.workspace_id, managerEvents.TYPES.SUPPLIER_UPDATED,
      { supplierId: supplier.id, purchaseOrderId: order.id, documentId, change: documentType },
      { source: 'supplier_email', sourceRecordType: 'supplier_document', sourceRecordId: documentId });
  }

  let trustedReceipt = null;
  if (!discrepancies.length && documentType === 'delivery_confirmation') {
    trustedReceipt = receiveTrustedDelivery(db, message, supplier, order, documentId, matched);
  }

  if (discrepancies.length) {
    const first = discrepancies[0];
    const mappingCandidates = discrepancies.filter((entry) => entry.type === 'unknown_sku' && entry.supplierSku)
      .map((entry) => ({ kind: 'supplier_sku', supplierSku: entry.supplierSku,
        supplierId: supplier?.id || null, supplierName: supplier?.name || null, documentId }));
    const decisionCandidate = { kind: 'supplier_document_review', documentId,
      supplierId: supplier?.id || null, purchaseOrderId: order?.id || null, discrepancies };
    issue(db, message, 'SUPPLIER_DOCUMENT_REVIEW', `supplier-document:${documentId}`,
      `${supplier?.name || message.sender} sent ${documentType.replaceAll('_', ' ')} that needs your decision`,
      discrepancies.map((entry) => entry.message).join(' '),
      first.type === 'unknown_sku' ? 'Match the supplier SKU once; future documents will reuse it.'
        : 'Review the extracted facts and approve only the purchasing change you intend.',
      [decisionCandidate, ...mappingCandidates]);
  } else if (documentType === 'delivery_confirmation' && !trustedReceipt) {
    issue(db, message, 'PHYSICAL_RECEIPT_CONFIRMATION', `supplier-delivery:${documentId}`,
      `${supplier.name} says ${order?.po_number || 'an order'} was delivered`,
      'This is delivery evidence only. Foundry has not increased on-hand inventory.',
      order ? `Open ${order.po_number} and confirm what physically arrived.` : 'Match the order, then confirm what physically arrived.');
  }

  db.prepare(`UPDATE connection_email_messages SET classification = ?, processing_status = ?, processed_at = ? WHERE id = ?`)
    .run(documentType, status, now, messageId);
  const savedDocument = db.prepare('SELECT * FROM supplier_documents WHERE id = ?').get(documentId);
  // Mission 14 consumes only the structured, trusted result above. Any
  // accounting exception remains a bill/review; this adapter cannot receive
  // stock, change purchasing authority, or reinterpret the email.
  if (documentType === 'invoice') {
    try {
      require('../accounting/supplier-invoice-adapter').captureMatchedInvoice(db, message, savedDocument, matched);
    } catch (error) {
      issue(db, message, 'ACCOUNTING_INVOICE_REVIEW', `accounting-invoice:${documentId}`,
        `${supplier?.name || message.sender} invoice needs an accounting decision`,
        error.message, 'Open Accounting → Bills and resolve the exact match or amount before posting.');
    }
  }
  return savedDocument;
}

/**
 * Interpret an already-captured message only after the owner explicitly says
 * it is a purchasing document. AI proposes facts; `process` remains the
 * deterministic boundary that matches suppliers, POs and tolerances.
 */
async function interpretAndProcess(db, messageId, options = {}) {
  const message = db.prepare('SELECT * FROM connection_email_messages WHERE id = ?').get(messageId);
  if (!message || message.trust_status !== 'TRUSTED') return null;
  const attachments = db.prepare('SELECT * FROM connection_email_attachments WHERE message_id = ? ORDER BY rowid')
    .all(messageId);
  for (const attachment of attachments) {
    if (attachment.extracted_text || !attachment.content) continue;
    try {
      const extractedText = await require('../foundry/document-intake').extractText({
        filename: attachment.filename, buffer: Buffer.from(attachment.content),
      });
      db.prepare('UPDATE connection_email_attachments SET extracted_text = ? WHERE id = ?')
        .run(extractedText || null, attachment.id);
      attachment.extracted_text = extractedText || null;
    } catch {
      // Keep the original file. The deterministic review below will surface
      // any missing PO or line evidence instead of inventing it.
    }
  }
  const proposedFacts = await require('./supplier-document-extractor').extract({
    sender: message.sender, subject: message.subject, bodyText: message.body_text,
  }, attachments.map((attachment) => ({
    filename: attachment.filename, extractedText: attachment.extracted_text || '',
  })), { provider: options.provider });
  return process(db, messageId, proposedFacts || {});
}

function decide(db, ctx, issueId, decision) {
  if (!['accept', 'keep_original'].includes(decision)) throw new Error('Choose whether to accept the supplier changes or keep the original order.');
  const issueRow = db.prepare(`SELECT * FROM connection_issues
    WHERE id = ? AND workspace_id = ? AND status = 'OPEN' AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW'`)
    .get(issueId, ctx.workspaceId);
  if (!issueRow) throw new Error('That supplier-document decision is no longer waiting.');
  const candidate = json(issueRow.candidate_matches, []).find((entry) => entry.kind === 'supplier_document_review');
  const document = candidate?.documentId
    ? db.prepare('SELECT * FROM supplier_documents WHERE id = ? AND workspace_id = ?')
      .get(candidate.documentId, ctx.workspaceId) : null;
  if (!document) throw new Error('The supplier document for this decision is no longer available.');
  const discrepancies = json(document.discrepancies, []);
  if (discrepancies.some((entry) => entry.type === 'unknown_sku')) {
    throw new Error('Match every unknown supplier SKU before deciding on the remaining changes.');
  }
  const now = nowIso();
  if (decision === 'accept') {
    for (const entry of discrepancies) {
      if (!entry.lineId) continue;
      const line = db.prepare(`SELECT * FROM purchase_order_lines
        WHERE id = ? AND workspace_id = ?`).get(entry.lineId, ctx.workspaceId);
      if (!line) throw new Error('A purchase-order line in this decision is no longer available.');
      if (entry.type === 'price') {
        const value = number(entry.current);
        if (value === null || value < 0) throw new Error('The supplier price is not valid.');
        db.prepare(`UPDATE purchase_order_lines SET unit_cost = ?, line_total = ?
          WHERE id = ? AND workspace_id = ?`).run(value, value * Number(line.quantity_units), line.id, ctx.workspaceId);
        if (line.supplier_item_id) db.prepare(`UPDATE supplier_items SET last_unit_cost = ?, last_cost_at = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ?`).run(value, now, now, line.supplier_item_id, ctx.workspaceId);
      }
      if (entry.type === 'quantity') {
        const units = number(entry.current);
        if (!Number.isInteger(units) || units <= 0 || units < Number(line.quantity_received_units)) {
          throw new Error('The supplier quantity cannot be applied safely to this order.');
        }
        const purchaseUnits = units / Number(line.units_per_purchase_unit || 1);
        if (!Number.isInteger(purchaseUnits)) throw new Error('The supplier quantity does not match the configured pack size.');
        db.prepare(`UPDATE purchase_order_lines SET quantity_units = ?, quantity_purchase_units = ?,
          line_total = CASE WHEN unit_cost IS NULL THEN NULL ELSE unit_cost * ? END
          WHERE id = ? AND workspace_id = ?`).run(units, purchaseUnits, units, line.id, ctx.workspaceId);
      }
    }
    db.prepare(`UPDATE supplier_documents SET status = 'MATCHED', discrepancies = '[]', processed_at = ?
      WHERE id = ? AND workspace_id = ?`).run(now, document.id, ctx.workspaceId);
  } else {
    db.prepare(`UPDATE supplier_documents SET status = 'IGNORED', processed_at = ?
      WHERE id = ? AND workspace_id = ?`).run(now, document.id, ctx.workspaceId);
  }
  db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(now, now, issueRow.id, ctx.workspaceId);
  if (document.purchase_order_id) poService.recordEvent(db, ctx.workspaceId, document.purchase_order_id,
    decision === 'accept' ? 'supplier_changes_approved' : 'supplier_changes_declined',
    { documentId: document.id, discrepancies }, ctx.actorId);
  return { documentId: document.id, purchaseOrderId: document.purchase_order_id, decision };
}

function ignoreReview(db, ctx, issueId) {
  const issueRow = db.prepare(`SELECT * FROM connection_issues
    WHERE id = ? AND workspace_id = ? AND status = 'OPEN' AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW'`)
    .get(issueId, ctx.workspaceId);
  if (!issueRow) throw new Error('That supplier-document decision is no longer waiting.');
  const candidate = json(issueRow.candidate_matches, []).find((entry) => entry.kind === 'supplier_document_review');
  const document = candidate?.documentId ? db.prepare(`SELECT * FROM supplier_documents
    WHERE id = ? AND workspace_id = ?`).get(candidate.documentId, ctx.workspaceId) : null;
  if (!document) throw new Error('The supplier document for this decision is no longer available.');
  const now = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE supplier_documents SET status = 'IGNORED', processed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, document.id, ctx.workspaceId);
    db.prepare("UPDATE connection_email_messages SET processing_status = 'IGNORED', processed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, document.message_id, ctx.workspaceId);
    db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`).run(now, now, issueRow.id, ctx.workspaceId);
    if (document.purchase_order_id) poService.recordEvent(db, ctx.workspaceId, document.purchase_order_id,
      'supplier_document_ignored', { documentId: document.id }, ctx.actorId);
  })();
  return { documentId: document.id, purchaseOrderId: document.purchase_order_id };
}

/**
 * Repairs evidence created before exact PO-description matching was available.
 * It is intentionally narrow: exact supplier + PO, only unknown-code findings,
 * every line resolves uniquely by the matcher above, and price/quantity still
 * fall inside the supplier's saved tolerances. Original evidence is preserved.
 */
function reconcileExactDescriptionReview(db, workspaceId, documentId) {
  const document = db.prepare(`SELECT d.*, m.sender, m.received_at, m.id AS source_message_id,
      m.connector_id AS source_connector_id
    FROM supplier_documents d JOIN connection_email_messages m ON m.id = d.message_id
    WHERE d.id = ? AND d.workspace_id = ?`).get(documentId, workspaceId);
  if (!document || document.status !== 'NEEDS_REVIEW') return null;
  const oldDiscrepancies = json(document.discrepancies, []);
  if (!oldDiscrepancies.length || oldDiscrepancies.some((entry) => entry.type !== 'unknown_sku' || entry.supplierSku)) return null;
  const facts = json(document.facts, {});
  const order = document.purchase_order_id
    ? db.prepare('SELECT * FROM purchase_orders WHERE id = ? AND workspace_id = ?').get(document.purchase_order_id, workspaceId)
    : null;
  const supplier = document.supplier_id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ? AND workspace_id = ?').get(document.supplier_id, workspaceId)
    : null;
  if (!order || !supplier || !Array.isArray(facts.lines) || !facts.lines.length) return null;
  const lines = orderLines(db, order.id);
  const matched = facts.lines.map((proposed) => ({ proposed, line: matchLine(lines, proposed) }));
  if (matched.some((entry) => !entry.line)) return null;
  for (const { proposed, line } of matched) {
    const unitPrice = number(proposed.unitPrice);
    const quantity = number(proposed.quantity ?? proposed.confirmedQuantity);
    if (unitPrice !== null && line.unit_cost !== null) {
      const change = line.unit_cost === 0 ? (unitPrice === 0 ? 0 : 100) : Math.abs((unitPrice - line.unit_cost) / line.unit_cost * 100);
      if (change > Number(supplier.price_tolerance_percent ?? 5)) return null;
    }
    if (quantity !== null) {
      const percent = Number(line.quantity_units)
        ? Math.abs(quantity - Number(line.quantity_units)) / Number(line.quantity_units) * 100 : 100;
      if (percent > Number(supplier.quantity_tolerance_percent ?? 0)) return null;
    }
  }

  const now = nowIso();
  db.transaction(() => {
    for (const { proposed, line } of matched) {
      const unitPrice = number(proposed.unitPrice);
      const quantity = number(proposed.quantity ?? proposed.confirmedQuantity);
      if (unitPrice !== null) db.prepare(`INSERT OR IGNORE INTO supplier_price_history
        (id, workspace_id, supplier_id, sku_id, supplier_item_id, unit_cost, currency, source_document_id,
         observed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('sprice'), workspaceId, supplier.id, line.sku_id, line.supplier_item_id,
          unitPrice, order.currency || supplier.currency || 'USD', document.id, document.received_at, now);
      if (['order_acknowledgement', 'shipment_notice', 'packing_slip', 'backorder_notice'].includes(document.document_type)) {
        db.prepare(`INSERT INTO purchase_order_line_expectations
          (id, workspace_id, purchase_order_id, purchase_order_line_id, confirmed_units, shipping_units,
           backordered_units, expected_ship_date, expected_arrival_date, source_document_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, purchase_order_line_id) DO UPDATE SET
            confirmed_units = COALESCE(excluded.confirmed_units, confirmed_units),
            shipping_units = COALESCE(excluded.shipping_units, shipping_units),
            backordered_units = COALESCE(excluded.backordered_units, backordered_units),
            expected_ship_date = COALESCE(excluded.expected_ship_date, expected_ship_date),
            expected_arrival_date = COALESCE(excluded.expected_arrival_date, expected_arrival_date),
            source_document_id = excluded.source_document_id, updated_at = excluded.updated_at`)
          .run(newId('poexp'), workspaceId, order.id, line.id,
            number(proposed.confirmedQuantity ?? quantity), number(proposed.shippedQuantity),
            number(proposed.backorderedQuantity), date(proposed.expectedShipDate || facts.expectedShipDate),
            date(proposed.expectedArrivalDate || facts.expectedArrivalDate), document.id, now);
      }
    }
    db.prepare("UPDATE supplier_documents SET status = 'MATCHED', discrepancies = '[]', processed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, document.id, workspaceId);
    db.prepare("UPDATE connection_email_messages SET processing_status = 'MATCHED', processed_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, document.source_message_id, workspaceId);
    db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
      WHERE workspace_id = ? AND connector_id = ? AND issue_type = 'SUPPLIER_DOCUMENT_REVIEW'
        AND fingerprint = ? AND status = 'OPEN'`)
      .run(now, now, workspaceId, document.source_connector_id, `supplier-document:${document.id}`);
    poService.recordEvent(db, workspaceId, order.id, `supplier_${document.document_type}`,
      { documentId: document.id, sender: document.sender, facts, reconciledExactDescription: true }, null);
  })();
  return db.prepare('SELECT * FROM supplier_documents WHERE id = ? AND workspace_id = ?').get(document.id, workspaceId);
}

function forOrder(db, workspaceId, purchaseOrderId) {
  return db.prepare(`SELECT d.*, m.sender, m.subject, m.received_at FROM supplier_documents d
    JOIN connection_email_messages m ON m.id = d.message_id
    WHERE d.workspace_id = ? AND d.purchase_order_id = ? ORDER BY d.processed_at, d.rowid`)
    .all(workspaceId, purchaseOrderId).map((row) => ({ ...row, facts: json(row.facts, {}),
      discrepancies: json(row.discrepancies, []) }));
}

module.exports = { classify, conservativeFacts, process, interpretAndProcess, decide, ignoreReview, forOrder, matchLine,
  receiveTrustedDelivery, reconcileExactDescriptionReview };

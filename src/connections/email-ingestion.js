'use strict';

const crypto = require('node:crypto');
const connections = require('./service');
const { ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');

const replyTriage = require('./reply-triage');

function matchingRule(db, auth, sender) {
  const rules = db.prepare(`SELECT * FROM connection_email_rules
    WHERE workspace_id = ? AND connector_id = ? AND is_active = 1`)
    .all(auth.workspaceId, auth.connectorId);
  const lower = sender.toLowerCase();
  return rules.find((rule) => {
    const pattern = rule.sender_pattern.toLowerCase();
    return pattern.startsWith('@') ? lower.endsWith(pattern) : lower === pattern;
  }) || null;
}

/*
 * Somebody asking to buy something, in the words people actually use.
 *
 * Deliberately narrow. A phrase here causes StockChief to draft a Sales Order,
 * so the cost of a false positive is a phantom order in the owner's list,
 * while the cost of a miss is a message that still arrives, still shows as
 * needing an answer, and can be turned into an order by hand. Under-matching
 * is the cheaper mistake, so only unambiguous buying language counts.
 */
const WANTS_TO_BUY = [
  /\b(?:i|we)(?:'d| would)? (?:like|want|wish) to (?:order|buy|purchase)\b/,
  /\b(?:i|we) need to (?:order|buy|purchase)\b/,
  /\b(?:place|placing|submit|submitting|put in) (?:an|another|the following) order\b/,
  /\bcan (?:i|we) (?:order|buy|purchase)\b/,
  /\b(?:order|send|ship) (?:me|us) (?:the following|these)\b/,
];

function looksLikeAnOrderRequest(text) {
  return WANTS_TO_BUY.some((pattern) => pattern.test(text));
}

/**
 * What kind of document arrived.
 *
 * `knownSupplier` decides which reading wins when both are arguable: a
 * supplier writing "purchase order" is sending one of ours back, while a
 * stranger writing "I would like to place a purchase order" is trying to buy
 * something. The same words, the opposite direction, and the only thing that
 * separates them is who is speaking.
 *
 * `knownCustomer` closes the other half of that. A customer writing to ask
 * where their order is used to fall off the end of this function and be filed
 * as `supplier_message`, because the fallback assumed everybody who is not
 * buying is selling. That one wrong word meant the screen the owner reads did
 * not know a customer was waiting on them. Somebody we sell to, writing about
 * anything other than a new order, is a customer message.
 */
function classify(subject, body, attachments, options = {}) {
  const text = `${subject || ''} ${body || ''} ${(attachments || []).map((a) => a.filename).join(' ')}`.toLowerCase();
  if (!options.knownSupplier && looksLikeAnOrderRequest(text)) return 'customer_order_request';
  if (/packing\s*slip|delivery\s*(confirmation|note)|proof\s*of\s*delivery/.test(text)) return 'delivery_document';
  if (/invoice|bill\b/.test(text)) return 'invoice';
  if (/purchase\s*order|\bpo\b/.test(text)) return 'purchase_order';
  if (looksLikeAnOrderRequest(text)) return 'customer_order_request';
  if (options.knownCustomer && !options.knownSupplier) return 'customer_message';
  return 'supplier_message';
}

/*
 * Is this the customer answering a question about their own order?
 *
 * StockChief asked which of four shoes somebody meant, they replied "the moc toe
 * slip in 36 please", and that reply arrived as an unrelated message: no
 * buying words in it, so nothing connected it to the order it completes. The
 * customer had answered and StockChief did not notice.
 *
 * A reply from the same person on the same thread as an order request that
 * never became an order is part of that request. Narrow deliberately — same
 * thread, same sender, and only while the order is still unmade — so an
 * ordinary "thanks, got them" on a finished order is not read as a new one.
 */
function continuesAnOrder(db, workspaceId, threadId, sender) {
  if (!threadId) return false;
  return Boolean(db.prepare(`SELECT 1 FROM connection_email_messages m
    WHERE m.workspace_id = ? AND m.external_thread_id = ?
      AND LOWER(m.sender) = LOWER(?)
      AND m.classification = 'customer_order_request'
      -- The conversation, not the message: the order hangs off whichever email
      -- finally completed it, so a thread that has produced one is finished.
      AND NOT EXISTS (SELECT 1 FROM sales_orders so
        JOIN connection_email_messages src ON src.id = so.source_email_message_id
        WHERE so.workspace_id = m.workspace_id AND src.external_thread_id = m.external_thread_id)
    LIMIT 1`).get(workspaceId, threadId, sender));
}

/** Is this address one of our customers? The identity is the address, not the name. */
function knownCustomer(db, workspaceId, sender) {
  return db.prepare(`SELECT id, name FROM customers
    WHERE workspace_id = ? AND LOWER(email) = ?`)
    .get(workspaceId, String(sender || '').toLowerCase()) || null;
}

/** A supplier address explicitly held on the supplier record. */
function knownSupplier(db, workspaceId, sender) {
  return db.prepare(`SELECT id, name FROM suppliers
    WHERE workspace_id = ? AND LOWER(email) = ?`)
    .get(workspaceId, String(sender || '').toLowerCase()) || null;
}

function capture(db, auth, event) {
  const data = event.data || {};
  const messageId = requireText(data.messageId || data.externalMessageId, 'Message id', { max: 240 });
  const sender = requireText(data.sender || data.from, 'Sender', { max: 254 }).toLowerCase();
  const existing = db.prepare(`SELECT id, trust_status FROM connection_email_messages
    WHERE workspace_id = ? AND connector_id = ? AND external_message_id = ?`)
    .get(auth.workspaceId, auth.connectorId, messageId);
  if (existing) return { actionType: 'email.message_captured', actionRecordId: existing.id,
    movementIds: [], skuIds: [] };

  const rule = matchingRule(db, auth, sender);
  const attachments = Array.isArray(data.attachments) ? data.attachments : [];
  const customer = knownCustomer(db, auth.workspaceId, sender);
  const supplier = knownSupplier(db, auth.workspaceId, sender)
    || (rule?.supplier_id
      ? db.prepare('SELECT id, name FROM suppliers WHERE workspace_id = ? AND id = ?')
        .get(auth.workspaceId, rule.supplier_id)
      : null);
  const threadId = trimOrNull(data.threadId || data.externalThreadId);
  let classification = rule?.document_mode === 'inventory_list' && attachments.length
    ? 'inventory_document'
    : classify(data.subject, data.bodyText || data.body, attachments,
      { knownSupplier: Boolean(supplier || rule), knownCustomer: Boolean(customer) });
  if (classification !== 'customer_order_request' && !supplier
    && continuesAnOrder(db, auth.workspaceId, threadId, sender)) {
    classification = 'customer_order_request';
  }
  const messageContentHash = crypto.createHash('sha256').update(JSON.stringify({ sender,
    subject: data.subject || null, body: data.bodyText || data.body || null,
    attachments: attachments.map((attachment) => ({ filename: attachment.filename,
      content: attachment.contentBase64 || attachment.extractedText || null })) })).digest('hex');
  const id = newId('emailmsg');
  const now = nowIso();
  /*
   * Whether a person is waiting on an answer is a separate question from what
   * document came out of this, so it is judged separately and says why.
   */
  const triage = replyTriage.judge({ sender, subject: data.subject,
    bodyText: data.bodyText || data.body, attachmentCount: attachments.length, classification,
    knownCounterparty: Boolean(customer || supplier) });
  db.prepare(`INSERT INTO connection_email_messages
    (id, workspace_id, connector_id, external_message_id, sender, recipients, subject, body_text,
     received_at, supplier_id, trust_status, classification, external_thread_id, internet_message_id,
     content_hash, reply_state, reply_reason, reply_state_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, auth.workspaceId, auth.connectorId, messageId, sender, JSON.stringify(data.recipients || data.to || []),
      trimOrNull(data.subject), trimOrNull(data.bodyText || data.body), event.occurredAt || now,
      supplier?.id || null, customer || supplier || rule ? 'TRUSTED' : 'UNTRUSTED', classification,
      threadId, trimOrNull(data.internetMessageId), messageContentHash,
      triage.state, triage.reason, now, now);

  for (const attachment of attachments) {
    const filename = requireText(attachment.filename, 'Attachment filename', { max: 240 });
    let content = null;
    if (attachment.contentBase64) {
      try { content = Buffer.from(attachment.contentBase64, 'base64'); } catch { throw new ValidationError(`Attachment ${filename} is not valid base64.`); }
      if (content.length > 20 * 1024 * 1024) throw new ValidationError(`Attachment ${filename} is larger than 20 MB.`);
    }
    const contentHash = crypto.createHash('sha256').update(content || Buffer.from(`${messageId}:${filename}`)).digest('hex');
    db.prepare(`INSERT OR IGNORE INTO connection_email_attachments
      (id, workspace_id, message_id, external_attachment_id, filename, mime_type, content_hash, content,
       extracted_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('emailatt'), auth.workspaceId, id, trimOrNull(attachment.id), filename,
        trimOrNull(attachment.mimeType), contentHash, content, trimOrNull(attachment.extractedText), now);
  }

  let evidence = null;
  if (rule?.document_mode === 'supplier_documents') {
    evidence = require('../purchasing/supplier-evidence').process(db, id, data.facts || {});
  }

  require('../attention/needs-you-count').invalidateNeedsYou(db, auth.workspaceId);

  // Purchasing evidence may change a PO expectation, cost history, or create a
  // decision. It never becomes a physical receipt here.
  return { actionType: evidence ? `supplier.${evidence.document_type}_processed` : `email.${classification}_captured`,
    actionRecordId: evidence?.id || id, movementIds: [], skuIds: [] };
}

module.exports = { matchingRule, classify, capture, looksLikeAnOrderRequest, knownCustomer, knownSupplier };

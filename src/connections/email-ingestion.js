'use strict';

const crypto = require('node:crypto');
const connections = require('./service');
const { ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');

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

function classify(subject, body, attachments) {
  const text = `${subject || ''} ${body || ''} ${(attachments || []).map((a) => a.filename).join(' ')}`.toLowerCase();
  if (/packing\s*slip|delivery\s*(confirmation|note)|proof\s*of\s*delivery/.test(text)) return 'delivery_document';
  if (/invoice|bill\b/.test(text)) return 'invoice';
  if (/purchase\s*order|\bpo\b/.test(text)) return 'purchase_order';
  return 'supplier_message';
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
  const classification = rule?.document_mode === 'inventory_list' && attachments.length
    ? 'inventory_document' : classify(data.subject, data.bodyText || data.body, attachments);
  const messageContentHash = crypto.createHash('sha256').update(JSON.stringify({ sender,
    subject: data.subject || null, body: data.bodyText || data.body || null,
    attachments: attachments.map((attachment) => ({ filename: attachment.filename,
      content: attachment.contentBase64 || attachment.extractedText || null })) })).digest('hex');
  const id = newId('emailmsg');
  const now = nowIso();
  db.prepare(`INSERT INTO connection_email_messages
    (id, workspace_id, connector_id, external_message_id, sender, recipients, subject, body_text,
     received_at, supplier_id, trust_status, classification, external_thread_id, internet_message_id,
     content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, auth.workspaceId, auth.connectorId, messageId, sender, JSON.stringify(data.recipients || data.to || []),
      trimOrNull(data.subject), trimOrNull(data.bodyText || data.body), event.occurredAt || now,
      rule && rule.supplier_id, rule ? 'TRUSTED' : 'UNTRUSTED', classification,
      trimOrNull(data.threadId || data.externalThreadId), trimOrNull(data.internetMessageId), messageContentHash, now);

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

  // Purchasing evidence may change a PO expectation, cost history, or create a
  // decision. It never becomes a physical receipt here.
  return { actionType: evidence ? `supplier.${evidence.document_type}_processed` : `email.${classification}_captured`,
    actionRecordId: evidence?.id || id, movementIds: [], skuIds: [] };
}

module.exports = { matchingRule, classify, capture };

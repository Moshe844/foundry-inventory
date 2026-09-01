'use strict';

const path = require('node:path');
const documentEvents = require('../manager/document-events');
const documentIntake = require('../foundry/document-intake');
const connections = require('./service');
const { NotFoundError, ValidationError } = require('../domain/errors');
const { nowIso } = require('../lib/util');

const SUPPORTED = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.tsv', '.txt']);

function attachment(db, workspaceId, connectorId, attachmentId) {
  const row = db.prepare(`SELECT a.*, m.connector_id, m.sender, m.subject, m.trust_status,
      m.external_message_id, m.processing_status
    FROM connection_email_attachments a
    JOIN connection_email_messages m ON m.id = a.message_id AND m.workspace_id = a.workspace_id
    WHERE a.workspace_id = ? AND m.connector_id = ? AND a.id = ?`)
    .get(workspaceId, connectorId, attachmentId);
  if (!row) throw new NotFoundError('That email attachment is no longer available.');
  if (row.trust_status !== 'TRUSTED') throw new ValidationError('Approve this sender before using its attachment as inventory evidence.');
  if (!row.content) throw new ValidationError('Foundry kept the attachment record, but the file content is unavailable.');
  if (!SUPPORTED.has(path.extname(row.filename).toLowerCase())) {
    throw new ValidationError('Use a PDF, spreadsheet, Word document, CSV, TSV, or text attachment.');
  }
  return row;
}

async function prepare(db, ctx, membership, connectorId, attachmentId, options = {}) {
  const row = attachment(db, ctx.workspaceId, connectorId, attachmentId);
  if (row.setup_document_id) {
    const existing = db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, row.setup_document_id);
    if (existing) return {
      understandingId: existing.understanding_id, replayed: true,
      alreadyApplied: existing.status === 'APPLIED',
      duplicate: row.processing_status === 'DUPLICATE_IGNORED',
      document: documentIntake.hydrate(existing),
    };
  }

  // The attachment hash is calculated when the provider message is captured.
  // Check it before OCR/model work so an exact resend has an immediate,
  // deterministic outcome and can never masquerade as a successful import.
  const sameFile = db.prepare(`SELECT * FROM setup_documents
    WHERE workspace_id = ? AND content_hash = ? ORDER BY created_at LIMIT 1`)
    .get(ctx.workspaceId, row.content_hash);
  if (sameFile) {
    const duplicate = sameFile.status === 'APPLIED';
    db.prepare('UPDATE connection_email_attachments SET setup_document_id = ? WHERE workspace_id = ? AND id = ?')
      .run(sameFile.id, ctx.workspaceId, row.id);
    db.prepare(`UPDATE connection_email_messages SET classification = ?, processing_status = ?, processed_at = ?
      WHERE workspace_id = ? AND id = ?`)
      .run(duplicate ? 'inventory_document_duplicate' : 'inventory_document',
        duplicate ? 'DUPLICATE_IGNORED' : 'AWAITING_INVENTORY_REVIEW',
        nowIso(), ctx.workspaceId, row.message_id);
    return { understandingId: sameFile.understanding_id, replayed: true,
      duplicate, alreadyApplied: duplicate, document: documentIntake.hydrate(sameFile) };
  }

  const file = { filename: row.filename, mimeType: row.mime_type, buffer: Buffer.from(row.content) };
  const understood = await documentEvents.understand(db, ctx, file, { provider: options.provider });
  if (!understood.interpretation.lines.length) {
    throw new ValidationError(`Foundry could not find inventory rows in ${row.filename}. Nothing was changed.`);
  }
  const prepared = documentIntake.prepareFromInterpretation(
    db, ctx, membership, file, understood.interpretation, understood.extractedText
  );
  db.prepare('UPDATE connection_email_attachments SET setup_document_id = ? WHERE workspace_id = ? AND id = ?')
    .run(prepared.document.id, ctx.workspaceId, row.id);
  const duplicate = prepared.replayed && prepared.document.status === 'APPLIED';
  db.prepare(`UPDATE connection_email_messages SET classification = ?,
    processing_status = ?, processed_at = ? WHERE workspace_id = ? AND id = ?`)
    .run(duplicate ? 'inventory_document_duplicate' : 'inventory_document',
      duplicate ? 'DUPLICATE_IGNORED' : 'AWAITING_INVENTORY_REVIEW',
      nowIso(), ctx.workspaceId, row.message_id);

  // A former purchasing classification for this same message is superseded by
  // the explicit human choice. Keep its audit row, but remove the false alarm.
  const documents = db.prepare('SELECT id FROM supplier_documents WHERE workspace_id = ? AND message_id = ?')
    .all(ctx.workspaceId, row.message_id);
  for (const document of documents) {
    db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
      WHERE workspace_id = ? AND fingerprint = ? AND status = 'OPEN'`)
      .run(nowIso(), nowIso(), ctx.workspaceId, `supplier-document:${document.id}`);
  }
  connections.resolveIssues(db, ctx.workspaceId, connectorId, 'SUPPLIER_DOCUMENT_REVIEW', row.external_message_id);
  return { understandingId: prepared.understandingId, replayed: prepared.replayed,
    duplicate, alreadyApplied: duplicate, document: prepared.document };
}

function reconcileStatuses(db, workspaceId, connectorId) {
  const now = nowIso();
  return db.transaction(() => {
    const applied = db.prepare(`UPDATE connection_email_messages SET classification = 'inventory_document',
      processing_status = 'INVENTORY_APPLIED', processed_at = COALESCE(processed_at, ?)
      WHERE workspace_id = ? AND connector_id = ? AND processing_status = 'AWAITING_INVENTORY_REVIEW'
        AND EXISTS (
          SELECT 1 FROM connection_email_attachments a
          JOIN setup_documents d ON d.id = a.setup_document_id AND d.workspace_id = a.workspace_id
          WHERE a.workspace_id = connection_email_messages.workspace_id
            AND a.message_id = connection_email_messages.id AND d.status = 'APPLIED'
        )`).run(now, workspaceId, connectorId).changes;

    // A later resend may have been classified as purchasing before Foundry
    // noticed that the exact file was already approved as inventory. Close the
    // false purchasing review while preserving both email and audit records.
    const duplicates = db.prepare(`SELECT DISTINCT sd.id, sd.message_id
      FROM supplier_documents sd
      JOIN connection_email_attachments a ON a.id = sd.attachment_id
      WHERE sd.workspace_id = ? AND sd.connector_id = ? AND sd.status = 'NEEDS_REVIEW'
        AND EXISTS (SELECT 1 FROM setup_documents d
          WHERE d.workspace_id = sd.workspace_id AND d.content_hash = a.content_hash AND d.status = 'APPLIED')`)
      .all(workspaceId, connectorId);
    for (const duplicate of duplicates) {
      db.prepare(`UPDATE connection_email_attachments SET setup_document_id = (
          SELECT d.id FROM setup_documents d
          WHERE d.workspace_id = connection_email_attachments.workspace_id
            AND d.content_hash = connection_email_attachments.content_hash AND d.status = 'APPLIED'
          ORDER BY d.created_at LIMIT 1)
        WHERE workspace_id = ? AND message_id = ? AND setup_document_id IS NULL`)
        .run(workspaceId, duplicate.message_id);
      db.prepare("UPDATE supplier_documents SET status = 'IGNORED', processed_at = ? WHERE id = ? AND workspace_id = ?")
        .run(now, duplicate.id, workspaceId);
      db.prepare(`UPDATE connection_email_messages SET classification = 'inventory_document_duplicate',
        processing_status = 'DUPLICATE_IGNORED', processed_at = ? WHERE id = ? AND workspace_id = ?`)
        .run(now, duplicate.message_id, workspaceId);
      db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
        WHERE workspace_id = ? AND connector_id = ? AND fingerprint = ? AND status = 'OPEN'`)
        .run(now, now, workspaceId, connectorId, `supplier-document:${duplicate.id}`);
    }
    return applied;
  })();
}

module.exports = { SUPPORTED, attachment, prepare, reconcileStatuses };

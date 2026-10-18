ALTER TABLE accounting_supplier_bills ADD COLUMN charges JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE accounting_supplier_bills ADD COLUMN document_total_minor BIGINT;
ALTER TABLE accounting_supplier_bills ADD COLUMN source_message_id TEXT;
ALTER TABLE accounting_supplier_bills ADD COLUMN source_attachment_hash TEXT;
ALTER TABLE accounting_supplier_bills ADD COLUMN document_fingerprint TEXT;
ALTER TABLE accounting_supplier_bills ADD COLUMN invoice_input JSONB;
ALTER TABLE accounting_supplier_bills ADD COLUMN review_revision INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX supplier_invoice_document_number ON accounting_supplier_bills(workspace_id,supplier_id,lower(supplier_invoice_number))
 WHERE supplier_invoice_number IS NOT NULL AND status<>'VOID' AND document_fingerprint IS NOT NULL;

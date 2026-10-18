ALTER TABLE connection_email_attachments ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'PENDING'
 CHECK(extraction_status IN ('PENDING','READABLE','NEEDS_REVIEW'));
ALTER TABLE connection_email_attachments ADD COLUMN extraction_error TEXT;

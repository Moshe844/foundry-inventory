-- Files a customer or StockChief support attaches to a support conversation:
-- screenshots, photos, PDFs and spreadsheets. message_id is NULL for files sent
-- with the conversation's first message, which is stored on support_requests.
CREATE TABLE support_attachments(
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
 message_id TEXT REFERENCES support_messages(id) ON DELETE CASCADE,
 author_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
 file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 180),
 content_type TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=10485760),
 sha256 TEXT NOT NULL,
 content BYTEA NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_attachments_request ON support_attachments(request_id,created_at,id);
CREATE INDEX support_attachments_author ON support_attachments(author_account_id,created_at);

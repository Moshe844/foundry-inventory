ALTER TABLE stockchief_runtime.email_reply_outbox
  DROP CONSTRAINT IF EXISTS email_reply_outbox_status_check;

ALTER TABLE stockchief_runtime.email_reply_outbox
  ADD CONSTRAINT email_reply_outbox_status_check
  CHECK (status IN ('PENDING','SENDING','SENT','FAILED','AMBIGUOUS'));

DROP INDEX IF EXISTS stockchief_runtime.email_reply_outbox_recovery;

CREATE INDEX email_reply_outbox_recovery
  ON stockchief_runtime.email_reply_outbox(status,started_at)
  WHERE status IN ('PENDING','SENDING');

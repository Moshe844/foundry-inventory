-- Previous PostgreSQL mail intake inserted a generic holding draft before it
-- had read the message. Clear only unsent machine-generated holding drafts;
-- preserve owner edits and verified sent correspondence.
UPDATE connection_email_messages
SET draft_subject = NULL,
    draft_body = NULL,
    draft_source = NULL,
    draft_at = NULL,
    draft_rejected_because = NULL
WHERE draft_source = 'records'
  AND reply_sent_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM stockchief_runtime.email_reply_outbox outbox
    WHERE outbox.workspace_id = connection_email_messages.workspace_id
      AND outbox.message_id = connection_email_messages.id);

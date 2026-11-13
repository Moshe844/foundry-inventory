ALTER TABLE stockchief_runtime.report_templates
  ADD COLUMN use_chosen_mailbox boolean NOT NULL DEFAULT false;

UPDATE stockchief_runtime.report_templates
SET use_chosen_mailbox=true
WHERE cardinality(recipient_user_ids)>0 OR attachment_format='pdf';

ALTER TABLE connection_email_messages ADD COLUMN native_review_goal_id TEXT;
ALTER TABLE connection_email_messages ADD COLUMN native_review_state TEXT;
ALTER TABLE connection_email_messages ADD COLUMN native_review_reason TEXT;
ALTER TABLE connection_email_messages ADD CONSTRAINT native_mail_goal FOREIGN KEY(native_review_goal_id) REFERENCES stockchief_runtime.assistant_goals(id);

-- Job 111: the owner's return policy for returns created from customer email.
-- A request outside the return window, or worth more than the owner's
-- high-value limit, stops and asks instead of becoming an RMA on its own.
ALTER TABLE stockchief_runtime.agent_return_email_settings
 ADD COLUMN window_days integer CHECK(window_days BETWEEN 1 AND 3650),
 ADD COLUMN review_above_minor bigint CHECK(review_above_minor>0),
 ADD COLUMN currency text CHECK(currency ~ '^[A-Z]{3}$'),
 ADD CHECK((review_above_minor IS NULL)=(currency IS NULL));

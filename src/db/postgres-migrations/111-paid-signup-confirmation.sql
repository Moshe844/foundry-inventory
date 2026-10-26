ALTER TABLE commercial_checkout_attempts ADD COLUMN paid_at TIMESTAMPTZ;
ALTER TABLE commercial_checkout_attempts ADD COLUMN paid_provider_event_id TEXT;

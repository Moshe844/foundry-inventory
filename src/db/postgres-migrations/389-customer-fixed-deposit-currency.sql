ALTER TABLE customer_payment_terms ADD COLUMN deposit_currency text
  CHECK (deposit_currency IS NULL OR (deposit_minor IS NOT NULL AND deposit_currency ~ '^[A-Z]{3}$'));

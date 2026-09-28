ALTER TABLE commercial_plans ADD COLUMN packaging_reviewed_at TIMESTAMPTZ;

UPDATE commercial_plans
SET packaging_reviewed_at=now(),updated_at=now()
WHERE id IN ('starter','growth','pro','enterprise');

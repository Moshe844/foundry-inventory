-- Job 113: a return disposition rule may cover any product and add the owner's
-- conditions beyond the physical condition: words in the customer's return
-- reason, a highest goods value, a longest time since the goods left and the
-- fewest days left before their batch expires. The most specific rule decides.
ALTER TABLE stockchief_runtime.agent_return_disposition_rules
 ALTER COLUMN sku_id DROP NOT NULL,
 ADD COLUMN reason_contains text CHECK(reason_contains IS NULL OR length(reason_contains) BETWEEN 1 AND 200),
 ADD COLUMN maximum_value_minor bigint CHECK(maximum_value_minor>0),
 ADD COLUMN value_currency text CHECK(value_currency ~ '^[A-Z]{3}$'),
 ADD COLUMN maximum_age_days integer CHECK(maximum_age_days BETWEEN 0 AND 3650),
 ADD COLUMN minimum_expiry_days integer CHECK(minimum_expiry_days BETWEEN 0 AND 3650),
 ADD COLUMN criteria_key text NOT NULL DEFAULT '',
 ADD CHECK((maximum_value_minor IS NULL)=(value_currency IS NULL));
DO $$
DECLARE name text;
BEGIN
 SELECT conname INTO name FROM pg_constraint
  WHERE conrelid='stockchief_runtime.agent_return_disposition_rules'::regclass AND contype='u';
 IF name IS NOT NULL THEN
  EXECUTE 'ALTER TABLE stockchief_runtime.agent_return_disposition_rules DROP CONSTRAINT '||quote_ident(name);
 END IF;
END $$;
CREATE UNIQUE INDEX agent_disposition_rule_scope ON stockchief_runtime.agent_return_disposition_rules(workspace_id,(coalesce(sku_id,'')),condition_code,criteria_key);

CREATE TABLE commercial_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_name TEXT NOT NULL,
  outcome TEXT NOT NULL,
  audience TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED')),
  is_public BIGINT NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  is_recommended BIGINT NOT NULL DEFAULT 0 CHECK (is_recommended IN (0,1)),
  sales_only BIGINT NOT NULL DEFAULT 0 CHECK (sales_only IN (0,1)),
  display_order BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  monthly_amount_minor BIGINT,
  annual_amount_minor BIGINT,
  stripe_monthly_price_id TEXT,
  stripe_annual_price_id TEXT,
  trial_days BIGINT NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
  grace_days BIGINT NOT NULL DEFAULT 7 CHECK (grace_days >= 0),
  packaging_status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (packaging_status IN ('PROPOSED','APPROVED')),
  packaging_approved_at TIMESTAMPTZ,
  packaging_approved_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commercial_plan_entitlements (
  plan_id TEXT NOT NULL REFERENCES commercial_plans(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  enabled BIGINT NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  configuration JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY(plan_id, capability)
);

CREATE TABLE commercial_plan_meters (
  plan_id TEXT NOT NULL REFERENCES commercial_plans(id) ON DELETE CASCADE,
  meter TEXT NOT NULL,
  label TEXT NOT NULL,
  included_units BIGINT,
  hard_limit BIGINT,
  overage_block_units BIGINT,
  overage_amount_minor BIGINT,
  PRIMARY KEY(plan_id, meter),
  CHECK (included_units IS NULL OR included_units >= 0),
  CHECK (hard_limit IS NULL OR hard_limit >= 0),
  CHECK (overage_block_units IS NULL OR overage_block_units > 0),
  CHECK (overage_amount_minor IS NULL OR overage_amount_minor >= 0)
);

CREATE TABLE account_subscriptions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES commercial_plans(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING','TRIALING','ACTIVE','GRACE','PAST_DUE','SUSPENDED','CANCELLED','COMP')),
  billing_interval TEXT CHECK (billing_interval IN ('MONTHLY','ANNUAL','CUSTOM')),
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  grace_ends_at TIMESTAMPTZ,
  cancel_at_period_end BIGINT NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  cancelled_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'SELF_SERVICE',
  provider_state JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commercial_entitlement_overrides (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  capability TEXT,
  meter TEXT,
  enabled BIGINT CHECK (enabled IN (0,1)),
  limit_units BIGINT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'ADMIN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (account_id IS NOT NULL OR workspace_id IS NOT NULL),
  CHECK ((capability IS NOT NULL) <> (meter IS NOT NULL))
);
CREATE INDEX commercial_overrides_account ON commercial_entitlement_overrides(account_id, starts_at, ends_at);
CREATE INDEX commercial_overrides_workspace ON commercial_entitlement_overrides(workspace_id, starts_at, ends_at);

CREATE TABLE commercial_usage_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  meter TEXT NOT NULL,
  units BIGINT NOT NULL CHECK (units > 0),
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail JSONB NOT NULL DEFAULT '{}',
  UNIQUE(account_id, meter, idempotency_key)
);
CREATE INDEX commercial_usage_period ON commercial_usage_events(account_id, meter, occurred_at);

CREATE TABLE commercial_checkout_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES commercial_plans(id),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('MONTHLY','ANNUAL')),
  stripe_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','OPEN','COMPLETED','EXPIRED','FAILED')),
  return_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commercial_billing_events (
  provider_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  payload JSONB NOT NULL,
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE commercial_overage_charges (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES account_subscriptions(id) ON DELETE CASCADE,
  meter TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  overage_units BIGINT NOT NULL CHECK (overage_units > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CHARGING','CHARGED','BILLED','FAILED')),
  stripe_invoice_item_id TEXT UNIQUE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,meter,period_start,period_end)
);
CREATE INDEX commercial_overage_pending ON commercial_overage_charges(status,created_at);

CREATE TABLE commercial_promo_codes (
  code TEXT PRIMARY KEY,
  active BIGINT NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  plan_id TEXT REFERENCES commercial_plans(id),
  trial_days BIGINT,
  discount_percent BIGINT CHECK (discount_percent BETWEEN 0 AND 100),
  stripe_promotion_code_id TEXT,
  redemption_limit BIGINT,
  redeemed_count BIGINT NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE commercial_checkout_attempts ADD COLUMN promo_code TEXT REFERENCES commercial_promo_codes(code);
ALTER TABLE commercial_checkout_attempts ADD COLUMN promo_status TEXT
  CHECK (promo_status IN ('RESERVED','REDEEMED','RELEASED'));

CREATE TABLE account_email_verifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_business_name TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_commercial_plan_id TEXT REFERENCES commercial_plans(id);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_billing_interval TEXT
  CHECK (pending_billing_interval IN ('MONTHLY','ANNUAL'));
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS pending_promo_code TEXT;
UPDATE accounts SET email_verified_at=created_at::timestamptz WHERE email_verified_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_membership ON users(workspace_id,account_id);

CREATE TABLE workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','staff','accountant')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_invitation_pending ON workspace_invitations(workspace_id,email) WHERE status='PENDING';

CREATE TABLE commercial_funnel_events (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  anonymous_id TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES commercial_plans(id) ON DELETE SET NULL,
  source_path TEXT,
  detail JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commercial_funnel_event_time ON commercial_funnel_events(event_name, occurred_at);
CREATE UNIQUE INDEX commercial_funnel_account_milestone ON commercial_funnel_events(account_id,event_name)
WHERE account_id IS NOT NULL AND event_name IN ('signup_completed','first_workspace_setup_completed',
  'subscription_activated','first_integration_connected','first_meaningful_stockchief_action');

CREATE TABLE commercial_admin_accounts (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by TEXT NOT NULL
);

INSERT INTO commercial_plans(id,name,public_name,outcome,audience,status,is_public,is_recommended,sales_only,display_order,currency,monthly_amount_minor,annual_amount_minor)
VALUES
  ('starter','Starter','Starter','StockChief helps you manage inventory with one reliable operating system.','Businesses replacing spreadsheets and disconnected inventory tools.','ACTIVE',1,0,0,10,'USD',19900,199000),
  ('growth','Growth','Growth','StockChief handles a meaningful share of routine operations for you.','Growing businesses ready to automate communication, shipping and follow-through.','ACTIVE',1,1,0,20,'USD',49900,499000),
  ('pro','Pro','Pro','StockChief runs most inventory operations while you manage the exceptions.','Multi-location operators needing higher autonomy, intelligence and volume.','ACTIVE',1,0,0,30,'USD',99900,999000),
  ('enterprise','Enterprise','Enterprise','StockChief operates at scale with tailored controls, integrations and support.','Complex or high-volume operations with custom security and commercial requirements.','ACTIVE',1,0,1,40,'USD',NULL,NULL)
ON CONFLICT(id) DO NOTHING;

INSERT INTO commercial_plan_entitlements(plan_id,capability)
SELECT plan_id,capability FROM (VALUES
  ('starter','inventory.core'),('starter','sales_orders'),('starter','purchasing'),('starter','suppliers'),
  ('starter','receiving.manual'),('starter','replenishment.basic'),('starter','accounting.basic'),
  ('starter','ask_stockchief'),('starter','merchant_payments'),('starter','shipping.workflow'),('starter','needs_you'),
  ('growth','inventory.core'),('growth','sales_orders'),('growth','purchasing'),('growth','suppliers'),
  ('growth','receiving.manual'),('growth','replenishment.basic'),('growth','accounting.basic'),
  ('growth','ask_stockchief'),('growth','merchant_payments'),('growth','shipping.workflow'),('growth','needs_you'),
  ('growth','connection.email'),('growth','email.auto_extract'),('growth','documents.process'),
  ('growth','connection.commerce'),('growth','connection.accounting'),
  ('growth','email.response_generation'),('growth','shipping.automation'),('growth','accounting.explanations'),
  ('growth','forecasting.basic'),
  ('pro','inventory.core'),('pro','sales_orders'),('pro','purchasing'),('pro','suppliers'),
  ('pro','receiving.manual'),('pro','replenishment.basic'),('pro','accounting.basic'),('pro','ask_stockchief'),
  ('pro','merchant_payments'),('pro','shipping.workflow'),('pro','needs_you'),('pro','connection.email'),
  ('pro','connection.commerce'),('pro','connection.accounting'),
  ('pro','email.auto_extract'),('pro','documents.process'),('pro','email.response_generation'),
  ('pro','shipping.automation'),('pro','accounting.explanations'),('pro','forecasting.basic'),
  ('pro','authority.advanced'),('pro','support.priority'),
  ('enterprise','inventory.core'),('enterprise','sales_orders'),('enterprise','purchasing'),('enterprise','suppliers'),
  ('enterprise','receiving.manual'),('enterprise','replenishment.basic'),('enterprise','accounting.basic'),
  ('enterprise','ask_stockchief'),('enterprise','merchant_payments'),('enterprise','shipping.workflow'),
  ('enterprise','needs_you'),('enterprise','connection.email'),('enterprise','email.auto_extract'),
  ('enterprise','connection.commerce'),('enterprise','connection.accounting'),
  ('enterprise','documents.process'),('enterprise','email.response_generation'),
  ('enterprise','shipping.automation'),('enterprise','accounting.explanations'),
  ('enterprise','forecasting.basic'),('enterprise','authority.advanced'),('enterprise','support.priority'),
  ('enterprise','integrations.custom')
) AS proposed(plan_id,capability)
ON CONFLICT(plan_id,capability) DO NOTHING;

INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_block_units,overage_amount_minor)
VALUES
  ('starter','workspaces','Inventories',1,1,NULL,NULL),('starter','members','People',3,3,NULL,NULL),
  ('starter','locations','Locations',3,3,NULL,NULL),('starter','connections','Connections',2,2,NULL,NULL),
  ('starter','processing_units','Business emails and document pages processed',100,100,NULL,NULL),
  ('starter','external_events','External orders and operating events',500,500,NULL,NULL),
  ('growth','workspaces','Inventories',3,3,NULL,NULL),('growth','members','People',15,15,NULL,NULL),
  ('growth','locations','Locations',10,10,NULL,NULL),('growth','connections','Connections',8,8,NULL,NULL),
  ('growth','processing_units','Business emails and document pages processed',1000,NULL,1000,7500),
  ('growth','external_events','External orders and operating events',10000,NULL,5000,5000),
  ('pro','workspaces','Inventories',10,10,NULL,NULL),('pro','members','People',50,50,NULL,NULL),
  ('pro','locations','Locations',50,50,NULL,NULL),('pro','connections','Connections',25,25,NULL,NULL),
  ('pro','processing_units','Business emails and document pages processed',5000,NULL,1000,5000),
  ('pro','external_events','External orders and operating events',100000,NULL,10000,4000),
  ('enterprise','workspaces','Inventories',NULL,NULL,NULL,NULL),('enterprise','members','People',NULL,NULL,NULL,NULL),
  ('enterprise','locations','Locations',NULL,NULL,NULL,NULL),('enterprise','connections','Connections',NULL,NULL,NULL,NULL),
  ('enterprise','processing_units','Business emails and document pages processed',NULL,NULL,NULL,NULL),
  ('enterprise','external_events','External orders and operating events',NULL,NULL,NULL,NULL)
ON CONFLICT(plan_id,meter) DO NOTHING;

INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source)
SELECT 'sub_'||substr(md5(account.id||account.created_at),1,24),account.id,'pro','COMP','CUSTOM','GRANDFATHERED'
FROM accounts account
ON CONFLICT(account_id) DO NOTHING;

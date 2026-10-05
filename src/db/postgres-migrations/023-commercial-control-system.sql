CREATE TABLE commercial_capabilities (
  capability TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  readiness TEXT NOT NULL CHECK (readiness IN ('SELLABLE','CONDITIONAL','DISABLED')),
  variable_cost BIGINT NOT NULL DEFAULT 0 CHECK (variable_cost IN (0,1)),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO commercial_capabilities(capability,label,category,readiness,variable_cost)
VALUES
('identity.core','Identity and account security','foundation','SELLABLE',0),
('workspace.core','Workspaces and team access','foundation','SELLABLE',0),
('inventory.core','Products, SKUs and inventory ledger','inventory','SELLABLE',0),
('inventory.multi_location','Multi-location inventory','inventory','SELLABLE',0),
('inventory.lot_serial','Lot and serial tracking','inventory','SELLABLE',0),
('inventory.counts','Physical counts and reconciliation','inventory','SELLABLE',0),
('inventory.transfers','Inventory transfers','inventory','SELLABLE',0),
('inventory.kits','Kits and bills of material','inventory','DISABLED',0),
('purchasing.core','Purchasing and purchase orders','purchasing','SELLABLE',0),
('purchasing.suppliers','Suppliers and supplier SKUs','purchasing','SELLABLE',0),
('purchasing.invoices','Supplier invoices and payables','purchasing','SELLABLE',1),
('receiving.core','Purchase receiving','purchasing','SELLABLE',0),
('sales_orders.core','Sales orders and commitments','sales','SELLABLE',0),
('fulfillment.core','Fulfillment and reservations','sales','SELLABLE',0),
('returns.core','Customer and supplier returns','sales','SELLABLE',0),
('shipping.workflow','Manual shipping workflow','shipping','SELLABLE',0),
('shipping.rates','Carrier rates','shipping','CONDITIONAL',1),
('shipping.labels','Carrier labels','shipping','CONDITIONAL',1),
('shipping.tracking','Shipment tracking','shipping','CONDITIONAL',1),
('shipping.automation','Automated shipping within authority','shipping','CONDITIONAL',1),
('payments.customer','Merchant customer payments','payments','CONDITIONAL',1),
('accounting.core','Operational accounting ledger','accounting','SELLABLE',0),
('accounting.reports','Accounting reports','accounting','SELLABLE',0),
('accounting.sync','QuickBooks and Xero synchronization','accounting','CONDITIONAL',1),
('accounting.explanations','Evidence-backed accounting explanations','accounting','SELLABLE',1),
('ask.lookup','Ask StockChief business questions','intelligence','SELLABLE',1),
('ask.prepare_actions','Ask StockChief prepared actions','intelligence','SELLABLE',1),
('communications.email_ingestion','Business mailbox monitoring','communications','CONDITIONAL',1),
('communications.ai_drafts','AI communication drafts','communications','SELLABLE',1),
('communications.send_approved','Approved email sending','communications','CONDITIONAL',1),
('communications.auto_send','Automatic sending within authority','communications','CONDITIONAL',1),
('connections.commerce','Commerce connections','connections','CONDITIONAL',1),
('connections.accounting','Accounting connections','connections','CONDITIONAL',1),
('connections.custom_api','Custom API and event feeds','connections','SELLABLE',1),
('imports.spreadsheet','Spreadsheet import with preview','migration','SELLABLE',0),
('documents.extraction','Document and page extraction','migration','DISABLED',1),
('migration.assisted','Assisted system migration','migration','CONDITIONAL',1),
('planning.basic','Demand and stockout planning','planning','SELLABLE',1),
('planning.transfer_before_buy','Transfer-before-buy optimization','planning','SELLABLE',1),
('automation.transfers','Automatic transfers within authority','automation','SELLABLE',1),
('automation.purchasing','Automatic purchasing within authority','automation','SELLABLE',1),
('authority.advanced','Advanced authority policies','automation','SELLABLE',1),
('adaptive_optimization','Adaptive optimization','planning','DISABLED',1),
('operations.alerts','Operational alerts and Needs You','operations','SELLABLE',1),
('support.priority','Priority support','support','SELLABLE',1),
('integrations.custom','Custom integrations','connections','CONDITIONAL',1),
('api.public','Public API','connections','SELLABLE',1),
('sales_orders','Sales orders compatibility key','compatibility','SELLABLE',0),
('purchasing','Purchasing compatibility key','compatibility','SELLABLE',0),
('suppliers','Suppliers compatibility key','compatibility','SELLABLE',0),
('receiving.manual','Receiving compatibility key','compatibility','SELLABLE',0),
('replenishment.basic','Replenishment compatibility key','compatibility','SELLABLE',1),
('accounting.basic','Accounting compatibility key','compatibility','SELLABLE',0),
('ask_stockchief','Ask compatibility key','compatibility','SELLABLE',1),
('merchant_payments','Merchant payments compatibility key','compatibility','CONDITIONAL',1),
('needs_you','Needs You compatibility key','compatibility','SELLABLE',0),
('connection.email','Email connection compatibility key','compatibility','CONDITIONAL',1),
('connection.commerce','Commerce connection compatibility key','compatibility','CONDITIONAL',1),
('connection.accounting','Accounting connection compatibility key','compatibility','CONDITIONAL',1),
('email.auto_extract','Email extraction compatibility key','compatibility','CONDITIONAL',1),
('email.response_generation','AI reply compatibility key','compatibility','SELLABLE',1),
('documents.process','Document processing compatibility key','compatibility','DISABLED',1),
('forecasting.basic','Forecasting compatibility key','compatibility','SELLABLE',1)
ON CONFLICT(capability) DO UPDATE SET label=EXCLUDED.label,category=EXCLUDED.category,
  readiness=EXCLUDED.readiness,variable_cost=EXCLUDED.variable_cost,updated_at=now();

ALTER TABLE commercial_plan_entitlements
  ADD CONSTRAINT commercial_plan_entitlement_registered
  FOREIGN KEY(capability) REFERENCES commercial_capabilities(capability) NOT VALID;

CREATE TABLE commercial_meter_definitions (
  meter TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('STRUCTURAL','USAGE')),
  customer_visible BIGINT NOT NULL DEFAULT 1 CHECK (customer_visible IN (0,1)),
  critical_access BIGINT NOT NULL DEFAULT 0 CHECK (critical_access IN (0,1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO commercial_meter_definitions(meter,label,kind,customer_visible,critical_access)
VALUES
('workspaces','Inventories','STRUCTURAL',1,1),('members','People','STRUCTURAL',1,1),
('locations','Locations','STRUCTURAL',1,1),('connections','Connections','STRUCTURAL',1,1),
('business_communications','Business communications processed','USAGE',1,0),
('document_pages','Document pages processed','USAGE',1,0),
('intelligent_operations','StockChief intelligent operations','USAGE',1,0),
('external_events','External orders and operating events','USAGE',1,0),
('shipments_managed','Shipments managed','USAGE',1,0),
('automatic_actions','Automatic actions completed','USAGE',1,0),
('accounting_syncs','Accounting synchronization runs','USAGE',1,0),
('api_events','API events processed','USAGE',1,0),
('processing_units','Legacy business processing units','USAGE',0,0)
ON CONFLICT(meter) DO UPDATE SET label=EXCLUDED.label,kind=EXCLUDED.kind,
  customer_visible=EXCLUDED.customer_visible,critical_access=EXCLUDED.critical_access;

ALTER TABLE commercial_plan_meters
  ADD CONSTRAINT commercial_plan_meter_registered
  FOREIGN KEY(meter) REFERENCES commercial_meter_definitions(meter) NOT VALID;
ALTER TABLE commercial_plan_meters ADD COLUMN overage_mode TEXT NOT NULL DEFAULT 'PAUSE'
  CHECK (overage_mode IN ('PAUSE','BILL','PURCHASE','CONTRACT'));
ALTER TABLE commercial_plan_meters ADD COLUMN warning_thresholds JSONB NOT NULL DEFAULT '[80,95,100]'::jsonb;

ALTER TABLE commercial_usage_events ADD COLUMN status TEXT NOT NULL DEFAULT 'COMMITTED'
  CHECK (status IN ('RESERVED','COMMITTED','REVERSED'));
ALTER TABLE commercial_usage_events ADD COLUMN reserved_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE commercial_usage_events ADD COLUMN committed_at TIMESTAMPTZ;
ALTER TABLE commercial_usage_events ADD COLUMN reversed_at TIMESTAMPTZ;
ALTER TABLE commercial_usage_events ADD COLUMN estimated_variable_cost_minor NUMERIC(20,6) NOT NULL DEFAULT 0;
ALTER TABLE commercial_usage_events ADD COLUMN cost_rate_version TEXT;
UPDATE commercial_usage_events SET committed_at=COALESCE(committed_at,occurred_at) WHERE status='COMMITTED';
CREATE INDEX commercial_usage_capacity ON commercial_usage_events(account_id,meter,status,occurred_at);

CREATE TABLE commercial_cost_rates (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  unit TEXT NOT NULL,
  cost_per_unit_minor NUMERIC(20,8) NOT NULL CHECK (cost_per_unit_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,
  source TEXT NOT NULL,
  created_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider,operation,unit,effective_from)
);

CREATE TABLE commercial_cost_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  operation TEXT NOT NULL,
  unit TEXT NOT NULL,
  quantity NUMERIC(20,8) NOT NULL CHECK (quantity >= 0),
  amount_minor NUMERIC(20,6) NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  idempotency_key TEXT NOT NULL,
  rate_id TEXT REFERENCES commercial_cost_rates(id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,provider,operation,idempotency_key)
);
CREATE INDEX commercial_cost_period ON commercial_cost_events(account_id,occurred_at);

CREATE TABLE commercial_plan_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES commercial_plans(id) ON DELETE CASCADE,
  version_number BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  currency TEXT NOT NULL,
  monthly_amount_minor BIGINT,
  annual_amount_minor BIGINT,
  entitlements JSONB NOT NULL,
  meters JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  approved_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(plan_id,version_number)
);
ALTER TABLE account_subscriptions ADD COLUMN plan_version_id TEXT REFERENCES commercial_plan_versions(id);

INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'planver_'||plan.id||'_1',plan.id,1,'ACTIVE',plan.currency,plan.monthly_amount_minor,plan.annual_amount_minor,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('capability',entitlement.capability,'enabled',entitlement.enabled,
    'configuration',entitlement.configuration) ORDER BY entitlement.capability)
    FROM commercial_plan_entitlements entitlement WHERE entitlement.plan_id=plan.id),'[]'::jsonb),
  COALESCE((SELECT jsonb_agg(to_jsonb(policy) ORDER BY policy.meter)
    FROM commercial_plan_meters policy WHERE policy.plan_id=plan.id),'[]'::jsonb)
FROM commercial_plans plan ON CONFLICT(plan_id,version_number) DO NOTHING;
UPDATE account_subscriptions subscription SET plan_version_id=version.id
FROM commercial_plan_versions version WHERE version.plan_id=subscription.plan_id AND version.status='ACTIVE'
  AND subscription.plan_version_id IS NULL;

CREATE TABLE commercial_change_audit (
  id TEXT PRIMARY KEY,
  actor_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  reason TEXT,
  source_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX commercial_change_audit_subject ON commercial_change_audit(subject_type,subject_id,created_at DESC);

CREATE TABLE commercial_usage_notifications (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  meter TEXT NOT NULL REFERENCES commercial_meter_definitions(meter),
  period_start TIMESTAMPTZ NOT NULL,
  threshold BIGINT NOT NULL CHECK (threshold IN (80,95,100)),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id,meter,period_start,threshold)
);

CREATE TABLE commercial_subscription_changes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES account_subscriptions(id) ON DELETE CASCADE,
  from_plan_id TEXT NOT NULL REFERENCES commercial_plans(id),
  to_plan_id TEXT NOT NULL REFERENCES commercial_plans(id),
  status TEXT NOT NULL CHECK (status IN ('QUOTED','PENDING','APPLIED','CANCELLED','BLOCKED')),
  effective_at TIMESTAMPTZ,
  proration_amount_minor BIGINT,
  resource_excess JSONB NOT NULL DEFAULT '{}',
  provider_reference TEXT,
  requested_by_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE commercial_billing_events ADD COLUMN provider_created_at TIMESTAMPTZ;
ALTER TABLE account_subscriptions ADD COLUMN last_provider_event_created_at TIMESTAMPTZ;
ALTER TABLE commercial_plans ADD COLUMN target_contribution_margin_bps BIGINT NOT NULL DEFAULT 7500
  CHECK (target_contribution_margin_bps BETWEEN 0 AND 10000);

INSERT INTO commercial_plan_entitlements(plan_id,capability,enabled,configuration)
SELECT plan_id,capability,enabled,configuration FROM (VALUES
('starter','inventory.multi_location',1,'{}'::jsonb),('starter','inventory.lot_serial',1,'{}'::jsonb),
('starter','inventory.counts',1,'{}'::jsonb),('starter','inventory.transfers',1,'{}'::jsonb),
('starter','purchasing.core',1,'{}'::jsonb),('starter','purchasing.suppliers',1,'{}'::jsonb),
('starter','purchasing.invoices',1,'{}'::jsonb),('starter','receiving.core',1,'{}'::jsonb),
('starter','sales_orders.core',1,'{}'::jsonb),('starter','fulfillment.core',1,'{}'::jsonb),
('starter','returns.core',1,'{}'::jsonb),('starter','accounting.core',1,'{}'::jsonb),
('starter','accounting.reports',1,'{}'::jsonb),('starter','ask.lookup',1,'{}'::jsonb),
('starter','ask.prepare_actions',1,'{"approvalRequired":true}'::jsonb),
('starter','imports.spreadsheet',1,'{}'::jsonb),('starter','operations.alerts',1,'{}'::jsonb),
('growth','inventory.multi_location',1,'{}'::jsonb),('growth','inventory.lot_serial',1,'{}'::jsonb),
('growth','inventory.counts',1,'{}'::jsonb),('growth','inventory.transfers',1,'{}'::jsonb),
('growth','purchasing.core',1,'{}'::jsonb),('growth','purchasing.suppliers',1,'{}'::jsonb),
('growth','purchasing.invoices',1,'{}'::jsonb),('growth','receiving.core',1,'{}'::jsonb),
('growth','sales_orders.core',1,'{}'::jsonb),('growth','fulfillment.core',1,'{}'::jsonb),
('growth','returns.core',1,'{}'::jsonb),('growth','accounting.core',1,'{}'::jsonb),
('growth','accounting.reports',1,'{}'::jsonb),('growth','ask.lookup',1,'{}'::jsonb),
('growth','ask.prepare_actions',1,'{}'::jsonb),('growth','communications.ai_drafts',1,'{}'::jsonb),
('growth','planning.basic',1,'{}'::jsonb),('growth','planning.transfer_before_buy',1,'{}'::jsonb),
('growth','automation.transfers',1,'{"approvalRequired":true}'::jsonb),
('growth','automation.purchasing',1,'{"approvalRequired":true}'::jsonb),
('growth','imports.spreadsheet',1,'{}'::jsonb),('growth','operations.alerts',1,'{}'::jsonb),
('pro','inventory.multi_location',1,'{}'::jsonb),('pro','inventory.lot_serial',1,'{}'::jsonb),
('pro','inventory.counts',1,'{}'::jsonb),('pro','inventory.transfers',1,'{}'::jsonb),
('pro','purchasing.core',1,'{}'::jsonb),('pro','purchasing.suppliers',1,'{}'::jsonb),
('pro','purchasing.invoices',1,'{}'::jsonb),('pro','receiving.core',1,'{}'::jsonb),
('pro','sales_orders.core',1,'{}'::jsonb),('pro','fulfillment.core',1,'{}'::jsonb),
('pro','returns.core',1,'{}'::jsonb),('pro','accounting.core',1,'{}'::jsonb),
('pro','accounting.reports',1,'{}'::jsonb),('pro','ask.lookup',1,'{}'::jsonb),
('pro','ask.prepare_actions',1,'{}'::jsonb),('pro','communications.ai_drafts',1,'{}'::jsonb),
('pro','planning.basic',1,'{}'::jsonb),('pro','planning.transfer_before_buy',1,'{}'::jsonb),
('pro','automation.transfers',1,'{}'::jsonb),('pro','automation.purchasing',1,'{}'::jsonb),
('pro','imports.spreadsheet',1,'{}'::jsonb),('pro','operations.alerts',1,'{}'::jsonb),
('enterprise','inventory.multi_location',1,'{}'::jsonb),('enterprise','inventory.lot_serial',1,'{}'::jsonb),
('enterprise','inventory.counts',1,'{}'::jsonb),('enterprise','inventory.transfers',1,'{}'::jsonb),
('enterprise','purchasing.core',1,'{}'::jsonb),('enterprise','purchasing.suppliers',1,'{}'::jsonb),
('enterprise','purchasing.invoices',1,'{}'::jsonb),('enterprise','receiving.core',1,'{}'::jsonb),
('enterprise','sales_orders.core',1,'{}'::jsonb),('enterprise','fulfillment.core',1,'{}'::jsonb),
('enterprise','returns.core',1,'{}'::jsonb),('enterprise','accounting.core',1,'{}'::jsonb),
('enterprise','accounting.reports',1,'{}'::jsonb),('enterprise','ask.lookup',1,'{}'::jsonb),
('enterprise','ask.prepare_actions',1,'{}'::jsonb),('enterprise','communications.ai_drafts',1,'{}'::jsonb),
('enterprise','planning.basic',1,'{}'::jsonb),('enterprise','planning.transfer_before_buy',1,'{}'::jsonb),
('enterprise','automation.transfers',1,'{}'::jsonb),('enterprise','automation.purchasing',1,'{}'::jsonb),
('enterprise','imports.spreadsheet',1,'{}'::jsonb),('enterprise','operations.alerts',1,'{}'::jsonb),
('enterprise','api.public',1,'{}'::jsonb)
) AS approved(plan_id,capability,enabled,configuration)
ON CONFLICT(plan_id,capability) DO UPDATE SET enabled=EXCLUDED.enabled,configuration=EXCLUDED.configuration;

UPDATE commercial_plan_entitlements SET enabled=0
WHERE capability IN ('documents.process','documents.extraction','inventory.kits','adaptive_optimization');

INSERT INTO commercial_plan_meters(plan_id,meter,label,included_units,hard_limit,overage_block_units,overage_amount_minor,overage_mode)
SELECT plan.id,meter.meter,meter.label,NULL,NULL,NULL,NULL,
  CASE WHEN plan.id='enterprise' THEN 'CONTRACT' ELSE 'PAUSE' END
FROM commercial_plans plan CROSS JOIN commercial_meter_definitions meter
WHERE meter.kind='USAGE' AND meter.meter<>'processing_units'
ON CONFLICT(plan_id,meter) DO NOTHING;

UPDATE commercial_plan_meters SET overage_mode='BILL'
WHERE plan_id IN ('growth','pro') AND meter IN ('processing_units','external_events')
  AND overage_block_units IS NOT NULL AND overage_amount_minor IS NOT NULL;

UPDATE commercial_plans SET packaging_status='PROPOSED',packaging_approved_at=NULL,
  packaging_approved_by_account_id=NULL,updated_at=now()
WHERE id IN ('starter','growth','pro');

UPDATE commercial_plan_versions SET status='RETIRED',effective_until=now() WHERE status='ACTIVE';
INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
SELECT 'planver_'||plan.id||'_2',plan.id,2,'ACTIVE',plan.currency,plan.monthly_amount_minor,plan.annual_amount_minor,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('capability',entitlement.capability,'enabled',entitlement.enabled,
    'configuration',entitlement.configuration) ORDER BY entitlement.capability)
    FROM commercial_plan_entitlements entitlement WHERE entitlement.plan_id=plan.id),'[]'::jsonb),
  COALESCE((SELECT jsonb_agg(to_jsonb(policy) ORDER BY policy.meter)
    FROM commercial_plan_meters policy WHERE policy.plan_id=plan.id),'[]'::jsonb)
FROM commercial_plans plan ON CONFLICT(plan_id,version_number) DO NOTHING;

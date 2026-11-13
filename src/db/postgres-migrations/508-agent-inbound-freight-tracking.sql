-- Job 39: carrier tracking feeds, purchase-order dates that move with their
-- shipment, run-out alerts and the remaining balance on each purchase order.
ALTER TABLE stockchief_runtime.agent_inbound_freight
  ADD COLUMN carrier_code text CHECK (carrier_code IS NULL OR carrier_code ~ '^[A-Z0-9]{2,4}$'),
  ADD COLUMN tracking boolean NOT NULL DEFAULT false,
  ADD COLUMN tracking_reference text CHECK (tracking_reference IS NULL OR length(tracking_reference)<=200),
  ADD COLUMN tracking_checked_at timestamptz,
  ADD COLUMN tracking_retry_after timestamptz,
  ADD COLUMN tracking_issue text CHECK (tracking_issue IS NULL OR length(tracking_issue)<=500);
CREATE INDEX agent_inbound_freight_tracking_due ON stockchief_runtime.agent_inbound_freight(workspace_id,tracking_checked_at)
  WHERE tracking AND status<>'released';

ALTER TABLE stockchief_runtime.agent_inbound_freight_updates
  ADD COLUMN source text NOT NULL DEFAULT 'forwarder' CHECK (source IN ('forwarder','carrier')),
  ADD COLUMN provider_key text CHECK (provider_key IS NULL OR provider_key ~ '^[a-f0-9]{64}$'),
  ADD COLUMN held_reason text CHECK (held_reason IS NULL OR length(held_reason)<=500);
ALTER TABLE stockchief_runtime.agent_inbound_freight_updates DROP CONSTRAINT IF EXISTS agent_inbound_freight_updates_disposition_check;
ALTER TABLE stockchief_runtime.agent_inbound_freight_updates ADD CONSTRAINT agent_inbound_freight_updates_disposition_check
  CHECK (disposition IN ('REVIEW','APPLIED','WATCH'));
CREATE UNIQUE INDEX agent_inbound_freight_updates_provider ON stockchief_runtime.agent_inbound_freight_updates(workspace_id,freight_id,provider_key)
  WHERE provider_key IS NOT NULL;

ALTER TABLE stockchief_runtime.agent_inbound_freight_deposits
  ADD COLUMN balance_due_date date;

CREATE TABLE stockchief_runtime.agent_inbound_freight_po_dates (
  workspace_id text NOT NULL,
  id text NOT NULL,
  freight_id text NOT NULL,
  update_id text NOT NULL,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  previous_date date NOT NULL,
  proposed_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('APPLIED','APPROVED','HELD','WATCH','UNDONE','SUPERSEDED')),
  automatic boolean NOT NULL DEFAULT false,
  shortage jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(shortage)='array'),
  alert_seen_at timestamptz,
  decided_by text REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,update_id,purchase_order_id),
  FOREIGN KEY(workspace_id,freight_id) REFERENCES stockchief_runtime.agent_inbound_freight(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,update_id) REFERENCES stockchief_runtime.agent_inbound_freight_updates(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_inbound_freight_po_dates_order ON stockchief_runtime.agent_inbound_freight_po_dates(workspace_id,purchase_order_id,created_at DESC);
CREATE INDEX agent_inbound_freight_po_dates_freight ON stockchief_runtime.agent_inbound_freight_po_dates(workspace_id,freight_id,created_at DESC);
CREATE INDEX agent_inbound_freight_po_dates_decider ON stockchief_runtime.agent_inbound_freight_po_dates(decided_by) WHERE decided_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_inbound_freight_po_dates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,'stockchief_runtime.agent_inbound_freight_po_dates'::regclass,true FROM workspaces w;

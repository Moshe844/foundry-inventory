CREATE TABLE stockchief_runtime.agent_inbound_freight (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('ocean','air')),
  reference_type text NOT NULL CHECK (reference_type IN ('container','bill','booking','waybill')),
  reference text NOT NULL,
  forwarder text NOT NULL,
  destination text NOT NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','in_transit','arrived','released','exception')),
  eta date,
  order_ids jsonb NOT NULL CHECK (jsonb_typeof(order_ids)='array'),
  authorized_by text NOT NULL,
  routine boolean NOT NULL DEFAULT false,
  maximum_shift_days integer NOT NULL CHECK (maximum_shift_days BETWEEN 0 AND 365),
  original_eta date,
  revision integer NOT NULL DEFAULT 1,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  link_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,mode,reference_type,reference)
);
CREATE INDEX agent_inbound_freight_routines ON stockchief_runtime.agent_inbound_freight(workspace_id) WHERE routine;
CREATE INDEX agent_inbound_freight_recent ON stockchief_runtime.agent_inbound_freight(workspace_id,created_at DESC,id DESC);

CREATE TABLE stockchief_runtime.agent_inbound_freight_updates (
  workspace_id text NOT NULL,
  freight_id text NOT NULL,
  id text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL CHECK (status IN ('booked','in_transit','arrived','released','exception')),
  eta date,
  note text,
  disposition text NOT NULL CHECK (disposition IN ('REVIEW','APPLIED')),
  applied_by text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,freight_id,revision),
  FOREIGN KEY(workspace_id,freight_id) REFERENCES stockchief_runtime.agent_inbound_freight(workspace_id,id) ON DELETE CASCADE
);

CREATE TABLE stockchief_runtime.agent_inbound_freight_deposits (
  workspace_id text NOT NULL,
  freight_id text NOT NULL,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  bill_id text REFERENCES accounting_supplier_bills(id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency text NOT NULL,
  due_date date NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(workspace_id,freight_id,purchase_order_id),
  UNIQUE(workspace_id,bill_id),
  FOREIGN KEY(workspace_id,freight_id) REFERENCES stockchief_runtime.agent_inbound_freight(workspace_id,id) ON DELETE CASCADE
);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_inbound_freight'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_inbound_freight_updates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_inbound_freight_deposits'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_inbound_freight'::regclass,'stockchief_runtime.agent_inbound_freight_updates'::regclass,
 'stockchief_runtime.agent_inbound_freight_deposits'::regclass);

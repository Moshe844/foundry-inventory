-- Job 32: goods closed in StockChief because they will not arrive.
ALTER TABLE purchase_order_lines
  ADD COLUMN incoming_close_id text,
  DROP CONSTRAINT purchase_line_order_quantities,
  ADD CONSTRAINT purchase_line_order_quantities CHECK (
    (quantity_units>0 AND quantity_purchase_units>0) OR
    (quantity_units=0 AND quantity_purchase_units=0 AND (supplier_amendment_closed_at IS NOT NULL OR incoming_close_id IS NOT NULL))
  ),
  ADD CONSTRAINT incoming_closed_line CHECK (
    incoming_close_id IS NULL OR
    (quantity_units=quantity_received_units AND coalesce(secondary_quantity_ordered,0)=secondary_quantity_received)
  );
CREATE INDEX purchase_line_incoming_close ON purchase_order_lines(workspace_id,incoming_close_id) WHERE incoming_close_id IS NOT NULL;
-- Keep the byte representation of existing purchase lines.
UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.incoming_close_id IS NULL THEN to_jsonb(t)-''incoming_close_id'' ELSE to_jsonb(t) END)')
WHERE relation='purchase_order_lines'::regclass;

CREATE TABLE stockchief_runtime.agent_incoming_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  grace_days integer NOT NULL CHECK (grace_days BETWEEN 1 AND 365),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  max_value_minor bigint NOT NULL CHECK (max_value_minor>=0),
  automatic boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  authorized_by text NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_incoming_rule_owner ON stockchief_runtime.agent_incoming_rules(authorized_by);

CREATE TABLE stockchief_runtime.agent_incoming_closes (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  purchase_order_id text NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','CLOSED','REOPENED','STALE','DISMISSED')),
  plan jsonb NOT NULL,
  reason text,
  rule_revision integer,
  previous_status text,
  closed_status text,
  authorization_kind text CHECK (authorization_kind IN ('AUTOMATIC','INDIVIDUAL')),
  closed_by text REFERENCES users(id),
  closed_at timestamptz,
  reopened_by text REFERENCES users(id),
  reopened_at timestamptz,
  notice_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,id),
  UNIQUE(workspace_id,request_key),
  CHECK (status NOT IN ('CLOSED','REOPENED') OR (closed_at IS NOT NULL AND closed_by IS NOT NULL AND authorization_kind IS NOT NULL
    AND previous_status IS NOT NULL AND closed_status IS NOT NULL))
);
CREATE INDEX agent_incoming_close_order ON stockchief_runtime.agent_incoming_closes(purchase_order_id);
CREATE INDEX agent_incoming_close_recent ON stockchief_runtime.agent_incoming_closes(workspace_id,status,created_at);
CREATE INDEX agent_incoming_close_closer ON stockchief_runtime.agent_incoming_closes(closed_by);
CREATE INDEX agent_incoming_close_reopener ON stockchief_runtime.agent_incoming_closes(reopened_by);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_incoming_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
  ('stockchief_runtime.agent_incoming_closes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_incoming_rules'::regclass,
    'stockchief_runtime.agent_incoming_closes'::regclass]) r;

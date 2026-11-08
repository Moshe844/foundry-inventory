CREATE TABLE stockchief_runtime.orderful_orders (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid NOT NULL, connector_id text NOT NULL REFERENCES workspace_connectors(id),
  purchase_order_number text NOT NULL, sales_order_id text NOT NULL REFERENCES sales_orders(id),
  original_message jsonb NOT NULL, retailer_line_skus jsonb NOT NULL, superseding_message_id uuid, last_polled_at timestamptz, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,source_id), UNIQUE(connector_id,purchase_order_number), UNIQUE(workspace_id,sales_order_id)
);
CREATE TABLE stockchief_runtime.orderful_changes (
  workspace_id text NOT NULL, source_id uuid NOT NULL, transaction_id uuid NOT NULL,
  message jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,transaction_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES stockchief_runtime.orderful_orders(workspace_id,source_id)
);
CREATE TABLE stockchief_runtime.orderful_outbound (
  workspace_id text NOT NULL, source_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('ack','ship','invoice')), record_id text NOT NULL,
  message jsonb NOT NULL, status text NOT NULL CHECK(status IN ('SUBMITTING','ACCEPTED','FAILED','DELIVERED','ACKNOWLEDGED','REJECTED')),
  provider_id text, provider_uuid uuid, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,source_id,kind,record_id),
  FOREIGN KEY(workspace_id,source_id) REFERENCES stockchief_runtime.orderful_orders(workspace_id,source_id)
);
CREATE UNIQUE INDEX orderful_verified_provider_transaction ON stockchief_runtime.orderful_outbound(workspace_id,provider_uuid) WHERE provider_uuid IS NOT NULL;
CREATE TABLE stockchief_runtime.orderful_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE, actor_id text NOT NULL REFERENCES users(id),
  generation text NOT NULL, checked_through timestamptz NOT NULL, window_end timestamptz,
  next_cursor text, next_at timestamptz NOT NULL DEFAULT now(), last_issue text
);
CREATE TABLE stockchief_runtime.orderful_inbox (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, transaction_id uuid NOT NULL,
  business_number text NOT NULL, kind text NOT NULL, opened_at timestamptz NOT NULL, issue text,
  completed_at timestamptz, PRIMARY KEY(workspace_id,transaction_id)
);

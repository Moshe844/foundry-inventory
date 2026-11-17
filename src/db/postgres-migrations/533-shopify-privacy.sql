ALTER TABLE connection_webhook_receipts ADD COLUMN payload_purged_at timestamptz;
ALTER TABLE connector_feed_events ADD COLUMN personal_data_purged_at timestamptz;
CREATE INDEX connection_webhook_expiry ON connection_webhook_receipts(updated_at,id)
 WHERE status='COMPLETED' AND payload_purged_at IS NULL;
CREATE TABLE shopify_privacy_requests (
 id text PRIMARY KEY, app_client_id text NOT NULL, shop_domain text NOT NULL,
 topic text NOT NULL CHECK(topic IN ('customers/data_request','customers/redact','shop/redact')),
 delivery_id text NOT NULL, payload_hash text NOT NULL,
 ciphertext text, iv text, auth_tag text,
 received_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 completed_at timestamptz, UNIQUE(app_client_id,shop_domain,topic,delivery_id)
);
CREATE TABLE shopify_privacy_work (
 id text PRIMARY KEY, request_id text NOT NULL REFERENCES shopify_privacy_requests(id),
 workspace_id text NOT NULL REFERENCES workspaces(id), connector_id text NOT NULL,
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','NEEDS_REVIEW','HELD','COMPLETED')),
 result jsonb NOT NULL DEFAULT '{}', export_ciphertext text, export_iv text, export_auth_tag text,
 hold_reason text, hold_until timestamptz, completed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(request_id,workspace_id,connector_id),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES workspace_connectors(workspace_id,id)
);
CREATE INDEX shopify_privacy_due ON shopify_privacy_work(status,updated_at) WHERE status<>'COMPLETED';
CREATE TABLE shopify_privacy_access (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id),
 work_id text NOT NULL REFERENCES shopify_privacy_work(id), actor_id text NOT NULL,
 action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE shopify_privacy_subjects (
 workspace_id text NOT NULL REFERENCES workspaces(id),connector_id text NOT NULL,
 subject_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,connector_id,subject_hash),
 FOREIGN KEY(workspace_id,connector_id) REFERENCES workspace_connectors(workspace_id,id)
);

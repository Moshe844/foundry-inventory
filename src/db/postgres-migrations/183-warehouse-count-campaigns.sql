CREATE TABLE warehouse_count_campaigns (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 created_by_user_id TEXT NOT NULL,approved_by_user_id TEXT,
 title TEXT NOT NULL,scope JSONB NOT NULL,status TEXT NOT NULL DEFAULT 'DRAFT'
 CHECK(status IN ('DRAFT','APPLYING','REVIEW_REQUIRED','COMPLETED')),
 revision INTEGER NOT NULL DEFAULT 1,review_hash TEXT,problem TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),approved_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,
 UNIQUE(workspace_id,id)
);
CREATE TABLE warehouse_count_campaign_lines (
 workspace_id TEXT NOT NULL,campaign_id TEXT NOT NULL,sku_id TEXT NOT NULL,location_id TEXT NOT NULL,
 before_quantity NUMERIC NOT NULL,before_costed NUMERIC NOT NULL,before_value BIGINT NOT NULL,
 balance_version TEXT NOT NULL,cost_version TEXT NOT NULL,
 counted_quantity NUMERIC,unit_cost_minor BIGINT CHECK(unit_cost_minor>=0),cost_delta_minor BIGINT,applied_at TIMESTAMPTZ,
 PRIMARY KEY(campaign_id,location_id,sku_id),
 FOREIGN KEY(workspace_id,campaign_id) REFERENCES warehouse_count_campaigns(workspace_id,id),
 FOREIGN KEY(sku_id) REFERENCES skus(id),FOREIGN KEY(location_id) REFERENCES locations(id)
);
CREATE INDEX warehouse_count_campaign_inventory ON warehouse_count_campaigns(workspace_id,created_at DESC,id);
CREATE INDEX warehouse_count_campaign_pending ON warehouse_count_campaign_lines(campaign_id,location_id,sku_id) WHERE applied_at IS NULL;

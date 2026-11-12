-- Job 16: the owner's yearly stocktake rule, the planned count dates on each
-- stocktake, recounts of big differences and the agent's per-area decisions.
CREATE TABLE stockchief_runtime.agent_annual_stocktake_rules (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 enabled boolean NOT NULL DEFAULT true,
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 160),
 count_date date NOT NULL,
 count_days integer NOT NULL CHECK(count_days BETWEEN 1 AND 31),
 notice_days integer NOT NULL CHECK(notice_days BETWEEN 0 AND 90),
 root_location_ids jsonb NOT NULL CHECK(jsonb_typeof(root_location_ids)='array' AND jsonb_array_length(root_location_ids) BETWEEN 1 AND 50),
 counter_ids jsonb NOT NULL CHECK(jsonb_typeof(counter_ids)='array' AND jsonb_array_length(counter_ids) BETWEEN 1 AND 20),
 recount_units numeric CHECK(recount_units>0),
 recount_minor bigint CHECK(recount_minor>0),
 currency text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 last_issue text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(recount_units IS NOT NULL OR recount_minor IS NOT NULL),
 CHECK(recount_minor IS NULL OR currency IS NOT NULL)
);
CREATE INDEX agent_annual_stocktake_rule_owner ON stockchief_runtime.agent_annual_stocktake_rules(authorized_by) WHERE authorized_by IS NOT NULL;

ALTER TABLE stockchief_runtime.agent_annual_stocktakes
 ADD COLUMN count_date date,
 ADD COLUMN end_date date,
 ADD COLUMN automatic boolean NOT NULL DEFAULT false,
 ADD COLUMN rule_revision integer,
 ADD COLUMN recount_units numeric CHECK(recount_units>0),
 ADD COLUMN recount_minor bigint CHECK(recount_minor>0),
 ADD COLUMN recount_currency text,
 ADD COLUMN problem text,
 ADD COLUMN signoff_approved_at timestamptz,
 ADD COLUMN signoff_approved_by text REFERENCES users(id) ON DELETE SET NULL,
 ADD CONSTRAINT agent_annual_stocktake_dates CHECK(end_date IS NULL OR (count_date IS NOT NULL AND end_date>=count_date)),
 ADD CONSTRAINT agent_annual_stocktake_recount_currency CHECK(recount_minor IS NULL OR recount_currency IS NOT NULL);
CREATE INDEX agent_annual_stocktake_signoff_approver ON stockchief_runtime.agent_annual_stocktakes(signoff_approved_by) WHERE signoff_approved_by IS NOT NULL;
CREATE INDEX agent_annual_stocktake_running ON stockchief_runtime.agent_annual_stocktakes(workspace_id,status,count_date) WHERE status IN('DRAFT','FROZEN');

ALTER TABLE stockchief_runtime.agent_annual_count_teams ADD COLUMN agent_decision jsonb;

CREATE TABLE stockchief_runtime.agent_annual_recounts (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 stocktake_id text NOT NULL,
 campaign_id text NOT NULL,
 location_id text NOT NULL REFERENCES locations(id),
 sku_id text NOT NULL REFERENCES skus(id),
 first_quantity numeric NOT NULL CHECK(first_quantity>=0),
 first_counter_id text REFERENCES users(id) ON DELETE SET NULL,
 first_counter_name text,
 recounter_id text REFERENCES users(id) ON DELETE SET NULL,
 requested_by text REFERENCES users(id) ON DELETE SET NULL,
 automatic boolean NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(campaign_id,location_id,sku_id),
 FOREIGN KEY(workspace_id,stocktake_id) REFERENCES stockchief_runtime.agent_annual_stocktakes(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,campaign_id) REFERENCES warehouse_count_campaigns(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_annual_recount_stocktake ON stockchief_runtime.agent_annual_recounts(workspace_id,stocktake_id);
CREATE INDEX agent_annual_recount_campaign ON stockchief_runtime.agent_annual_recounts(workspace_id,campaign_id);
CREATE INDEX agent_annual_recount_location ON stockchief_runtime.agent_annual_recounts(location_id);
CREATE INDEX agent_annual_recount_sku ON stockchief_runtime.agent_annual_recounts(sku_id);
CREATE INDEX agent_annual_recount_first_counter ON stockchief_runtime.agent_annual_recounts(first_counter_id) WHERE first_counter_id IS NOT NULL;
CREATE INDEX agent_annual_recount_recounter ON stockchief_runtime.agent_annual_recounts(recounter_id) WHERE recounter_id IS NOT NULL;
CREATE INDEX agent_annual_recount_requester ON stockchief_runtime.agent_annual_recounts(requested_by) WHERE requested_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_annual_stocktake_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_annual_recounts'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_annual_stocktake_rules'::regclass,'stockchief_runtime.agent_annual_recounts'::regclass])r;

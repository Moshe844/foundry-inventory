-- Job 214: more of how each Custom manager likes their reports and approvals.
-- What Needs you shows first, rows on item reports, grouped or one-by-one
-- approvals, the one channel approvals reach them on, and the hour for new
-- scheduled reports. "learned" names each preference StockChief learned from
-- the manager's own repeated choices, so the page can say so and reset it.
ALTER TABLE stockchief_runtime.manager_presentation
  ADD COLUMN inbox_category text NOT NULL DEFAULT 'all'
    CHECK (inbox_category IN ('all','approval','clarification','mail','inventory','accounting','orders','connection','other')),
  ADD COLUMN report_view text NOT NULL DEFAULT 'default' CHECK (report_view IN ('default','items','variants')),
  ADD COLUMN approval_grouping text NOT NULL DEFAULT 'grouped' CHECK (approval_grouping IN ('grouped','one_by_one')),
  ADD COLUMN approval_channel text NOT NULL DEFAULT 'all' CHECK (approval_channel IN ('all','email','sms','push')),
  ADD COLUMN report_hour smallint CHECK (report_hour BETWEEN 0 AND 23),
  ADD COLUMN learned jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Each manager's own recent choices, kept short. Only that manager's
-- choices ever teach their preferences.
CREATE TABLE stockchief_runtime.manager_preference_choices (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id bigint GENERATED ALWAYS AS IDENTITY,
  preference text NOT NULL CHECK (preference IN ('report_period','download_format','inbox_sort','inbox_category','report_view','approval_grouping','report_hour')),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 40),
  chosen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,actor_id,id)
);
CREATE INDEX manager_preference_recent ON stockchief_runtime.manager_preference_choices(workspace_id,actor_id,preference,id DESC);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.manager_preference_choices'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.manager_preference_choices'::regclass,true FROM workspaces;

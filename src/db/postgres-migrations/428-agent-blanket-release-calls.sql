-- Job 42: a supplier contract may cap its total value and let each release
-- move with real demand within an agreed range. A release can be placed and
-- queued to the supplier on its own, and undone before the email goes out.
ALTER TABLE stockchief_runtime.agent_blanket_contracts
 ADD COLUMN value_limit_minor bigint CHECK(value_limit_minor>0),
 ADD COLUMN flex_percent integer NOT NULL DEFAULT 0 CHECK(flex_percent BETWEEN 0 AND 100);
ALTER TABLE stockchief_runtime.agent_blanket_releases
 ADD COLUMN scheduled_lines jsonb,
 ADD COLUMN adjustment jsonb,
 ADD COLUMN needs_person text,
 ADD COLUMN communication_id text,
 ADD COLUMN effect_id text,
 ADD COLUMN sent_at timestamptz,
 ADD COLUMN undone_at timestamptz,
 ADD COLUMN undone_by text REFERENCES users(id);
UPDATE stockchief_runtime.agent_blanket_releases SET scheduled_lines=lines WHERE scheduled_lines IS NULL;
ALTER TABLE stockchief_runtime.agent_blanket_releases ALTER COLUMN scheduled_lines SET NOT NULL;
CREATE INDEX agent_blanket_release_undoer ON stockchief_runtime.agent_blanket_releases(undone_by) WHERE undone_by IS NOT NULL;

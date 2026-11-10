CREATE TABLE stockchief_runtime.agent_shelf_photos (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 location_id text REFERENCES locations(id) ON DELETE SET NULL,
 job_id text REFERENCES stockchief_runtime.jobs(id) ON DELETE SET NULL,
 request_key text NOT NULL,
 filename text NOT NULL,
 source_hash text NOT NULL,
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 20971520),
 status text NOT NULL CHECK(status IN ('QUEUED','READING','REVIEW','CONFIRMED','FAILED')),
 reading jsonb,
 confirmation jsonb,
 training_example_id text REFERENCES stockchief_runtime.agent_shelf_photos(id) ON DELETE SET NULL,
 credits_used integer NOT NULL DEFAULT 0 CHECK(credits_used>=0),
 problem text,
 created_at timestamptz NOT NULL DEFAULT now(),
 confirmed_at timestamptz,
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_shelf_photo_history ON stockchief_runtime.agent_shelf_photos(workspace_id,created_at DESC,id);
CREATE UNIQUE INDEX agent_shelf_photo_original ON stockchief_runtime.agent_shelf_photos(workspace_id,location_id,source_hash) WHERE location_id IS NOT NULL;
CREATE INDEX agent_shelf_photo_actor ON stockchief_runtime.agent_shelf_photos(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX agent_shelf_photo_location ON stockchief_runtime.agent_shelf_photos(location_id) WHERE location_id IS NOT NULL;
CREATE INDEX agent_shelf_photo_job ON stockchief_runtime.agent_shelf_photos(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX agent_shelf_photo_training_example ON stockchief_runtime.agent_shelf_photos(training_example_id) WHERE training_example_id IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_shelf_photo_rules (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 example_id text NOT NULL REFERENCES stockchief_runtime.agent_shelf_photos(id) ON DELETE CASCADE,
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 label_signature text NOT NULL,
 maximum_boxes integer NOT NULL CHECK(maximum_boxes BETWEEN 1 AND 240),
 PRIMARY KEY(workspace_id,location_id,label_signature)
);
CREATE INDEX agent_shelf_photo_rule_example ON stockchief_runtime.agent_shelf_photo_rules(example_id);
CREATE INDEX agent_shelf_photo_rule_actor ON stockchief_runtime.agent_shelf_photo_rules(authorized_by) WHERE authorized_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_shelf_photos'::regclass,'octet_length(t.content)+octet_length(convert_to((to_jsonb(t)-''content'')::text,''UTF8''))'),
 ('stockchief_runtime.agent_shelf_photo_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_shelf_photos'::regclass,'stockchief_runtime.agent_shelf_photo_rules'::regclass);

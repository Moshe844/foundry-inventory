CREATE TABLE stockchief_runtime.agent_channel_buffer_recipes (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 authorized_by text NOT NULL REFERENCES users(id),connector_id text NOT NULL REFERENCES workspace_connectors(id),
 location_id text NOT NULL REFERENCES locations(id),buffer_units integer NOT NULL CHECK(buffer_units BETWEEN 1 AND 100000),
 automatic_enabled boolean NOT NULL,active_members integer NOT NULL DEFAULT 0 CHECK(active_members>=0),
 UNIQUE(workspace_id,authorized_by,connector_id,location_id,buffer_units,automatic_enabled),UNIQUE(workspace_id,id)
);
CREATE INDEX agent_channel_buffer_recipe_owner ON stockchief_runtime.agent_channel_buffer_recipes(authorized_by);
CREATE INDEX agent_channel_buffer_recipe_connector ON stockchief_runtime.agent_channel_buffer_recipes(connector_id);
CREATE INDEX agent_channel_buffer_recipe_location ON stockchief_runtime.agent_channel_buffer_recipes(location_id);
CREATE INDEX agent_channel_buffer_active_recipe ON stockchief_runtime.agent_channel_buffer_recipes(workspace_id,id) WHERE active_members>0;
CREATE TABLE stockchief_runtime.agent_channel_buffers (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 position_id text NOT NULL UNIQUE REFERENCES connection_commerce_positions(id) ON DELETE CASCADE,
 authorized_by text NOT NULL REFERENCES users(id),recipe_id text NOT NULL,profile jsonb NOT NULL,profile_hash text NOT NULL,
 buffer_units integer NOT NULL CHECK(buffer_units BETWEEN 1 AND 100000),
 enabled boolean NOT NULL DEFAULT true,automatic_enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),last_issue text,last_checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(workspace_id,recipe_id) REFERENCES stockchief_runtime.agent_channel_buffer_recipes(workspace_id,id)
);
CREATE INDEX agent_channel_buffer_workspace ON stockchief_runtime.agent_channel_buffers(workspace_id,created_at,id);
CREATE INDEX agent_channel_buffer_owner ON stockchief_runtime.agent_channel_buffers(authorized_by);
CREATE INDEX agent_channel_buffer_recipe_member ON stockchief_runtime.agent_channel_buffers(workspace_id,recipe_id);
CREATE FUNCTION stockchief_runtime.channel_buffer_recipe_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE stockchief_runtime.agent_channel_buffer_recipes r SET active_members=r.active_members+n.n FROM(SELECT recipe_id,count(*)::integer n FROM new_buffers WHERE enabled GROUP BY recipe_id)n WHERE r.id=n.recipe_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE stockchief_runtime.agent_channel_buffer_recipes r SET active_members=r.active_members-n.n FROM(SELECT recipe_id,count(*)::integer n FROM old_buffers WHERE enabled GROUP BY recipe_id)n WHERE r.id=n.recipe_id;
 ELSE
  UPDATE stockchief_runtime.agent_channel_buffer_recipes r SET active_members=r.active_members+n.n FROM(SELECT recipe_id,sum(n)::integer n FROM(SELECT recipe_id,count(*)::integer n FROM new_buffers WHERE enabled GROUP BY recipe_id UNION ALL SELECT recipe_id,-count(*)::integer n FROM old_buffers WHERE enabled GROUP BY recipe_id)d GROUP BY recipe_id HAVING sum(n)<>0)n WHERE r.id=n.recipe_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER channel_buffer_recipe_insert AFTER INSERT ON stockchief_runtime.agent_channel_buffers REFERENCING NEW TABLE AS new_buffers FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.channel_buffer_recipe_members();
CREATE TRIGGER channel_buffer_recipe_update AFTER UPDATE ON stockchief_runtime.agent_channel_buffers REFERENCING NEW TABLE AS new_buffers OLD TABLE AS old_buffers FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.channel_buffer_recipe_members();
CREATE TRIGGER channel_buffer_recipe_delete AFTER DELETE ON stockchief_runtime.agent_channel_buffers REFERENCING OLD TABLE AS old_buffers FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.channel_buffer_recipe_members();
CREATE TABLE stockchief_runtime.agent_channel_buffer_reviews (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 buffer_id text NOT NULL REFERENCES stockchief_runtime.agent_channel_buffers(id) ON DELETE CASCADE,
 buffer_revision integer NOT NULL,reviewed_by text NOT NULL REFERENCES users(id),snapshot jsonb NOT NULL,source_fingerprint text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_channel_buffer_review_workspace ON stockchief_runtime.agent_channel_buffer_reviews(workspace_id,created_at,id);
CREATE INDEX agent_channel_buffer_review_rule ON stockchief_runtime.agent_channel_buffer_reviews(buffer_id);
CREATE INDEX agent_channel_buffer_review_owner ON stockchief_runtime.agent_channel_buffer_reviews(reviewed_by);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_channel_buffer_recipes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_channel_buffers'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_channel_buffer_reviews'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,r,true FROM workspaces CROSS JOIN unnest(ARRAY['stockchief_runtime.agent_channel_buffer_recipes'::regclass,'stockchief_runtime.agent_channel_buffers'::regclass,'stockchief_runtime.agent_channel_buffer_reviews'::regclass])r;

CREATE FUNCTION stockchief_runtime.require_channel_buffer_worker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='commerce.position.publish' AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_channel_buffers b WHERE b.workspace_id=NEW.workspace_id AND b.position_id=NEW.aggregate_id AND b.enabled AND (NEW.payload#>>'{channelBuffer,id}' IS DISTINCT FROM b.id OR NEW.payload#>>'{channelBuffer,revision}' IS DISTINCT FROM b.revision::text)) THEN
  RAISE EXCEPTION 'This stock position needs a compatible channel-buffer worker and current buffer authority.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER channel_buffer_provider_protocol BEFORE INSERT OR UPDATE OF payload ON stockchief_runtime.provider_effects FOR EACH ROW EXECUTE FUNCTION stockchief_runtime.require_channel_buffer_worker();

ALTER TABLE stockchief_runtime.agent_time_samples DROP CONSTRAINT agent_time_samples_activity_check;
ALTER TABLE stockchief_runtime.agent_time_samples ADD CHECK (activity IN (
 'repeat-order','supplier-response','staff-request','invoice-match','accounting-export',
 'count-adjustment','repeat-sale','margin-price','combine-purchases','split-purchase',
 'customer-receipt','customer-reminder','arrived-stock','stock-ready','invoice-dispute','customer-statement','quote-followup','supplier-forecast','return-email','bin-correction','supplier-details','po-delivery-date','container-plan','team-procedure','product-retirement','shutdown-purchase','promotion-purchase','delivery-qc','supplier-rfq','supplier-claim','customer-reservation','customer-priority','channel-buffer'));

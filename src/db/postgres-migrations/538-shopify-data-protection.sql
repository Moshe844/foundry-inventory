-- Privacy choices do not change plan entitlements or payment agreements.
ALTER TABLE customers ADD COLUMN automated_credit_decisions boolean NOT NULL DEFAULT true;

-- Deliberately contains no URLs, query strings, IP addresses, tokens, names,
-- email addresses, document contents or before/after customer records.
CREATE TABLE stockchief_runtime.data_access_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 workspace_id text,
 account_id text,
 actor_id text,
 channel text NOT NULL CHECK(channel IN ('APP','API','PRIVATE_LINK')),
 area text NOT NULL CHECK(area ~ '^[a-z][a-z_]{0,39}$'),
 method text NOT NULL CHECK(method IN ('GET','HEAD','POST','PUT','PATCH','DELETE','ACCESS')),
 reference text CHECK(reference IS NULL OR reference ~ '^[A-Za-z0-9_-]{1,100}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX data_access_events_workspace_time ON stockchief_runtime.data_access_events(workspace_id,created_at DESC,id DESC);
CREATE INDEX data_access_events_expiry ON stockchief_runtime.data_access_events(created_at,id);
-- Entries cannot be rewritten or removed during their 180-day review window.
CREATE FUNCTION stockchief_protect_data_access_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND (OLD.created_at < now()-interval '180 days' OR stockchief_workspace_purge_allowed(OLD.workspace_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Personal data access events are immutable during retention';
END $$;
CREATE TRIGGER data_access_events_immutable BEFORE UPDATE OR DELETE ON stockchief_runtime.data_access_events
 FOR EACH ROW EXECUTE FUNCTION stockchief_protect_data_access_event();

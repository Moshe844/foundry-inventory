-- Logical, uncompressed business-row bytes plus original attachment bytes.
-- Platform jobs, telemetry, commercial ledgers, indexes, WAL and backups are
-- shared service overhead and are not charged to a customer's data allowance.
CREATE TABLE commercial_storage_tables(
 relation regclass PRIMARY KEY, bytes_expression text NOT NULL
);
CREATE TABLE commercial_storage_usage(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 relation regclass NOT NULL REFERENCES commercial_storage_tables(relation),
 delta_bytes bigint NOT NULL DEFAULT 0,
 baseline_bytes bigint NOT NULL DEFAULT 0 CHECK(baseline_bytes>=0),
 baseline_delta bigint NOT NULL DEFAULT 0,
 baseline_complete boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,relation)
);
CREATE FUNCTION commercial_check_storage(target_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE owner_id text; quota bigint; used_bytes bigint; incomplete boolean;
BEGIN
 SELECT w.owner_account_id,(m->>'hard_limit')::bigint INTO owner_id,quota
 FROM workspaces w JOIN account_subscriptions s ON s.account_id=w.owner_account_id
 JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
 CROSS JOIN LATERAL jsonb_array_elements(v.meters) m
 WHERE w.id=target_workspace AND m->>'meter'='storage_bytes';
 IF EXISTS(SELECT 1 FROM commercial_entitlement_overrides o WHERE (o.account_id=owner_id OR o.workspace_id=target_workspace) AND o.meter='storage_bytes' AND o.starts_at<=now() AND (o.ends_at IS NULL OR o.ends_at>now())) THEN
  SELECT limit_units INTO quota FROM commercial_entitlement_overrides o WHERE (o.account_id=owner_id OR o.workspace_id=target_workspace) AND o.meter='storage_bytes' AND o.starts_at<=now() AND (o.ends_at IS NULL OR o.ends_at>now()) ORDER BY CASE WHEN o.workspace_id IS NOT NULL THEN 0 ELSE 1 END,o.created_at DESC LIMIT 1;
 END IF;
 IF quota IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('storage-quota:'||owner_id,0));
 SELECT coalesce(sum(greatest(0,u.baseline_bytes+u.delta_bytes-u.baseline_delta)),0),
 coalesce(bool_or(NOT u.baseline_complete),false) INTO used_bytes,incomplete
 FROM commercial_storage_usage u JOIN workspaces w ON w.id=u.workspace_id
 WHERE w.owner_account_id=owner_id AND w.deletion_requested_at IS NULL;
 IF incomplete THEN RAISE EXCEPTION 'Stored data is being measured. New storage will be available once this check finishes; your saved data is preserved.' USING ERRCODE='23514',CONSTRAINT='commercial_storage_capacity'; END IF;
 SELECT quota+coalesce(sum((o.entitlements->>'storage_bytes')::bigint*o.quantity),0) INTO quota
 FROM commercial_capacity_orders o WHERE o.account_id=owner_id AND o.status='ACTIVE' AND o.paid_through>now() AND o.entitlements ? 'storage_bytes';
 IF used_bytes>quota THEN RAISE EXCEPTION 'Stored business data has reached the current plan limit. Add storage or upgrade before saving more data. Existing records are preserved.' USING ERRCODE='23514',CONSTRAINT='commercial_storage_capacity'; END IF;
END $$;
CREATE FUNCTION commercial_track_storage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expression text; changes record; statement text;
BEGIN
 SELECT bytes_expression INTO STRICT expression FROM commercial_storage_tables WHERE relation=TG_RELID;
 IF TG_OP='INSERT' THEN statement:=format('SELECT t.workspace_id,sum(%s)::bigint AS bytes FROM after_rows t WHERE t.workspace_id IS NOT NULL GROUP BY t.workspace_id',expression);
 ELSIF TG_OP='DELETE' THEN statement:=format('SELECT t.workspace_id,-sum(%s)::bigint AS bytes FROM before_rows t WHERE t.workspace_id IS NOT NULL GROUP BY t.workspace_id',expression);
 ELSE statement:=format('SELECT workspace_id,sum(bytes)::bigint AS bytes FROM (SELECT t.workspace_id,sum(%1$s)::bigint AS bytes FROM after_rows t GROUP BY t.workspace_id UNION ALL SELECT t.workspace_id,-sum(%1$s)::bigint FROM before_rows t GROUP BY t.workspace_id) changes WHERE workspace_id IS NOT NULL GROUP BY workspace_id',expression);
 END IF;
 -- One ledger write per table/inventory/statement, including bulk imports.
 FOR changes IN EXECUTE statement LOOP
  IF changes.bytes=0 THEN CONTINUE; END IF;
  UPDATE commercial_storage_usage SET delta_bytes=delta_bytes+changes.bytes WHERE workspace_id=changes.workspace_id AND relation=TG_RELID;
  IF NOT FOUND THEN
   -- Deleted inventories can cascade after their ledger has been removed.
   IF NOT EXISTS(SELECT 1 FROM workspaces WHERE id=changes.workspace_id) THEN CONTINUE; END IF;
   RAISE EXCEPTION 'The stored data counter is awaiting initialization.' USING ERRCODE='23514',CONSTRAINT='commercial_storage_capacity';
  END IF;
  IF changes.bytes>0 THEN PERFORM commercial_check_storage(changes.workspace_id); END IF;
 END LOOP;
 RETURN NULL;
END $$;
DO $$
DECLARE tab record; byte_columns text[]; raw_expression text; expression text;
BEGIN
 FOR tab IN SELECT c.oid,c.relnamespace,n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind='r' AND n.nspname IN('public','stockchief_runtime')
 AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='workspace_id' AND a.attnum>0 AND NOT a.attisdropped)
 AND c.relname !~ '^(commercial_|platform_)'
 AND (n.nspname='public' OR c.relname IN('report_templates','report_runs','inventory_capacity'))
 LOOP
  SELECT coalesce(array_agg(a.attname ORDER BY a.attnum),'{}'::text[]),coalesce(string_agg(format('+coalesce(octet_length(t.%I),0)',a.attname),''),'')
  INTO byte_columns,raw_expression FROM pg_attribute a WHERE a.attrelid=tab.oid AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='bytea'::regtype;
  -- Access timestamps do not turn an otherwise read-only lookup into storage
  -- growth, even when the account is exactly at its business-data quota.
  expression:=format('octet_length(convert_to((to_jsonb(t)-%L::text[])::text,''UTF8''))%s',byte_columns||ARRAY['updated_at','last_used_at','last_seen_at','last_synced_at','last_activity_at','last_attempt_at'],raw_expression);
  INSERT INTO commercial_storage_tables VALUES(tab.oid,expression);
  INSERT INTO commercial_storage_usage(workspace_id,relation) SELECT id,tab.oid FROM workspaces;
  EXECUTE format('CREATE TRIGGER commercial_storage_insert AFTER INSERT ON %I.%I REFERENCING NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab.nspname,tab.relname);
  EXECUTE format('CREATE TRIGGER commercial_storage_update AFTER UPDATE ON %I.%I REFERENCING OLD TABLE AS before_rows NEW TABLE AS after_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab.nspname,tab.relname);
  EXECUTE format('CREATE TRIGGER commercial_storage_delete AFTER DELETE ON %I.%I REFERENCING OLD TABLE AS before_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial_track_storage()',tab.nspname,tab.relname);
 END LOOP;
END $$;
CREATE FUNCTION commercial_initialize_storage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT NEW.id,relation,true FROM commercial_storage_tables;
 RETURN NEW;
END $$;
CREATE TRIGGER commercial_storage_workspace AFTER INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION commercial_initialize_storage();

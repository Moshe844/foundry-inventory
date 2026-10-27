-- Consent attempts live independently of established business connections.
ALTER TABLE connection_authorization_states ALTER COLUMN connector_id DROP NOT NULL;
ALTER TABLE workspace_connectors ADD COLUMN first_connected_at TIMESTAMPTZ;
UPDATE workspace_connectors SET first_connected_at=COALESCE(last_activity_at,last_synced_at,created_at)::timestamptz
 WHERE status='connected' OR credential_ref IS NOT NULL OR provider_account_id IS NOT NULL
 OR last_activity_at IS NOT NULL OR last_synced_at IS NOT NULL
 OR setup_status NOT IN ('AUTHORIZING','AUTHORIZATION_FAILED');
-- Preserve disconnected history whenever related records prove prior use.
DO $$ DECLARE ref RECORD; BEGIN
 FOR ref IN SELECT ns.nspname AS schema_name,rel.relname AS table_name,att.attname AS column_name
 FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
 JOIN pg_namespace ns ON ns.oid=rel.relnamespace
 JOIN LATERAL unnest(con.conkey,con.confkey) AS fk(source_num,target_num) ON true
 JOIN pg_attribute att ON att.attrelid=con.conrelid AND att.attnum=fk.source_num
 JOIN pg_attribute target ON target.attrelid=con.confrelid AND target.attnum=fk.target_num
 WHERE con.contype='f' AND con.confrelid='workspace_connectors'::regclass
 AND target.attname='id' AND rel.relname<>'connection_authorization_states'
 LOOP EXECUTE format('UPDATE workspace_connectors c SET first_connected_at=c.created_at::timestamptz WHERE c.first_connected_at IS NULL AND EXISTS (SELECT 1 FROM %I.%I r WHERE r.%I=c.id)',ref.schema_name,ref.table_name,ref.column_name); END LOOP;
END $$;
CREATE FUNCTION stockchief_keep_connection_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' AND OLD.first_connected_at IS NOT NULL THEN NEW.first_connected_at=OLD.first_connected_at;
 ELSIF NEW.status='connected' THEN NEW.first_connected_at=COALESCE(NEW.first_connected_at,clock_timestamp()); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER connection_established_history BEFORE INSERT OR UPDATE ON workspace_connectors
 FOR EACH ROW EXECUTE FUNCTION stockchief_keep_connection_history();

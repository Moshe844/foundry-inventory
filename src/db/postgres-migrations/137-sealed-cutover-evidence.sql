CREATE OR REPLACE FUNCTION stockchief_cutover_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state TEXT;
BEGIN
 SELECT status INTO state FROM migration_packages WHERE id=OLD.package_id AND postgres_state IS NOT NULL;
 IF state IS NOT NULL AND state<>'STAGING' AND (TG_OP='DELETE' OR
  (NEW.workspace_id,NEW.package_id,NEW.entity_type,NEW.source_key,NEW.source_version,NEW.payload_json,NEW.payload_hash,NEW.ordinal)
  IS DISTINCT FROM (OLD.workspace_id,OLD.package_id,OLD.entity_type,OLD.source_key,OLD.source_version,OLD.payload_json,OLD.payload_hash,OLD.ordinal)) THEN
  RAISE EXCEPTION 'The ERP source evidence is sealed. Create and review a new source revision before changing it.' USING ERRCODE='55000';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER cutover_source_guard BEFORE UPDATE OR DELETE ON migration_records FOR EACH ROW EXECUTE FUNCTION stockchief_cutover_source_guard();

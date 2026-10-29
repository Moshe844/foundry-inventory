-- A review token must reflect semantic changes without hashing the complete
-- catalogue in application memory. Transition tables charge once per changed
-- connector per statement, including batched upserts. Refresh timestamps and
-- reconciliation bookkeeping do not invalidate an unchanged owner review.
ALTER TABLE workspace_connectors ADD COLUMN catalogue_revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION stockchief_external_catalogue_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE workspace_connectors c SET catalogue_revision=c.catalogue_revision+1
   FROM (SELECT DISTINCT workspace_id,connector_id FROM catalogue_new) changed
   WHERE c.workspace_id=changed.workspace_id AND c.id=changed.connector_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE workspace_connectors c SET catalogue_revision=c.catalogue_revision+1
   FROM (SELECT DISTINCT workspace_id,connector_id FROM catalogue_old) changed
   WHERE c.workspace_id=changed.workspace_id AND c.id=changed.connector_id;
 ELSE
  UPDATE workspace_connectors c SET catalogue_revision=c.catalogue_revision+1
   FROM (SELECT DISTINCT affected.workspace_id,affected.connector_id FROM catalogue_new n JOIN catalogue_old o USING(id)
    CROSS JOIN LATERAL (VALUES(n.workspace_id,n.connector_id),(o.workspace_id,o.connector_id)) affected(workspace_id,connector_id)
    WHERE (n.workspace_id,n.connector_id,n.entity_type,n.external_id,n.parent_external_id,n.display_name,n.mapping_status,n.selected,n.code,n.provider_data::jsonb)
     IS DISTINCT FROM (o.workspace_id,o.connector_id,o.entity_type,o.external_id,o.parent_external_id,o.display_name,o.mapping_status,o.selected,o.code,o.provider_data::jsonb)) changed
   WHERE c.workspace_id=changed.workspace_id AND c.id=changed.connector_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER catalogue_revision_insert AFTER INSERT ON connection_external_records REFERENCING NEW TABLE AS catalogue_new FOR EACH STATEMENT EXECUTE FUNCTION stockchief_external_catalogue_revision();
CREATE TRIGGER catalogue_revision_update AFTER UPDATE ON connection_external_records REFERENCING NEW TABLE AS catalogue_new OLD TABLE AS catalogue_old FOR EACH STATEMENT EXECUTE FUNCTION stockchief_external_catalogue_revision();
CREATE TRIGGER catalogue_revision_delete AFTER DELETE ON connection_external_records REFERENCING OLD TABLE AS catalogue_old FOR EACH STATEMENT EXECUTE FUNCTION stockchief_external_catalogue_revision();

CREATE FUNCTION stockchief_mapping_catalogue_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE workspace_connectors c SET catalogue_revision=c.catalogue_revision+1
   FROM (SELECT DISTINCT workspace_id,connector_id FROM mapping_new) changed
   WHERE c.workspace_id=changed.workspace_id AND c.id=changed.connector_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE workspace_connectors c SET catalogue_revision=c.catalogue_revision+1
   FROM (SELECT DISTINCT workspace_id,connector_id FROM mapping_old) changed
   WHERE c.workspace_id=changed.workspace_id AND c.id=changed.connector_id;
 ELSE
  UPDATE workspace_connectors c SET catalogue_revision=c.catalogue_revision+1
   FROM (SELECT DISTINCT affected.workspace_id,affected.connector_id FROM mapping_new n JOIN mapping_old o USING(id)
    CROSS JOIN LATERAL (VALUES(n.workspace_id,n.connector_id),(o.workspace_id,o.connector_id)) affected(workspace_id,connector_id)
    WHERE (n.workspace_id,n.connector_id,n.entity_type,n.external_id,n.foundry_record_id)
     IS DISTINCT FROM (o.workspace_id,o.connector_id,o.entity_type,o.external_id,o.foundry_record_id)) changed
   WHERE c.workspace_id=changed.workspace_id AND c.id=changed.connector_id;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER catalogue_revision_insert AFTER INSERT ON connection_mappings REFERENCING NEW TABLE AS mapping_new FOR EACH STATEMENT EXECUTE FUNCTION stockchief_mapping_catalogue_revision();
CREATE TRIGGER catalogue_revision_update AFTER UPDATE ON connection_mappings REFERENCING NEW TABLE AS mapping_new OLD TABLE AS mapping_old FOR EACH STATEMENT EXECUTE FUNCTION stockchief_mapping_catalogue_revision();
CREATE TRIGGER catalogue_revision_delete AFTER DELETE ON connection_mappings REFERENCING OLD TABLE AS mapping_old FOR EACH STATEMENT EXECUTE FUNCTION stockchief_mapping_catalogue_revision();

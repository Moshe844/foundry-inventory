CREATE TABLE catalogue_change_history (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 actor_id TEXT,
 item_id TEXT NOT NULL,
 sku_id TEXT,
 action TEXT NOT NULL,
 before_state JSONB NOT NULL,
 after_state JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX catalogue_change_history_workspace_time ON catalogue_change_history(workspace_id,created_at DESC,id);
CREATE INDEX catalogue_change_history_item_time ON catalogue_change_history(workspace_id,item_id,created_at DESC);
CREATE FUNCTION protect_catalogue_change_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND pg_trigger_depth()>1 THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Catalogue change history cannot be rewritten.'; END $$;
CREATE TRIGGER catalogue_change_history_immutable BEFORE UPDATE OR DELETE ON catalogue_change_history FOR EACH ROW EXECUTE FUNCTION protect_catalogue_change_history();

ALTER TABLE catalog_bulk_reviews DROP CONSTRAINT catalog_bulk_reviews_kind_check;
ALTER TABLE catalog_bulk_reviews ADD CONSTRAINT catalog_bulk_reviews_kind_check CHECK(kind IN ('archive','restore','price','cost','reorder'));

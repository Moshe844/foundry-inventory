CREATE TABLE accounting_inventory_cost_repairs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 inventory_movement_id TEXT NOT NULL,
 cost_removed_minor BIGINT NOT NULL CHECK(cost_removed_minor>=0),
 journal_entry_id TEXT,
 approved_by_user_id TEXT NOT NULL,
 evidence JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,inventory_movement_id)
);
CREATE TRIGGER inventory_cost_repairs_immutable BEFORE UPDATE OR DELETE ON accounting_inventory_cost_repairs FOR EACH ROW EXECUTE FUNCTION stockchief_forbid_change('Stock cost repairs are immutable; retain the original evidence.');

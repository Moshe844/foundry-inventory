-- Establish evidenced cost for stock already present; never fabricate receipts.
CREATE TABLE accounting_inventory_cost_establishments (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 sku_id TEXT NOT NULL REFERENCES skus(id),
 location_id TEXT NOT NULL REFERENCES locations(id),
 quantity_units BIGINT NOT NULL CHECK(quantity_units>0),
 unit_cost_minor BIGINT NOT NULL CHECK(unit_cost_minor>=0),
 total_cost_minor BIGINT NOT NULL CHECK(total_cost_minor>=0),
 currency TEXT NOT NULL,
 basis TEXT NOT NULL CHECK(basis IN ('opening_inventory','previously_expensed')),
 evidence_reference TEXT NOT NULL,
 posting_date TEXT NOT NULL,
 physical_units BIGINT NOT NULL,
 costed_units_before BIGINT NOT NULL,
 costed_units_after BIGINT NOT NULL,
 cost_minor_before BIGINT NOT NULL,
 cost_minor_after BIGINT NOT NULL,
 journal_entry_id TEXT REFERENCES accounting_journal_entries(id),
 idempotency_key TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 created_by_user_id TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(workspace_id,idempotency_key),
 CHECK(total_cost_minor=quantity_units*unit_cost_minor),
 CHECK(costed_units_after=costed_units_before+quantity_units),
 CHECK(cost_minor_after=cost_minor_before+total_cost_minor),
 CHECK(costed_units_after<=physical_units),
 CHECK((total_cost_minor=0 AND journal_entry_id IS NULL) OR (total_cost_minor>0 AND journal_entry_id IS NOT NULL))
);
CREATE INDEX accounting_cost_establishments_position ON accounting_inventory_cost_establishments(workspace_id,sku_id,location_id,created_at);
CREATE TRIGGER accounting_cost_establishment_no_update BEFORE UPDATE ON accounting_inventory_cost_establishments
 FOR EACH ROW EXECUTE FUNCTION stockchief_forbid_change('Inventory cost evidence is immutable; prepare a new correction.');
CREATE TRIGGER accounting_cost_establishment_no_delete BEFORE DELETE ON accounting_inventory_cost_establishments
 FOR EACH ROW EXECUTE FUNCTION stockchief_forbid_change('Inventory cost evidence cannot be deleted.');
CREATE VIEW accounting_inventory_cost_events AS
 SELECT cm.id,cm.workspace_id,cm.inventory_movement_id,cm.inventory_group_id,cm.sku_id,cm.location_id,
  cm.quantity_delta,cm.cost_delta_minor,cm.unit_cost_minor,cm.balance_quantity_units,cm.balance_cost_minor,
  cm.journal_entry_id,cm.cost_source_type,cm.cost_source_record_id,cm.created_at,
  cm.quantity_delta AS physical_quantity_delta,m.reference AS source_reference
 FROM accounting_inventory_cost_movements cm LEFT JOIN movements m ON m.workspace_id=cm.workspace_id AND m.id=cm.inventory_movement_id
 UNION ALL
 SELECT ce.id,ce.workspace_id,NULL::text,'existing-stock-cost:'||ce.id,ce.sku_id,ce.location_id,
  ce.quantity_units,ce.total_cost_minor,ce.unit_cost_minor,ce.costed_units_after,ce.cost_minor_after,
  ce.journal_entry_id,'inventory_cost_establishment'::text,ce.id,ce.created_at,0::bigint,ce.evidence_reference
 FROM accounting_inventory_cost_establishments ce;

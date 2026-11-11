ALTER TABLE stockchief_runtime.agent_supplier_claims
  ALTER COLUMN hold_id DROP NOT NULL,
  ADD COLUMN delivery_comparison_id text,
  ADD COLUMN purchase_order_line_id text REFERENCES purchase_order_lines(id),
  ADD CONSTRAINT agent_supplier_claim_comparison_fk FOREIGN KEY(workspace_id,delivery_comparison_id)
    REFERENCES stockchief_runtime.agent_delivery_comparisons(workspace_id,id),
  ADD CONSTRAINT agent_supplier_claim_one_source CHECK (
    (hold_id IS NOT NULL AND delivery_comparison_id IS NULL AND purchase_order_line_id IS NULL) OR
    (hold_id IS NULL AND delivery_comparison_id IS NOT NULL AND purchase_order_line_id IS NOT NULL)
  );

CREATE UNIQUE INDEX agent_supplier_shortage_line ON stockchief_runtime.agent_supplier_claims(workspace_id,purchase_order_line_id)
  WHERE purchase_order_line_id IS NOT NULL;
CREATE INDEX agent_supplier_shortage_comparison ON stockchief_runtime.agent_supplier_claims(workspace_id,delivery_comparison_id)
  WHERE delivery_comparison_id IS NOT NULL;
CREATE INDEX agent_supplier_shortage_pending ON stockchief_runtime.agent_supplier_claims(workspace_id,id)
  WHERE delivery_comparison_id IS NOT NULL AND communication_id IS NULL;

DROP INDEX stockchief_runtime.agent_supplier_claim_rule_scope;
CREATE UNIQUE INDEX agent_supplier_claim_rule_scope ON stockchief_runtime.agent_supplier_claim_rules
  (workspace_id,supplier_id,sku_id,location_id,(coalesce(scope->>'claimKind','damage'))) WHERE enabled;

UPDATE commercial_storage_tables SET bytes_expression=replace(bytes_expression,'to_jsonb(t)',
  '(CASE WHEN t.delivery_comparison_id IS NULL THEN to_jsonb(t)-ARRAY[''delivery_comparison_id'',''purchase_order_line_id'']::text[] ELSE to_jsonb(t) END)')
WHERE relation='stockchief_runtime.agent_supplier_claims'::regclass;

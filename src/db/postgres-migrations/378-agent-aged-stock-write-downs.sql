
CREATE INDEX stock_age_movement_position ON movements(workspace_id,sku_id,location_id,seq);
CREATE INDEX stock_age_lot_origin ON movements(workspace_id,lot_id,seq) WHERE lot_id IS NOT NULL AND operation='receive';

-- Follow an untracked transfer only where the issued units trace to one
-- receipt. Every hop goes to an earlier movement, including partial receipts
-- of a single-source transfer. Mixed or unlinked stock has no proven age.
CREATE FUNCTION stockchief_runtime.proven_transfer_receipt_date(tenant text, inbound_id text)
RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE
  incoming movements%ROWTYPE;
  outgoing movements%ROWTYPE;
  matches integer;
  next_id text;
  used numeric;
  last_empty bigint;
BEGIN
  SELECT * INTO incoming FROM movements m WHERE m.workspace_id=tenant AND m.id=inbound_id;
  WHILE FOUND LOOP
    IF incoming.operation='receive' THEN
      IF coalesce(incoming.reference,'') LIKE 'cutover:%' OR EXISTS(
        SELECT 1 FROM accounting_inventory_cost_movements c WHERE c.workspace_id=tenant AND c.inventory_movement_id=incoming.id
          AND c.cost_source_type IN ('opening_inventory','verified_migration_opening_value')
      ) THEN RETURN NULL; END IF;
      RETURN incoming.occurred_at;
    END IF;
    IF incoming.operation<>'transfer' OR incoming.leg IS DISTINCT FROM 'in' THEN RETURN NULL; END IF;

    SELECT count(*)::integer,min(m.id) INTO matches,next_id FROM movements m
    WHERE m.workspace_id=tenant AND m.sku_id=incoming.sku_id AND m.operation='transfer' AND m.leg='out'
      AND m.location_id=incoming.counterparty_location_id AND m.counterparty_location_id=incoming.location_id
      AND m.seq<incoming.seq AND -m.quantity_delta>=incoming.quantity_delta
      AND (m.group_id=incoming.group_id OR EXISTS(
        SELECT 1 FROM inventory_transfer_movement_links r JOIN inventory_transfer_movement_links d
          ON d.workspace_id=r.workspace_id AND d.transfer_line_id=r.transfer_line_id AND d.role='DISPATCH'
        WHERE r.workspace_id=tenant AND r.movement_id=incoming.id AND r.role='RECEIPT' AND d.movement_id=m.id
      ));
    IF matches<>1 THEN RETURN NULL; END IF;
    SELECT * INTO outgoing FROM movements m WHERE m.workspace_id=tenant AND m.id=next_id;

    SELECT count(*)::integer,min(u.receipt_movement_id),coalesce(sum(u.quantity),0) INTO matches,next_id,used
      FROM stockchief_runtime.stock_rotation_layer_uses u WHERE u.workspace_id=tenant AND u.movement_id=outgoing.id;
    IF matches>0 THEN
      IF matches<>1 OR used<>-outgoing.quantity_delta THEN RETURN NULL; END IF;
    ELSE
      SELECT coalesce(max(m.seq),0) INTO last_empty FROM movements m
        WHERE m.workspace_id=tenant AND m.sku_id=outgoing.sku_id AND m.location_id=outgoing.location_id
          AND m.seq<outgoing.seq AND m.balance_after<=0;
      SELECT count(*)::integer,min(m.id) INTO matches,next_id FROM movements m
        WHERE m.workspace_id=tenant AND m.sku_id=outgoing.sku_id AND m.location_id=outgoing.location_id
          AND m.seq>last_empty AND m.seq<outgoing.seq AND m.quantity_delta>0;
      IF matches<>1 THEN RETURN NULL; END IF;
    END IF;
    SELECT * INTO incoming FROM movements m WHERE m.workspace_id=tenant AND m.id=next_id AND m.seq<outgoing.seq;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TABLE accounting_inventory_write_downs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id text NOT NULL REFERENCES skus(id) ON DELETE RESTRICT,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  currency text NOT NULL,
  posting_date text NOT NULL,
  quantity_units numeric NOT NULL CHECK(quantity_units>0),
  secondary_quantity numeric CHECK(secondary_quantity>0),
  before_value_minor bigint NOT NULL,
  after_value_minor bigint NOT NULL CHECK(after_value_minor>=0 AND after_value_minor<before_value_minor),
  evidence_reference text NOT NULL,
  snapshot jsonb NOT NULL,
  approved_by text REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  journal_entry_id text NOT NULL UNIQUE REFERENCES accounting_journal_entries(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  UNIQUE(workspace_id,idempotency_key)
);
CREATE INDEX inventory_write_downs_position ON accounting_inventory_write_downs(workspace_id,sku_id,location_id,approved_at DESC);
CREATE INDEX inventory_write_downs_sku ON accounting_inventory_write_downs(sku_id);
CREATE INDEX inventory_write_downs_location ON accounting_inventory_write_downs(location_id);
CREATE INDEX inventory_write_downs_owner ON accounting_inventory_write_downs(approved_by) WHERE approved_by IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('accounting_inventory_write_downs'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'accounting_inventory_write_downs'::regclass,true FROM workspaces;

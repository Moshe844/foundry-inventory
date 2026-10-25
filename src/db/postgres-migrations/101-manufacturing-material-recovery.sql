ALTER TABLE manufacturing_work_orders DROP CONSTRAINT manufacturing_work_orders_status_check;
ALTER TABLE manufacturing_work_orders ADD CONSTRAINT manufacturing_work_orders_status_check CHECK(status IN ('DRAFT','IN_PROGRESS','RECOVERING','COMPLETED','CANCELLED'));
CREATE TABLE manufacturing_material_recoveries (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id), work_order_id text NOT NULL REFERENCES manufacturing_work_orders(id),
 material_use_id text NOT NULL REFERENCES manufacturing_material_uses(id), event_id text NOT NULL REFERENCES manufacturing_events(id),
 quantity bigint NOT NULL CHECK(quantity>0), cost_minor bigint NOT NULL CHECK(cost_minor>=0), location_id text NOT NULL REFERENCES locations(id),
 movement_id text NOT NULL REFERENCES movements(id), tracking jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,movement_id)
);
CREATE INDEX manufacturing_recoveries_use ON manufacturing_material_recoveries(workspace_id,material_use_id);

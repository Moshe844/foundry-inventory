-- Job 12: stock the owner protects for big customers and upcoming orders.
-- A protection is the owner's standing instruction. Each reservation row is a
-- sales commitment like an order allocation: it never moves physical stock and
-- it is read through sales_stock_commitments, so orders, channels and reorder
-- all see it as not available.
CREATE TABLE stockchief_runtime.agent_stock_protections (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 customer_id text NOT NULL REFERENCES customers(id),
 location_id text NOT NULL REFERENCES locations(id),
 kind text NOT NULL CHECK(kind IN ('customer','expected','recurring')),
 lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array' AND jsonb_array_length(lines) BETWEEN 1 AND 50),
 next_on date,
 every_days integer CHECK(every_days BETWEEN 1 AND 365),
 lead_days integer NOT NULL DEFAULT 0 CHECK(lead_days BETWEEN 0 AND 90),
 grace_days integer NOT NULL DEFAULT 0 CHECK(grace_days BETWEEN 0 AND 30),
 ends_on date,
 routine boolean NOT NULL DEFAULT false,
 example_id text,
 enabled boolean NOT NULL DEFAULT true,
 problem text,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 request_key text NOT NULL,
 checked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key),
 CHECK(kind='customer' OR next_on IS NOT NULL),
 CHECK(kind<>'customer' OR (next_on IS NULL AND every_days IS NULL)),
 CHECK((kind='recurring')=(every_days IS NOT NULL)),
 CHECK(kind='customer' OR ends_on IS NULL),
 CHECK(every_days IS NULL OR lead_days<every_days)
);
CREATE INDEX agent_stock_protection_workspace ON stockchief_runtime.agent_stock_protections(workspace_id,enabled,id);
CREATE INDEX agent_stock_protection_customer ON stockchief_runtime.agent_stock_protections(customer_id);
CREATE INDEX agent_stock_protection_location ON stockchief_runtime.agent_stock_protections(location_id);
CREATE INDEX agent_stock_protection_owner ON stockchief_runtime.agent_stock_protections(authorized_by) WHERE authorized_by IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_stock_reservations (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 protection_id text NOT NULL REFERENCES stockchief_runtime.agent_stock_protections(id) ON DELETE CASCADE,
 cycle text NOT NULL,
 customer_id text NOT NULL REFERENCES customers(id),
 sku_id text NOT NULL REFERENCES skus(id),
 location_id text NOT NULL REFERENCES locations(id),
 target integer NOT NULL CHECK(target>0),
 held integer NOT NULL DEFAULT 0 CHECK(held>=0 AND held<=target),
 proposed integer NOT NULL DEFAULT 0 CHECK(proposed>=0 AND held+proposed<=target),
 one_time boolean NOT NULL,
 kept boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RELEASED')),
 release_reason text CHECK(release_reason IN ('order_arrived','expired','released','undone','removed','plan')),
 expires_at timestamptz,
 sales_order_id text REFERENCES sales_orders(id) ON DELETE SET NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 released_at timestamptz,
 UNIQUE(workspace_id,protection_id,cycle,sku_id),
 CHECK((status='RELEASED')=(release_reason IS NOT NULL)),
 CHECK(status='OPEN' OR (held=0 AND proposed=0))
);
CREATE INDEX agent_stock_reservation_position ON stockchief_runtime.agent_stock_reservations(workspace_id,sku_id,location_id) WHERE status='OPEN' AND held>0;
CREATE INDEX agent_stock_reservation_customer ON stockchief_runtime.agent_stock_reservations(customer_id,workspace_id) WHERE status='OPEN';
CREATE INDEX agent_stock_reservation_protection ON stockchief_runtime.agent_stock_reservations(protection_id,status);
CREATE INDEX agent_stock_reservation_sku ON stockchief_runtime.agent_stock_reservations(sku_id);
CREATE INDEX agent_stock_reservation_location ON stockchief_runtime.agent_stock_reservations(location_id);
CREATE INDEX agent_stock_reservation_order ON stockchief_runtime.agent_stock_reservations(sales_order_id) WHERE sales_order_id IS NOT NULL;

CREATE TABLE stockchief_runtime.agent_stock_reservation_changes (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 reservation_id text NOT NULL REFERENCES stockchief_runtime.agent_stock_reservations(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('held','topped_up','trimmed','released','expired','order_arrived','undone','removed','plan')),
 delta integer NOT NULL CHECK(delta<>0),
 held_after integer NOT NULL CHECK(held_after>=0),
 handed_over integer NOT NULL DEFAULT 0 CHECK(handed_over>=0),
 authority text NOT NULL CHECK(authority IN ('INDIVIDUAL','TRAINED','CUSTOM','UPKEEP','ORDER')),
 actor_id text REFERENCES users(id) ON DELETE SET NULL,
 sales_order_id text REFERENCES sales_orders(id) ON DELETE SET NULL,
 undoes text REFERENCES stockchief_runtime.agent_stock_reservation_changes(id),
 undone_at timestamptz,
 request_key text,
 reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,request_key)
);
CREATE INDEX agent_stock_reservation_change_reservation ON stockchief_runtime.agent_stock_reservation_changes(reservation_id,created_at);
CREATE INDEX agent_stock_reservation_change_workspace ON stockchief_runtime.agent_stock_reservation_changes(workspace_id,created_at DESC,id);
CREATE INDEX agent_stock_reservation_change_actor ON stockchief_runtime.agent_stock_reservation_changes(actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX agent_stock_reservation_change_order ON stockchief_runtime.agent_stock_reservation_changes(sales_order_id) WHERE sales_order_id IS NOT NULL;
CREATE UNIQUE INDEX agent_stock_reservation_change_undoes ON stockchief_runtime.agent_stock_reservation_changes(undoes) WHERE undoes IS NOT NULL;

-- Held reservations join the existing commitment view. Expiry is part of the
-- reservation itself, so an expired row stops holding stock at its end time
-- even before the routine records the release.
CREATE OR REPLACE VIEW public.sales_stock_commitments WITH (security_invoker=true) AS
 SELECT a.workspace_id,l.sku_id,a.location_id,a.quantity,l.id AS sales_order_line_id,o.id AS sales_order_id,NULL::text AS kit_component_id,
  NULL::text AS stock_reservation_id,NULL::text AS reserved_for_customer_id
 FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
 JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id WHERE o.status NOT IN('CANCELLED','FULFILLED')
 UNION ALL
 SELECT a.workspace_id,c.component_sku_id,a.location_id,a.quantity,l.id,o.id,c.id,NULL::text,NULL::text
 FROM sales_order_kit_allocations a JOIN sales_order_kit_components c ON c.workspace_id=a.workspace_id AND c.id=a.kit_component_id
 JOIN sales_order_lines l ON l.workspace_id=c.workspace_id AND l.id=c.sales_order_line_id
 JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id WHERE o.status NOT IN('CANCELLED','FULFILLED')
 UNION ALL
 SELECT r.workspace_id,r.sku_id,r.location_id,r.held::numeric,NULL::text,NULL::text,NULL::text,r.id,r.customer_id
 FROM stockchief_runtime.agent_stock_reservations r
 WHERE r.status='OPEN' AND r.held>0 AND (r.expires_at IS NULL OR r.expires_at>now());

-- Reorder planning and cached pages follow reservation changes exactly as they
-- follow order allocations.
CREATE FUNCTION stockchief_runtime.stock_reservations_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_expire_replenishment((SELECT jsonb_agg(p) FROM(SELECT DISTINCT workspace_id,sku_id FROM changed_rows)p),'reservations_changed');
 PERFORM stockchief_signal_reorder_candidates(jsonb_agg(to_jsonb(candidate)))
 FROM (SELECT DISTINCT r.workspace_id,r.sku_id,r.location_id,coalesce(b.on_hand,0)-coalesce((SELECT sum(x.held) FROM stockchief_runtime.agent_stock_reservations x
   WHERE x.workspace_id=r.workspace_id AND x.sku_id=r.sku_id AND x.location_id=r.location_id AND x.status='OPEN'),0) AS remaining
  FROM changed_rows r LEFT JOIN balances b ON b.workspace_id=r.workspace_id AND b.sku_id=r.sku_id AND b.location_id=r.location_id
  WHERE r.status='OPEN' AND r.held>0
   AND EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=r.workspace_id AND p.sku_id=r.sku_id AND p.reorder_point IS NOT NULL)) candidate
 HAVING count(*)>0;
 RETURN NULL;
END $$;
CREATE TRIGGER stock_reservations_inserted AFTER INSERT ON stockchief_runtime.agent_stock_reservations REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.stock_reservations_changed();
CREATE TRIGGER stock_reservations_updated AFTER UPDATE ON stockchief_runtime.agent_stock_reservations REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_runtime.stock_reservations_changed();
DO $$
DECLARE target text;
BEGIN
 FOREACH target IN ARRAY ARRAY['agent_stock_protections','agent_stock_reservations'] LOOP
  EXECUTE format('CREATE TRIGGER read_model_insert AFTER INSERT ON stockchief_runtime.%I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target);
  EXECUTE format('CREATE TRIGGER read_model_update AFTER UPDATE ON stockchief_runtime.%I REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target);
  EXECUTE format('CREATE TRIGGER read_model_delete AFTER DELETE ON stockchief_runtime.%I REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_changed_read_model()',target);
 END LOOP;
END $$;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_stock_protections'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_stock_reservations'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_stock_reservation_changes'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_stock_protections'::regclass,'stockchief_runtime.agent_stock_reservations'::regclass,
  'stockchief_runtime.agent_stock_reservation_changes'::regclass);

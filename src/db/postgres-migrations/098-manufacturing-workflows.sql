CREATE TABLE manufacturing_settings (
 workspace_id text PRIMARY KEY REFERENCES workspaces(id),wip_account_id text NOT NULL REFERENCES accounting_accounts(id),
 configured_by_user_id text NOT NULL REFERENCES users(id),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE manufacturing_work_centres (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),name text NOT NULL,
 capacity_minutes_per_day integer NOT NULL CHECK(capacity_minutes_per_day BETWEEN 1 AND 1440),
 active integer NOT NULL DEFAULT 1 CHECK(active IN (0,1)),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,name)
);
CREATE TABLE manufacturing_boms (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),output_sku_id text NOT NULL REFERENCES skus(id),
 revision integer NOT NULL CHECK(revision>0),definition jsonb NOT NULL,integrity_hash text NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','ACTIVE','RETIRED')),
 created_by_user_id text NOT NULL REFERENCES users(id),approved_by_user_id text REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),approved_at timestamptz,UNIQUE(workspace_id,output_sku_id,revision)
);
CREATE UNIQUE INDEX manufacturing_one_active_bom ON manufacturing_boms(workspace_id,output_sku_id) WHERE status='ACTIVE';
CREATE FUNCTION protect_manufacturing_bom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.workspace_id,NEW.output_sku_id,NEW.revision,NEW.definition,NEW.integrity_hash,NEW.created_by_user_id,NEW.created_at)
 IS DISTINCT FROM (OLD.workspace_id,OLD.output_sku_id,OLD.revision,OLD.definition,OLD.integrity_hash,OLD.created_by_user_id,OLD.created_at)
 THEN RAISE EXCEPTION 'BOM content is immutable; create a revision';END IF;RETURN NEW;END $$;
CREATE TRIGGER manufacturing_bom_content BEFORE UPDATE ON manufacturing_boms FOR EACH ROW EXECUTE FUNCTION protect_manufacturing_bom();
CREATE TABLE manufacturing_work_orders (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),bom_id text NOT NULL REFERENCES manufacturing_boms(id),
 order_number text NOT NULL,quantity bigint NOT NULL CHECK(quantity>0),needed_by date NOT NULL,currency text NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','IN_PROGRESS','COMPLETED','CANCELLED')),
 input_hash text NOT NULL,request_key text NOT NULL,wip_account_id text NOT NULL REFERENCES accounting_accounts(id),
 material_cost_minor bigint NOT NULL DEFAULT 0 CHECK(material_cost_minor>=0),additional_cost_minor bigint NOT NULL DEFAULT 0 CHECK(additional_cost_minor>=0),
 wip_cost_minor bigint NOT NULL DEFAULT 0 CHECK(wip_cost_minor>=0),good_quantity bigint NOT NULL DEFAULT 0 CHECK(good_quantity>=0),
 scrap_quantity bigint NOT NULL DEFAULT 0 CHECK(scrap_quantity>=0),cancelled_quantity bigint NOT NULL DEFAULT 0 CHECK(cancelled_quantity>=0),created_by_user_id text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,completed_at timestamptz,
 CHECK(good_quantity+scrap_quantity+cancelled_quantity<=quantity),UNIQUE(workspace_id,order_number),UNIQUE(workspace_id,request_key)
);
CREATE INDEX manufacturing_work_orders_open ON manufacturing_work_orders(workspace_id,status,needed_by);
CREATE TABLE manufacturing_events (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),work_order_id text NOT NULL REFERENCES manufacturing_work_orders(id),
 kind text NOT NULL,request_key text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,
 actor_user_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,request_key)
);
CREATE TABLE manufacturing_material_uses (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),work_order_id text NOT NULL REFERENCES manufacturing_work_orders(id),
 component integer NOT NULL,sku_id text NOT NULL REFERENCES skus(id),location_id text NOT NULL REFERENCES locations(id),
 quantity bigint NOT NULL CHECK(quantity>0),cost_minor bigint NOT NULL CHECK(cost_minor>=0),movement_id text NOT NULL REFERENCES movements(id),
 tracking jsonb NOT NULL,UNIQUE(workspace_id,movement_id)
);
CREATE TABLE manufacturing_added_costs (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),work_order_id text NOT NULL REFERENCES manufacturing_work_orders(id),
 source_journal_line_id text NOT NULL REFERENCES accounting_journal_lines(id),amount_minor bigint NOT NULL CHECK(amount_minor>0),
 journal_entry_id text NOT NULL REFERENCES accounting_journal_entries(id),event_id text NOT NULL REFERENCES manufacturing_events(id),
 reversed_by_event_id text REFERENCES manufacturing_events(id),reversal_entry_id text REFERENCES accounting_journal_entries(id)
);
CREATE TABLE manufacturing_capacity_bookings (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),work_order_id text NOT NULL REFERENCES manufacturing_work_orders(id),
 event_id text NOT NULL REFERENCES manufacturing_events(id),operation integer NOT NULL CHECK(operation>=0),
 work_centre_id text NOT NULL REFERENCES manufacturing_work_centres(id),scheduled_on date NOT NULL,minutes integer NOT NULL CHECK(minutes BETWEEN 1 AND 1440),
 status text NOT NULL DEFAULT 'HELD' CHECK(status IN ('HELD','RELEASED')),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,event_id,operation,scheduled_on)
);
CREATE INDEX manufacturing_capacity_by_centre_day ON manufacturing_capacity_bookings(workspace_id,work_centre_id,scheduled_on) WHERE status='HELD';

CREATE TABLE custody_agreements (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),agreement_number text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('RENTAL','CONSIGN_OUT','CONSIGN_IN')),customer_id text REFERENCES customers(id),supplier_id text REFERENCES suppliers(id),
 start_date date NOT NULL,due_date date NOT NULL CHECK(due_date>=start_date),currency text NOT NULL,status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
 external_location_id text REFERENCES locations(id),inspection_location_id text REFERENCES locations(id),request_key text NOT NULL,input_hash text NOT NULL,
 created_by_user_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,agreement_number),UNIQUE(workspace_id,request_key),
 CHECK((kind='CONSIGN_IN' AND supplier_id IS NOT NULL AND customer_id IS NULL) OR (kind<>'CONSIGN_IN' AND customer_id IS NOT NULL AND supplier_id IS NULL))
);
ALTER TABLE locations ADD COLUMN custody_agreement_id text REFERENCES custody_agreements(id);
CREATE TABLE custody_lines (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),agreement_id text NOT NULL REFERENCES custody_agreements(id),sku_id text NOT NULL REFERENCES skus(id),
 quantity bigint NOT NULL CHECK(quantity>0),unit_price_minor bigint NOT NULL CHECK(unit_price_minor>=0),unit_cost_minor bigint NOT NULL CHECK(unit_cost_minor>=0),
 dispatched_quantity bigint NOT NULL DEFAULT 0 CHECK(dispatched_quantity>=0),external_quantity bigint NOT NULL DEFAULT 0 CHECK(external_quantity>=0),
 inspection_quantity bigint NOT NULL DEFAULT 0 CHECK(inspection_quantity>=0),sold_quantity bigint NOT NULL DEFAULT 0 CHECK(sold_quantity>=0),
 owned_quantity bigint NOT NULL DEFAULT 0 CHECK(owned_quantity>=0),returned_quantity bigint NOT NULL DEFAULT 0 CHECK(returned_quantity>=0),
 CHECK(dispatched_quantity<=quantity),UNIQUE(workspace_id,agreement_id,sku_id)
);
CREATE TABLE custody_events (
 id text PRIMARY KEY,workspace_id text NOT NULL REFERENCES workspaces(id),agreement_id text NOT NULL REFERENCES custody_agreements(id),action text NOT NULL,
 request_key text NOT NULL,input_hash text NOT NULL,result jsonb NOT NULL,actor_user_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,request_key)
);
CREATE INDEX custody_open ON custody_agreements(workspace_id,status,due_date);
CREATE INDEX custody_lines_agreement ON custody_lines(workspace_id,agreement_id);

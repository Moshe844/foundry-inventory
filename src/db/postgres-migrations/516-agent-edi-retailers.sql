-- Job 185: EDI orders, ship notices and invoices with each big retailer.
--
-- One EDI connection carries documents for many retailers. Each retailer is
-- set up once: its EDI ID, the StockChief customer and warehouse its orders
-- use, the agreed currency and, when the owner allows it, the largest order
-- StockChief may confirm on its own. A document from an EDI ID that is not
-- set up stops and asks.
CREATE TABLE stockchief_runtime.agent_edi_retailers (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id text NOT NULL REFERENCES workspace_connectors(id),
  partner_id text NOT NULL CHECK (length(partner_id) BETWEEN 1 AND 80),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  customer_id text NOT NULL REFERENCES customers(id),
  location_id text NOT NULL REFERENCES locations(id),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  automatic boolean NOT NULL DEFAULT false,
  max_order_minor bigint CHECK (max_order_minor IS NULL OR max_order_minor>0),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  authorized_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id,connector_id,partner_id),
  CHECK (NOT automatic OR max_order_minor IS NOT NULL)
);
CREATE INDEX agent_edi_retailer_connector ON stockchief_runtime.agent_edi_retailers(connector_id);
CREATE INDEX agent_edi_retailer_customer ON stockchief_runtime.agent_edi_retailers(customer_id);
CREATE INDEX agent_edi_retailer_location ON stockchief_runtime.agent_edi_retailers(location_id);
CREATE INDEX agent_edi_retailer_owner ON stockchief_runtime.agent_edi_retailers(authorized_by);

-- Which retailer sent each order, and why StockChief left an order for a person.
ALTER TABLE stockchief_runtime.orderful_orders ADD COLUMN retailer_id text, ADD COLUMN hold_reason text;
-- The EDI ID each received document came from.
ALTER TABLE stockchief_runtime.orderful_inbox ADD COLUMN sender_id text;

-- A connection made before this keeps its one retailer.
INSERT INTO stockchief_runtime.agent_edi_retailers(workspace_id,connector_id,partner_id,name,customer_id,location_id,currency,authorized_by)
SELECT c.workspace_id,c.id,c.config::jsonb->>'buyer',coalesce(u.name,c.config::jsonb->>'buyer'),u.id,l.id,c.config::jsonb->>'currency',c.authorized_by_user_id
FROM workspace_connectors c
JOIN customers u ON u.workspace_id=c.workspace_id AND u.id=c.config::jsonb->>'customerId'
JOIN locations l ON l.workspace_id=c.workspace_id AND l.id=c.config::jsonb->>'locationId'
JOIN users p ON p.workspace_id=c.workspace_id AND p.id=c.authorized_by_user_id
WHERE c.connector_key='agent-orderful-test' AND coalesce(c.config::jsonb->>'buyer','')<>'' AND c.config::jsonb->>'currency' ~ '^[A-Z]{3}$'
ON CONFLICT DO NOTHING;
UPDATE stockchief_runtime.orderful_orders o SET retailer_id=c.config::jsonb->>'buyer'
FROM workspace_connectors c WHERE c.id=o.connector_id AND o.retailer_id IS NULL;
UPDATE stockchief_runtime.orderful_inbox i SET sender_id=c.config::jsonb->>'buyer'
FROM workspace_connectors c WHERE c.workspace_id=i.workspace_id AND c.connector_key='agent-orderful-test' AND i.sender_id IS NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_edi_retailers'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT id,'stockchief_runtime.agent_edi_retailers'::regclass,true FROM workspaces;

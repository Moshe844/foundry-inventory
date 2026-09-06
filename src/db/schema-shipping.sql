-- Shipping, as an operation rather than a status.
--
-- A shipment already existed: which goods, from where, to whom, and the fact
-- that they left. What did not exist was everything a carrier is actually for
-- — what it would cost, which service, the label, and where the parcel is now.
-- Those are facts a carrier owns, so they are stored as the carrier's answers
-- rather than as anything Foundry decided.

-- What one package weighs and measures.
--
-- Separate from the shipment because rates are quoted per parcel: two boxes at
-- 9 lb is not one box at 18 lb, and a carrier prices them differently. A
-- shipment with no package rows is one package, which is what a shop that has
-- never thought about it means.
CREATE TABLE IF NOT EXISTS shipment_packages (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id         TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL DEFAULT 1,
  weight_grams        INTEGER,
  length_mm           INTEGER,
  width_mm            INTEGER,
  height_mm           INTEGER,
  -- Whether the weight was measured or worked out from what is in the box.
  -- A rate quoted on a guessed weight can be re-quoted; one presented as fact
  -- and then corrected at the counter is a surprise on an invoice.
  weight_source       TEXT NOT NULL DEFAULT 'ESTIMATED'
                        CHECK (weight_source IN ('MEASURED', 'ESTIMATED')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (shipment_id, position)
);

-- What the carriers said they would charge, when asked.
--
-- Kept rather than used and discarded, because "Foundry chose UPS Ground"
-- is only checkable next to what it was choosing between. A rate goes stale;
-- `quoted_at` says when it was true.
CREATE TABLE IF NOT EXISTS shipment_rates (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id         TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  provider_rate_id    TEXT NOT NULL,
  carrier             TEXT NOT NULL,
  service             TEXT NOT NULL,
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'USD',
  delivery_days       INTEGER,
  delivery_date       TEXT,
  -- Whether the carrier guarantees that date or merely expects it.
  delivery_guaranteed INTEGER NOT NULL DEFAULT 0 CHECK (delivery_guaranteed IN (0,1)),
  quoted_at           TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (shipment_id, provider_rate_id)
);
CREATE INDEX IF NOT EXISTS idx_shipment_rates_shipment
  ON shipment_rates(workspace_id, shipment_id, amount_minor);

-- Where the parcel is, in the carrier's own words.
--
-- Every scan, kept in full. A delivery is not one fact but a sequence, and the
-- day somebody asks "when did it leave the depot" the answer has to be a
-- record rather than a recollection.
CREATE TABLE IF NOT EXISTS shipment_tracking_events (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  shipment_id         TEXT NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  -- The carrier's own id for this scan, so the same scan arriving by webhook
  -- and again by the polling fallback is one event.
  external_event_id   TEXT,
  status              TEXT NOT NULL
                        CHECK (status IN ('PRE_TRANSIT','IN_TRANSIT','OUT_FOR_DELIVERY',
                                          'DELIVERED','RETURNED','FAILURE','CANCELLED','UNKNOWN')),
  detail              TEXT,
  location            TEXT,
  occurred_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  UNIQUE (workspace_id, shipment_id, external_event_id)
);
CREATE INDEX IF NOT EXISTS idx_shipment_tracking_shipment
  ON shipment_tracking_events(workspace_id, shipment_id, occurred_at DESC);

-- Provider messages, kept before they are believed.
--
-- The same discipline as payment provider events: what arrived is recorded
-- first, and what Foundry made of it second, so a message that could not be
-- read is visible rather than lost.
CREATE TABLE IF NOT EXISTS shipping_provider_events (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  external_event_id   TEXT NOT NULL,
  event_type          TEXT,
  shipment_id         TEXT REFERENCES sales_shipments(id) ON DELETE SET NULL,
  payload             TEXT NOT NULL DEFAULT '{}',
  outcome             TEXT,
  received_at         TEXT NOT NULL,
  UNIQUE (workspace_id, provider, external_event_id)
);

-- The rule an owner gave Foundry about buying labels.
--
-- Structured on purpose. "Use UPS Ground automatically if it arrives by the
-- promised date and costs under $25" is three conditions and a choice, and
-- storing it as a sentence would mean re-reading that sentence, differently,
-- every time a parcel is ready.
CREATE TABLE IF NOT EXISTS shipping_rules (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  -- Which service this rule is about. NULL means "the cheapest that qualifies".
  carrier               TEXT,
  service               TEXT,
  max_cost_minor        INTEGER,
  -- Whether the rate has to arrive by the date the customer was promised.
  require_by_promised   INTEGER NOT NULL DEFAULT 1 CHECK (require_by_promised IN (0,1)),
  max_delivery_days     INTEGER,
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  stated_text           TEXT,
  created_by_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shipping_rules_workspace
  ON shipping_rules(workspace_id, is_active);

-- A shipping account Foundry opened on a merchant's behalf.
--
-- The alternative to asking every shop owner to leave, create an EasyPost
-- account, fund a wallet and copy a key back. Foundry creates the account
-- through the partner API and the merchant never sees EasyPost — but the
-- account is theirs, not Keeper's: their rates, their labels, their bill.
--
-- No key is stored here. The keys live in the encrypted credential store like
-- every other provider credential, referenced by the connector row; this table
-- holds only the facts a person might need to see on a screen, and the one
-- fact that decides whether a live label may be bought.
CREATE TABLE IF NOT EXISTS shipping_referral_accounts (
  id                    TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id          TEXT REFERENCES workspace_connectors(id) ON DELETE SET NULL,
  partner               TEXT NOT NULL DEFAULT 'easypost',
  -- The carrier's own id for this merchant. The account survives Foundry
  -- disconnecting from it, which is why the id is worth keeping.
  referral_customer_id  TEXT NOT NULL,
  name                  TEXT,
  email                 TEXT,
  -- Whether the merchant has a way to be billed yet. Until they do, the
  -- account exists but can buy nothing, and rates quoted against it are test
  -- rates rather than what a carrier would really charge.
  billing_ready         INTEGER NOT NULL DEFAULT 0 CHECK (billing_ready IN (0,1)),
  billing_checked_at    TEXT,
  opened_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (workspace_id, partner)
);
CREATE INDEX IF NOT EXISTS idx_shipping_referral_customer
  ON shipping_referral_accounts(referral_customer_id);

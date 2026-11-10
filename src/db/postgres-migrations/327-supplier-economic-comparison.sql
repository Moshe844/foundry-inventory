CREATE TABLE stockchief_runtime.agent_supplier_comparison_terms(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_item_id text NOT NULL REFERENCES supplier_items(id) ON DELETE CASCADE,
 location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
 offer_fingerprint text NOT NULL,minimum_quantity numeric NOT NULL CHECK(minimum_quantity>0),
 maximum_quantity numeric NOT NULL CHECK(maximum_quantity>=minimum_quantity),
 minimum_secondary_quantity numeric,maximum_secondary_quantity numeric,
 goods_price_basis text NOT NULL CHECK(goods_price_basis IN ('net','gross')),
 goods_tax_percent numeric NOT NULL CHECK(goods_tax_percent>=0),
 freight_mode text NOT NULL CHECK(freight_mode IN ('saved','fixed','included')),
 fixed_freight_minor bigint CHECK(fixed_freight_minor>=0),
 freight_threshold_basis text CHECK(freight_threshold_basis IN ('net_goods','recorded_goods')),
 freight_price_basis text NOT NULL CHECK(freight_price_basis IN ('net','gross')),
 freight_tax_percent numeric NOT NULL CHECK(freight_tax_percent>=0),
 goods_recoverable_tax_percent numeric NOT NULL CHECK(goods_recoverable_tax_percent BETWEEN 0 AND 100),
 freight_recoverable_tax_percent numeric NOT NULL CHECK(freight_recoverable_tax_percent BETWEEN 0 AND 100),
 other_charges_minor bigint NOT NULL CHECK(other_charges_minor>=0),
 valid_from date NOT NULL,valid_until date NOT NULL CHECK(valid_until>=valid_from),source_reference text NOT NULL,
 confirmed_by text REFERENCES users(id) ON DELETE SET NULL,
 confirmed_owner_account_id text REFERENCES accounts(id) ON DELETE SET NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,supplier_item_id,location_id),
 CHECK((minimum_secondary_quantity IS NULL)=(maximum_secondary_quantity IS NULL)),
 CHECK(minimum_secondary_quantity IS NULL OR minimum_secondary_quantity>0 AND maximum_secondary_quantity>=minimum_secondary_quantity),
 CHECK(freight_mode<>'fixed' OR fixed_freight_minor IS NOT NULL),
 CHECK(freight_mode<>'saved' OR freight_threshold_basis IS NOT NULL));
CREATE INDEX supplier_comparison_confirmer ON stockchief_runtime.agent_supplier_comparison_terms(confirmed_by);
CREATE INDEX supplier_comparison_owner ON stockchief_runtime.agent_supplier_comparison_terms(confirmed_owner_account_id);
CREATE TABLE stockchief_runtime.agent_supplier_comparison_rates(
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 foreign_currency text NOT NULL,comparison_currency text NOT NULL,comparison_per_foreign text NOT NULL,
 quoted_on date NOT NULL,valid_from date NOT NULL,valid_until date NOT NULL CHECK(valid_until>=valid_from),source_reference text NOT NULL,
 confirmed_by text REFERENCES users(id) ON DELETE SET NULL,
 confirmed_owner_account_id text REFERENCES accounts(id) ON DELETE SET NULL,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,foreign_currency,comparison_currency),CHECK(foreign_currency<>comparison_currency));
CREATE INDEX supplier_comparison_rate_confirmer ON stockchief_runtime.agent_supplier_comparison_rates(confirmed_by);
CREATE INDEX supplier_comparison_rate_owner ON stockchief_runtime.agent_supplier_comparison_rates(confirmed_owner_account_id);
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_comparison_terms'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_comparison_rates'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,r.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables r
 WHERE r.relation IN ('stockchief_runtime.agent_supplier_comparison_terms'::regclass,'stockchief_runtime.agent_supplier_comparison_rates'::regclass);

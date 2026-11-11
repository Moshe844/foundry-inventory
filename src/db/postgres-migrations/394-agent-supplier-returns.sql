
ALTER TABLE supplier_return_lines ALTER COLUMN quantity TYPE numeric(20,6);
ALTER TABLE supplier_return_lines ADD COLUMN secondary_quantity numeric(20,6) CHECK(secondary_quantity>0);
ALTER TABLE stockchief_runtime.agent_quality_holds ADD COLUMN returned_quantity integer NOT NULL DEFAULT 0
 CHECK(returned_quantity>=0 AND returned_quantity<=quantity);

CREATE OR REPLACE FUNCTION stockchief_runtime.apply_quality_hold_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  UPDATE balances b SET quality_held=b.quality_held+d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity-returned_quantity) quantity FROM new_holds WHERE status<>'PASSED' GROUP BY sku_id,location_id)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 ELSIF TG_OP='DELETE' THEN
  UPDATE balances b SET quality_held=b.quality_held-d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity-returned_quantity) quantity FROM old_holds WHERE status<>'PASSED' GROUP BY sku_id,location_id)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 ELSE
  UPDATE balances b SET quality_held=b.quality_held+d.quantity FROM
   (SELECT sku_id,location_id,sum(quantity) quantity FROM (
     SELECT sku_id,location_id,quantity-returned_quantity AS quantity FROM new_holds WHERE status<>'PASSED'
     UNION ALL SELECT sku_id,location_id,returned_quantity-quantity FROM old_holds WHERE status<>'PASSED'
    )changes GROUP BY sku_id,location_id HAVING sum(quantity)<>0)d
   WHERE b.sku_id=d.sku_id AND b.location_id=d.location_id;
 END IF;
 RETURN NULL;
END $$;

CREATE TABLE stockchief_runtime.agent_supplier_return_cases (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 bill_id text NOT NULL REFERENCES accounting_supplier_bills(id),
 return_id text UNIQUE REFERENCES supplier_returns(id) DEFERRABLE INITIALLY DEFERRED,
 requested_by text REFERENCES users(id) ON DELETE SET NULL,
 prepared_by text REFERENCES users(id) ON DELETE SET NULL,
 authorization_kind text CHECK(authorization_kind IN ('INDIVIDUAL','TRAINED','CUSTOM')),
 rule_revision integer,
 evidence jsonb NOT NULL,
 evidence_hash text NOT NULL,
 request_key text NOT NULL,
 supplier_reference text NOT NULL,
 problem text,
 dispatch jsonb,
 dispatch_hash text,
 tracking jsonb,
 checked_at timestamptz,
 cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_key),
 UNIQUE(workspace_id,supplier_id,supplier_reference),
 CHECK((return_id IS NULL)=(authorization_kind IS NULL)),
 CHECK((dispatch IS NULL)=(dispatch_hash IS NULL))
);
CREATE INDEX agent_supplier_return_case_workspace ON stockchief_runtime.agent_supplier_return_cases(workspace_id,created_at,id);
CREATE INDEX agent_supplier_return_case_supplier ON stockchief_runtime.agent_supplier_return_cases(supplier_id);
CREATE INDEX agent_supplier_return_case_bill ON stockchief_runtime.agent_supplier_return_cases(bill_id);
CREATE INDEX agent_supplier_return_case_requester ON stockchief_runtime.agent_supplier_return_cases(requested_by) WHERE requested_by IS NOT NULL;
CREATE INDEX agent_supplier_return_case_preparer ON stockchief_runtime.agent_supplier_return_cases(prepared_by) WHERE prepared_by IS NOT NULL;
CREATE TABLE stockchief_runtime.agent_supplier_return_lines (
 case_id text NOT NULL REFERENCES stockchief_runtime.agent_supplier_return_cases(id) ON DELETE CASCADE,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 receipt_line_id text NOT NULL REFERENCES purchase_order_receipt_lines(id) DEFERRABLE INITIALLY DEFERRED,
 quantity numeric(20,6) NOT NULL CHECK(quantity>0),
 secondary_quantity numeric(20,6) CHECK(secondary_quantity>0),
 serial_ids text[] NOT NULL,
 hold_active boolean NOT NULL DEFAULT true,
 extra_hold boolean NOT NULL,
 PRIMARY KEY(case_id,receipt_line_id)
);
CREATE INDEX agent_supplier_return_source_receipt ON stockchief_runtime.agent_supplier_return_lines(receipt_line_id);
CREATE INDEX agent_supplier_return_source_workspace ON stockchief_runtime.agent_supplier_return_lines(workspace_id);
CREATE TABLE stockchief_runtime.agent_supplier_return_rules (
 id text PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 supplier_id text NOT NULL REFERENCES suppliers(id),
 location_id text NOT NULL REFERENCES locations(id),
 authorized_by text REFERENCES users(id) ON DELETE SET NULL,
 currency text NOT NULL,
 maximum_minor bigint NOT NULL CHECK(maximum_minor>0),
 example_id text REFERENCES stockchief_runtime.agent_supplier_return_cases(id) DEFERRABLE INITIALLY DEFERRED,
 enabled boolean NOT NULL DEFAULT true,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 UNIQUE(workspace_id,supplier_id,location_id,currency)
);
CREATE INDEX agent_supplier_return_rule_supplier ON stockchief_runtime.agent_supplier_return_rules(supplier_id);
CREATE INDEX agent_supplier_return_rule_location ON stockchief_runtime.agent_supplier_return_rules(location_id);
CREATE INDEX agent_supplier_return_rule_owner ON stockchief_runtime.agent_supplier_return_rules(authorized_by) WHERE authorized_by IS NOT NULL;
CREATE INDEX agent_supplier_return_rule_example ON stockchief_runtime.agent_supplier_return_rules(example_id) WHERE example_id IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_supplier_return_cases'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_return_lines'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))'),
 ('stockchief_runtime.agent_supplier_return_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT w.id,t.relation,true FROM workspaces w CROSS JOIN commercial_storage_tables t
 WHERE t.relation IN('stockchief_runtime.agent_supplier_return_cases'::regclass,'stockchief_runtime.agent_supplier_return_lines'::regclass,'stockchief_runtime.agent_supplier_return_rules'::regclass);

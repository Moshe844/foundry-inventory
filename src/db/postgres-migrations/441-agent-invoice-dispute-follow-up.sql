-- Job 100: the owner's dispute limit and reminder schedule, what each open
-- dispute waits for, and the supplier credit note that settled it.

-- One saved rule per inventory. On Pro, saving it teaches StockChief to send
-- disputes on its own; on Custom it is the limit. Larger disputes wait.
CREATE TABLE stockchief_runtime.agent_invoice_dispute_rules (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  currency text NOT NULL,
  maximum_minor bigint NOT NULL CHECK (maximum_minor>0),
  reminder_days integer NOT NULL CHECK (reminder_days BETWEEN 1 AND 60),
  reminder_limit integer NOT NULL CHECK (reminder_limit BETWEEN 0 AND 5),
  authorized_by text REFERENCES users(id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX agent_invoice_dispute_rule_owner ON stockchief_runtime.agent_invoice_dispute_rules(authorized_by) WHERE authorized_by IS NOT NULL;

-- What an open dispute waits for (a reply to read, a reminder to approve),
-- when the owner last read the supplier's replies, and the credit note that
-- settled it.
ALTER TABLE stockchief_runtime.agent_invoice_dispute_work
  ADD COLUMN attention text,
  ADD COLUMN attention_at timestamptz,
  ADD COLUMN replies_seen_at timestamptz,
  ADD COLUMN credit_intake_id text UNIQUE REFERENCES stockchief_runtime.agent_supplier_invoice_intakes(id) ON DELETE SET NULL;
CREATE INDEX agent_invoice_dispute_attention ON stockchief_runtime.agent_invoice_dispute_work(workspace_id,attention_at,id)
  WHERE attention IS NOT NULL;

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
  ('stockchief_runtime.agent_invoice_dispute_rules'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
  SELECT w.id,'stockchief_runtime.agent_invoice_dispute_rules'::regclass,true FROM workspaces w;

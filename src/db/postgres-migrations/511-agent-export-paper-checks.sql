-- Job 70 routine: each packed international shipment is checked once for
-- its paperwork. Pro and Custom prepare the private packet on their own
-- (PREPARED); Growth, and anything held by Ask me first, prepares the exact
-- request for the owner's approval (PROPOSED). A missing or mismatched fact
-- (HS code, origin, net weight, value, weight or currency) stops and asks
-- (HELD) with the reason, and is checked again on the next run.
CREATE TABLE stockchief_runtime.agent_export_paper_checks (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 shipment_id text NOT NULL REFERENCES sales_shipments(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('HELD','PROPOSED','PREPARED')),
 facts_key text,
 reason text CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 600),
 sku text,
 proposal_id text,
 packet_id text,
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,shipment_id),
 CHECK((status='HELD')=(reason IS NOT NULL)),
 CHECK(status<>'PROPOSED' OR proposal_id IS NOT NULL AND facts_key IS NOT NULL),
 CHECK(status<>'PREPARED' OR packet_id IS NOT NULL AND facts_key IS NOT NULL)
);
CREATE INDEX agent_export_paper_checks_shipment ON stockchief_runtime.agent_export_paper_checks(shipment_id);

INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES
 ('stockchief_runtime.agent_export_paper_checks'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete)
 SELECT id,'stockchief_runtime.agent_export_paper_checks'::regclass,true FROM workspaces;

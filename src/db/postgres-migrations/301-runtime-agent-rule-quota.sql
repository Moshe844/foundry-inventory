-- Current instruction targets make execution checks independent of the length
-- of instruction history. Configuration tables are counted with bounded reads.
CREATE FUNCTION stockchief_agent_rule_target(c jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE c->>'domain'
 WHEN 'replenishment' THEN 'replenishment:'||coalesce(c->>'skuId','undefined')||':'||coalesce(nullif(c->>'locationId',''),'*')
 WHEN 'stock_alert' THEN 'stock_alert:'||coalesce(c->>'skuId','undefined')||':'||coalesce(nullif(c->>'locationId',''),'*')
 WHEN 'supplier_terms' THEN 'supplier:'||coalesce(c->>'supplierId','undefined')||':'||coalesce(c->>'skuId','undefined')
 WHEN 'transfer_authority' THEN 'authority:transfer'
 WHEN 'purchase_authority' THEN 'authority:purchase'
 WHEN 'operating_preference' THEN 'preference:'||CASE WHEN btrim(coalesce(c->>'daysOfStock','')) ~ '^[+]?[0-9]+([.][0-9]+)?$' THEN CASE WHEN (c->>'daysOfStock')::numeric>0 THEN 'days' ELSE 'transfer' END ELSE 'transfer' END
 WHEN 'capability_authority' THEN 'authority:capability:'||coalesce(c->>'capabilityName','undefined')
 WHEN 'stock_protection' THEN 'guard:'||coalesce(c->>'skuId','undefined')||':'||coalesce(nullif(c->>'locationId',''),'*')
 ELSE NULL END
$$;
CREATE FUNCTION stockchief_agent_rule_changes(raw text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE parsed jsonb;
BEGIN
 parsed:=raw::jsonb;
 IF jsonb_typeof(parsed)='array' THEN RETURN parsed; END IF;
 RETURN '[{"domain":"unrecognized_saved_instruction"}]'::jsonb;
EXCEPTION WHEN invalid_text_representation THEN RETURN '[{"domain":"unrecognized_saved_instruction"}]'::jsonb;
END $$;
CREATE TABLE stockchief_runtime.agent_instruction_rule_targets (
 workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 target_key text NOT NULL,active boolean NOT NULL,unrecognized boolean NOT NULL,
 source_proposal_id text NOT NULL,source_approved_at text NOT NULL,source_ordinal bigint NOT NULL,
 PRIMARY KEY(workspace_id,target_key)
);
CREATE INDEX agent_instruction_targets_active ON stockchief_runtime.agent_instruction_rule_targets(workspace_id,target_key) WHERE active;
CREATE INDEX agent_instruction_targets_unknown ON stockchief_runtime.agent_instruction_rule_targets(workspace_id) WHERE active AND unrecognized;
CREATE INDEX agent_instruction_history_refresh ON operating_instruction_proposals(workspace_id,approved_at DESC,id DESC) WHERE approved_at IS NOT NULL;
CREATE FUNCTION stockchief_refresh_agent_rule_targets(ids text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF ids IS NULL OR cardinality(ids)=0 THEN RETURN; END IF;
 DELETE FROM stockchief_runtime.agent_instruction_rule_targets WHERE workspace_id=ANY(ids);
 INSERT INTO stockchief_runtime.agent_instruction_rule_targets(workspace_id,target_key,active,unrecognized,source_proposal_id,source_approved_at,source_ordinal)
 SELECT DISTINCT ON (p.workspace_id,k.target_key) p.workspace_id,k.target_key,
  x.change->>'operation' IS DISTINCT FROM 'remove',k.unrecognized,p.id,p.approved_at,x.ordinality
 FROM operating_instruction_proposals p JOIN workspaces w ON w.id=p.workspace_id AND w.deletion_requested_at IS NULL
 CROSS JOIN LATERAL jsonb_array_elements(stockchief_agent_rule_changes(p.resolved_changes)) WITH ORDINALITY x(change,ordinality)
 CROSS JOIN LATERAL(SELECT coalesce(stockchief_agent_rule_target(x.change),'unknown:'||md5(x.change::text)) target_key,stockchief_agent_rule_target(x.change) IS NULL unrecognized)k
 WHERE p.workspace_id=ANY(ids) AND p.approved_at IS NOT NULL
 ORDER BY p.workspace_id,k.target_key,p.approved_at DESC,p.id DESC,x.ordinality DESC;
END $$;
CREATE FUNCTION stockchief_agent_rule_targets_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM stockchief_refresh_agent_rule_targets(ARRAY(SELECT DISTINCT workspace_id FROM new_rules WHERE approved_at IS NOT NULL));RETURN NULL;END $$;
CREATE FUNCTION stockchief_agent_rule_targets_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM stockchief_refresh_agent_rule_targets(ARRAY(SELECT DISTINCT workspace_id FROM old_rules WHERE approved_at IS NOT NULL));RETURN NULL;END $$;
CREATE FUNCTION stockchief_agent_rule_targets_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_refresh_agent_rule_targets(ARRAY(
  SELECT DISTINCT workspace_id FROM(
   SELECT n.workspace_id FROM new_rules n JOIN old_rules o ON o.id=n.id
    WHERE (n.workspace_id,n.approved_at,n.resolved_changes) IS DISTINCT FROM(o.workspace_id,o.approved_at,o.resolved_changes) AND (n.approved_at IS NOT NULL OR o.approved_at IS NOT NULL)
   UNION SELECT o.workspace_id FROM new_rules n JOIN old_rules o ON o.id=n.id
    WHERE (n.workspace_id,n.approved_at,n.resolved_changes) IS DISTINCT FROM(o.workspace_id,o.approved_at,o.resolved_changes) AND (n.approved_at IS NOT NULL OR o.approved_at IS NOT NULL)
  ) changed));RETURN NULL;
END $$;
CREATE TRIGGER agent_rule_targets_insert AFTER INSERT ON operating_instruction_proposals REFERENCING NEW TABLE AS new_rules FOR EACH STATEMENT EXECUTE FUNCTION stockchief_agent_rule_targets_inserted();
CREATE TRIGGER agent_rule_targets_delete AFTER DELETE ON operating_instruction_proposals REFERENCING OLD TABLE AS old_rules FOR EACH STATEMENT EXECUTE FUNCTION stockchief_agent_rule_targets_deleted();
CREATE TRIGGER agent_rule_targets_update AFTER UPDATE ON operating_instruction_proposals REFERENCING NEW TABLE AS new_rules OLD TABLE AS old_rules FOR EACH STATEMENT EXECUTE FUNCTION stockchief_agent_rule_targets_updated();
SELECT stockchief_refresh_agent_rule_targets(ARRAY(SELECT DISTINCT workspace_id FROM operating_instruction_proposals WHERE approved_at IS NOT NULL));
INSERT INTO commercial_storage_tables(relation,bytes_expression) VALUES('stockchief_runtime.agent_instruction_rule_targets'::regclass,'octet_length(convert_to(to_jsonb(t)::text,''UTF8''))');
INSERT INTO commercial_storage_usage(workspace_id,relation,baseline_complete) SELECT id,'stockchief_runtime.agent_instruction_rule_targets'::regclass,false FROM workspaces;

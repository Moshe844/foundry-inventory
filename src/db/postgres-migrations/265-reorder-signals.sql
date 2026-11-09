CREATE FUNCTION stockchief_signal_reorder_candidates(input jsonb) RETURNS void LANGUAGE sql AS $$
 WITH candidates AS (
   SELECT DISTINCT r.workspace_id,r.sku_id FROM jsonb_to_recordset(input) r(workspace_id text,sku_id text,location_id text,remaining numeric)
   JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
   JOIN account_subscriptions s ON s.account_id=w.owner_account_id
   JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
   WHERE (v.configuration->>'offerId'='agent-v3' OR s.plan_id='enterprise')
     AND EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=r.workspace_id AND p.sku_id=r.sku_id
       AND (p.location_id=r.location_id OR p.location_id IS NULL) AND p.reorder_point IS NOT NULL
       AND (r.remaining<=p.reorder_point OR EXISTS(SELECT 1 FROM sales_order_allocations a JOIN sales_order_lines l
         ON l.id=a.sales_order_line_id AND l.workspace_id=a.workspace_id WHERE a.workspace_id=r.workspace_id AND a.location_id=r.location_id AND l.sku_id=r.sku_id)))
 ), numbered AS (SELECT *,((row_number() OVER(PARTITION BY workspace_id ORDER BY sku_id)-1)/50) AS part FROM candidates),
 batches AS (SELECT workspace_id,array_agg(sku_id ORDER BY sku_id) AS skus FROM numbered GROUP BY workspace_id,part),
 saved AS (INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,available_at,idempotency_key,created_at,updated_at)
   SELECT 'reorder-'||gen_random_uuid()::text,workspace_id,'agent.reorder-signal',jsonb_build_object('skus',skus),35,
     (extract(epoch FROM statement_timestamp())*1000)::bigint,txid_current()::text||':'||md5(to_json(skus)::text),now(),now()
   FROM batches ON CONFLICT DO NOTHING RETURNING id,available_at)
 INSERT INTO stockchief_runtime.job_events(id,job_id,event_type,detail,created_at)
 SELECT 'event-'||gen_random_uuid()::text,id,'ENQUEUED',jsonb_build_object('availableAt',available_at),now() FROM saved;
$$;
CREATE FUNCTION stockchief_signal_issue() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_signal_reorder_candidates(jsonb_agg(jsonb_build_object('workspace_id',m.workspace_id,'sku_id',m.sku_id,'location_id',m.location_id,'remaining',m.balance_after)))
 FROM reorder_changes m WHERE m.quantity_delta<0 HAVING count(*)>0;
 RETURN NULL;
END $$;
CREATE TRIGGER agent_reorder_issue AFTER INSERT ON movements REFERENCING NEW TABLE AS reorder_changes
 FOR EACH STATEMENT EXECUTE FUNCTION stockchief_signal_issue();
CREATE FUNCTION stockchief_signal_sales_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM stockchief_signal_reorder_candidates(jsonb_agg(to_jsonb(candidate)))
 FROM (SELECT DISTINCT a.workspace_id,l.sku_id,a.location_id,coalesce(b.on_hand,0) AS remaining
   FROM reorder_changes a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id
   LEFT JOIN balances b ON b.workspace_id=a.workspace_id AND b.sku_id=l.sku_id AND b.location_id=a.location_id
   WHERE EXISTS(SELECT 1 FROM reorder_policies p WHERE p.workspace_id=a.workspace_id AND p.sku_id=l.sku_id AND p.reorder_point IS NOT NULL)) candidate
 HAVING count(*)>0;
 RETURN NULL;
END $$;
CREATE TRIGGER agent_reorder_sales_reservation AFTER INSERT ON sales_order_allocations REFERENCING NEW TABLE AS reorder_changes
 FOR EACH STATEMENT EXECUTE FUNCTION stockchief_signal_sales_reservation();
CREATE TRIGGER agent_reorder_changed_reservation AFTER UPDATE ON sales_order_allocations REFERENCING NEW TABLE AS reorder_changes
 FOR EACH STATEMENT EXECUTE FUNCTION stockchief_signal_sales_reservation();

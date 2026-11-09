'use strict';
const decision=require('./replenishment-decision');
async function rows(database,workspaceId,{afterSkuId=null,limitSkus=null,eligibleOnly=false,onlySkuIds=null,cycleId=null}={}){
 // Fresh imports can underestimate thousands of variants as one row. Drive
 // eligibility and final detail from their IDs with bounded primary-key reads;
 // do not repeatedly scan the catalogue or the same position CTE for each SKU.
 const result=await database.query(`WITH demand_eligible AS (
  ${cycleId?`SELECT sku_id FROM stockchief_runtime.replenishment_planning_eligible WHERE workspace_id=$1
   AND $5::int>0 AND $6::int>0 AND EXISTS(SELECT 1 FROM stockchief_runtime.replenishment_planning_runs WHERE workspace_id=$1 AND cycle_id=$9)`:
  `SELECT sku_id FROM stockchief_runtime.replenishment_demand_events WHERE workspace_id=$1
   AND occurred_at>=CURRENT_TIMESTAMP-make_interval(days=>$5) AND occurred_at<=CURRENT_TIMESTAMP
   GROUP BY sku_id,location_id HAVING count(*)>=$6`}),
 eligible_skus AS MATERIALIZED (${cycleId?'SELECT sku_id FROM demand_eligible':'SELECT sku_id FROM reorder_policies WHERE workspace_id=$1 UNION SELECT sku_id FROM demand_eligible'} ORDER BY sku_id),
 selected_skus AS MATERIALIZED (SELECT ${eligibleOnly?'eligible.sku_id':'s.id'} AS id FROM ${eligibleOnly?'eligible_skus eligible CROSS JOIN LATERAL(SELECT s.* FROM skus s WHERE s.id=eligible.sku_id LIMIT 1)s CROSS JOIN LATERAL(SELECT i.* FROM items i WHERE i.id=s.item_id LIMIT 1)i':'skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id'}
  WHERE s.workspace_id=$1 AND i.workspace_id=s.workspace_id AND s.is_active=1 AND i.is_active=1 AND $4::boolean=${eligibleOnly?'true':'false'}
   AND ($2::text IS NULL OR ${eligibleOnly?'eligible.sku_id':'s.id'}>$2) AND ($8::text[] IS NULL OR ${eligibleOnly?'eligible.sku_id':'s.id'}=ANY($8::text[])) ORDER BY ${eligibleOnly?'eligible.sku_id':'s.id'} LIMIT $3),
 sales_committed AS(SELECT line.sku_id,a.location_id,SUM(a.quantity) AS quantity FROM sales_order_allocations a
  JOIN sales_order_lines line ON line.id=a.sales_order_line_id AND line.workspace_id=a.workspace_id
  WHERE a.workspace_id=$1 AND line.sku_id IN(SELECT id FROM selected_skus) GROUP BY line.sku_id,a.location_id),
 transfer_committed AS(SELECT line.sku_id,t.source_location_id AS location_id,SUM(CASE t.status WHEN 'REQUESTED' THEN line.requested_quantity WHEN 'APPROVED' THEN line.approved_quantity ELSE line.picked_quantity END) AS quantity
  FROM inventory_transfer_lines line JOIN inventory_transfers t ON t.id=line.transfer_id AND t.workspace_id=line.workspace_id
  WHERE line.workspace_id=$1 AND line.sku_id IN(SELECT id FROM selected_skus) AND t.status IN('REQUESTED','APPROVED','PICKED') GROUP BY line.sku_id,t.source_location_id),
 committed AS(SELECT sku_id,location_id,SUM(quantity) AS quantity FROM(SELECT * FROM sales_committed UNION ALL SELECT * FROM transfer_committed) held GROUP BY sku_id,location_id),
 purchase_incoming AS(SELECT line.sku_id,COALESCE(line.destination_location_id,po.destination_location_id) AS location_id,SUM(line.quantity_units-line.quantity_received_units) AS quantity
  FROM purchase_order_lines line JOIN purchase_orders po ON po.id=line.purchase_order_id AND po.workspace_id=line.workspace_id
  WHERE line.workspace_id=$1 AND line.sku_id IN(SELECT id FROM selected_skus) AND po.status IN('APPROVED','ORDERED','PARTIALLY_RECEIVED') GROUP BY line.sku_id,COALESCE(line.destination_location_id,po.destination_location_id)),
 transfer_incoming AS(SELECT line.sku_id,t.destination_location_id AS location_id,SUM(CASE t.status WHEN 'REQUESTED' THEN line.requested_quantity WHEN 'APPROVED' THEN line.approved_quantity WHEN 'PICKED' THEN line.picked_quantity ELSE line.shipped_quantity-line.received_quantity-line.lost_quantity-line.damaged_quantity END) AS quantity
  FROM inventory_transfer_lines line JOIN inventory_transfers t ON t.id=line.transfer_id AND t.workspace_id=line.workspace_id
  WHERE line.workspace_id=$1 AND line.sku_id IN(SELECT id FROM selected_skus) AND t.status IN('REQUESTED','APPROVED','PICKED','SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED') GROUP BY line.sku_id,t.destination_location_id),
 incoming AS(SELECT sku_id,location_id,SUM(quantity) AS quantity FROM(SELECT * FROM purchase_incoming UNION ALL SELECT * FROM transfer_incoming) pending GROUP BY sku_id,location_id),
 demand AS(${cycleId?`SELECT sku_id,location_id,issue_events,issued FROM stockchief_runtime.replenishment_planning_demand
  WHERE workspace_id=$1 AND sku_id IN(SELECT id FROM selected_skus)`:
  `SELECT sku_id,location_id,COUNT(*) AS issue_events,SUM(issued) AS issued FROM stockchief_runtime.replenishment_demand_events
  WHERE workspace_id=$1 AND sku_id IN(SELECT id FROM selected_skus)
   AND occurred_at>=CURRENT_TIMESTAMP-make_interval(days=>$5) AND occurred_at<=CURRENT_TIMESTAMP GROUP BY sku_id,location_id`}),
 active_locations AS MATERIALIZED(SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL),
 evidenced_positions AS MATERIALIZED(
  SELECT sku_id,location_id FROM balances WHERE workspace_id=$1 AND sku_id IN(SELECT id FROM selected_skus)
  UNION SELECT sku_id,location_id FROM committed
  UNION SELECT sku_id,location_id FROM incoming
  UNION SELECT sku_id,location_id FROM demand
  UNION SELECT sku_id,location_id FROM reorder_policies WHERE workspace_id=$1 AND location_id IS NOT NULL AND sku_id IN(SELECT id FROM selected_skus)),
 active_positions AS MATERIALIZED(SELECT p.sku_id,p.location_id FROM evidenced_positions p JOIN active_locations l ON l.id=p.location_id),
 positions AS(SELECT * FROM active_positions UNION ALL
  SELECT empty.sku_id,l.id FROM(SELECT id AS sku_id FROM selected_skus EXCEPT SELECT sku_id FROM active_positions)empty
  CROSS JOIN(SELECT id FROM active_locations ORDER BY id LIMIT 1)l)
 SELECT s.id AS sku_id,s.code,s.variant_label,s.position AS sku_position,coalesce(source_version.version,0)::text AS source_version,i.id AS item_id,i.name AS item_name,i.tracking_mode,l.id AS location_id,l.name AS location_name,
  COALESCE(b.on_hand,0)::numeric AS on_hand,COALESCE(c.quantity,0)::numeric AS committed,COALESCE(inc.quantity,0)::numeric AS incoming,
  COALESCE(d.issue_events,0)::bigint AS issue_events,COALESCE(d.issued,0)::numeric AS issued,rp.id AS policy_id,rp.location_id AS policy_location_id,rp.reorder_point,rp.target_stock,rp.safety_stock,rp.default_order_quantity,rp.preferred_supplier_id,
  (SELECT to_jsonb(global_policy)||jsonb_build_object('effective_lead',coalesce((
    SELECT coalesce(lead.observed_lead,global_policy.lead_time_days,lead.configured_lead) FROM stockchief_runtime.supplier_planning_leads lead
    JOIN supplier_items si ON si.id=lead.supplier_item_id WHERE lead.workspace_id=s.workspace_id AND lead.sku_id=s.id
    AND (global_policy.preferred_supplier_id IS NULL OR lead.supplier_id=global_policy.preferred_supplier_id)
    ORDER BY si.is_preferred DESC,si.last_unit_cost NULLS LAST,lead.effective_lead NULLS LAST,si.id LIMIT 1),global_policy.lead_time_days,$7)) FROM reorder_policies global_policy WHERE global_policy.workspace_id=s.workspace_id AND global_policy.sku_id=s.id AND global_policy.location_id IS NULL LIMIT 1) AS global_policy,
  (SELECT value FROM operational_preferences preference WHERE preference.workspace_id=$1 AND preference.key='target_days_of_stock') AS saved_cover_days,
  COALESCE(terms.observed_lead,rp.lead_time_days,terms.configured_lead,$7) AS lead_time_days,
  COALESCE(terms.observed_lead,rp.lead_time_days,terms.configured_lead) IS NULL AS lead_time_assumed,cost.amount_minor AS cost_minor
 FROM positions pos CROSS JOIN LATERAL(SELECT s.* FROM skus s WHERE s.id=pos.sku_id LIMIT 1)s
 CROSS JOIN LATERAL(SELECT i.* FROM items i WHERE i.id=s.item_id LIMIT 1)i
 JOIN active_locations l ON l.id=pos.location_id LEFT JOIN stockchief_runtime.replenishment_source_versions source_version ON source_version.workspace_id=s.workspace_id AND source_version.sku_id=s.id LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=l.id
 LEFT JOIN committed c ON c.sku_id=s.id AND c.location_id=l.id LEFT JOIN incoming inc ON inc.sku_id=s.id AND inc.location_id=l.id LEFT JOIN demand d ON d.sku_id=s.id AND d.location_id=l.id
 LEFT JOIN LATERAL(SELECT * FROM reorder_policies p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id AND(p.location_id=l.id OR p.location_id IS NULL) ORDER BY(p.location_id IS NOT NULL) DESC,p.updated_at DESC,p.id LIMIT 1) rp ON true
 LEFT JOIN LATERAL(SELECT lead.observed_lead,lead.configured_lead FROM stockchief_runtime.supplier_planning_leads lead JOIN supplier_items si ON si.id=lead.supplier_item_id WHERE lead.workspace_id=s.workspace_id AND lead.sku_id=s.id AND(rp.preferred_supplier_id IS NULL OR si.supplier_id=rp.preferred_supplier_id) ORDER BY si.is_preferred DESC,COALESCE(si.last_unit_cost,1e100),COALESCE(lead.effective_lead,$7),si.id LIMIT 1) terms ON true
 LEFT JOIN LATERAL(SELECT amount_minor FROM sku_purchase_costs WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1) cost ON true
 WHERE s.workspace_id=$1 AND i.workspace_id=s.workspace_id
 ORDER BY s.id,l.id`,[workspaceId,afterSkuId,limitSkus===null?null:limitSkus+1,eligibleOnly,decision.WINDOW_DAYS,decision.MIN_ISSUE_EVENTS,decision.DEFAULT_LEAD_DAYS,onlySkuIds,...(cycleId?[cycleId]:[])]);
 const receivingOptions=result.rows.some(row=>row.global_policy)?(await database.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND custody_agreement_id IS NULL ORDER BY id',[workspaceId])).rows:[];
 const availability=require('../domain/postgres-stock-availability'),current=await availability.readMany(database,workspaceId,result.rows.map(row=>({skuId:row.sku_id,locationId:row.location_id}))),bySku=new Map();
 for(const row of result.rows){if(row.saved_cover_days!==null&&row.saved_cover_days!==undefined){let saved;try{saved=JSON.parse(row.saved_cover_days);}catch{throw new(require('../domain/errors').ValidationError)('Review the saved target days of stock before replenishment can continue.');}const days=Number(saved&&typeof saved==='object'?saved.value:saved);if(!Number.isSafeInteger(days)||days<1)throw new(require('../domain/errors').ValidationError)('Target days of stock must be a positive whole number.');row.cover_days=days;}const stock=current.get(availability.key(row.sku_id,row.location_id));if(stock){row.committed=stock.committed+stock.reserved;row.rental_reserved=stock.rentalReserved;}if(!bySku.has(row.sku_id))bySku.set(row.sku_id,[]);bySku.get(row.sku_id).push(row);}
 const rows=[];for(const positions of bySku.values()){
  const global=positions[0].global_policy;
  if(global){const total={...positions[0],...global,lead_time_days:global.effective_lead,policy_id:global.id,policy_location_id:null,scope:'workspace',location_id:null,location_name:'All locations',receivingOptions};for(const key of ['on_hand','committed','incoming','issue_events','issued'])total[key]=positions.reduce((sum,p)=>sum+Number(p[key]||0),0);rows.push(total);
   for(const row of positions){if(row.policy_location_id===null){row.planning_suppressed=true;row.scope='position';}rows.push(row);}
  }else rows.push(...positions);
 }
 return rows;
}
module.exports={rows};

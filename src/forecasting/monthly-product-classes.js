'use strict';
const agent=require('../commercial/agent-plan'),time=require('../lib/business-time');

async function calculate(c,workspaceId){
  const state=await agent.accountState(c,workspaceId);
  if(!agent.usesAgentTerms(state)||!agent.permits(state.plan,15,'automatic'))return {skipped:true};
  const when=await time.forWorkspace(c,workspaceId),month=when.calendarDate.slice(0,7)+'-01';
  const header=await c.query(`INSERT INTO stockchief_runtime.product_class_months(workspace_id,month_start,currency)
    SELECT $1,$2,(SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1)
    ON CONFLICT DO NOTHING RETURNING currency`,[workspaceId,month]);
  if(!header.rowCount)return {month,replayed:true};
  // Gross cost of physically sold units. Missing cost on even one sale keeps
  // that item out of the ranking. Equal consumption values share one class.
  const stored=await c.query(`WITH consumption AS (
    SELECT s.item_id,bool_and(v.cost_delta_minor IS NOT NULL AND v.quantity_delta=-d.issued AND v.cost_delta_minor<=0) AS complete,
      sum(-v.cost_delta_minor) AS value
    FROM stockchief_runtime.replenishment_demand_events d JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id AND m.reason_code IN ('sale','sold')
    JOIN skus s ON s.workspace_id=d.workspace_id AND s.id=d.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    LEFT JOIN accounting_inventory_cost_movements v ON v.workspace_id=d.workspace_id AND v.inventory_movement_id=d.movement_id
    WHERE d.workspace_id=$1 AND d.occurred_at>=($2::date-interval '12 months') AT TIME ZONE $3 AND d.occurred_at<$2::date::timestamp AT TIME ZONE $3 GROUP BY s.item_id
  ), bands AS (
    SELECT value,sum(value) AS band FROM consumption WHERE complete AND value>0 GROUP BY value
  ), ranked AS (
    SELECT value,sum(band) OVER(ORDER BY value DESC)-band AS prior,sum(band) OVER() AS total FROM bands
  ) INSERT INTO stockchief_runtime.product_class_values(workspace_id,month_start,item_id,class,consumption_minor)
    SELECT $1,$2,c.item_id,CASE WHEN NOT c.complete THEN 'Review' WHEN c.value=0 THEN 'C' WHEN r.prior<r.total*0.80 THEN 'A'
      WHEN r.prior<r.total*0.95 THEN 'B' ELSE 'C' END,CASE WHEN c.complete THEN c.value END
    FROM consumption c LEFT JOIN ranked r ON r.value=c.value`,[workspaceId,month,when.timeZone]);
  return {month,withSales:stored.rowCount};
}
async function review(db,ctx,{filter,page,today}){
  const month=today.slice(0,7)+'-01';
  const result=await db.query(`SELECT i.id,i.name,i.base_code,h.month_start,h.currency,v.consumption_minor,
    CASE WHEN h.month_start IS NULL THEN 'Awaiting monthly review' ELSE coalesce(v.class,'C') END AS category
    FROM items i LEFT JOIN stockchief_runtime.product_class_months h ON h.workspace_id=i.workspace_id AND h.month_start=$2::date
    LEFT JOIN stockchief_runtime.product_class_values v ON v.workspace_id=i.workspace_id AND v.month_start=h.month_start AND v.item_id=i.id
    WHERE i.workspace_id=$1 AND i.is_active=1 AND ($3='' OR lower(i.name)=lower($3) OR lower(i.base_code)=lower($3)
      OR (h.month_start IS NOT NULL AND lower(coalesce(v.class,'C'))=lower($3)))
    ORDER BY category,i.name,i.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,month,filter,(page-1)*100]);
  return {more:result.rowCount>100,summary:'Monthly ABC classes use the gross stock cost of sales in the previous 12 complete months. A covers the first 80% of value, B the next 15%, and C the rest. Products with equal consumption stay together. Missing sale costs require review.',
    rows:result.rows.slice(0,100).map(r=>({Product:r.name,'Product code':r.base_code,Class:r.category,'Month beginning':month,
      'Sale cost':r.month_start&&r.currency&&r.category!=='Review'?require('../domain/currency').format(r.consumption_minor||0,r.currency):null,link:'/inventory/'+r.id}))};
}
module.exports={calculate,review};

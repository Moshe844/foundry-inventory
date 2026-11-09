'use strict';
const sql=`SELECT s.code AS "SKU",l.name AS "Warehouse",count(*)::int AS "Corrections",max(m.occurred_at)::text AS "Latest correction",
  m.sku_id||':'||m.location_id AS reference,
  'Schedule a recurring blind count for this warehouse and review the differences before posting.' AS "Suggested rule",
  '/autopilot/reviews/staff-count-lists?locationId='||l.id AS link
 FROM movements m JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
 JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN locations l ON l.workspace_id=m.workspace_id AND l.id=m.location_id
 WHERE m.workspace_id=$1 AND m.operation='adjust' AND m.quantity_delta<>0 AND coalesce(m.reason_code,'') NOT IN ('opening_stock','opening')
  AND i.tracking_mode='quantity' AND i.secondary_unit_label IS NULL AND i.is_active=1 AND s.is_active=1 AND l.is_active=1
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_count_schedules scheduled WHERE scheduled.workspace_id=m.workspace_id AND scheduled.location_id=m.location_id)
  AND m.occurred_at::timestamptz BETWEEN now()-interval '30 days' AND now()
  AND ($2='' OR lower(s.code)=lower($2) OR lower(l.name)=lower($2))
 GROUP BY m.sku_id,m.location_id,s.code,l.name,l.id HAVING count(*)>=3 ORDER BY count(*) DESC,s.code,l.name`;
module.exports={sql,definition:{id:209,key:'repeated-corrections',label:'Rules suggested by repeated corrections',filterLabel:'SKU or warehouse',sql,
  summary:'At least three recorded corrections affected this product at the same warehouse in the last 30 days. Review a recurring blind-count rule and choose its counter and dates.'}};

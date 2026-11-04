'use strict';
const zone="(SELECT coalesce(w.time_zone,a.time_zone,'UTC') FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1)";
const instant='stockchief_movement_instant(m.occurred_at)';
function applied(filter){return filter.field==='occurred_on'&&['after','at_least','before','at_most','equals','greater_than','less_than','is_null'].includes(filter.operator);}
function bound(source,config,{parameterBase=1}={}){
 let parameter=parameterBase;const predicates=[];
 for(const filter of config.filters){
  if(!['is_null','is_empty','not_empty'].includes(filter.operator))parameter++;
  if(filter.field!=='occurred_on')continue;
  const start=`($${parameter}::text::date::timestamp AT TIME ZONE ${zone})`;
  // Add a calendar day before converting to UTC: DST days are not always 24h.
  const end=`(($${parameter}::text::date+1)::timestamp AT TIME ZONE ${zone})`;
  if(['after','at_least','equals'].includes(filter.operator))predicates.push(`${instant}>=${start}`);
  if(['before','at_most','equals'].includes(filter.operator))predicates.push(`${instant}<${end}`);
  if(filter.operator==='greater_than')predicates.push(`${instant}>=${end}`);
  if(filter.operator==='less_than')predicates.push(`${instant}<${start}`);
  if(filter.operator==='is_null')predicates.push(`${instant} IS NULL`);
 }
 return predicates.length?source+' AND '+predicates.join(' AND '):source;
}
async function warnings(database,workspaceId){
 const rows=(await database.query(`SELECT coalesce(nullif(s.code,''),i.name,'an item') label
  FROM movements m LEFT JOIN skus s ON s.workspace_id=m.workspace_id AND s.id=m.sku_id
  LEFT JOIN items i ON i.workspace_id=m.workspace_id AND i.id=m.item_id
  WHERE m.workspace_id=$1 AND stockchief_movement_instant(m.occurred_at) IS NULL
  LIMIT 3`,[workspaceId])).rows;
 return rows.length?['Some stock movement dates need review: '+rows.map(r=>r.label).join(', ')+'. These movements are excluded from date-filtered totals.']:[];
}
module.exports={bound,applied,warnings};

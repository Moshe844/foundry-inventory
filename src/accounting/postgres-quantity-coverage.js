'use strict';
const exact=require('../domain/exact-quantity');
async function read(db,workspaceId){
 // missing_units is generated as greatest(physical-costed,0). Zero rows do
 // not contribute; the partial workspace/SKU covering index can
 // read only missing stock instead of summing every fully costed position.
 // PostgreSQL numeric NaN is greater than zero, so damaged rows still reach
 // the existing validation and named-position warning path below.
 // Counted and measured stock are summed apart (domain/stock-totals.js): 22
 // units and 1.25 kg is never "23.25 units". missingCostUnits stays the total
 // every caller tests for "anything missing".
 const totals=require('../domain/stock-totals'),result=await db.query(`SELECT ${totals.MEASURED} AS measured,
   CASE WHEN ${totals.MEASURED} THEN coalesce(nullif(i.unit_label,''),'measured') END AS unit,coalesce(sum(p.missing_units),0) AS missing_units
   FROM inventory_cost_coverage_positions p LEFT JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
   LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
   WHERE p.workspace_id=$1 AND p.missing_units>0 GROUP BY 1,2`,[workspaceId]);
 try{
  let all='0',counted='0';const measured=[];
  for(const row of result.rows){exact.safeNumber(row.missing_units,{label:'Stock quantity'});all=exact.add(all,row.missing_units);
   if(row.measured)measured.push({unit:row.unit,quantity:row.missing_units});else counted=exact.add(counted,row.missing_units);}
  return {missingCostUnits:exact.safeNumber(all,{label:'Stock quantity'}),missingCostCounted:exact.safeNumber(counted,{label:'Stock quantity'}),missingCostMeasured:totals.byUnit(measured)};
 }
 catch(error){if(error.code!=='validation_error')throw error;}
 // A damaged projection must not hide every invoice or business report. The
 // normal path is one indexed aggregate read; only invalid totals use pages.
 let afterSku='',afterLocation='',total='0',excluded=0;const warnings=[];
 for(;;){
  const rows=(await db.query(`SELECT p.sku_id,p.location_id,p.missing_units::text,i.id AS item_id,i.name,s.code,l.name AS location
   FROM inventory_cost_coverage_positions p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
   JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
   WHERE p.workspace_id=$1 AND (p.sku_id,p.location_id)>($2::text,$3::text) ORDER BY p.sku_id,p.location_id LIMIT 500`,[workspaceId,afterSku,afterLocation])).rows;
  if(!rows.length)break;
  for(const row of rows){try{exact.safeNumber(row.missing_units,{label:'Stock quantity'});const next=exact.add(total,row.missing_units);exact.safeNumber(next,{label:'Stock quantity total'});total=next;}
   catch(error){if(error.code!=='validation_error')throw error;excluded++;if(warnings.length<20)warnings.push({itemId:row.item_id,sku:row.code,itemName:row.name,location:row.location,href:'/inventory/'+row.item_id,message:'Stock quantity for '+row.name+' ('+row.code+') at '+row.location+' needs review and is excluded from this quantity total.'});}}
  afterSku=rows.at(-1).sku_id;afterLocation=rows.at(-1).location_id;
 }
 if(excluded>20)warnings.push({message:(excluded-20)+' more stock positions need review and are excluded from this quantity total.'});
 if(!excluded)warnings.push({message:'The saved stock quantity summary needs review. Showing totals recalculated from its stock positions.'});
 return {missingCostUnits:exact.safeNumber(total),quantityWarnings:warnings,quantityTotalsIncomplete:excluded>0,excludedQuantityPositions:excluded};
}
async function forItems(db,workspaceId,itemIds){
 if(!itemIds.length)return [];
 return(await db.query(`SELECT s.item_id,sum(p.missing_units) AS missing_units
  FROM inventory_cost_coverage_positions p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
  WHERE p.workspace_id=$1 AND p.missing_units>0 AND p.physical_units>0 AND s.item_id=ANY($2::text[])
  GROUP BY s.item_id ORDER BY s.item_id`,[workspaceId,itemIds])).rows;
}
module.exports={read,forItems};

'use strict';
const permissions=require('../actions/permissions'),{ValidationError}=require('../domain/errors'),money=require('../domain/currency');
// Totals are calculated before paging children. A large item's subtotal must
// never be the sum of only the first screen of its variants.
async function stockValue(db,ctx,actor,currency,{afterItem=null}={}){
 permissions.assertCan(actor,permissions.VIEW,'view stock value');
 if(afterItem!==null&&(typeof afterItem!=='string'||afterItem.length>160))throw new ValidationError('Choose a valid report page.');
 const source=`WITH physical AS(SELECT sku_id,sum(on_hand)::numeric AS units FROM balances WHERE workspace_id=$1 GROUP BY sku_id),
 costs AS(SELECT sku_id,sum(quantity_units)::numeric AS costed,sum(total_cost_minor)::bigint AS value FROM accounting_inventory_cost_balances WHERE workspace_id=$1 GROUP BY sku_id),
 positions AS(SELECT i.id AS item_id,i.name,i.base_code,s.id AS sku_id,s.code,s.variant_label,coalesce(p.units,0) AS units,coalesce(c.costed,0) AS costed,coalesce(c.value,0) AS value,
 greatest(coalesce(p.units,0)-coalesce(c.costed,0),0) AS missing
 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN physical p ON p.sku_id=s.id LEFT JOIN costs c ON c.sku_id=s.id
 WHERE s.workspace_id=$1 AND (coalesce(p.units,0)<>0 OR coalesce(c.costed,0)<>0 OR coalesce(c.value,0)<>0))`;
 const operation=async client=>{
  const all=(await client.query(source+` SELECT item_id,name,base_code,sum(units)::numeric AS units,sum(costed)::numeric AS costed,sum(missing)::numeric AS missing,sum(value)::bigint AS value,count(*)::int AS variant_count
   FROM positions WHERE ($2::text IS NULL OR item_id>$2) GROUP BY item_id,name,base_code ORDER BY item_id LIMIT 26`,[ctx.workspaceId,afterItem])).rows;
  const parents=all.slice(0,25),children=parents.length?(await client.query(source+` SELECT * FROM(SELECT *,row_number() OVER(PARTITION BY item_id ORDER BY lower(variant_label),code,sku_id) AS child_position FROM positions WHERE item_id=ANY($2::text[])) bounded WHERE child_position<=100 ORDER BY item_id,child_position`,[ctx.workspaceId,parents.map(r=>r.item_id)])).rows:[];
  const format=row=>{if(!Number.isSafeInteger(Number(row.value)))throw new ValidationError('This stock value exceeds the supported exact money range.');return {...row,valueLabel:money.format(Number(row.value),currency)};};
  return {items:parents.map(row=>({...format(row),variants:children.filter(c=>c.item_id===row.item_id).map(format)})),hasMore:all.length>25,nextAfterItem:parents.at(-1)?.item_id||null,currency};
 };
 return db.transaction(operation,{isolation:'REPEATABLE READ',readOnly:true,statementTimeoutMs:10000,lockTimeoutMs:2000});
}
module.exports={stockValue};

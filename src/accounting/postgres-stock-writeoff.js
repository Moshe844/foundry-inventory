'use strict';
// Empties every stock position of the chosen variants, one set-based pass per
// chunk. Each position receives what a count to zero records (movement,
// adjustment and cost movement) and the chunk posts one journal for the value
// removed. Lots, serial numbers, measured weights, stock below zero and stock
// without a complete recorded cost need their own evidence, so they are
// reported and nothing is written while any of them remain.
const exact=require('../domain/exact-quantity'),ledger=require('./postgres-ledger');
const {ValidationError,InvariantError}=require('../domain/errors'),{nowIso}=require('../lib/util'),{newAppendId}=require('../lib/append-id');
const CHUNK=1000;

// Balances are probed by key (stats-proof right after a large import).
const POSITIONS=`SELECT b.sku_id,b.location_id,b.on_hand::text AS on_hand,s.item_id,s.code,l.name AS location_name,
  coalesce(c.quantity_units,0)::text AS costed,coalesce(c.total_cost_minor,0)::text AS value,
  CASE WHEN i.tracking_mode<>'quantity' THEN 'tracked by batch or serial number'
   WHEN i.secondary_unit_label IS NOT NULL OR coalesce(b.secondary_on_hand,0)<>0 THEN 'counted by weight'
   WHEN b.on_hand<0 THEN 'below zero'
   WHEN coalesce(c.quantity_units,0)<>0 AND c.quantity_units<>b.on_hand OR coalesce(c.quantity_units,0)=0 AND coalesce(c.total_cost_minor,0)<>0 THEN 'only partly costed'
  END AS problem
 FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 CROSS JOIN LATERAL(SELECT * FROM balances WHERE sku_id=s.id OFFSET 0) x
 JOIN balances b ON b.sku_id=x.sku_id AND b.location_id=x.location_id
 JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=b.location_id
 LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
 WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND b.workspace_id=$1 AND b.on_hand<>0`;

function chunks(ids,size=CHUNK){const out=[];for(let i=0;i<ids.length;i+=size)out.push(ids.slice(i,i+size));return out;}
function problemText(rows){const first=rows[0],more=rows.length-1;
 return `${first.code} at ${first.location_name} is ${first.problem}${more?` (and ${more.toLocaleString('en-US')} more ${more===1?'position':'positions'})`:''}. Adjust that stock on the product page first; nothing was removed.`;}

// What emptying these variants would remove, without writing anything.
async function summarize(client,ctx,skuIds){
 const total={positions:0,units:'0',valueMinor:0,problems:[]};
 for(const ids of chunks([...new Set(skuIds)],20000)){
  const row=(await client.query(`SELECT count(*)::int AS positions,coalesce(sum(on_hand::numeric),0)::text AS units,coalesce(sum(value::bigint),0)::text AS value,
    coalesce(jsonb_agg(jsonb_build_object('code',code,'location_name',location_name,'problem',problem)) FILTER(WHERE problem IS NOT NULL),'[]') AS problems
   FROM (${POSITIONS}) p`,[ctx.workspaceId,ids])).rows[0];
  total.positions+=row.positions;total.units=exact.add(total.units,row.units);total.valueMinor+=Number(row.value);total.problems.push(...row.problems);
 }
 if(!Number.isSafeInteger(total.valueMinor))throw new ValidationError('The stock value is outside the supported exact range.');
 return {...total,problem:total.problems.length?problemText(total.problems):null};
}

// options: reasonCode, notes, reference, debitAccountKey, sourceType, sourceRecordType, sourceRecordId, description
async function writeOffInTransaction(client,ctx,skuIds,options){
 const result={positions:0,units:'0',valueMinor:0,journalEntryIds:[]};
 for(const ids of chunks([...new Set(skuIds)])){
  await client.query('SELECT 1 FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND on_hand<>0 ORDER BY sku_id,location_id FOR UPDATE',[ctx.workspaceId,ids]);
  const rows=(await client.query(POSITIONS+' ORDER BY b.sku_id,b.location_id',[ctx.workspaceId,ids])).rows;
  if(!rows.length)continue;
  const blocked=rows.filter(r=>r.problem);if(blocked.length)throw new ValidationError(problemText(blocked));
  await require('../operations/postgres-warehouse-access').assertLocations(client,ctx,[...new Set(rows.map(r=>r.location_id))]);
  const held=await require('../operations/postgres-return-holds').heldMany(client,ctx.workspaceId,rows.map(r=>({skuId:r.sku_id,locationId:r.location_id})));
  for(const value of held.values())if(value.quantity>0)throw new ValidationError('Some of these units are waiting for return inspection. Inspect and release them first; nothing was removed.');
  const at=nowIso(),movements=[],costed=[];let value=0;
  for(const row of rows){const quantity=exact.canonical(row.on_hand),cost=Number(row.value);
   const movement={id:newAppendId('mv'),group_id:newAppendId('grp'),adjustment_id:newAppendId('adj'),item_id:row.item_id,sku_id:row.sku_id,location_id:row.location_id,quantity,delta:exact.canonical('-'+quantity,{signed:true})};
   movements.push(movement);result.units=exact.add(result.units,quantity);
   if(Number(row.costed)!==0){value+=cost;costed.push({...movement,cost_id:newAppendId('icm'),costed:exact.canonical(row.costed),cost});}
  }
  if(!Number.isSafeInteger(value))throw new ValidationError('The stock value is outside the supported exact range.');
  const payload=JSON.stringify(movements);
  const emptied=await client.query(`UPDATE balances b SET on_hand=0,secondary_on_hand=NULL,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) x(sku_id text,location_id text,quantity numeric)
   WHERE b.workspace_id=$1 AND b.sku_id=x.sku_id AND b.location_id=x.location_id AND b.on_hand=x.quantity`,[ctx.workspaceId,payload,at]);
  if(emptied.rowCount!==movements.length)throw new InvariantError('Stock changed while it was being removed. Try again.','stock_changed');
  await client.query(`INSERT INTO movements(id,workspace_id,group_id,operation,item_id,sku_id,location_id,quantity_delta,balance_after,reason_code,notes,reference,actor_user_id,occurred_at)
   SELECT x.id,$1,x.group_id,'adjust',x.item_id,x.sku_id,x.location_id,x.delta,0,$3,$4,$5,$6,$7 FROM jsonb_to_recordset($2::jsonb) x(id text,group_id text,item_id text,sku_id text,location_id text,delta numeric)`,
   [ctx.workspaceId,payload,options.reasonCode,options.notes||null,options.reference||null,ctx.actorId,at]);
  await client.query(`INSERT INTO adjustments(id,workspace_id,movement_id,sku_id,location_id,expected_qty,counted_qty,reason_code,notes,actor_user_id,created_at)
   SELECT x.adjustment_id,$1,x.id,x.sku_id,x.location_id,x.quantity,0,$3,$4,$5,$6 FROM jsonb_to_recordset($2::jsonb) x(adjustment_id text,id text,sku_id text,location_id text,quantity numeric)`,
   [ctx.workspaceId,payload,options.reasonCode,options.notes||null,ctx.actorId,at]);
  let journalId=null;
  if(value>0){
   const settings=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
   if(!settings)throw new ValidationError('Set up the inventory currency before removing valued stock.');
   const journal=await ledger.postInTransaction(client,ctx,{sourceKey:'stock-writeoff:'+newAppendId('wo'),sourceType:options.sourceType,sourceRecordType:options.sourceRecordType,sourceRecordId:options.sourceRecordId,
    currency:settings.base_currency,description:options.description,lines:[{accountKey:options.debitAccountKey,debitMinor:value},{accountKey:'INVENTORY_ASSET',creditMinor:value}]});
   journalId=journal.entry.id;result.journalEntryIds.push(journalId);
  }
  if(costed.length){const costPayload=JSON.stringify(costed);
   const zeroed=await client.query(`UPDATE accounting_inventory_cost_balances c SET quantity_units=0,total_cost_minor=0,secondary_quantity_units=NULL,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) x(sku_id text,location_id text,costed numeric)
    WHERE c.workspace_id=$1 AND c.sku_id=x.sku_id AND c.location_id=x.location_id AND c.quantity_units=x.costed`,[ctx.workspaceId,costPayload,at]);
   if(zeroed.rowCount!==costed.length)throw new InvariantError('Recorded stock cost changed while it was being removed. Try again.','stock_changed');
   await client.query(`INSERT INTO accounting_inventory_cost_movements(id,workspace_id,inventory_movement_id,inventory_group_id,sku_id,location_id,quantity_delta,cost_delta_minor,unit_cost_minor,balance_quantity_units,balance_cost_minor,journal_entry_id,cost_source_type,cost_source_record_id,created_at)
    SELECT x.cost_id,$1,x.id,x.group_id,x.sku_id,x.location_id,-x.costed,-x.cost,NULL,0,0,$3,$4,$5,$6 FROM jsonb_to_recordset($2::jsonb) x(cost_id text,id text,group_id text,sku_id text,location_id text,costed numeric,cost bigint)`,
    [ctx.workspaceId,costPayload,journalId,options.sourceType,options.sourceRecordId||null,at]);
  }
  result.positions+=movements.length;result.valueMinor+=value;
 }
 return result;
}
module.exports={summarize,writeOffInTransaction,CHUNK};

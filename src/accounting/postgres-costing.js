'use strict';

const { newId, nowIso } = require('../lib/util');
const { ValidationError, InvariantError } = require('../domain/errors');

async function movement(client, ctx, movementId, direction) {
  const result = await client.query(`SELECT * FROM movements WHERE id=$1 AND workspace_id=$2`,[movementId,ctx.workspaceId]);
  const row=result.rows[0];
  if(!row)throw new ValidationError('The inventory movement used for costing could not be found.');
  if(direction==='in'&&Number(row.quantity_delta)<=0)throw new ValidationError('Receipt costing requires an incoming movement.');
  if(direction==='out'&&Number(row.quantity_delta)>=0)throw new ValidationError('Issue costing requires an outgoing movement.');
  const prior=await client.query(`SELECT * FROM accounting_inventory_cost_movements
    WHERE workspace_id=$1 AND inventory_movement_id=$2`,[ctx.workspaceId,movementId]);
  return {row,prior:prior.rows[0]||null};
}

async function lockState(client,ctx,skuId,locationId){
  await client.query(`INSERT INTO accounting_inventory_cost_balances
    (workspace_id,sku_id,location_id,quantity_units,total_cost_minor,updated_at)
    VALUES($1,$2,$3,0,0,$4) ON CONFLICT(workspace_id,sku_id,location_id) DO NOTHING`,
  [ctx.workspaceId,skuId,locationId,nowIso()]);
  return (await client.query(`SELECT * FROM accounting_inventory_cost_balances
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE`,[ctx.workspaceId,skuId,locationId])).rows[0];
}

async function append(client,ctx,row,input,quantityDelta,costDelta,after){
  await client.query(`INSERT INTO accounting_inventory_cost_movements
    (id,workspace_id,inventory_movement_id,inventory_group_id,sku_id,location_id,quantity_delta,cost_delta_minor,
     unit_cost_minor,balance_quantity_units,balance_cost_minor,journal_entry_id,cost_source_type,cost_source_record_id,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [newId('icm'),ctx.workspaceId,row.id,row.group_id,row.sku_id,row.location_id,quantityDelta,costDelta,
    input.unitCostMinor??null,after.quantity,after.cost,input.journalEntryId||null,input.sourceType,
    input.sourceRecordId||null,nowIso()]);
}

async function receiveManyInTransaction(client,ctx,inputs){
  if(!Array.isArray(inputs))throw new ValidationError('Receipt costs must be a list.');if(!inputs.length)return [];
  const ids=[...new Set(inputs.map(input=>input.movementId))],movements=(await client.query('SELECT * FROM movements WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',[ctx.workspaceId,ids])).rows,byId=new Map(movements.map(row=>[row.id,row]));
  const prior=(await client.query('SELECT * FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND inventory_movement_id=ANY($2::text[])',[ctx.workspaceId,ids])).rows,results=new Map(prior.map(row=>[row.inventory_movement_id,{replayed:true,totalCostMinor:Number(row.cost_delta_minor)}])),fresh=new Map();
  for(const input of inputs){const row=byId.get(input.movementId);if(!row)throw new ValidationError('The inventory movement used for costing could not be found.');if(Number(row.quantity_delta)<=0)throw new ValidationError('Receipt costing requires an incoming movement.');if(results.has(row.id)||fresh.has(row.id))continue;
    const quantity=Number(row.quantity_delta),total=input.totalCostMinor!=null?Number(input.totalCostMinor):quantity*Number(input.unitCostMinor);if(!Number.isSafeInteger(total)||total<0)throw new ValidationError('Received inventory requires an exact non-negative cost.');fresh.set(row.id,{row,input,quantity,total});}
  const values=[...fresh.values()];if(values.length){
    const positions=[...new Map(values.map(value=>[JSON.stringify([value.row.sku_id,value.row.location_id]),{sku_id:value.row.sku_id,location_id:value.row.location_id}])).values()].sort((a,b)=>a.sku_id.localeCompare(b.sku_id)||a.location_id.localeCompare(b.location_id)),payload=JSON.stringify(positions),at=nowIso();
    await client.query(`INSERT INTO accounting_inventory_cost_balances(workspace_id,sku_id,location_id,quantity_units,total_cost_minor,updated_at) SELECT $1,x.sku_id,x.location_id,0,0,$3 FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text) ON CONFLICT(workspace_id,sku_id,location_id) DO NOTHING`,[ctx.workspaceId,payload,at]);
    const positionSkus=[...new Set(positions.map(p=>p.sku_id))];
    const balances=(await client.query(`SELECT b.* FROM accounting_inventory_cost_balances b JOIN jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text) ON x.sku_id=b.sku_id AND x.location_id=b.location_id WHERE b.workspace_id=$1 AND b.sku_id=ANY($3::text[]) ORDER BY b.sku_id,b.location_id FOR UPDATE OF b`,[ctx.workspaceId,payload,positionSkus])).rows;
    const states=new Map(balances.map(row=>[JSON.stringify([row.sku_id,row.location_id]),{sku_id:row.sku_id,location_id:row.location_id,quantity:Number(row.quantity_units),cost:Number(row.total_cost_minor)}])),appended=[];
    for(const value of values){const {row,input,quantity,total}=value,state=states.get(JSON.stringify([row.sku_id,row.location_id]));state.quantity+=quantity;state.cost+=total;if(!Number.isSafeInteger(state.quantity)||!Number.isSafeInteger(state.cost))throw new ValidationError('Receipt cost totals exceed the supported exact range.');
      appended.push({id:newId('icm'),inventory_movement_id:row.id,inventory_group_id:row.group_id,sku_id:row.sku_id,location_id:row.location_id,quantity_delta:quantity,cost_delta_minor:total,unit_cost_minor:input.unitCostMinor??null,balance_quantity_units:state.quantity,balance_cost_minor:state.cost,journal_entry_id:input.journalEntryId||null,cost_source_type:input.sourceType,cost_source_record_id:input.sourceRecordId||null,created_at:nowIso()});results.set(row.id,{replayed:false,totalCostMinor:total,balance:{quantity:state.quantity,cost:state.cost}});}
    await client.query(`UPDATE accounting_inventory_cost_balances b SET quantity_units=x.quantity,total_cost_minor=x.cost,updated_at=$3 FROM jsonb_to_recordset($2::jsonb) AS x(sku_id text,location_id text,quantity bigint,cost bigint) WHERE b.workspace_id=$1 AND b.sku_id=ANY($4::text[]) AND b.sku_id=x.sku_id AND b.location_id=x.location_id`,[ctx.workspaceId,JSON.stringify([...states.values()]),at,positionSkus]);
    await client.query(`INSERT INTO accounting_inventory_cost_movements(id,workspace_id,inventory_movement_id,inventory_group_id,sku_id,location_id,quantity_delta,cost_delta_minor,unit_cost_minor,balance_quantity_units,balance_cost_minor,journal_entry_id,cost_source_type,cost_source_record_id,created_at)
      SELECT x.id,$1,x.inventory_movement_id,x.inventory_group_id,x.sku_id,x.location_id,x.quantity_delta,x.cost_delta_minor,x.unit_cost_minor,x.balance_quantity_units,x.balance_cost_minor,x.journal_entry_id,x.cost_source_type,x.cost_source_record_id,x.created_at FROM jsonb_to_recordset($2::jsonb) AS x(id text,inventory_movement_id text,inventory_group_id text,sku_id text,location_id text,quantity_delta bigint,cost_delta_minor bigint,unit_cost_minor bigint,balance_quantity_units bigint,balance_cost_minor bigint,journal_entry_id text,cost_source_type text,cost_source_record_id text,created_at text)`,[ctx.workspaceId,JSON.stringify(appended)]);
  }
  const seen=new Set(prior.map(row=>row.inventory_movement_id));return inputs.map(input=>{const result=results.get(input.movementId);if(seen.has(input.movementId))return {replayed:true,totalCostMinor:result.totalCostMinor};seen.add(input.movementId);return result;});
}
async function receiveInTransaction(client,ctx,input){return (await receiveManyInTransaction(client,ctx,[input]))[0];}

async function prepareIssueInTransaction(client,ctx,input){
  const evidence=await movement(client,ctx,input.movementId,'out');
  if(evidence.prior)return {replayed:true,totalCostMinor:Math.abs(Number(evidence.prior.cost_delta_minor)),evidence};
  const quantity=Math.abs(Number(evidence.row.quantity_delta));
  const before=await lockState(client,ctx,evidence.row.sku_id,evidence.row.location_id);
  const available=Number(before.quantity_units);
  if(available<quantity)throw new ValidationError('Inventory was issued before its receipt cost was established.');
  const cost=quantity===available?Number(before.total_cost_minor):Math.round(Number(before.total_cost_minor)*quantity/available);
  return {replayed:false,totalCostMinor:cost,quantity,before,evidence};
}

async function commitIssueInTransaction(client,ctx,prepared,input){
  if(prepared.replayed)return {replayed:true,totalCostMinor:prepared.totalCostMinor};
  const after={quantity:Number(prepared.before.quantity_units)-prepared.quantity,
    cost:Number(prepared.before.total_cost_minor)-prepared.totalCostMinor};
  if(after.quantity<0||after.cost<0)throw new InvariantError('Inventory cost state cannot become negative.','invalid_inventory_cost_state');
  if(after.quantity===0)after.cost=0;
  const row=prepared.evidence.row;
  await client.query(`UPDATE accounting_inventory_cost_balances SET quantity_units=$4,total_cost_minor=$5,updated_at=$6
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
  [ctx.workspaceId,row.sku_id,row.location_id,after.quantity,after.cost,nowIso()]);
  await append(client,ctx,row,input,-prepared.quantity,-prepared.totalCostMinor,after);
  return {replayed:false,totalCostMinor:prepared.totalCostMinor,balance:after};
}

async function transferInTransaction(client,ctx,input){
  const outgoing=await movement(client,ctx,input.outMovementId,'out');
  const incoming=await movement(client,ctx,input.inMovementId,'in');
  if(Boolean(outgoing.prior)!==Boolean(incoming.prior)){
    throw new InvariantError('Transferred inventory cost evidence is incomplete.','partial_transfer_cost_state');
  }
  if(outgoing.prior&&incoming.prior){
    return {replayed:true,totalCostMinor:Math.abs(Number(outgoing.prior.cost_delta_minor))};
  }
  const prepared=await prepareIssueInTransaction(client,ctx,{movementId:input.outMovementId});
  const common={journalEntryId:input.journalEntryId||null,sourceType:input.sourceType,
    sourceRecordId:input.sourceRecordId||null};
  const removed=await commitIssueInTransaction(client,ctx,prepared,common);
  const received=await receiveInTransaction(client,ctx,{movementId:input.inMovementId,
    totalCostMinor:removed.totalCostMinor,...common});
  return {replayed:false,totalCostMinor:removed.totalCostMinor,sourceBalance:removed.balance,
    destinationBalance:received.balance};
}

module.exports={receiveInTransaction,receiveManyInTransaction,prepareIssueInTransaction,commitIssueInTransaction,transferInTransaction};

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

async function receiveInTransaction(client,ctx,input){
  const evidence=await movement(client,ctx,input.movementId,'in');
  if(evidence.prior)return {replayed:true,totalCostMinor:Number(evidence.prior.cost_delta_minor)};
  const quantity=Number(evidence.row.quantity_delta);
  const total=input.totalCostMinor!=null?Number(input.totalCostMinor):quantity*Number(input.unitCostMinor);
  if(!Number.isSafeInteger(total)||total<0)throw new ValidationError('Received inventory requires an exact non-negative cost.');
  const before=await lockState(client,ctx,evidence.row.sku_id,evidence.row.location_id);
  const after={quantity:Number(before.quantity_units)+quantity,cost:Number(before.total_cost_minor)+total};
  await client.query(`UPDATE accounting_inventory_cost_balances SET quantity_units=$4,total_cost_minor=$5,updated_at=$6
    WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,
  [ctx.workspaceId,evidence.row.sku_id,evidence.row.location_id,after.quantity,after.cost,nowIso()]);
  await append(client,ctx,evidence.row,input,quantity,total,after);
  return {replayed:false,totalCostMinor:total,balance:after};
}

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

module.exports={receiveInTransaction,prepareIssueInTransaction,commitIssueInTransaction,transferInTransaction};

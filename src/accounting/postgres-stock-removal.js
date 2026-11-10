'use strict';
const inventory=require('../domain/postgres-inventory-engine'),costing=require('./postgres-costing'),ledger=require('./postgres-ledger');
const {ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity');

// Takes the value of stock that already left the shelf out of the books with it:
// the cost records shrink and Inventory is credited (to cost of goods sold for a
// sale, else to inventory adjustments). `physicalBefore` is the shelf count
// before the movement. Stock only partly costed cannot say which units left;
// strict callers refuse it, others leave it for the owner to record its cost.
async function followRemovalValueInTransaction(client,ctx,input){
 const prior=(await client.query('SELECT cost_delta_minor,journal_entry_id FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND inventory_movement_id=$2',[ctx.workspaceId,input.movementId])).rows[0];
 if(prior)return {costRemovedMinor:-Number(prior.cost_delta_minor),journalEntryId:prior.journal_entry_id};
 const balance=(await client.query('SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,input.skuId,input.locationId])).rows[0];
 if(!balance||Number(balance.quantity_units)===0)return {costRemovedMinor:0,journalEntryId:null};
 if(exact.canonical(balance.quantity_units)!==exact.canonical(input.physicalBefore)){
  if(input.strict)throw new ValidationError('Some stock at this location is missing its purchase cost. Record that cost before removing valued stock.');
  return {costRemovedMinor:0,journalEntryId:null,skipped:'partly_costed'};
 }
 const settings=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!settings){if(input.strict)throw new ValidationError('Configure accounting before removing valued stock.');return {costRemovedMinor:0,journalEntryId:null,skipped:'no_books'};}
 const prepared=await costing.prepareIssueInTransaction(client,ctx,{movementId:input.movementId});
 const sourceType=input.sourceType||'manual_stock_removal';let journal=null;
 if(prepared.totalCostMinor)journal=await ledger.postInTransaction(client,ctx,{sourceKey:(input.keyPrefix||'manual-issue:')+input.movementId,sourceType,sourceRecordType:'movement',sourceRecordId:input.movementId,
  postingDate:input.occurredAt?await require('../lib/business-time').today(client,ctx.workspaceId,new Date(input.occurredAt)):await require('../lib/business-time').today(client,ctx.workspaceId),currency:settings.base_currency,
  description:'Stock removed: '+(input.reasonCode||'manual removal'),lines:[{accountKey:['sold','sale'].includes(input.reasonCode)?'COST_OF_GOODS_SOLD':'INVENTORY_ADJUSTMENTS',debitMinor:prepared.totalCostMinor,skuId:input.skuId,locationId:input.locationId},{accountKey:'INVENTORY_ASSET',creditMinor:prepared.totalCostMinor,skuId:input.skuId,locationId:input.locationId}]});
 await costing.commitIssueInTransaction(client,ctx,prepared,{journalEntryId:journal?.entry.id||null,sourceType,sourceRecordId:input.movementId});
 return {costRemovedMinor:prepared.totalCostMinor,journalEntryId:journal?.entry.id||null};
}

// Moves the value of stock that changed location along with it, when every unit
// at the source carried a cost. Value never leaves the books, so no entry posts.
async function followTransferValueInTransaction(client,ctx,input){
 const balance=(await client.query('SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,input.skuId,input.sourceLocationId])).rows[0];
 if(!balance||Number(balance.quantity_units)===0||exact.canonical(balance.quantity_units)!==exact.canonical(input.sourceBefore))return {totalCostMinor:0,skipped:true};
 return costing.transferInTransaction(client,ctx,{outMovementId:input.outMovementId,inMovementId:input.inMovementId,sourceType:input.sourceType,sourceRecordId:input.sourceRecordId||null});
}

// Manual removals need their own accounting. Sales, transfers and production
// continue using their canonical accounting workflows around the stock engine.
async function issueInTransaction(client,ctx,input){
 const physical=await inventory.issueInTransaction(client,ctx,input);
 const prior=(await client.query('SELECT cost_delta_minor,journal_entry_id FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND inventory_movement_id=$2',[ctx.workspaceId,physical.movementId])).rows[0];
 if(prior)return {...physical,costRemovedMinor:-Number(prior.cost_delta_minor),journalEntryId:prior.journal_entry_id};
 if(physical.replayed)return {...physical,costRemovedMinor:0,journalEntryId:null};
 const value=await followRemovalValueInTransaction(client,ctx,{skuId:input.skuId,locationId:input.locationId,movementId:physical.movementId,
  physicalBefore:exact.add(physical.balanceAfter,physical.quantity),reasonCode:input.reasonCode,occurredAt:input.occurredAt,strict:true});
 return {...physical,costRemovedMinor:value.costRemovedMinor,journalEntryId:value.journalEntryId};
}
async function issue(database,ctx,input){return database.transaction(client=>issueInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:Boolean(input.idempotencyKey)});}
module.exports={issue,issueInTransaction,followRemovalValueInTransaction,followTransferValueInTransaction};

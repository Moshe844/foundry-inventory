'use strict';
const inventory=require('../domain/postgres-inventory-engine'),costing=require('./postgres-costing'),ledger=require('./postgres-ledger');
const {ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity');
// Manual removals need their own accounting. Sales, transfers and production
// continue using their canonical accounting workflows around the stock engine.
async function issueInTransaction(client,ctx,input){
 const physical=await inventory.issueInTransaction(client,ctx,input);
 const prior=(await client.query('SELECT cost_delta_minor,journal_entry_id FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND inventory_movement_id=$2',[ctx.workspaceId,physical.movementId])).rows[0];
 if(prior)return {...physical,costRemovedMinor:-Number(prior.cost_delta_minor),journalEntryId:prior.journal_entry_id};
 if(physical.replayed)return {...physical,costRemovedMinor:0,journalEntryId:null};
 const balance=(await client.query('SELECT quantity_units FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',[ctx.workspaceId,input.skuId,input.locationId])).rows[0];
 if(!balance||Number(balance.quantity_units)===0)return {...physical,costRemovedMinor:0,journalEntryId:null};
 if(exact.canonical(balance.quantity_units)!==exact.canonical(exact.add(physical.balanceAfter,physical.quantity)))throw new ValidationError('Some stock at this location is missing its purchase cost. Record that cost before removing valued stock.');
 const prepared=await costing.prepareIssueInTransaction(client,ctx,{movementId:physical.movementId});
 const settings=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!settings)throw new ValidationError('Configure accounting before removing valued stock.');
 const sourceType='manual_stock_removal';let journal=null;
 if(prepared.totalCostMinor)journal=await ledger.postInTransaction(client,ctx,{sourceKey:'manual-issue:'+physical.movementId,sourceType,sourceRecordType:'movement',sourceRecordId:physical.movementId,
  postingDate:input.occurredAt?await require('../lib/business-time').today(client,ctx.workspaceId,new Date(input.occurredAt)):await require('../lib/business-time').today(client,ctx.workspaceId),currency:settings.base_currency,
  description:'Stock removed: '+(input.reasonCode||'manual removal'),lines:[{accountKey:['sold','sale'].includes(input.reasonCode)?'COST_OF_GOODS_SOLD':'INVENTORY_ADJUSTMENTS',debitMinor:prepared.totalCostMinor,skuId:input.skuId,locationId:input.locationId},{accountKey:'INVENTORY_ASSET',creditMinor:prepared.totalCostMinor,skuId:input.skuId,locationId:input.locationId}]});
 await costing.commitIssueInTransaction(client,ctx,prepared,{journalEntryId:journal?.entry.id||null,sourceType,sourceRecordId:physical.movementId});
 return {...physical,costRemovedMinor:prepared.totalCostMinor,journalEntryId:journal?.entry.id||null};
}
async function issue(database,ctx,input){return database.transaction(client=>issueInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:Boolean(input.idempotencyKey)});}
module.exports={issue,issueInTransaction};

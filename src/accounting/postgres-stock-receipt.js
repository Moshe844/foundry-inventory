'use strict';
const inventory=require('../domain/postgres-inventory-engine'),money=require('../domain/currency'),exact=require('../domain/exact-quantity');
const {ValidationError}=require('../domain/errors');
async function receiveInTransaction(client,ctx,input){
 await require('../operations/postgres-warehouse-access').assertLocations(client,ctx,[input.locationId]);
 const prior=(await client.query("SELECT result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='inventory.receive' AND idempotency_key=$2 AND status='COMPLETED'",[ctx.workspaceId,input.idempotencyKey])).rows[0];
 if(prior)return {...prior.result,replayed:true};
 const settings=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!settings)throw new ValidationError('Set up the inventory currency before recording a purchase cost.');
 const purchase=await require('../pricing/postgres-service').purchaseCost(client,ctx.workspaceId,input.skuId);
 const unitCost=input.unitCost!=null&&String(input.unitCost).trim()!==''?money.toMinor(input.unitCost,settings.base_currency,{label:'Unit cost'}):purchase?.currency===settings.base_currency?purchase.amount_minor:null;
 if(unitCost===null)throw new ValidationError('Enter a unit cost for this receipt, or save the variant’s purchase cost first. Enter 0 only if the stock cost nothing.');
 const received=await inventory.receiveInTransaction(client,ctx,input);
 const total=exact.costMinor(input.secondaryQuantity??received.quantity,unitCost);let journal=null;
 if(total)journal=await require('./postgres-ledger').postInTransaction(client,ctx,{postingDate:await require('../lib/business-time').today(client,ctx.workspaceId),sourceKey:'receipt:'+input.idempotencyKey,sourceType:'manual_stock_receipt',sourceRecordType:'movement',sourceRecordId:received.movementId,currency:settings.base_currency,description:'Stock receipt awaiting supplier invoice',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:total,skuId:input.skuId,locationId:input.locationId},{accountKey:'RECEIVED_NOT_INVOICED',creditMinor:total,skuId:input.skuId,locationId:input.locationId}]});
 await require('./postgres-costing').receiveInTransaction(client,ctx,{movementId:received.movementId,unitCostMinor:unitCost,totalCostMinor:total,journalEntryId:journal?.entry.id||null,sourceType:'manual_stock_receipt',sourceRecordId:received.movementId});
 return received;
}
async function receive(db,ctx,input){return db.transaction(client=>receiveInTransaction(client,ctx,input),{isolation:'SERIALIZABLE',retrySafe:Boolean(input.idempotencyKey)});}
module.exports={receive,receiveInTransaction};

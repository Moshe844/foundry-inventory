'use strict';
const {ValidationError}=require('./errors'),inventory=require('./postgres-inventory-engine'),pricing=require('../pricing/postgres-service'),money=require('./currency');
async function receiveInTransaction(client,ctx,input){
 const prior=(await client.query("SELECT result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='inventory.receive' AND idempotency_key=$2 AND status='COMPLETED'",[ctx.workspaceId,input.idempotencyKey])).rows[0];if(prior)return {...prior.result,replayed:true};
 const quantity=Number(input.quantity);if(!Number.isSafeInteger(quantity)||quantity<=0)throw new ValidationError('Starting quantity must be a positive whole number.');
 const previous=(await client.query('SELECT 1 FROM movements WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 LIMIT 1',[ctx.workspaceId,input.skuId,input.locationId])).rows.length;
 if(previous)throw new ValidationError('Opening stock has already been recorded at this location. Use Receive stock or a physical count for later changes.');
 const settings=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];const currency=settings?.base_currency||'USD';
 const purchase=await pricing.purchaseCost(client,ctx.workspaceId,input.skuId);
 const unitCost=input.unitCost!=null&&String(input.unitCost).trim()!==''?money.toMinor(input.unitCost,currency):purchase?.currency===currency?purchase.amount_minor:null;
 if(unitCost===null)throw new ValidationError('Enter the purchase cost per unit for your starting stock. Enter 0 only if it cost nothing.');
 if(!Number.isSafeInteger(unitCost)||unitCost<0||!Number.isSafeInteger(unitCost*quantity))throw new ValidationError('Enter a valid starting stock cost.');
 const received=await inventory.receiveInTransaction(client,ctx,{...input,quantity,reasonCode:'opening',reference:input.reference||'Opening stock'});
 const total=unitCost*quantity;let journal=null;
 if(total)journal=await require('../accounting/postgres-ledger').postInTransaction(client,ctx,{postingDate:await require('../lib/business-time').today(client,ctx.workspaceId),sourceKey:'opening:'+input.idempotencyKey,sourceType:'opening_inventory',sourceRecordType:'movement',sourceRecordId:received.movementId,currency,description:'Starting stock and purchase cost',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:total},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:total}]});
 await require('../accounting/postgres-costing').receiveInTransaction(client,ctx,{movementId:received.movementId,totalCostMinor:total,unitCostMinor:unitCost,journalEntryId:journal?.entry.id||null,sourceType:'opening_inventory',sourceRecordId:received.movementId});return received;
}
async function receive(db,ctx,input){return db.transaction(client=>receiveInTransaction(client,ctx,input),{isolation:'SERIALIZABLE'});}
module.exports={receive,receiveInTransaction};

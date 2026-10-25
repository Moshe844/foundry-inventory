'use strict';
const {ValidationError}=require('../domain/errors'),inventory=require('../domain/postgres-inventory-engine'),costing=require('./postgres-costing'),ledger=require('./postgres-ledger');
const {nowIso}=require('../lib/util');
async function applyInTransaction(client,ctx,input){
 const state=(await client.query(`SELECT COALESCE(b.on_hand,0) AS physical,COALESCE(c.quantity_units,0) AS costed,COALESCE(c.total_cost_minor,0) AS value
   FROM skus s LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=$3
   LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=s.workspace_id AND c.sku_id=s.id AND c.location_id=$3
   WHERE s.workspace_id=$1 AND s.id=$2`,[ctx.workspaceId,input.skuId,input.locationId])).rows[0];
 if(!state)throw new ValidationError('That stock position is not in this inventory.');
 const before={physical:Number(state.physical),costed:Number(state.costed),value:Number(state.value)};
 const prior=(await client.query("SELECT result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='inventory.adjust' AND idempotency_key=$2 AND status='COMPLETED'",[ctx.workspaceId,input.idempotencyKey])).rows[0];
 if(prior){const cost=(await client.query('SELECT cost_delta_minor,journal_entry_id FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND inventory_movement_id=$2',[ctx.workspaceId,prior.result.movementId||null])).rows[0];return {...prior.result,costDeltaMinor:Number(cost?.cost_delta_minor||0),journalEntryId:cost?.journal_entry_id||null,replayed:true};}
 if(input.expectedBefore&&['physical','costed','value'].some(k=>Number(input.expectedBefore[k])!==before[k]))throw new ValidationError('This stock or its recorded cost changed after the preview. Recalculate before setting its count.');
 const counted=Number(input.countedQuantity),delta=counted-before.physical;
 if(delta<0&&before.costed>0&&before.costed!==before.physical)throw new ValidationError('This position mixes costed and uncosted stock. Establish its cost evidence before reducing it with a file count.');
 const physical=await inventory.adjustInTransaction(client,ctx,{...input,countedQuantity:counted});
 if(physical.unchanged)return {...physical,costDeltaMinor:0,journalEntryId:null};
 const settings=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 const sourceType=input.sourceType||'inventory_count',sourceId=input.sourceRecordId||physical.adjustmentId;
 let costDeltaMinor=0,prepared=null;
 if(delta<0&&before.costed>0){prepared=await costing.prepareIssueInTransaction(client,ctx,{movementId:physical.movementId});costDeltaMinor=-prepared.totalCostMinor;}
 if(delta>0&&input.unitCostMinor!==undefined&&input.unitCostMinor!==null){if(!Number.isSafeInteger(input.unitCostMinor)||input.unitCostMinor<0||!Number.isSafeInteger(delta*input.unitCostMinor))throw new ValidationError('The count cost exceeds the exact supported range.');costDeltaMinor=delta*input.unitCostMinor;}
 if(input.expectedCostDeltaMinor!==undefined&&costDeltaMinor!==input.expectedCostDeltaMinor)throw new ValidationError('The count value changed after the preview. Review its current cost.');
 if(costDeltaMinor&&(!settings||input.currency&&input.currency!==settings.base_currency))throw new ValidationError('Configure the matching accounting currency before changing valued inventory.');
 const postingDate=input.postingDate||await require('../lib/business-time').today(client,ctx.workspaceId);let journal=null;
 if(costDeltaMinor)journal=await ledger.postInTransaction(client,ctx,{sourceKey:input.idempotencyKey,sourceType,sourceRecordType:input.sourceRecordType||'adjustment',sourceRecordId:sourceId,postingDate,currency:settings.base_currency,description:input.description||'Confirmed physical inventory count',
   lines:costDeltaMinor>0?[{accountKey:'INVENTORY_ASSET',debitMinor:costDeltaMinor},{accountKey:'INVENTORY_ADJUSTMENTS',creditMinor:costDeltaMinor}]:[{accountKey:'INVENTORY_ADJUSTMENTS',debitMinor:-costDeltaMinor},{accountKey:'INVENTORY_ASSET',creditMinor:-costDeltaMinor}]});
 const costInput={journalEntryId:journal?.entry.id||null,sourceType,sourceRecordId:sourceId};
 if(prepared)await costing.commitIssueInTransaction(client,ctx,prepared,costInput);
 if(delta>0&&input.unitCostMinor!==undefined&&input.unitCostMinor!==null)await costing.receiveInTransaction(client,ctx,{...costInput,movementId:physical.movementId,unitCostMinor:input.unitCostMinor,totalCostMinor:costDeltaMinor});
 return {...physical,costDeltaMinor,journalEntryId:journal?.entry.id||null};
}
module.exports={applyInTransaction};

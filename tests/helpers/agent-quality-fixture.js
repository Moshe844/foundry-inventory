'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t,plan='pro'){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:8}),{db,ctx}=f;
 await f.subscribe(plan);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,last_unit_cost,minimum_order_quantity,order_multiple,created_at,updated_at)
  VALUES($1,$2,'fixture-supplier',$3,1,1,1,now()::text,now()::text) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[randomUUID(),ctx.workspaceId,f.item.skuIds[0]]);
 const quality=require('../../src/operations/agent-quality-holds'),inventory=require('../../src/domain/postgres-inventory-engine');
 const scope={supplierId:'fixture-supplier',skuId:f.item.skuIds[0],locationId:f.location.id,checklist:['Check packaging is intact','Check contents match the ordered product'],maxUnits:10,confirmed:'yes'};
 async function order(quantity=10){const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:scope.supplierId,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:scope.skuId,quantityUnits:quantity,unitCost:1}]});await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});return {...po,quantity};}
 async function receive(po,input={}){return f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:po.quantity,locationId:f.location.id}],...input});}
 async function available(){return require('../../src/domain/postgres-stock-availability').read(db,ctx.workspaceId,scope.skuId,f.location.id);}
 async function rule(id){return quality.getPolicy(db,ctx,id);}
 async function hold(id){return quality.hold(db,ctx,id);}
 return {...f,quality,inventory,scope,order,receive,available,rule,hold};
}
module.exports={fixture};

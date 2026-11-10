'use strict';const {randomUUID}=require('node:crypto');
async function fixture(t,plan='growth'){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20});await f.subscribe(plan);await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);const source=require('../../src/purchasing/fx-reference'),service=require('../../src/purchasing/agent-purchase-fx'),date=await require('../../src/lib/business-time').today(f.db,f.ctx.workspaceId),quote={date,rates:{EUR:'1',USD:'1.1',GBP:'0.8',JPY:'160'},url:source.url};t.mock.method(source,'latest',async()=>quote);
 async function foreign({currency='EUR',quantity=10,cost=10}={}){return f.workflows.createPurchaseOrder(f.db,f.ctx,{supplierId:'fixture-supplier',currency,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:quantity,unitCost:cost}]});}
 async function save(p,rest={}){const facts=await service.purchase(f.db,f.ctx,p.purchaseOrderId),saved=await service.baseline(f.db,f.ctx,facts.id);return service.saveBaseline(f.db,f.ctx,{purchaseOrderId:facts.id,sourceHash:facts.sourceHash,basePerForeign:'1',quotedOn:date,sourceReference:'Checked original supplier budget quote',revision:saved?.revision||0,confirmed:'yes',...rest});}
 return {...f,source,service,date,quote,foreign,save};
}
module.exports={fixture};

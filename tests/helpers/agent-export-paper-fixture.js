'use strict';const {randomUUID}=require('node:crypto');
async function fixture(t,plan='pro'){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe(plan);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await require('../../src/operations/postgres-company-profile').save(db,ctx,{legalName:'Fixture Export Company',addressLine1:'1 Main St',addressLine2:'',city:'Monroe',region:'NY',postalCode:'10950',country:'US',revision:0});
 const fields={line1:'100 King Street West',line2:'Suite 200',city:'Toronto',state:'ON',postalCode:'M5X 1A9',country:'CA'},address=require('../../src/sales/customer-address').fromInput({addressLine1:fields.line1,addressLine2:fields.line2,...fields});
 await db.query("UPDATE customers SET shipping_address=$2,shipping_address_fields=$3::jsonb WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId,address.text,JSON.stringify(fields)]);
 const service=require('../../src/shipping/agent-export-papers'),assistant=require('../../src/assistant/postgres-service');await service.saveProfile(db,ctx,{countryCode:'US',deliveryTerms:'DAP Toronto as agreed',revision:0,confirmed:'yes'});
 const sku=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 await service.saveProducts(db,ctx,{confirmed:'yes',products:[{sku,description:'Recorded sample whole-unit product',hsCode:'820559',originCountry:'US',netWeightGrams:100}]});
 const prepare=p=>assistant.prepareAction(db,ctx,'Prepare this private export invoice draft and packing list',{action:service.action,recordReference:p.shipmentId});
 async function mission(p){const q=await prepare(p),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');if(q.status!=='PREPARED')throw Error(JSON.stringify(q));await plans.save(db,ctx,'Prepare this export packet then review products',randomUUID(),[{contract:registry.get(service.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}],[{result:q},{result:{status:'CLARIFY'}}]);return q;}
 return {...f,sku,fields,service,assistant,prepare,mission};
}
module.exports={fixture};

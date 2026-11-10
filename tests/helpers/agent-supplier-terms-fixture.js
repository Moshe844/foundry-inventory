'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await db.query("UPDATE suppliers SET email='supplier@example.test',contact_name='Original contact',phone='555-000-0000' WHERE id='fixture-supplier'");
 await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:f.item.skuIds[0],supplierSku:'VENDOR-1',purchaseUnit:'case',unitsPerPurchaseUnit:12,lastUnitCost:9.50,leadTimeDays:7,minimumOrderQuantity:2,orderMultiple:1,isPreferred:true,notes:'Keep these notes'});
 const connector=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Supplier mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'supplier-source-mailbox',now(),now())`,[connector,ctx.workspaceId,ctx.actorId]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connector])).rows[0],service=require('../../src/purchasing/agent-supplier-email-terms'),source=require('../../src/purchasing/supplier-email-terms-source'),code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const caps={maximumLeadDays:30,maximumLeadChangeDays:10,maximumMoq:10,maximumMoqChange:3};
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const incoming=({lead=10,moq=3,date=today,extra='',contacts='',sender='supplier@example.test',receivedAt,codeValue=code,unit='case'}={})=>require('../../src/connections/postgres-mail').capture(db,connection,{externalMessageId:randomUUID(),sender,subject:'Supplier terms update',receivedAt,bodyText:'Effective date: '+date+'\n'+contacts+'SKU,Purchase unit,Lead time days,Minimum order quantity\n'+codeValue+','+unit+','+lead+','+moq+extra});
 const review=id=>service.preview(db,ctx,id),apply=async(id,override={})=>{const p=await review(id);return service.apply(db,ctx,id,{confirmed:'yes',expectedFingerprint:p.facts.sourceFingerprint,...override});};
 const enable=(overrides={})=>service.configure(db,ctx,'fixture-supplier',{connectorId:connector,skuIds:[f.item.skuIds[0]],fields:['lead_time_days','minimum_order_quantity'],...caps,confirmed:'yes',revision:0,...overrides});
 const item=async()=>(await db.query("SELECT * FROM supplier_items WHERE workspace_id=$1 AND supplier_id='fixture-supplier'",[ctx.workspaceId])).rows[0];
 return {...f,skuId:f.item.skuIds[0],connector,connection,service,source,code,caps,today,incoming,review,apply,enable,item};
}
module.exports={fixture};

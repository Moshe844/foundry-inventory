'use strict';
// Two months of posted sales for the monthly report jobs (157, 159).
// The month before: 10 Anchor bolts at $10 (cost $2) and 6 Clamps at $3 (cost
// $1), which sells the Clamps out. The month: Anchor bolts cost $4 (average $3)
// and sell 8 at $12 with a $6 discount; a new Bracket sells 2 at $20 through
// the web shop; one Anchor bolt is damaged; a $10 refund; no Clamps all month.
const {randomUUID}=require('node:crypto');
const reportRuns=require('../../src/reports/agent-report-runs');
async function setup(t,{job,kind}){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,ws=ctx.workspaceId,w=f.workflows;
  const time=require('../../src/lib/business-time'),catalog=require('../../src/domain/postgres-catalog-service');
  const zone='America/New_York';
  await db.query('UPDATE workspaces SET time_zone=$2 WHERE id=$1',[ws,zone]);
  const today=await time.today(db,ws),month=reportRuns.lastCompleted(today),prior=reportRuns.addMonths(month,-1);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,reportRuns.addMonths(prior,-1)+'-01']);
  await f.subscribe('growth');
  const at=(m,day,hour=12)=>time.wall(m+'-'+String(day).padStart(2,'0'),hour,0,zone).toISOString();
  const item=async name=>{const made=await catalog.createItem(db,ctx,{name,baseCode:name.toUpperCase().replace(/\W/g,'')+'-'+randomUUID().slice(0,6),trackingMode:'quantity'});
    const code=(await db.query('SELECT code FROM skus WHERE id=$1',[made.skuIds[0]])).rows[0].code;return {skuId:made.skuIds[0],itemId:made.id||made.itemId,code};};
  const [a,b,c]=[await item('Anchor bolt'),await item('Bracket'),await item('Clamp')];
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('web-customer',$1,'Web buyer','web@example.test','5185550101','12 Market St, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  const receive=async(sku,units,unitCost,when)=>{
    const key=randomUUID(),po=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:key,lines:[{skuId:sku.skuId,quantityUnits:units,unitCost}]});
    await w.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
    await w.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r',reference:'Receipt '+key.slice(0,6),receivedAt:when,lines:[{lineId:po.lineIds[0],quantity:units,locationId:f.location.id}]});
  };
  const sell=async(sku,units,priceMinor,when,{customerId='fixture-customer',discountMinor=0}={})=>{
    const order=await w.createSalesOrder(db,ctx,{customerId,deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),discountMinor,lines:[{skuId:sku.skuId,quantity:units,unitPriceMinor:priceMinor}]});
    await w.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
    await w.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),fulfilledAt:when,lines:[{lineId:order.lineIds[0],quantity:units,locationId:f.location.id}]});
    return order;
  };
  // The month before: 10 Anchor bolts at $10 (cost $2) and 6 Clamps at $3 (cost $1), which sells the Clamps out.
  await receive(a,20,2,at(prior,2));await receive(c,6,1,at(prior,1));
  await sell(a,10,1000,at(prior,10));await sell(c,6,300,at(prior,15));
  // The month: Anchor bolts cost $4 now (average $3) and sell 8 at $12 with a $6 discount;
  // the new Bracket sells 2 at $20 through the web shop; one Anchor bolt is damaged;
  // a $10 refund on an Anchor bolt; no Clamps all month.
  await receive(a,10,4,at(month,2));await receive(b,5,5,at(month,1));
  await sell(a,8,1200,at(month,10),{discountMinor:600});
  const shopped=await sell(b,2,2000,at(month,11),{customerId:'web-customer'});
  const connectorId='shop-'+randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provider_account_id,status,capabilities,provides,config,setup_status,authorized_by_user_id,created_at,updated_at)
    VALUES($1,$2,$1,'Web shop','fixture_sync','fixture-account','connected','[]','[]','{}','CONNECTED',$3,now()::text,now()::text)`,[connectorId,ws,ctx.actorId]);
  await db.transaction(tx=>require('../../src/connections/postgres-provider-sync').setMappingInTransaction(tx,ctx,{connectorId,entityType:'sales_order',externalId:'#2001',foundryRecordId:shopped.salesOrderId}));
  await require('../../src/accounting/postgres-stock-removal').issue(db,ctx,{skuId:a.skuId,locationId:f.location.id,quantity:1,reasonCode:'damaged',occurredAt:at(month,12),idempotencyKey:randomUUID()});
  const refund=await require('../../src/accounting/postgres-ledger').post(db,ctx,{postingDate:month+'-20',sourceKey:'refund-'+randomUUID(),sourceType:'sales_refund',
    description:'Refund for a scratched Anchor bolt',lines:[{accountKey:'SALES_RETURNS',debitMinor:1000,skuId:a.skuId,customerId:'fixture-customer'},{accountKey:'CASH',creditMinor:1000}]});
  const flags=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_report_flags WHERE workspace_id=$1 AND job_id=${job} AND ${where} ORDER BY flag_key`,[ws])).rows;
  const runs=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_report_runs WHERE workspace_id=$1 AND job_id=$2 ORDER BY created_at,id',[ws,job])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('agent-report'));
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[kind];
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  return {...f,ws,today,month,prior,a,b,c,refund,connectorId,flags,runs,audits,needs,pilot,handler,older};
}
module.exports={setup};

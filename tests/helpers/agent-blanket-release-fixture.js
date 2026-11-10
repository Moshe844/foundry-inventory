'use strict';
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20});
 await f.subscribe('pro');await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(f.db,f.ctx,{role:'owner'},'POLICY_AUTOMATED');
 const service=require('../../src/purchasing/agent-blanket-releases'),today=await require('../../src/lib/business-time').today(f.db,f.ctx.workspaceId),add=require('../../src/accounting/customer-money').addDays;
 const sku=(await f.db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const input={supplierId:'fixture-supplier',destinationId:f.location.id,reference:'REVIEWED-CONTRACT-1',currency:'USD',firstRelease:add(today,-7),lastRelease:add(today,21),intervalDays:7,leadDays:3,lines:[{sku,totalUnits:100,releaseUnits:20,unitPrice:'1.00'}]};
 async function contract(extra={}){
  const value={...input,...extra},preview=await service.preview(f.db,f.ctx,value),saved=await service.save(f.db,f.ctx,{...value,sourceHash:preview.sourceHash,confirmed:'yes'});
  const slots=(await f.db.query('SELECT * FROM stockchief_runtime.agent_blanket_releases WHERE workspace_id=$1 AND contract_id=$2 ORDER BY release_date,id',[f.ctx.workspaceId,saved.id])).rows;
  return {...saved,preview,slots,input:value};
 }
 const orders=async()=>(await f.db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[f.ctx.workspaceId])).rows[0].n;
 return {...f,service,today,add,sku,input,contract,orders};
}
module.exports={fixture};

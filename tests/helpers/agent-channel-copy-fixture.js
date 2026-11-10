'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20});
 await f.subscribe('pro');
 await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(f.db,f.ctx,{role:'owner'},'POLICY_AUTOMATED');
 const service=require('../../src/catalog/agent-channel-copy'),catalog=require('../../src/domain/postgres-catalog-service');
 const sku=(await f.db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const input={label:'Our store copy',channelName:'Our online store',titleLimit:160,descriptionStyle:'paragraph',skuIds:f.item.skuIds};
 async function prepare(extra={}){
  const args={...input,...extra},preview=await service.preview(f.db,f.ctx,args);
  return {...await service.save(f.db,f.ctx,{...args,sourceHash:preview.sourceHash,confirmed:'yes'}),preview,input:args};
 }
 async function rename(name,description){
  const current=(await f.db.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.item.itemId])).rows[0];
  return catalog.updateItem(f.db,f.ctx,current.id,{name,baseCode:current.base_code,unitLabel:current.unit_label,description:description??current.description});
 }
 return {...f,service,catalog,sku,input,prepare,rename,requestKey:randomUUID};
}
module.exports={fixture};

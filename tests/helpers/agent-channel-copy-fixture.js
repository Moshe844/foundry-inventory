'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20});
 await f.subscribe('pro');
 await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(f.db,f.ctx,{role:'owner'},'POLICY_AUTOMATED');
 const service=require('../../src/catalog/agent-channel-copy'),catalog=require('../../src/domain/postgres-catalog-service');
 const providerModule=require('../../src/ai/provider'),original=providerModule.createProviderForTier;
 let modelCalls=0,failAt=null,onModel=null;
 const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',complete:async request=>{
  modelCalls++;if(onModel)await onModel(modelCalls,request);if(failAt===modelCalls)throw Error('Synthetic mid-batch provider failure');
  const source=JSON.parse(request.prompt);let data;
  if(request.schemaName==='stockchief_channel_copy_source_evidence')data={quotes:[source.descriptionSection.slice(0,200)]};
  else if(request.schemaName==='stockchief_copy_source_evidence')data={quotes:[source.descriptionSection.slice(0,200)]};
  else if(request.schemaName==='stockchief_channel_copy_grounding')data={rows:source.copy.map(p=>({skuId:p.skuId,supported:true,reason:''}))};
  else data={rows:source.products.map(p=>{const options=p.options||[],values=options.length?options.map(o=>o.value).join(' / '):p.variant_label||'',title=p.name+(values?' — '+values:''),description=[p.description||p.name,...options.map(o=>o.name+': '+o.value),'Product code: '+p.code].join('\n\n');return {skuId:p.id,title:[...title].length<=source.titleLimit?title:'',description:[...title].length<=source.titleLimit?(source.format==='bullets'?description.split('\n\n').map(s=>'• '+s).join('\n'):description):'',evidence:[p.name],problem:[...title].length>source.titleLimit?'Variant identity cannot fit this title limit.':''};})};
  return {data,usage:{provider:'anthropic',model:provider.model,providerVersion:'2023-06-01',inputTokens:100,outputTokens:100}};
 }};
 if(process.env.STOCKCHIEF_CHANNEL_COPY_REAL!=='1'){providerModule.createProviderForTier=()=>provider;t.after(()=>{providerModule.createProviderForTier=original;});}
 const sku=(await f.db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const input={label:'Our store copy',channelName:'Our online store',titleLimit:160,descriptionStyle:'paragraph',skuIds:f.item.skuIds};
 async function prepare(extra={}){
  const args={...input,...extra},preview=await service.preview(f.db,f.ctx,args);
  const saved=await service.save(f.db,f.ctx,{...args,sourceHash:preview.sourceHash,confirmed:'yes'});
  if(!saved.id){const handlers=require('../../src/operations/postgres-runtime-handlers').create();await require('../../src/operations/postgres-job-queue').processOne(f.db,{[service.kind]:handlers[service.kind]},{owner:'copy-fixture-worker'});const run=(await service.screen(f.db,f.ctx,{id:saved.copyId})).latestRun;if(run.status==='FAILED')throw Error(run.issue);Object.assign(saved,await service.approve(f.db,f.ctx,saved.runId,{confirmed:'yes'}));}
  const screen=await service.screen(f.db,f.ctx,{id:saved.copyId});preview.document=screen.selectedVersion.document;
  return {...saved,preview,input:args};
 }
 async function rename(name,description){
  const current=(await f.db.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.item.itemId])).rows[0];
  return catalog.updateItem(f.db,f.ctx,current.id,{name,baseCode:current.base_code,unitLabel:current.unit_label,description:description??current.description});
 }
 return {...f,service,catalog,sku,input,prepare,rename,requestKey:randomUUID,provider,modelCalls:()=>modelCalls,failModelAt:n=>{failAt=n;},onModel:fn=>{onModel=fn;}};
}
module.exports={fixture};

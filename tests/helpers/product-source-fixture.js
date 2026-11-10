'use strict';
const {hash}=require('../../src/pricing/postgres-promotions');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20});await f.subscribe('pro');await f.db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(f.db,f.ctx,{role:'owner'},'POLICY_AUTOMATED');
 const service=require('../../src/documents/agent-product-source'),providerModule=require('../../src/ai/provider'),original=providerModule.createProviderForTier;
 const sku=(await f.db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;let facts=[],calls=0,failAt=null,onModel=null;
 const fact=(kind,value,unit='',extra={})=>{const label=extra.label||kind,subject=extra.subject??sku,perUnit=extra.perUnit??'',quote=extra.quote||[subject,label+':',value,unit,perUnit?'per '+perUnit:''].filter(Boolean).join(' ');return {page:1,kind,label,value,unit,subject,perUnit,basis:extra.basis||(kind==='mass'?'product_net':'not_applicable'),quote,identityQuote:'',uncertain:false,note:'',...extra};};
 const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',complete:async request=>{
  calls++;if(onModel)await onModel(calls,request);if(calls===failAt)throw Error('Synthetic product-source provider failure');let data;
  if(request.schemaName==='stockchief_product_fact_grounding'){const input=JSON.parse(request.prompt);data={complete:true,facts:input.facts.map(f=>({id:f.id,supported:true,uncertain:false,reason:''}))};}
  else{let text=request.prompt;try{text=JSON.parse(text).sourceSections||text;}catch{}data={relevant:true,complete:true,facts:facts.filter(f=>text.includes(f.quote)),issues:[]};}
  const contract=require('../../src/foundry/validator').validate(require('../../src/foundry/schema-tools').toWireSchema(request.schema),data);if(!contract.ok)throw Error('Synthetic provider contract mismatch for '+request.schemaName+': '+JSON.stringify(contract.errors)+' Data: '+JSON.stringify(data));
  return {data,usage:{provider:'anthropic',model:provider.model,providerVersion:'2023-06-01',inputTokens:100,outputTokens:100}};
 }};
 if(process.env.STOCKCHIEF_PRODUCT_SOURCE_REAL!=='1'){providerModule.createProviderForTier=()=>provider;t.after(()=>{providerModule.createProviderForTier=original;});}
 let selectedProvider=process.env.STOCKCHIEF_PRODUCT_SOURCE_REAL==='1'?undefined:provider;
 const input={itemId:f.item.itemId,filename:'Synthetic spec.txt',documentKind:'specification',targetConfirmed:'yes'};
 const source=()=>Buffer.from('PRODUCT SPECIFICATION\n'+facts.map(f=>f.quote).join('\n')+'\nOriginal product source. No prices or physical stock changes.','utf8');
 async function start(extra={}){return service.enqueue(f.db,f.ctx,{...input,buffer:source(),...extra});}
 async function processReading(id){const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{productSourceProvider:selectedProvider});const job=await require('../../src/operations/postgres-job-queue').processOne(f.db,{[service.kind]:handlers[service.kind]},{owner:'product-source-fixture-worker'});return {job,view:await service.screen(f.db,f.ctx,{id})};}
 async function approve(id,extra={}){const view=await service.screen(f.db,f.ctx,{id});return service.approve(f.db,f.ctx,id,{confirmed:'yes',revision:view.record.revision,reviewHash:view.view.reviewHash,...extra});}
 return {...f,service,provider,fact,sku,input,source,start,process:processReading,approve,setProvider:value=>{selectedProvider=value;},setFacts:value=>{facts=value;},calls:()=>calls,failAt:value=>{failAt=value;},onModel:value=>{onModel=value;}};
}
module.exports={fixture};

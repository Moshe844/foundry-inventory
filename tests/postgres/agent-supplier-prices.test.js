'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('supplier price lists enforce exact five-percent reviews, trained Pro scopes and frozen source costs',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const imports=require('../../src/imports/postgres-service'),assistant=require('../../src/assistant/postgres-service'),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 const sku=f.item.skuIds[0],item=(await db.query('SELECT s.code,i.name FROM skus s JOIN items i ON i.id=s.item_id WHERE s.id=$1',[sku])).rows[0];
 const source=async amount=>{
  const p=await imports.analyse(db,ctx,{filename:'Supplier prices '+amount+'.csv',text:'Product,SKU,Unit cost\n'+item.name+','+item.code+','+amount,allowModel:false});
  return imports.revise(db,ctx,p.id,{expectedHash:p.integrityHash,confirmCatalogOnly:true});
 };
 const prepare=p=>assistant.prepareAction(db,ctx,'Read this supplier price list',{action:'catalog.supplier_price_list',recordReference:p.id});
 const payload=async p=>(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.proposal.id])).rows[0].payload;
 const prices=require('../../src/pricing/postgres-service');await db.transaction(c=>prices.setPurchaseCostsInTransaction(c,ctx,[{skuId:sku,amountMinor:100,currency:'USD'}]));
 const first=await source('1.05');
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  if(['starter','growth'].includes(tier)){await assert.rejects(prepare(first),e=>e.code==='entitlement_required');continue;}
  const p=await prepare(first);assert.match(p.proposal.summary,/within 5%/);assert.equal((await payload(p)).overReviewThreshold,false);
 }
 await subscribe('pro');const example=await prepare(first);
 const page=await f.browser.get('/actions/'+example.proposal.id).expect(200);assert.match(page.text,/\$1.00 → \$1.05/);assert(!page.text.includes('<dt>Fingerprint</dt>'));
 await assistant.executeProposal(db,ctx,example.proposal.id);await assistant.executeProposal(db,ctx,example.proposal.id);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,105);
 const mission=async p=>{const prepared=await prepare(p);await plans.save(db,ctx,'Update costs then check products',randomUUID(),[
  {contract:registry.get('catalog.supplier_price_list'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}
 ],[{result:prepared},{result:{status:'CLARIFY'}}]);return prepared;};
 const second=await source('1.10'),next=await mission(second);
 await assert.rejects(assistant.executeMission(db,ctx,next.proposal.id),e=>e.code==='entitlement_required');
 await require('../../src/autopilot/draft-authority').save(db,ctx,example.proposal.id,{mode:'save',maximum:'2.00',revision:0});
 await assistant.executeMission(db,ctx,next.proposal.id);assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,110);
 const above=await source('1.16');await subscribe('enterprise');const separate=await mission(above);
 assert.equal((await payload(separate)).overReviewThreshold,true);
 await assert.rejects(assistant.executeMission(db,ctx,separate.proposal.id),/own confirmation/);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,110);
 await assistant.executeProposal(db,ctx,separate.proposal.id);await assistant.executeProposal(db,ctx,separate.proposal.id);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,116);
 const within=await source('1.17'),autonomous=await mission(within);await assistant.executeMission(db,ctx,autonomous.proposal.id);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,117);
 const changedSource=await source('1.18'),stale=await prepare(changedSource);
 await db.query("UPDATE import_rows SET parsed=(parsed::jsonb||'{\"unitCostMinor\":119}')::text WHERE workspace_id=$1 AND import_id=$2",[ctx.workspaceId,changedSource.id]);
 await assert.rejects(assistant.executeProposal(db,ctx,stale.proposal.id),/source prices or current costs changed/);
 const current=await prepare(changedSource);await subscribe('growth');await assert.rejects(assistant.executeProposal(db,ctx,current.proposal.id),e=>e.code==='entitlement_required');
 assert.equal(await f.balance(),4);assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].total_cost_minor,'400');
 assert.equal((await imports.get(db,ctx.workspaceId,within.id)).status,'READY','The price-list job never executes catalogue or opening-stock imports');
 assert.equal(require('../../src/commercial/agent-plan').needsPerson('catalog.supplier_price_list'),true,'Missing threshold evidence fails closed');
 await subscribe('enterprise');
 const entries=[{skuId:sku,...item}];
 for(let n=0;n<100;n++){
  const name='Price part '+n,code='PRICE-PAGE-'+n,created=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name,baseCode:code,trackingMode:'quantity'});
  entries.push({skuId:created.skuIds[0],name,code});
 }
 await db.transaction(c=>prices.setPurchaseCostsInTransaction(c,ctx,entries.slice(1).map(e=>({skuId:e.skuId,amountMinor:100,currency:'USD'}))));
 const full=await imports.analyse(db,ctx,{filename:'Large price list.csv',text:'Product,SKU,Unit cost\n'+entries.map(e=>e.name+','+e.code+',1.05').join('\n'),allowModel:false});
 const reviewed=await imports.revise(db,ctx,full.id,{expectedHash:full.integrityHash,confirmCatalogOnly:true});
 const firstPage=await prepare(reviewed);assert.match(firstPage.proposal.summary,/continue with sourcePage 2/);
 const secondPage=await assistant.prepareAction(db,ctx,'Update the second page of supplier prices',{action:'catalog.supplier_price_list',recordReference:reviewed.id,sourcePage:2});
 await assistant.executeProposal(db,ctx,secondPage.proposal.id);await assistant.executeProposal(db,ctx,secondPage.proposal.id);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,entries[100].skuId)).amount_minor,105);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,entries[1].skuId)).amount_minor,100,'Page two cannot update the first hundred rows');
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,117);
 assert.equal(await f.balance(),4);
});

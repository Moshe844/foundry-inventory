'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('count sheets and real label images post reviewed differences only on eligible plans',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const imports=require('../../src/imports/postgres-service'),assistant=require('../../src/assistant/postgres-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Count bolts',baseCode:'COUNT5',trackingMode:'quantity',purchaseCost:'1'}),sku=item.skuIds[0];
 await receipt.receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:5,unitCostMinor:100,idempotencyKey:randomUUID()});
 const text='Product,SKU,Quantity,Cost\nCount bolts,COUNT5,2,1.00';
 let source=await imports.analyse(db,ctx,{filename:'Physical count.csv',text,allowModel:false,defaultLocationId:f.location.id,importMode:'set'});
 const request={action:'import.count_sheet',recordReference:source.id},prepare=()=>assistant.prepareAction(db,ctx,'Apply this counted sheet',request);
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);if(['starter','growth'].includes(tier)){await assert.rejects(prepare(),e=>e.code==='entitlement_required');await browser.get('/autopilot/reviews/count-sources').expect(402);}
  else assert.equal((await prepare()).status,'PREPARED');
 }
 await subscribe('pro');const p=await prepare();
 const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 await plans.save(db,ctx,'Apply this sheet and review the result',randomUUID(),[
  {contract:registry.get(request.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'count-sources'},dependsOn:[0]}
 ],[{result:p},{result:{status:'CLARIFY'}}]);await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/own confirmation/);
 await subscribe('enterprise');await assert.rejects(assistant.executeMission(db,ctx,p.proposal.id),/own confirmation/);await subscribe('pro');
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,5,{mode:'watch',revision:0});
 await assert.rejects(assistant.executeProposal(db,ctx,p.proposal.id),/Watch only/);await modes.save(db,ctx,5,{mode:'inherit',revision:1});
 await assistant.executeProposal(db,ctx,p.proposal.id);
 const saved=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.execute-approved' AND payload->>'planId'=$2",[ctx.workspaceId,source.id])).rows[0];
 const handler=require('../../src/operations/postgres-runtime-handlers').create()['import.execute-approved'],job={workspaceId:ctx.workspaceId,payload:saved.payload};
 await subscribe('growth');await assert.rejects(handler(job,db),e=>e.code==='entitlement_required');assert.equal(await f.balance(),9);
 await subscribe('pro');await receipt.receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:1,unitCostMinor:100,idempotencyKey:randomUUID()});
 assert((await handler(job,db)).verified);await handler(job,db);assert.equal(await f.balance(),7,'The count difference preserves the later receipt.');
 assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].total_cost_minor,'300');
 assert.match((await browser.get('/autopilot/reviews/count-sources').expect(200)).text,/Verified/);
 const clone=await imports.analyse(db,ctx,{filename:'Count renamed.csv',text,allowModel:false,defaultLocationId:f.location.id,importMode:'set'});
 await assert.rejects(imports.approve(db,ctx,clone.id,clone.integrityHash),/already been imported|no valid rows/i);
 const blank=await imports.analyse(db,ctx,{filename:'Blank count.csv',text:'Product,SKU,Quantity\nCount bolts,COUNT5,',allowModel:false,defaultLocationId:f.location.id,importMode:'set'});
 await assert.rejects(assistant.prepareAction(db,ctx,'Apply an incomplete count',{...request,recordReference:blank.id}),/exact existing|map the actual|every counted/);
 assert.equal(await f.balance(),7);
 const {createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(1300,350),c=canvas.getContext('2d');
 c.fillStyle='#fff';c.fillRect(0,0,1300,350);c.fillStyle='#12334d';c.fillRect(0,25,1300,65);c.fillStyle='#fff';c.font='30px Arial';
 for(const[x,value]of [[30,'Product'],[410,'SKU'],[760,'Quantity'],[1000,'Cost']])c.fillText(value,x,68);
 c.fillStyle='#172b3d';for(const[x,value]of [[30,'Count bolts'],[410,'COUNT5'],[760,'0'],[1000,'1.00']])c.fillText(value,x,155);
 let image=await imports.analyse(db,ctx,{filename:'Count labels.png',buffer:canvas.toBuffer('image/png'),allowModel:false,defaultLocationId:f.location.id,importMode:'set'});
 assert.equal(image.sourceKind,'image');await assert.rejects(assistant.prepareAction(db,ctx,'Apply label counts',{...request,recordReference:image.id}),/image|every counted/);
 const readRows=await imports.rowsFor(db,ctx.workspaceId,image.id);
 image=await imports.revise(db,ctx,image.id,{expectedHash:image.integrityHash,codeOverrides:{[readRows[0].rowNumber]:'COUNT5'},confirmImageReading:true});
 assert.deepEqual((await imports.rowsFor(db,ctx.workspaceId,image.id))[0].raw,readRows[0].raw,'Original OCR evidence survives an owner correction.');
 assert.equal(image.recordsValid,1,JSON.stringify(await imports.rowsFor(db,ctx.workspaceId,image.id)));
 const zero=await assistant.prepareAction(db,ctx,'Confirm zero physically counted',{...request,recordReference:image.id});
 await assistant.executeProposal(db,ctx,zero.proposal.id);assert((await imports.execute(db,ctx,image.id)).verified);
 assert.equal(await f.balance(),4);assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].total_cost_minor,'0');
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_supplier_bills WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});

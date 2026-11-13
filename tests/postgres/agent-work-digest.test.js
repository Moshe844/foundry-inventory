'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('daily agent work offers safe one-tap undo and refuses changed, physical and lower-plan work',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,subscribe,browser,workflows}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1",[ctx.workspaceId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const assistant=require('../../src/assistant/postgres-service'),prices=require('../../src/pricing/postgres-service'),reviews=require('../../src/autopilot/job-reviews'),digest=require('../../src/autopilot/agent-work-digest');
 const sku=f.item.skuIds[0],item=(await db.query('SELECT s.code,i.name FROM skus s JOIN items i ON i.id=s.item_id WHERE s.id=$1',[sku])).rows[0];
 await prices.setPrice(db,ctx,{skuId:sku,amountMinor:1000,currency:'USD'});await prices.setPurchaseCost(db,ctx,{skuId:sku,amountMinor:100,currency:'USD'});
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ctx.workspaceId,require('../../src/accounting/customer-money').addDays(today,-30)]);
 const act=async request=>{const p=await assistant.prepareAction(db,ctx,'Carry out this reviewed request',request);await assistant.executeProposal(db,ctx,p.proposal.id);return (await db.query('SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.proposal.id])).rows[0];};
 const quote=await act({action:'sales_quote.create',recordReference:'Receiver',quoteValidUntil:require('../../src/accounting/customer-money').addDays(today,10),orderLines:JSON.stringify([{sku:item.code,quantity:1}])});
 const original=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1000}]});
 await workflows.confirmSalesOrder(db,ctx,original.salesOrderId,{idempotencyKey:randomUUID()});
 const sale=await act({action:'sales_order.repeat',recordReference:'Receiver',repeatPeriod:'latest'});
 const production=require('../../src/manufacturing/postgres-service'),output=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Undo assembly',baseCode:'UNDO-ASSEMBLY',trackingMode:'quantity'});
 const wip=await require('../../src/accounting/postgres-ledger').createAccount(db,ctx,{code:'1226',name:'Work in progress',type:'ASSET'});await production.configure(db,ctx,{wipAccountId:wip.id});
 const bom=await production.createBom(db,ctx,{outputSkuId:output.skuIds[0],outputQuantity:1,components:[{skuId:sku,quantity:2}]});await production.activateBom(db,ctx,bom.id,{expectedHash:bom.integrity_hash});
 const work=await act({action:'manufacturing.create_work_order',manufacturingInput:JSON.stringify({bomId:bom.id,quantity:1,neededBy:today})});
 const priceFile=async amount=>{const p=await require('../../src/imports/postgres-service').analyse(db,ctx,{filename:'Undo supplier prices.csv',text:'Product,SKU,Unit cost\n'+item.name+','+item.code+','+amount,allowModel:false});return require('../../src/imports/postgres-service').revise(db,ctx,p.id,{expectedHash:p.integrityHash,confirmCatalogOnly:true});};
 const file=await priceFile('1.05'),cost=await act({action:'catalog.supplier_price_list',recordReference:file.id});
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  if(tier==='starter'){
   await assert.rejects(digest.report(db,ctx),e=>e.code==='entitlement_required');await assert.rejects(digest.undo(db,ctx,quote.id),e=>e.code==='entitlement_required');
   await browser.get('/autopilot/reviews/daily-work').expect(402);continue;
  }
  // The four prepared changes, and the import columns StockChief mapped on its own (job 133), which has nothing to undo.
  const result=await reviews.run(db,ctx,'daily-work');assert.equal(result.rows.length,5);assert.ok(result.rows.some(r=>r.Action==='Import columns mapped by StockChief'));assert.equal(result.undoForm.entries.length,4);
  const page=await browser.get('/autopilot/reviews/daily-work').expect(200);assert.equal((page.text.match(/>Undo this change</g)||[]).length,4);
 }
 await subscribe('growth');const page=await browser.get('/autopilot/reviews/daily-work').expect(200),post={_csrf:f.csrf(page.text),day:today};
 await browser.post('/autopilot/undo/'+quote.id).set('Accept','application/json').type('form').send({...post,day:'bad-date'}).expect(400);
 assert.equal((await require('../../src/sales/postgres-quotes').get(db,ctx.workspaceId,quote.result.quoteId)).status,'OPEN');
 await browser.post('/autopilot/undo/'+quote.id).type('form').send(post).expect(303);await browser.post('/autopilot/undo/'+quote.id).type('form').send(post).expect(303);
 assert.equal((await require('../../src/sales/postgres-quotes').get(db,ctx.workspaceId,quote.result.quoteId)).status,'DECLINED');
 await workflows.confirmSalesOrder(db,ctx,sale.result.salesOrderId,{idempotencyKey:randomUUID()});
 await assert.rejects(digest.undo(db,ctx,sale.id),/Order changed/);
 await digest.undo(db,ctx,work.id);assert((await digest.undo(db,ctx,work.id)).replayed);
 assert.equal((await production.getWorkOrder(db,ctx.workspaceId,work.result.id)).status,'CANCELLED');
 await digest.undo(db,ctx,cost.id);assert((await digest.undo(db,ctx,cost.id)).replayed);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,100);
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Agent action undone'",[ctx.workspaceId])).rows[0].n,3);
 assert.equal(await f.balance(),10);
 assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].total_cost_minor,'1000');
 await subscribe('pro');const newFile=await priceFile('1.10'),changed=await act({action:'catalog.supplier_price_list',recordReference:newFile.id});
 await prices.setPurchaseCost(db,ctx,{skuId:sku,amountMinor:112,currency:'USD'});await assert.rejects(digest.undo(db,ctx,changed.id),/Purchase costs changed/);
 assert.equal((await prices.purchaseCost(db,ctx.workspaceId,sku)).amount_minor,112);
 const cancelledSale=await act({action:'sales_order.repeat',recordReference:'Receiver',repeatPeriod:'latest'});
 await digest.undo(db,ctx,cancelledSale.id);assert((await digest.undo(db,ctx,cancelledSale.id)).replayed);
 assert.equal((await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,cancelledSale.result.salesOrderId])).rows[0].status,'CANCELLED');
 const started=await act({action:'manufacturing.create_work_order',manufacturingInput:JSON.stringify({bomId:bom.id,quantity:1,neededBy:today})});
 const physical=await act({action:'manufacturing.start',recordReference:started.result.order_number,manufacturingInput:JSON.stringify({confirmed:'yes',materials:[{component:0,skuId:sku,locationId:f.location.id,quantity:2}]})});
 await assert.rejects(digest.undo(db,ctx,physical.id),/review a correction/);
 await assert.rejects(digest.undo(db,ctx,started.id),/Production has later work/);assert.equal(await f.balance(),8);
 const clock=require('../../src/lib/business-time'),day=require('../../src/accounting/customer-money').addDays(today,-1),zone=(await clock.forWorkspace(db,ctx.workspaceId)).timeZone;
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET executed_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,quote.id,new Date(Date.parse(clock.dayBoundary(day,zone))+12*3600000).toISOString()]);
 // The worker writes yesterday's digest once; a replay writes nothing new.
 assert.equal((await digest.deliver(db,ctx.workspaceId)).day,day);assert.deepEqual(await digest.deliver(db,ctx.workspaceId),{replayed:true,day});
 const notices=require('../../src/autopilot/operational-notices');await notices.refresh(db,ctx.workspaceId);
 const notice=(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).find(n=>n.sourceId==='agent-notice-204');assert(notice);assert(notice.href.endsWith(day));
 assert.equal((await reviews.run(db,ctx,'daily-work',{filter:day})).rows[0].Status,'Undone');
 const routineId=randomUUID();
 await db.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,execution_status,verification_status,idempotency_key,created_at,completed_at)
  VALUES($1,$2,'replenishment_plan','verified-history-fixture',$3,'COMPLETED','VERIFIED',$1,$4,$4)`,[routineId,ctx.workspaceId,JSON.stringify({type:'purchase',displayName:'Recorded routine fixture'}),new Date().toISOString()]);
 const combined=await reviews.run(db,ctx,'daily-work');assert(combined.rows.some(r=>r.link==='/autopilot/work/'+routineId));assert(!combined.undoForm.entries.some(e=>e.id===routineId));
 const oldDay=require('../../src/accounting/customer-money').addDays(today,-775),oldInstant=new Date(Date.parse(clock.dayBoundary(oldDay,zone))+12*3600000).toISOString();
 await db.query('UPDATE work_items SET created_at=$3,completed_at=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,routineId,oldInstant]);
 await subscribe('growth');assert.equal((await reviews.run(db,ctx,'daily-work',{filter:oldDay})).rows.length,0);
 await subscribe('pro');assert.equal((await reviews.run(db,ctx,'daily-work',{filter:oldDay})).rows.length,1);
 await db.query("UPDATE users SET role='staff',permissions='[\"VIEW\"]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(digest.report(db,ctx),e=>e.code==='forbidden');await assert.rejects(digest.undo(db,ctx,cost.id),e=>e.code==='forbidden');
});

'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
test('committed intermediate effects survive later workflow states while current claims and receipt access stay strict',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 let app,browser,server;t.after(async()=>{if(browser)await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}if(app)await app.locals.sessionStore.close();await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Offline!'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Lifecycle owner',businessName:'Receipt lifecycle',email,password});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},today=new Date().toISOString().slice(0,10);
 const service=require('../../src/assistant/postgres-service'),noModels={name:'offline',complete:async()=>{throw Error('NO_MODEL_CALLS');}};
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:today.slice(0,4)+'-01-01',currency:'USD'});
 const sku='LIFE-'+randomUUID().slice(0,6),item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:sku,baseCode:sku,trackingMode:'quantity'});
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Lifecycle depot',kind:'warehouse'});
 await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:1,reference:'FIXTURE',idempotencyKey:'fixture-receipt'});
 const cost=await require('../../src/accounting/postgres-inventory-costs').prepare(db,ctx,{skuId:item.skuIds[0],locationId:place.id,unitCost:'1.25',basis:'opening_inventory',evidenceReference:'Owner-confirmed disposable opening valuation',postingDate:today},'Establish evidenced opening stock cost.');
 await service.executeProposal(db,ctx,cost.proposal.id,{provider:noModels});
 const customer='Customer '+randomUUID().slice(0,6);await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:customer});
 const reference='LIFECYCLE-'+randomUUID().slice(0,8),executed=[];
 async function execute(action,args){
  const prepared=await service.prepareAction(db,ctx,'Disposable authorized lifecycle test.',{action,...args},{provider:noModels});
  assert.equal(prepared.status,'PREPARED',JSON.stringify(prepared));
  const result=await service.executeProposal(db,ctx,prepared.proposal.id,{provider:noModels});assert.equal(result.status,'EXECUTED');executed.push(result);return result;
 }
 const created=await execute('create_sales_order',{customer,sku,quantity:1,amount:'75',currency:'USD',location:place.name||'Lifecycle depot',deliveryMethod:'PICKUP',reference});
 const order=created.result.salesOrderId;
 const confirmed=await execute('sales_order.confirm',{recordReference:created.result.orderNumber});
 const registry=require('../../src/assistant/postgres-capability-registry').registry,confirm=registry.get('sales_order.confirm');
 assert.equal(await confirm.verifyExecution(db,ctx,confirmed.result,confirmed.payload),true,'The canonical verifier succeeds when confirmation commits');
 await execute('sales_order.fulfill',{recordReference:created.result.orderNumber,sku,quantity:1});
 const paid=await execute('customer_payment.record',{recordReference:created.result.orderNumber,amount:'75',paymentDate:today,paymentMethod:'cash',reference});
 assert.equal(await confirm.verifyExecution(db,ctx,confirmed.result,confirmed.payload),false,'Reproduces the recorded live failure: current state is FULFILLED, not the earlier CONFIRMED');
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.create(db,ctx,'Verify the complete authorized pickup sale.');
 const h={calls:{fixture:{state:'DONE',result:{outcomes:executed.map(p=>({result:{proposal:{id:p.id}}}))}}}};
 const catalogue={list:()=>registry.list(),get:name=>registry.get(name)};
 const receipts=require('../../scripts/environment-agent-demo/receipts'),receipt=await receipts.collect(db,ctx,goal,h,catalogue);
 assert.equal(receipt.operations.length,4);assert(receipt.operations.every(o=>o.verified));
 assert(receipt.operations.every(o=>o.verificationScope==='canonical_execution_at_commit'&&o.committedAt));
 assert.equal(receipt.operations[1].result.status,'CONFIRMED','Historical execution result is preserved, not rewritten as a later state');
 assert.equal(receipt.dependencyState,'READY');
 const recordedAt=confirmed.executed_at;
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET executed_at=NULL WHERE id=$1',[confirmed.id]);
 assert.equal((await receipts.collect(db,ctx,goal,h,catalogue)).operations[1].verified,false,'A status flag without its canonical commit record is insufficient');
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET executed_at=$2 WHERE id=$1',[confirmed.id,recordedAt]);
 const entry={id:goal.id+':execution',name:'canonical_execution_state',text:JSON.stringify(receipt),sha256:createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),at:new Date().toISOString()};
 goal.checkpoint.harness={...h,evidence:{[entry.id]:entry}};
 const verifier=require('../../src/assistant/postgres-codex-verification');
 const report={status:'completed',outcome:'answer',answer:'At the recorded execution, the order was confirmed.',claims:[{evidenceId:entry.id,path:'/operations/1/result/status',value:'CONFIRMED'}]};
 const wrongScope=await verifier.verify(db,ctx,goal,report,catalogue);assert.equal(wrongScope.verified,false);assert.equal(wrongScope.verificationFailure,'EXECUTION_RESULT_REQUIRES_HISTORICAL_SCOPE');
 report.claims[0].historical=true;assert.equal((await verifier.verify(db,ctx,goal,report,catalogue)).verified,true);
 const payments=await service.lookup(db,ctx,{view:'payments',search:reference});assert.equal(payments.rows.length,1);assert.equal(payments.rows[0].amount,'$75.00');assert.equal(payments.rows[0].amountMinor,7500);assert.equal(payments.rows[0].method,'cash');assert.equal(payments.rows[0].reference,reference);
 const orders=await service.lookup(db,ctx,{view:'sales_orders',search:reference});assert.equal(orders.rows.length,1);assert.equal(orders.rows[0].reference,reference);assert.equal(orders.rows[0].outstanding,'$0.00');
 // Recorded live email continuation: a later approved operation must not
 // invalidate unchanged sales/payment facts merely because they were learned
 // earlier. The host re-reads every current claim; it does not trust age.
 const readSource=JSON.stringify({version:1,name:'business_operations',input:{steps:[{capability:'read.payments',arguments:[{name:'search',value:reference}],dependsOn:[]}]}});
 const readText=JSON.stringify({missionId:null,outcomes:[{capability:'read.payments',result:payments}]});
 const priorRead={id:goal.id+':prior-payment',name:'business_operations',text:readText,sha256:createHash('sha256').update(readText).digest('hex'),sourceText:readSource,sourceSha256:createHash('sha256').update(readSource).digest('hex'),at:new Date(Date.parse(confirmed.executed_at)-60000).toISOString()};
 goal.checkpoint.harness.evidence[priorRead.id]=priorRead;
 const priorReport={status:'completed',outcome:'answer',answer:'The recorded payment remains $75.00 cash.',claims:[{evidenceId:priorRead.id,path:'/outcomes/0/result/rows/0/amount',value:'$75.00'},{evidenceId:priorRead.id,path:'/outcomes/0/result/rows/0/method',value:'cash'}]};
 const checkedPrior=await verifier.verify(db,ctx,goal,priorReport,catalogue);
 assert.equal(checkedPrior.verified,true,'Exact live failure class: current unchanged facts remain usable across unrelated subsequent execution '+JSON.stringify(checkedPrior));
 await db.query("UPDATE accounting_payments SET method='bank_transfer' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,paid.result.paymentId]);
 assert.equal((await verifier.verify(db,ctx,goal,priorReport,catalogue)).verified,false,'A genuinely changed payment still rejects the earlier current claim');
 await db.query("UPDATE accounting_payments SET method='cash' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,paid.result.paymentId]);
 const balance=(await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,item.skuIds[0]])).rows[0];assert.equal(Number(balance.on_hand),0);
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:noModels});
 const web=require('supertest').agent(app),login=await web.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1];
 const signed=await web.post('/login').type('form').send({_csrf:csrf,email,password});
 const receiptPage=await web.get(`/orders/${order}/receipt/${paid.result.paymentId}`);assert.equal(receiptPage.status,200);assert.match(receiptPage.text,new RegExp(reference));assert.match(receiptPage.text,/\$75\.00/);assert.match(receiptPage.text,/Cash/);
 const wrongOrder=await web.get(`/orders/foreign-order/receipt/${paid.result.paymentId}`);assert.equal(wrongOrder.status,404,'A valid payment cannot disclose a different order receipt');
 const otherEmail=randomUUID()+'@example.test',otherPassword='Offline!'+randomUUID();
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Other inventory',email:otherEmail,password:otherPassword});
 const foreign=require('supertest').agent(app),foreignLogin=await foreign.get('/login');
 await foreign.post('/login').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(foreignLogin.text)[1],email:otherEmail,password:otherPassword});
 assert.equal((await foreign.get(`/orders/${order}/receipt/${paid.result.paymentId}`)).status,404,'A different workspace owner cannot read this receipt');
 const foreignReceipt=await receipts.collect(db,{workspaceId:other.workspaceId,actorId:other.userId},goal,h,catalogue);
 assert.equal(foreignReceipt.operations.length,0);assert.equal(foreignReceipt.dependencyState,'BLOCKED');
 const orderPage=await web.get('/orders/'+order);assert.equal(orderPage.status,200);assert.match(orderPage.text,new RegExp('Reference: '+reference));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await require('playwright').chromium.launch({headless:true});
 const tools=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});
 const cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));
 await tools.context.addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);
 await tools.restore(origin+'/orders/'+order);
 await tools.page.getByText('Reference: '+reference,{exact:true}).evaluate(el=>el.remove());
 await tools.page.getByText('Money',{exact:true}).last().evaluate(el=>{el.closest('details').open=true;});
 const oldPage=await tools.inspect();
 const freshPage=await tools.verifyObservation(origin+'/orders/'+order,oldPage);
 const status=Object.entries(oldPage.textBlocks).find(([,text])=>text==='Collected');assert(status,'Actual recorded order status is present');
 const unchanged=require('../../src/assistant/browser-text-verification').unchangedLine;
 assert(freshPage.textRegions.some(region=>region.kind==='heading_container'),'Host captures actual record-header semantics without registered routes or classes');
 assert.equal(unchanged(oldPage,freshPage,'/textBlocks/'+status[0]).matched,true,'Reproduces the live UI-reference insertion: unchanged collected status survives');
 const paidLine=Object.entries(oldPage.textBlocks).find(([,text])=>text.includes('by cash. Print receipt'));
 assert(paidLine,'The actual expanded payment line from the live failure is present');
 assert.equal(unchanged(oldPage,freshPage,'/textBlocks/'+paidLine[0]).matched,true,'A fresh GET collapsing disclosure state must not erase an unchanged canonical payment');
 const legacyPage=structuredClone(oldPage);delete legacyPage.viewState;
 assert.equal(unchanged(legacyPage,await tools.verifyObservation(origin+'/orders/'+order,legacyPage),'/textBlocks/'+paidLine[0]).matched,true,'The exact older live trace remains verifiable through a complete unchanged disclosure region');
 await tools.page.locator('details').filter({hasText:'Print receipt'}).last().locator('p').filter({hasText:'by cash.'}).evaluate(el=>{el.innerText=el.innerText.replace('$75.00','$76.00');});
 assert.equal(unchanged(oldPage,await tools.inspect(),'/textBlocks/'+paidLine[0]).matched,false,'Changed payment amount fails even though the host can reveal its section');
 await tools.page.locator('.page-head .badge').evaluate(el=>{el.innerText='Cancelled';});
 assert.equal(unchanged(oldPage,await tools.inspect(),'/textBlocks/'+status[0]).matched,false,'A changed header still fails current-state verification');
 await tools.restore(origin+'/orders/new');
 const newForm=await tools.inspect(),nativeDetails=await tools.page.locator('details').evaluateAll(elements=>elements.map(e=>e.open));
 const checkedForm=await tools.verifyObservation(origin+'/orders/new',newForm);
 assert.deepEqual(await tools.page.locator('details').evaluateAll(elements=>elements.map(e=>e.open)),nativeDetails,'Exact new-order failure: verification must not expand optional form fields or global navigation');
 assert.equal(checkedForm.text,newForm.text);
 const legacyForm=structuredClone(newForm);delete legacyForm.viewState;
 assert.equal((await tools.verifyObservation(origin+'/orders/new',legacyForm)).text,newForm.text,'Earlier journals with closed forms retain their visible form, not an all-open replacement');
 // Exact browser-013 failure: native dialogs are local view state, not a
 // route. Reloading the Locations page cannot invalidate its unchanged form
 // merely by closing the dialog the agent independently opened.
 const locations=await tools.restore(origin+'/locations');
 const modal=await tools.act({action:'click',ref:locations.controls.find(c=>c.label==='Add location').ref});
 const modalText=JSON.stringify(modal),modalSource=JSON.stringify({version:1,name:'environment_browser',input:{action:'click',ref:null,value:null}}),modalEntry={id:goal.id+':dialog',name:'environment_browser',text:modalText,sha256:createHash('sha256').update(modalText).digest('hex'),sourceText:modalSource,sourceSha256:createHash('sha256').update(modalSource).digest('hex'),at:new Date().toISOString()};
 goal.checkpoint.harness.evidence[modalEntry.id]=modalEntry;
 const heading=Object.entries(modal.textBlocks).find(([,value])=>value==='Add a location');assert(heading);
 const nameIndex=modal.controls.findIndex(c=>c.name==='name'&&c.form),kindIndex=modal.controls.findIndex(c=>c.name==='kind'&&c.form);assert(nameIndex>=0&&kindIndex>=0);
 const dialogReport={status:'completed',outcome:'answer',answer:'The current form requires a name and a type, initially Warehouse. Nothing was saved.',claims:[
  {evidenceId:modalEntry.id,path:'/textBlocks/'+heading[0],value:heading[1]},
  {evidenceId:modalEntry.id,path:'/controls/'+nameIndex+'/required',value:true},
  {evidenceId:modalEntry.id,path:'/controls/'+kindIndex+'/value',value:'warehouse'}]};
 assert.equal((await verifier.verify(db,ctx,goal,JSON.stringify(dialogReport),catalogue,{browser:tools})).verified,true,'An unchanged genuinely opened form verifies without another model call');
 // Reproduce the actual stock-cost trace: the model filtered form controls
 // and cited index zero, which was really the page's skip link. Never accept
 // that guessed location or infer a different field from its claimed value.
 await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:1,reference:'UNCOSTED-FORM-FIXTURE',idempotencyKey:'uncosted-form-fixture'});
 const costForm=await tools.restore(origin+'/inventory/'+item.itemId+'/costs');
 const costControl=costForm.controls.find(control=>control.name==='position');assert(costControl);
 const costText=JSON.stringify(costForm),costSource=JSON.stringify({version:1,name:'environment_browser',input:{action:'open',value:new URL(costForm.url).pathname,ref:null}}),costEntry={id:goal.id+':cost-form',name:'environment_browser',text:costText,sha256:createHash('sha256').update(costText).digest('hex'),sourceText:costSource,sourceSha256:createHash('sha256').update(costSource).digest('hex'),at:new Date().toISOString()};
 goal.checkpoint.harness.evidence[costEntry.id]=costEntry;
 const badControlReport={status:'completed',outcome:'answer',answer:'The cost form prepares an approved cost correction.',claims:[{evidenceId:costEntry.id,path:'/controls/0/form/action',value:costControl.form.action}]};
 const rejected=await verifier.verify(db,ctx,goal,badControlReport,catalogue,{browser:tools});assert.equal(rejected.verified,false);assert.equal(rejected.verificationFailure,'EVIDENCE_POINTER_NOT_FOUND');assert.equal(rejected.verificationDetail.path,'/controls/0/form/action');
 const exactControlReport=structuredClone(badControlReport);exactControlReport.claims[0].path=costControl.evidencePath+'/form/action';
 assert.equal((await verifier.verify(db,ctx,goal,exactControlReport,catalogue,{browser:tools})).verified,true,'The explicit field citation path works without another inspection or guessed reindexing');
 await tools.close();
 t.diagnostic(JSON.stringify({recordedFailureReproduced:true,committedOperations:4,currentOrder:'FULFILLED',invoiceBalance:0,physicalStock:0,referenceAvailable:true,paymentReceiptStatus:200,crossOrderReceiptStatus:404,paidCalls:0}));
});

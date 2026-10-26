'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded OWN_DELIVERY constraint failure resumes one approved six-step mission without repeated receipt, broadened scope or another model call',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();cluster.stop();for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Offline!'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Testing',email,password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);await require('../../src/accounting/postgres-ledger').configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 const stamp=new Date().toISOString(),sku='PART-'+randomUUID().slice(0,8),supplier='supplier-'+randomUUID(),customer='customer-'+randomUUID(),bay='Test bay',reference='DELIVERY-'+randomUUID().slice(0,8);
 await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Receiving component',baseCode:sku,trackingMode:'quantity'});await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:bay,kind:'warehouse'});
 const skuId=(await db.query('SELECT id FROM skus WHERE workspace_id=$1 AND code=$2',[ctx.workspaceId,sku])).rows[0].id,locationId=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,bay])).rows[0].id;
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES($1,$2,'Test supplier','active','USD',$3,$3)",[supplier,ctx.workspaceId,stamp]);
 await db.query("INSERT INTO customers(id,workspace_id,name,record_state,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Test customer','ACTIVE',$3,$4,$4)",[customer,ctx.workspaceId,ctx.actorId,stamp]);
 const workflows=require('../../src/operations/postgres-business-workflows'),po=await workflows.createPurchaseOrder(db,ctx,{supplierId:supplier,destinationLocationId:locationId,idempotencyKey:'test:po',lines:[{skuId,quantityUnits:1,unitCost:1.25}]});await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'test:approve'});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'test:place'});
 const poNumber=(await db.query('SELECT po_number FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,po.purchaseOrderId])).rows[0].po_number;
 const steps=[
  {capability:'purchase_order.receive',args:{purchaseOrder:poNumber,sku,quantity:1,location:bay,receiptReference:reference},dependsOn:[]},
  {capability:'sales_order.create',args:{customer:'Test customer',sku,quantity:1,amount:75,currency:'USD',reference,location:bay,deliveryMethod:'OWN_DELIVERY',shipToAddress:'1 Test Ave, Example, NY 10950, United States'},dependsOn:[0]},
  {capability:'sales_order.reserve_all',args:{recordReference:reference},dependsOn:[0,1]},
  {capability:'shipping.prepare',args:{recordReference:reference,sku,quantity:1},dependsOn:[2]},
  {capability:'shipping.handoff',args:{recordReference:reference,handover:'delivered by us'},dependsOn:[3]},
  {capability:'shipping.delivered',args:{recordReference:reference},dependsOn:[4]}
 ];
 const store=require('../../src/assistant/postgres-goal-store'),pilot=require('../../src/assistant/postgres-codex-pilot'),plans=require('../../src/assistant/postgres-capability-plans');let goal=await store.claim(db,ctx,(await store.create(db,ctx,'Complete the frozen disposable delivery workflow.')).id);
 await db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE id=$1",[goal.id]);
 const noModel={name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('PAID_CALL_FORBIDDEN');}},gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token,provider:noModel});
 await require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize}).load();const result=await gateway.operate({steps:steps.map(({args,...s})=>({...s,arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)}))}))});assert(result.missionId,JSON.stringify(result));
 await db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness,calls}',$2::jsonb) WHERE id=$1",[goal.id,JSON.stringify({fixture:{state:'DONE',result}})]);await require('../../scripts/environment-agent-demo/approval-handoff').inbox(db,ctx,goal.id,{pause:true,runToken:goal.run_token});
 const card=(await pilot.inbox(db,ctx,goal.id)).approvals[0],scope={kind:'mission',id:card.mission.id,sha256:card.mission.sha256},decision={responseReference:'OFFLINE ONE EXACT APPROVAL',missionScope:scope};
 // Reproduce the actual failed SQL boundary: the formerly advertised mode
 // reached the unchanged SHIP/PICKUP PostgreSQL check after receipt committed.
 let inject=true;const broken={...db,transaction:(fn,settings)=>db.transaction(client=>fn({...client,query:async(sql,args)=>{
  if(inject&&/INSERT INTO sales_orders\s/.test(sql)){inject=false;const oldWire=[...args];oldWire[7]='OWN_DELIVERY';return client.query(sql,oldWire);}return client.query(sql,args);
 }}),settings)};
 const stopped=await pilot.decide(broken,ctx,goal.id,card.id,card.sha256,true,decision);
 assert.equal(inject,false);assert.match(stopped.result.continuationError,/delivery_method/);
 let mission=(await db.query('SELECT * FROM stockchief_runtime.assistant_capability_plans WHERE id=$1',[scope.id])).rows[0];assert.equal(mission.approval_status,'APPROVED');assert.equal(mission.steps[0].state,'DONE');assert.equal(mission.steps[1].state,'WAITING');assert.equal(mission.run_token,null);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);assert.equal(Number((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1);
 const preparedId=mission.steps[1].proposalId,payload=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[preparedId])).rows[0].payload;
 // The newly staged second card has no step decision, but the first human
 // decision already granted the exact frozen mission. The shared inbox must
 // distinguish recovery from another approval and retain incomplete scope.
 await pilot.inbox(db,ctx,goal.id);
 const decisions=require('../../src/projections/postgres-service'),recoveries=(await decisions.needs(db,ctx.workspaceId,ctx.actorId)).filter(i=>i.approval?.proposalId===preparedId);
 assert.equal(recoveries.length,1);assert.equal(recoveries[0].kind,'recovery');assert.equal(recoveries[0].approval.scope,'review_existing_mission');assert.equal(recoveries[0].approval.recordedMission.sha256,scope.sha256);assert.equal(recoveries[0].approval.missionOption,null);
 const scopeMissing=structuredClone(mission.steps);scopeMissing[1].reason='mission_scope_incomplete';
 await db.query("UPDATE stockchief_runtime.assistant_capability_plans SET status='WAITING_USER',steps=$2::jsonb WHERE id=$1",[scope.id,JSON.stringify(scopeMissing)]);
 const additional=(await decisions.needs(db,ctx.workspaceId,ctx.actorId)).find(i=>i.approval?.proposalId===preparedId);assert.equal(additional.kind,'approval');assert.equal(additional.approval.scope,'single_operation');assert.match(additional.why,/additional scope/);
 await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET status=$2,steps=$3::jsonb WHERE id=$1',[scope.id,mission.status,JSON.stringify(mission.steps)]);
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET payload=$2::jsonb WHERE id=$1',[preparedId,JSON.stringify({...payload,lines:payload.lines.map(line=>({...line,unitPriceMinor:9900}))})]);
 await pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,decision);assert.equal(Number((await db.query('SELECT count(*) AS n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0,'A revised payload is never covered by the original frozen approval');
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET payload=$2::jsonb WHERE id=$1',[preparedId,JSON.stringify(payload)]);
 // A business owner must recover through the normal website using the saved
 // approval, without a developer calling the handoff or changing a goal.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();cleanup.push(()=>app.locals.sessionStore.close(),()=>new Promise(resolve=>server.close(resolve)),()=>browser.close());
 const origin='http://127.0.0.1:'+server.address().port,page=await browser.newPage(),web=require('supertest').agent(app),login=await web.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1],signed=await web.post('/login').type('form').send({_csrf:csrf,email,password}),cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));await page.context().addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);
 await page.goto(origin+'/actions/'+card.proposalId);await page.getByRole('button',{name:'Continue approved request',exact:true}).waitFor();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue approved request',exact:true}).click()]);mission=(await db.query('SELECT * FROM stockchief_runtime.assistant_capability_plans WHERE id=$1',[scope.id])).rows[0];
 assert.equal(mission.status,'DONE',JSON.stringify(mission.steps));assert.equal(mission.metrics.approvalInteractions,1);assert.equal(mission.plan_hash,scope.sha256);assert(mission.steps.every(s=>s.state==='DONE'));
 const order=(await db.query('SELECT * FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(order.delivery_method,'SHIP');assert.equal(order.status,'FULFILLED');
 assert.equal((await db.query('SELECT status FROM sales_shipments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].status,'DELIVERED');assert.equal(Number((await db.query('SELECT balance_minor FROM accounting_customer_invoices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].balance_minor),7500);
 const counts=async()=> (await db.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,(SELECT sum(on_hand) FROM balances WHERE workspace_id=$1) AS stock,(SELECT count(*) FROM sales_orders WHERE workspace_id=$1) AS orders,(SELECT count(*) FROM accounting_payments WHERE workspace_id=$1) AS payments,(SELECT count(*) FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1) AS model_calls`,[ctx.workspaceId])).rows[0];
 const before=await counts();assert.equal(Number(before.movements),2);assert.equal(Number(before.stock),0);assert.equal(Number(before.payments),0);assert.equal(Number(before.model_calls),0);
 await pilot.decide(db,ctx,goal.id,card.id,card.sha256,true,decision);assert.deepEqual(await counts(),before,'Repeated approval delivery must not repeat any effect');
 await assert.rejects(workflows.createSalesOrder(db,ctx,{customerId:customer,deliveryMethod:'UNSUPPORTED',shipToAddress:'1 Test Ave',idempotencyKey:'invalid-mode',lines:[{skuId,quantity:1,unitPriceMinor:7500}]}),/Choose shipped delivery/);
 await page.goto(origin+'/actions/'+card.proposalId);assert.equal(await page.getByRole('button',{name:'Continue approved request',exact:true}).count(),0,'a completed request has no retry control');
 t.diagnostic(JSON.stringify({recordedConstraintReproduced:true,stepsCompleted:6,humanApprovals:1,actualBrowserContinuation:true,duplicateEffects:0,modifiedPayloadRejected:true,modelCalls:0}));
});

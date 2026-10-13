'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),fs=require('node:fs'),path=require('node:path');
const {randomUUID}=require('node:crypto'),trace=require('../fixtures/recorded-sales-clarification.json');
const store=require('../../src/assistant/postgres-goal-store'),pilot=require('../../src/assistant/postgres-codex-pilot');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('recorded clarification and unfamiliar multi-turn domains traverse the real website, SDK, approvals and PostgreSQL',{timeout:300000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();cluster.stop();for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Offline!'+randomUUID();
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline verification',businessName:'Offline lifecycle verification',email,password});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Offline lifecycle verification',emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE FAKE ONLY' WHERE workspace_id=$1`,[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 const sku='R-'+randomUUID().slice(0,7),item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Field repair kit '+randomUUID().slice(0,5),baseCode:sku,trackingMode:'quantity'});
 const variant=(await db.query('SELECT id FROM skus WHERE item_id=$1',[item.itemId])).rows[0];
 const location='South store '+randomUUID().slice(0,5),loc=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:location,kind:'warehouse'});
 const commerce=require('../../src/operations/postgres-commerce');
 const customer=await commerce.createCustomer(db,ctx,{name:'Cedar repairs '+randomUUID().slice(0,5),email:'cedar@example.test',shippingAddress:'18 Test Road'});
 const supplier=await commerce.createSupplier(db,ctx,{name:'Moorland parts '+randomUUID().slice(0,5),currency:'GBP'});
 await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId:variant.id,amount:'12.75',currency:'GBP'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:{complete:async()=>{throw Error('NO_PAID_CALLS');}}});
 cleanup.push(()=>app.locals.sessionStore.close());
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});cleanup.push(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`,browser=await require('playwright').chromium.launch();cleanup.push(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:900}}),web=request.agent(app),login=await web.get('/login');
 const signed=await web.post('/login').type('form').send({_csrf:csrf(login.text),email,password});
 const cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));await page.context().addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);
 const artifact=path.resolve('data/conversation-lifecycle');fs.mkdirSync(artifact,{recursive:true});
 const cases=[
  {name:'sales',goal:trace.request,question:JSON.parse(trace.rawFinal),reply:`For ${customer.name}, 2 ${sku}. Use the saved selling price and their saved address.`,
   follow:'Should I prepare this as a draft to ship to the saved address?',second:'Yes, prepare the draft for shipping. I will review the approval.',
   capability:'sales_order.create',args:{customer:customer.name,sku,quantity:2,deliveryMethod:'ship'},
   dataset:{dataset:'sales_orders',columns:['order_number','ordered_units','currency']},path:'/rows/0/ordered_units',value:2},
  {name:'inventory',goal:'The workshop counted a newly arrived carton. Record its contents after checking with me.',question:{status:'needs_user',question:'Which product arrived, how many units, and where was it received?',missingInformation:['Physical receipt details']},
   reply:`3 ${sku} arrived at ${location}.`,follow:'What reference should identify this physical receipt?',second:'Use receiving note FIELD-17.',
   capability:'inventory.receive',args:{sku,quantity:3,location,reference:'FIELD-17'},dataset:{dataset:'stock',columns:['sku','location','on_hand']},path:'/rows/0/on_hand',value:3},
  {name:'purchasing',goal:'Get a supplier order ready for next week’s maintenance work.',question:{status:'needs_user',question:'Which parts, supplier, quantity and receiving location should I use?',missingInformation:['Purchase choices']},
   reply:`5 ${sku} from ${supplier.name}, to ${location}.`,follow:'Which reference should identify this draft purchase?',second:'Use maintenance batch SERVICE-23.',
   capability:'purchase_order.create',args:{supplier:supplier.name,sku,quantity:5,location,reference:'SERVICE-23'},dataset:{dataset:'purchase_orders',columns:['po_number','status']},path:'/rows/0/status',value:'DRAFT'}
 ];
 const outcomes=[];
 for(const sample of cases){
  await page.goto(origin+'/ask');await page.getByRole('button',{name:'New conversation',exact:true}).click().catch(()=>{});
  await page.getByLabel('Ask StockChief',{exact:true}).fill(sample.goal);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
  const goal=await store.latest(db,ctx);let calls=0;
  const options={image:JSON.parse(fs.readFileSync('data/environment-agent-demo/codex-sdk-approval-handoff/runtime.json')).image,
   apiKey:'FAKE',countInput:async()=>({object:'response.input_tokens',input_tokens:200}),fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);calls++;
    if(calls===1)return require('../helpers/codex-offline-response').final(body,calls,sample.name==='sales'?trace.rawFinal:JSON.stringify(sample.question));
    assert(JSON.stringify(body).includes(sample.reply),'Native resumed context retains the first user answer');
    if(calls===2)return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({version:1,status:'needs_user',question:sample.follow,missingInformation:['One remaining user decision']}));
    assert(JSON.stringify(body).includes(sample.second),'Native resumed context retains the second user answer');
    if(calls===3){const steps=[{capability:sample.capability,arguments:Object.entries(sample.args).map(([name,value])=>({name,value})),dependsOn:[]}];
     return require('../helpers/codex-offline-response')(body,calls,`const op=ALL_TOOLS.find(t=>t.name.endsWith('__business_operations'));text(await tools[op.name](${JSON.stringify({stepsJson:JSON.stringify(steps)})}));`);}
    if(calls===4)return require('../helpers/codex-offline-response')(body,calls,`const d=ALL_TOOLS.find(t=>t.name.endsWith('__environment_dataset'));text(await tools[d.name](${JSON.stringify({specJson:JSON.stringify(sample.dataset),offset:0})}));`);
    assert.equal(calls,5,'No hidden retry');const current=await store.get(db,ctx,goal.id),entry=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='environment_dataset');
    let actual=JSON.parse(entry.text);for(const part of sample.path.slice(1).split('/'))actual=actual[part];assert.equal(String(actual),String(sample.value));
    return require('../helpers/codex-offline-response').final(body,calls,JSON.stringify({version:1,status:'completed',outcome:'answer',answer:'The approved operation is recorded and its current business state is verified.',claims:[{evidenceId:entry.id,path:sample.path,value:actual}]}));
   }};
  await page.getByLabel('Ask StockChief',{exact:true}).fill(sample.reply); // unsent input must survive the arriving question
  const first=await pilot.run(db,ctx,goal.id,options);assert.equal(first.status,'WAITING_USER');
  await page.locator('[data-goal-phase-text]').last().getByText('Let’s clarify',{exact:true}).waitFor({timeout:10000});
  assert.equal(await page.getByLabel('Ask StockChief',{exact:true}).inputValue(),sample.reply);
  assert(!await page.locator('body').innerText().then(s=>s.includes('"missingInformation"')||s.includes('Could not finish')));
  const qid=first.checkpoint.conversationState.input.id;
  if(sample.name==='sales')await page.screenshot({path:path.join(artifact,'recorded-sales-clarification-after.png'),fullPage:true});
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
  const resumed=await store.latest(db,ctx);assert.equal(resumed.id,goal.id);assert.deepEqual(resumed.checkpoint.messages,[sample.reply]);
  const duplicate=await store.reply(db,ctx,goal.id,sample.reply,{questionId:qid});assert(duplicate.replyReplayed);assert.equal(duplicate.checkpoint.messages.length,1);
  assert.equal(await store.reply(db,{...ctx,actorId:'not-this-actor'},goal.id,'intrusion',{questionId:qid}),null);
  await pilot.run(db,ctx,goal.id,options);await page.reload();
  const second=await store.get(db,ctx,goal.id);assert.notEqual(second.checkpoint.conversationState.input.id,qid);
  assert.equal(await store.reply(db,ctx,goal.id,'stale different answer',{questionId:qid}),null);
  const secondQuestion=second.checkpoint.conversationState.input.id;
  await page.getByLabel('Ask StockChief',{exact:true}).fill(sample.second);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
  assert.deepEqual((await store.get(db,ctx,goal.id)).checkpoint.messages,[sample.reply,sample.second]);
  const prepared=await pilot.run(db,ctx,goal.id,options);assert.equal(prepared.status,'WAITING_APPROVAL',prepared.answer);assert.equal(calls,3);
  await page.reload();const inbox=await pilot.inbox(db,ctx,goal.id);assert.equal(inbox.approvals.length,1);
  const proposal=inbox.approvals[0];assert.equal(proposal.canonicalStatus,'PENDING');
  if(sample.name==='sales'){assert.equal(proposal.payload.lines[0].unitPriceMinor,1275);assert.equal(proposal.payload.currency,'GBP');assert.equal(proposal.payload.shipToAddress,'18 Test Road');}
  assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 AND status=$3',[ctx.workspaceId,proposal.proposalId,'EXECUTED'])).rows[0].n,'0');
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve exact operation',exact:true}).click()]);
  const verified=await pilot.run(db,ctx,goal.id,options);assert.equal(verified.status,'COMPLETED',verified.answer);
  await page.reload();assert(await page.getByText('Completed and verified',{exact:true}).isVisible());
  assert((await page.locator('body').innerText()).includes(sample.reply));assert((await page.locator('body').innerText()).includes(sample.second));
  assert.equal((await db.query('SELECT status FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,proposal.proposalId])).rows[0].status,'EXECUTED');
  assert.equal((await store.get(db,ctx,goal.id)).original_request,sample.goal);
  const afterContext=await require('../../src/assistant/postgres-agent-context').capture(db,ctx);
  assert(JSON.stringify(afterContext).includes(sample.reply),'New goals can refer to earlier human replies, not just the original request');
  await pilot.decide(db,ctx,goal.id,proposal.id,proposal.sha256,true,{responseReference:'OFFLINE duplicate delivery'});
  assert.equal(calls,5,'Approval replay cannot cause another model call');
  if(sample.name==='sales')await page.screenshot({path:path.join(artifact,'sales-completed-after.png'),fullPage:true});
  outcomes.push({domain:sample.name,status:verified.status,simulatedProviderCalls:calls,humanReplies:2,simulatedWebsiteApprovals:1,secondQuestion});
 }
 const sales=(await db.query('SELECT o.currency,o.ship_to_address,l.quantity_ordered,l.unit_price_minor FROM sales_orders o JOIN sales_order_lines l ON l.sales_order_id=o.id AND l.workspace_id=o.workspace_id WHERE o.workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(sales.length,1);assert.equal(sales[0].currency,'GBP');assert.equal(Number(sales[0].quantity_ordered),2);assert.equal(Number(sales[0].unit_price_minor),1275);
 assert.equal((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,variant.id,loc.id])).rows[0].on_hand,'3');
 assert.equal((await db.query('SELECT count(*) AS n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'1');
 // Model final/host delivery is also exercised under interruption and restart.
 // These are deterministic boundary tests, not claimed independent reasoning.
 async function running(message){
  const created=await pilot.start(db,ctx,message),goal=await store.claim(db,ctx,created.goalId);
  const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:message,goalId:goal.id,runToken:goal.run_token});
  return {goal,session:require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize})};
 }
 const interrupted=await running('Compare the periods I choose for the management report.');
 const question={version:1,status:'needs_user',question:'Which two periods should I compare?',missingInformation:['Reporting periods']};
 await interrupted.session.recordReport(JSON.stringify(question));
 await db.query("UPDATE stockchief_runtime.assistant_goals SET tool_calls=30,checkpoint=jsonb_set(checkpoint,'{harness,codexRequests}','24'::jsonb) WHERE id=$1",[interrupted.goal.id]);
 await interrupted.session.stop({code:'DURABLE_MODEL_REQUEST_LIMIT'});
 let recovered=await store.get(db,ctx,interrupted.goal.id);assert.equal(recovered.status,'WAITING_USER');assert.equal(recovered.tool_calls,30);assert.equal(recovered.checkpoint.harness.codexRequests,24);
 const beforeLedger=(await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const restart=await running('Apply the time-zone setting I select.');await restart.session.recordReport(JSON.stringify({status:'needs_user',question:'Which time zone should this business use?',missingInformation:['Business time zone']}));
 await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 minute' WHERE id=$1",[restart.goal.id]);
 recovered=await require('../../scripts/environment-agent-demo/waits').recover(db,ctx,restart.goal.id);assert.equal(recovered.status,'WAITING_USER');
 const once=recovered.checkpoint.conversationState.history.length;
 recovered=await require('../../scripts/environment-agent-demo/waits').recover(db,ctx,restart.goal.id);assert.equal(recovered.checkpoint.conversationState.history.length,once,'Question delivered once across recovery');
 const unclear=await running('Investigate an interrupted adjustment.');await unclear.session.recordReport(JSON.stringify(question));
 await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 minute',checkpoint=jsonb_set(checkpoint,'{harness,inflight}',$2::jsonb) WHERE id=$1",[unclear.goal.id,JSON.stringify({name:'business_operations',consequential:true})]);
 recovered=await require('../../scripts/environment-agent-demo/waits').recover(db,ctx,unclear.goal.id);assert.equal(recovered.status,'BLOCKED','Unknown effects cannot become a user-question wait');
 await store.cancel(db,ctx,restart.goal.id);assert.equal(await store.reply(db,ctx,restart.goal.id,'Europe/London'),null,'Cancellation cannot be resumed by a late answer');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,beforeLedger,'Handoff/recovery spends nothing');
 const malformed=await running('Check a generic response boundary.');await malformed.session.finish({answer:'{"status":"completed","error":"PRIVATE_ADAPTER_FAILURE"}',verified:false});
 const progress=await web.get('/ask/goals/'+malformed.goal.id);assert.equal(progress.body.conversation.phase,'failed');
 assert(!JSON.stringify(progress.body).includes('PRIVATE_ADAPTER_FAILURE'));assert(!JSON.stringify(progress.body).includes('Agent report'));
 const legacy=await running(trace.request),repair=require('../../src/assistant/postgres-conversation-recovery');
 const packet={status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:trace.rawFinal}]}]};
 const oldHarness={...legacy.goal.checkpoint.harness,candidate:'codex',failure:{code:'OUTCOME_UNVERIFIED',requiresUserInput:false},
  codexDelivery:{state:'SETTLED',packet:{body:'data: '+JSON.stringify({type:'response.completed',response:packet})+'\n\n'}},
  lastCodexResponse:{terminal:true,empty:false,tool:false,usageSettled:true}};
 const oldCheckpoint={...legacy.goal.checkpoint,harness:oldHarness};
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',answer=$2,checkpoint=$3::jsonb WHERE id=$1",[legacy.goal.id,'Outcome not fully verified. Agent report:\n'+trace.rawFinal,JSON.stringify(oldCheckpoint)]);
 assert.equal(await repair.recoverClarification(db,{...ctx,actorId:'other-actor'},legacy.goal.id),null);
 const repaired=await repair.recoverClarification(db,ctx,legacy.goal.id);assert.equal(repaired.status,'WAITING_USER');
 assert.equal(repaired.answer,JSON.parse(trace.rawFinal).question);assert.equal(repaired.original_request,trace.request);
 assert.deepEqual(repaired.checkpoint.harness.codexDelivery,oldHarness.codexDelivery,'No model replay or altered usage settlement');
 assert.equal(await repair.recoverClarification(db,ctx,legacy.goal.id),null,'Repair is applied exactly once');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,beforeLedger,'Legacy repair cannot spend or retry');
 fs.writeFileSync(path.join(artifact,'results.json'),JSON.stringify({offline:true,realModel:false,paidCalls:0,outcomes,sales},null,2));
 t.diagnostic(JSON.stringify({outcomes,paidCalls:0,independentlyVerified:{salesOrders:1,stockUnits:3,purchaseOrders:1}}));
});

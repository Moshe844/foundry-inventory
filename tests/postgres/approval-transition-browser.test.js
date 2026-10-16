'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const request=require('supertest');

test('real browser distinguishes two approvals, pending external delivery and final verification without repeating effects',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();await cluster.stop();for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Offline!'+randomUUID(),business='Approval transitions '+randomUUID();
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reviewer',businessName:business,email,password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:business,emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=1000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1`,[ctx.workspaceId]);
 const sku='AT-'+randomUUID().slice(0,8);await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Workshop component',baseCode:sku,trackingMode:'quantity'});
 const supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Workshop supplier',email:'parts@example.test'});
 const connector='con_'+randomUUID(),at=new Date().toISOString();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
  VALUES($1,$2,$3,'Offline Gmail','gmail','["business mail"]','{}','connected','["mail:read","mail:send"]',$4,5,'CONNECTED',$5,'offline','offline@example.test',$6,$6)`,[connector,ctx.workspaceId,'gmail:'+connector,'connection_credentials:'+connector,ctx.actorId,at]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'offline-fixture-only'}));
 const store=require('../../src/assistant/postgres-goal-store'),pilot=require('../../src/assistant/postgres-codex-pilot'),handoff=require('../../scripts/environment-agent-demo/approval-handoff'),waits=require('../../scripts/environment-agent-demo/waits'),conversation=require('../../src/assistant/agent-conversation');
 let goal=await store.create(db,ctx,'Record the agreed supplier quote and send the supplier the reviewed message.');goal=await store.claim(db,ctx,goal.id);
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||'{"runtime":"codex-staging"}'::jsonb WHERE id=$1`,[goal.id]);
 const noModel={name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('NO_MODEL_CALLS');}};
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token,provider:noModel});
 await require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize}).load();
 const steps=[{capability:'catalog.set_purchase_cost',args:{sku,amount:17.25,currency:'GBP'}},{capability:'communication.send_email',args:{recipient:supplier.name,recipientKind:'supplier',subject:'Reviewed quote',body:'Please confirm the agreed quote.',mailbox:'gmail'}}];
 const prepared=await gateway.operate({steps:steps.map(({args,...s})=>({...s,arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)})),dependsOn:[]}))});
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness,calls}',$2::jsonb) WHERE id=$1`,[goal.id,JSON.stringify({fixture:{state:'DONE',result:prepared}})]);
 await handoff.inbox(db,ctx,goal.id,{pause:true,runToken:goal.run_token});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:noModel});cleanup.push(()=>app.locals.sessionStore.close());
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});cleanup.push(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port,web=request.agent(app),login=await web.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1];
 const signed=await web.post('/login').type('form').send({_csrf:csrf,email,password}),cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));
 const browser=await require('playwright').chromium.launch();cleanup.push(()=>browser.close());const context=await browser.newContext({viewport:{width:1100,height:900}});
 await context.addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);
 const page=await context.newPage(),other=await context.newPage(),url=origin+'/ask?goal='+goal.id+'#focused-goal';
 const artifacts=path.resolve('data/approval-transition-browser');fs.mkdirSync(artifacts,{recursive:true});
 const panel=page.locator('[data-adaptive-goal="'+goal.id+'"]'),otherPanel=other.locator('[data-adaptive-goal="'+goal.id+'"]');
 await page.goto(url);await other.goto(url);assert.equal(await panel.locator('[data-approval-id]').count(),1);
 // Real form submissions call the same durable human-decision and canonical
 // execution path as the recorded request; there is no model or real email.
 await Promise.all([page.waitForNavigation(),panel.getByRole('button',{name:'Approve this change',exact:true}).click()]);
 const next=(await pilot.inbox(db,ctx,goal.id)).approvals;assert.equal(next.length,1);assert.equal(next[0].proposal.action_type,'communication.send_email');
 await Promise.all([page.waitForNavigation(),panel.getByRole('button',{name:'Approve this change',exact:true}).click()]);
 const saved=await store.get(db,ctx,goal.id);assert.equal(saved.status,'WAITING_EVENT');
 const deliveries=Object.values(saved.checkpoint.harness.approvalDeliveries);assert.equal(deliveries.length,2);assert(deliveries.every(d=>d.decision.approved&&d.canonicalStatus==='EXECUTED'));
 const effect=(await db.query(`SELECT id,status FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send'`,[ctx.workspaceId])).rows[0];assert.equal(effect.status,'PENDING');
 const message=await panel.locator('[data-goal-answer]').innerText();await page.screenshot({path:path.join(artifacts,'after-second-approval.png'),fullPage:true});
 fs.writeFileSync(path.join(artifacts,'observed.json'),JSON.stringify({status:saved.status,message,modelCalls:0,offline:true,realModel:false},null,2));
 assert(!message.includes('Approval required'),'Recorded defect: WAITING_EVENT still displays the old approval request');assert(!message.includes('not executed'));
 assert.match(message,/No further approval/);assert.equal(await panel.locator('[data-approval-id]').count(),0);assert(!/Completed/.test(await panel.locator('[data-goal-phase-text]').innerText()));
 await otherPanel.waitFor({state:'visible'});await other.waitForFunction(id=>document.querySelector('[data-adaptive-goal="'+id+'"]')?.dataset.goalStatus==='WAITING_EVENT',goal.id);
 assert.equal(await otherPanel.locator('[data-approval-id]').count(),0);assert(!/Approval required/.test(await otherPanel.locator('[data-goal-answer]').innerText()));
 assert.deepEqual(conversation.state(await store.progress(db,ctx,goal.id)),conversation.state(saved));
 const reconnect=await context.newPage();await reconnect.goto(url);assert(!/Approval required/.test(await reconnect.locator('[data-adaptive-goal="'+goal.id+'"] [data-goal-answer]').innerText()));
 let sends=0;await require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,effect.id,{provider:{send:async()=>{sends++;return{externalMessageId:'offline-delivery',externalThreadId:'offline-thread'};}}});
 // Provider acceptance alone does not finish the durable mission. Run its
 // ordinary canonical resumption before admitting final goal verification.
 assert.equal((await waits.refresh(db,ctx,goal.id)).status,'WAITING_EVENT');
 const mission=await require('../../src/assistant/postgres-capability-plans').missionForProposal(db,ctx.workspaceId,ctx.actorId,deliveries.find(d=>d.proposalId===next[0].proposalId).proposalId);
 await require('../../src/assistant/postgres-service').resumeMission(db,ctx,mission.id,{provider:noModel});
 const verified=await waits.refresh(db,ctx,goal.id);assert.equal(verified.status,'READY');assert.equal(verified.checkpoint.lifecycleStage,'verification');
 assert.equal(verified.checkpoint.conversationState.phase,'verification');assert(!verified.answer.includes('Approval required'));
 await page.reload();assert.match(await panel.locator('[data-goal-phase-text]').innerText(),/Checking the result/);assert.equal(await panel.locator('[data-approval-id]').count(),0);
 await page.screenshot({path:path.join(artifacts,'checking-complete-result.png'),fullPage:true});
 assert.equal(await store.progress(db,{...ctx,actorId:'foreign-user'},goal.id),null);await assert.rejects(pilot.inbox(db,{...ctx,actorId:'foreign-user'},goal.id));
 await require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,effect.id,{provider:{send:async()=>{throw Error('DUPLICATE_SEND');}}});
 assert.equal(sends,1);assert.deepEqual((await db.query('SELECT amount_minor,currency FROM sku_purchase_costs WHERE workspace_id=$1',[ctx.workspaceId])).rows.map(r=>({amountMinor:Number(r.amount_minor),currency:r.currency})),[{amountMinor:1725,currency:'GBP'}]);
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,effect.id])).rows[0].status,'SUCCEEDED');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 t.diagnostic(JSON.stringify({recordedBoundaryReproduced:true,browserApprovalSubmissions:2,canonicalChanges:2,externalSends:sends,paidCalls:0,otherTabAndReconnectVerified:true,tenantIsolation:true,finalVerificationNotSkipped:true}));
});

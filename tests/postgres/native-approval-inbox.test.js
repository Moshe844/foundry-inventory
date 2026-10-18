'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('recorded missing native approvals appear consistently in the actor inbox without granting authority or writing on reads',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();cluster.stop();for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),email=randomUUID()+'@example.test',password='Offline!'+randomUUID(),business='Decision inbox '+randomUUID();
 const owner=await auth.createBusiness(db,{name:'Reviewer',businessName:business,email,password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const foreign=await auth.createBusiness(db,{name:'Other owner',businessName:'Foreign '+randomUUID(),email:randomUUID()+'@example.test',password});
 const colleague='usr_'+randomUUID();await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at)
  SELECT $1,$2,account_id,'Another member','staff',created_at FROM users WHERE id=$3`,[colleague,ctx.workspaceId,foreign.userId]);
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:business,emails:[email]})).environment);
 const store=require('../../src/assistant/postgres-goal-store'),handoff=require('../../scripts/environment-agent-demo/approval-handoff'),service=require('../../src/assistant/postgres-service'),projection=require('../../src/projections/postgres-service');
 async function prepare(label,scope=ctx,kind='business',actionType='location.create'){
  const goal=await store.create(db,scope,'Prepare '+label+' for my approval.');let id;
  if(kind==='business')id=(await service.createProposal(db,scope,goal.original_request,actionType,{name:label,kind:'warehouse'},'Prepared '+label)).proposal.id;
  else {id='rule_'+randomUUID();await db.query(`INSERT INTO operating_instruction_proposals(id,workspace_id,created_by_user_id,stated_as,summary,integrity_hash,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,[id,scope.workspaceId,scope.actorId,goal.original_request,'Review a lasting stock warning',randomUUID(),new Date().toISOString()]);}
  const h={calls:{prepared:{state:'DONE',result:{outcomes:[{result:{proposal:{id}}}]}}}},cards=await handoff.stage(db,scope,goal,h);
  assert.equal(cards.length,1);
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET status='WAITING_APPROVAL',checkpoint=$2::jsonb WHERE id=$1`,[goal.id,JSON.stringify({runtime:'codex-staging',harness:h})]);
  return {goalId:goal.id,proposalId:id,card:cards[0],label};
 }
 // The live trace omitted eleven real native cards; exceed the existing
 // ten-row read limit so truncated coverage cannot masquerade as exhaustive.
 const ready=[];for(let i=0;i<11;i++)ready.push(await prepare('Review shelf '+i));
 const rule=await prepare('stock warning',ctx,'rule');ready.push(rule);
 await prepare('private colleague change',{...ctx,actorId:colleague});
 const other=await prepare('foreign workspace change',{workspaceId:foreign.workspaceId,actorId:foreign.userId});
 const edited=await prepare('edited revision');await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET summary='Changed after delivery' WHERE id=$1",[edited.proposalId]);
 const expired=await prepare('expired request');await db.query("UPDATE stockchief_runtime.assistant_goals SET expires_at=now()-interval '1 second' WHERE id=$1",[expired.goalId]);
 const cancelled=await prepare('cancelled request');await db.query("UPDATE stockchief_runtime.assistant_goals SET status='CANCELLED' WHERE id=$1",[cancelled.goalId]);
 const decided=await prepare('recorded human decision');await db.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,ARRAY['harness','approvalDeliveries',$2,'decision'],$3::jsonb) WHERE id=$1`,[decided.goalId,decided.card.id,JSON.stringify({source:'human_user',approved:true,responseReference:'OFFLINE ONLY',at:new Date().toISOString()})]);
 const done=await prepare('executed proposal');await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET status='EXECUTED' WHERE id=$1",[done.proposalId]);
 const frozen=[{capability:'location.create',args:{name:ready[0].label,kind:'warehouse'},dependsOn:[],continuesPending:false},{capability:'read.locations',args:{},dependsOn:[0],continuesPending:false}];
 const hash=require('../../src/assistant/postgres-capability-plans').planHash(frozen),mission='mission_'+randomUUID();
 await db.query(`INSERT INTO stockchief_runtime.assistant_capability_plans(id,workspace_id,actor_user_id,batch_id,source_message,steps,status,waiting_proposal_id,goal_id,plan_hash,approved_steps,approval_status)
  VALUES($1,$2,$3,$1,'Offline frozen proposal',$4::jsonb,'WAITING',$5,$6,$7,$8::jsonb,'PENDING')`,[mission,ctx.workspaceId,ctx.actorId,JSON.stringify([{proposalId:ready[0].proposalId}]),ready[0].proposalId,ready[0].goalId,hash,JSON.stringify(frozen)]);
 const before=await db.query(`SELECT id,status,checkpoint,updated_at FROM stockchief_runtime.assistant_goals ORDER BY id`);
 const readonly={query:async(sql,args)=>{assert.match(sql.trim(),/^(SELECT|WITH)\b/i);return db.query(sql,args);}};
 const items=await projection.needs(readonly,ctx.workspaceId,ctx.actorId),native=items.filter(i=>i.approval);
 assert.equal(native.length,12);assert.equal(await projection.needsCount(readonly,ctx.workspaceId,ctx.actorId),items.length);
 assert.equal((await projection.brief(readonly,ctx.workspaceId,ctx.actorId)).needs.length,items.length);
 assert.equal((await projection.needs(readonly,ctx.workspaceId)).filter(i=>i.approval).length,0,'Workspace-only callers never receive actor-private cards');
 assert.equal((await projection.needs(readonly,ctx.workspaceId,colleague)).filter(i=>i.approval).length,0,'Pilot membership is still required');
 assert.equal((await projection.needs(readonly,foreign.workspaceId,ctx.actorId)).filter(i=>i.approval).length,0);
 assert(!native.some(i=>i.approval.proposalId===other.proposalId));
 const first=native.find(i=>i.approval.proposalId===ready[0].proposalId);assert.equal(first.approval.scope,'single_operation');assert.deepEqual(first.approval.missionOption,{id:mission,sha256:hash,count:2});
 assert.match(first.href,new RegExp(ready[0].goalId));assert(!JSON.stringify(first).includes('payload'));
 const read=await service.lookup(readonly,ctx,{view:'needs_you'});assert.equal(read.coverage.returned,10);assert.equal(read.coverage.total,items.length);assert.equal(read.coverage.complete,false);assert.equal(read.handoff.href,'/needs-you/all');assert.match(read.answer,/not the complete list/);
 assert.deepEqual((await db.query(`SELECT id,status,checkpoint,updated_at FROM stockchief_runtime.assistant_goals ORDER BY id`)).rows,before.rows);
 // Spending exhaustion and a dead SDK do not erase already-durable approval
 // delivery. This read neither calls the model nor resets financial limits.
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET stopped=true,period_ends_at=now()-interval '1 second' WHERE workspace_id=$1`,[ctx.workspaceId]);
 assert.equal((await projection.needs(readonly,ctx.workspaceId,ctx.actorId)).filter(i=>i.approval).length,12);
 const noModel={complete:async()=>{throw Error('NO_MODEL_CALLS');}},app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:noModel});cleanup.push(()=>app.locals.sessionStore.close());
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});cleanup.push(()=>new Promise(resolve=>server.close(resolve)));
 const origin='http://127.0.0.1:'+server.address().port,web=require('supertest').agent(app),login=await web.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1];
 const signed=await web.post('/login').type('form').send({_csrf:csrf,email,password}),cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));
 const browser=await require('playwright').chromium.launch();cleanup.push(()=>browser.close());const context=await browser.newContext({viewport:{width:1180,height:900}});
 await context.addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);const page=await context.newPage();
 await page.goto(origin+'/needs-you/all');assert.equal(await page.getByRole('link',{name:'Review approval',exact:true}).count(),12);assert.equal((await page.locator('a[href="/needs-you"] .nav-count').innerText()).trim(),String(items.length));
 const artifacts=require('node:path').resolve('data/native-approval-inbox');require('node:fs').mkdirSync(artifacts,{recursive:true});await page.screenshot({path:artifacts+'/all-pending.png',fullPage:true});
 const href=await page.getByRole('link',{name:'Review approval',exact:true}).first().getAttribute('href');await page.goto(origin+href);
 assert.equal(await page.locator('[data-adaptive-goal="'+ready[0].goalId+'"] [data-approval-id]').count(),1);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[ready[0].proposalId])).rows[0].status,'PENDING');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM locations WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,ready[0].label])).rows[0].n),0,'Opening review grants no execution authority');
 const expiredState=(await db.query('SELECT status,checkpoint FROM stockchief_runtime.assistant_goals WHERE id=$1',[expired.goalId])).rows[0];assert.equal(expiredState.status,'BLOCKED');assert.equal(expiredState.checkpoint.harness.failure.code,'GOAL_EXPIRED');
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[expired.proposalId])).rows[0].status,'PENDING','Expiry does not execute or erase the canonical proposal');
 const progress=await page.evaluate(async id=>{const r=await fetch('/ask/goals/'+id);return {status:r.status,body:await r.json()};},expired.goalId);assert.equal(progress.status,200);assert.equal(progress.body.status,'BLOCKED');assert.deepEqual(progress.body.approvalIds,[]);assert.match(progress.body.answer,/expired/);
 const expiryClock=(await db.query('SELECT updated_at FROM stockchief_runtime.assistant_goals WHERE id=$1',[expired.goalId])).rows[0].updated_at;
 assert.deepEqual((await handoff.inbox(db,ctx,expired.goalId)).approvals,[]);
 assert.equal((await db.query('SELECT updated_at FROM stockchief_runtime.assistant_goals WHERE id=$1',[expired.goalId])).rows[0].updated_at.toISOString(),expiryClock.toISOString(),'Expired handoff reads are idempotent');
 const financial=await prepare('Private supplier payment amount',ctx,'business','supplier_payment.record');
 const ownerOnly=await prepare('Private pricing authority',ctx,'business','pricing.rule.configure');
 for(const [type,title]of [['purchase','Private purchase terms'],['transfer','Private transfer scope']])await db.query(`INSERT INTO work_items(id,workspace_id,category,source,recommended_action,idempotency_key,created_at) VALUES($1,$2,'replenishment_plan','offline',$3,$1,$4)`,['work_'+randomUUID(),ctx.workspaceId,JSON.stringify({type,title,summary:title}),new Date().toISOString()]);
 assert((await projection.needs(readonly,ctx.workspaceId,ctx.actorId)).some(i=>i.approval?.proposalId===financial.proposalId));
 await db.query("UPDATE users SET role='staff',permissions='[\"VIEW\"]' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 assert.deepEqual(await projection.needs(readonly,ctx.workspaceId,ctx.actorId),[],'A private proposal does not outlive current domain/action permission');
 assert.equal(await projection.needsCount(readonly,ctx.workspaceId,ctx.actorId),0);
 await page.goto(origin+'/needs-you');assert.equal(await page.locator('.ny-card').count(),0);assert(!/Private (supplier|purchase|transfer)/.test(await page.locator('main').innerText()));
 for(const [grant,allowed,hidden]of [['VIEW_PURCHASING','Private purchase terms','Private transfer scope'],['VIEW_TRANSFERS','Private transfer scope','Private purchase terms']]){
  await db.query('UPDATE users SET permissions=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,JSON.stringify(['VIEW',grant])]);
  const restricted=await projection.needs(readonly,ctx.workspaceId,ctx.actorId);assert.equal(restricted.length,1);assert.equal(restricted[0].title,allowed);assert(!restricted.some(i=>i.title===hidden));assert.equal(await projection.needsCount(readonly,ctx.workspaceId,ctx.actorId),1);
 }
 await db.query('UPDATE users SET permissions=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId,JSON.stringify(['ADMIN'])]);
 const adminOnly=await projection.needs(readonly,ctx.workspaceId,ctx.actorId);assert(!adminOnly.some(i=>[ownerOnly.proposalId,rule.proposalId].includes(i.approval?.proposalId)),'ADMIN does not restore owner-only authority');assert.equal(await projection.needsCount(readonly,ctx.workspaceId,ctx.actorId),adminOnly.length);
 t.diagnostic(JSON.stringify({nativeApprovals:12,excludesStaleExpiredCancelledDecidedExecuted:true,actorAndTenantIsolation:true,completeCoverageMetadata:true,realBrowserReviewLink:true,paidCalls:0}));
});

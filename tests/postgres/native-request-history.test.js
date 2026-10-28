'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('recorded discovery gaps: paginated owned history exposes canonical effects across conversations without resuming work',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),cleanup=[];
 t.after(async()=>{for(const close of cleanup.reverse())await close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),email=randomUUID()+'@example.test',password='History!'+randomUUID();
 const owner=await auth.createBusiness(db,{name:'History owner',businessName:'History '+randomUUID(),email,password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const foreign=await auth.createBusiness(db,{name:'Other owner',businessName:'Other '+randomUUID(),email:randomUUID()+'@example.test',password});
 const colleague='usr_'+randomUUID();await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) SELECT $1,$2,account_id,'Colleague','staff',created_at FROM users WHERE id=$3",[colleague,ctx.workspaceId,foreign.userId]);
 const store=require('../../src/assistant/postgres-goal-store'),history=require('../../src/assistant/postgres-goal-history'),service=require('../../src/assistant/postgres-service'),ids=[];
 for(let i=0;i<44;i++){
  const g=await store.create(db,ctx,'Unfamiliar saved request '+i);ids.push(g.id);
  // Sub-millisecond collisions reproduce the pagination precision boundary.
  await db.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',answer='Saved result before final reporting.',
   created_at='2026-01-01T00:00:00Z'::timestamptz+($2::integer/2)*interval '1 microsecond',expires_at=now()-interval '1 day',
   checkpoint=$3::jsonb WHERE id=$1`,[g.id,i,JSON.stringify({runtime:'codex-staging',harness:{native:{private:'PRIVATE_NATIVE_SECRET'}}})]);
 }
 const proposal=(await service.createProposal(db,ctx,'Create a shelf','location.create',{name:'Historical shelf',kind:'warehouse'},'Create historical shelf')).proposal;
 // Canonical status fixtures test the projection, not an agent's performance.
 await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET status='EXECUTED' WHERE id=$1",[proposal.id]);
 const p2=(await service.createProposal(db,ctx,'Second shelf','location.create',{name:'Mission shelf',kind:'warehouse'},'Second recorded operation')).proposal;
 await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET status='EXECUTED' WHERE id=$1",[p2.id]);
 const pending=(await service.createProposal(db,ctx,'Unapproved shelf','location.create',{name:'Unapproved shelf',kind:'warehouse'},'Unapproved shelf')).proposal;
 const rule='oin_'+randomUUID();await db.query(`INSERT INTO operating_instruction_proposals(id,workspace_id,created_by_user_id,stated_as,summary,integrity_hash,status,created_at,updated_at)
  VALUES($1,$2,$3,'Lasting instruction','Recorded rule approval',$4,'APPROVED',$5,$5)`,[rule,ctx.workspaceId,ctx.actorId,randomUUID(),new Date().toISOString()]);
 const deliveries={a:{kind:'business',proposalId:proposal.id,canonicalStatus:'PENDING'},again:{kind:'business',proposalId:proposal.id},
  pending:{kind:'business',proposalId:pending.id,canonicalStatus:'EXECUTED'},rule:{kind:'rule',proposalId:rule}};
 await db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness,approvalDeliveries}',$2::jsonb) WHERE id=$1",[ids[0],JSON.stringify(deliveries)]);
 await db.query(`INSERT INTO stockchief_runtime.assistant_capability_plans(id,workspace_id,actor_user_id,batch_id,source_message,steps,goal_id,status)
  VALUES($1,$2,$3,$1,'Recorded mission',$4::jsonb,$5,'BLOCKED')`,['plan_'+randomUUID(),ctx.workspaceId,ctx.actorId,JSON.stringify([{proposalId:p2.id},{proposalId:proposal.id}]),ids[0]]);
 const single=(await service.createProposal(db,ctx,'Earlier single operation','location.create',{name:'Old single shelf',kind:'warehouse'},'Earlier operation without native card')).proposal;
 await db.query("UPDATE stockchief_runtime.assistant_action_proposals SET status='EXECUTED' WHERE id=$1",[single.id]);
 // The original adaptive controller retains this host-written association
 // after waiting is cleared. No native approval delivery or mission exists.
 await db.query(`INSERT INTO stockchief_runtime.assistant_interactions(id,workspace_id,actor_user_id,message,intent,status,answer,evidence,created_at)
  VALUES($1,$2,$3,'Earlier single operation',$4::jsonb,'PREPARED','Prepared before execution','[]'::jsonb,$5)`,
  ['interaction_'+randomUUID(),ctx.workspaceId,ctx.actorId,JSON.stringify({batchId:ids[2]+':1',proposalId:single.id}),new Date().toISOString()]);
 const otherGoal=await store.create(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},'PRIVATE_OTHER_TENANT');
 const colleagueGoal=await store.create(db,{...ctx,actorId:colleague},'PRIVATE_OTHER_ACTOR');
 await db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{harness,approvalDeliveries}',$2::jsonb) WHERE id=$1",[ids[1],JSON.stringify({forged:{kind:'business',proposalId:'foreign_proposal'}})]);
 const before=(await db.query('SELECT id,status,checkpoint,updated_at FROM stockchief_runtime.assistant_goals ORDER BY id')).rows,locationCount=(await db.query('SELECT count(*) AS n FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const guarded={query:async(sql,args)=>{assert.match(sql.trim(),/^(SELECT|WITH)\b/);return db.query(sql,args);},transaction:async(fn,options)=>{
  assert.equal(options.readOnly,true);return fn(guarded);
 }};
 let page=await history.list(guarded,ctx,{status:'BLOCKED'}),all=[];
 assert.deepEqual(page.statusCounts.find(r=>r.status==='BLOCKED'),{status:'BLOCKED',label:history.labels.BLOCKED,total:44,expired:44,withinLifetime:0});
 assert(page.rows.every(r=>r.expired&&r.phase==='failed'&&r.publicSummary.includes('could not confirm')));
 assert(!JSON.stringify(page).includes('PRIVATE_NATIVE_SECRET'));assert(page.rows.every(r=>!Object.hasOwn(r,'public_checkpoint')&&!Object.hasOwn(r,'answer')));
 while(true){assert.equal(page.total,44);assert(page.rows.length<=20);all.push(...page.rows.map(g=>g.id));if(!page.next)break;page=await history.list(guarded,ctx,{status:'BLOCKED',before:page.next});}
 assert.equal(all.length,44);assert.equal(new Set(all).size,44);assert.deepEqual(new Set(all),new Set(ids));
 await assert.rejects(()=>history.list(guarded,ctx,{status:"BLOCKED' OR TRUE"}),/available request status/);
 await assert.rejects(()=>history.list(guarded,ctx,{before:'not-a-cursor'}),/history page is unavailable/);
 const effects=await history.effects(guarded,ctx,[ids[0],ids[1],ids[2],otherGoal.id,colleagueGoal.id]);
 assert.equal(effects.get(ids[0]).filter(e=>e.kind==='business').length,2,'Mission-only effects included, duplicate delivery references collapsed');
 assert.equal(effects.get(ids[0]).filter(e=>e.kind==='rule').length,1);
 assert.deepEqual(effects.get(ids[2]).map(e=>e.id),[single.id],'Existing adaptive single-operation associations survive cleared waiting state');
 assert(!effects.get(ids[0]).some(e=>e.id===pending.id),'Cached delivery EXECUTED is not canonical proof');
 assert.equal(effects.get(otherGoal.id).length,0);assert.equal(effects.get(colleagueGoal.id).length,0);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:{complete:async()=>{throw Error('NO_PAID_CALLS');}}});cleanup.push(()=>app.locals.sessionStore.close());
 const web=require('supertest').agent(app),login=await web.get('/login'),csrf=/name="_csrf" value="([^"]+)"/.exec(login.text)[1],signed=await web.post('/login').type('form').send({_csrf:csrf,email,password});
 const ask=await web.get('/ask');assert.match(ask.text,/href="\/ask\/history"/);
 assert.equal((await web.post('/ask/new').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(ask.text)[1]})).status,303);
 // Exact live UI defect: unrelated workspace-wide PENDING rules were appended
 // as the assistant's replies even after starting an isolated new chat.
 const ruleIds={old:'oin_'+randomUUID(),current:'oin_'+randomUUID(),other:'oin_'+randomUUID()};
 for(const[k,id]of Object.entries(ruleIds))await db.query(`INSERT INTO operating_instruction_proposals
  (id,workspace_id,created_by_user_id,stated_as,summary,integrity_hash,status,created_at,updated_at)
  VALUES($1,$2,$3,$4,$4,$5,'PENDING',$6,$6)`,[id,ctx.workspaceId,k==='other'?colleague:ctx.actorId,'Pending conversation scope '+k,randomUUID(),new Date().toISOString()]);
 const fresh=await web.get('/ask');for(const id of Object.values(ruleIds))assert(!fresh.text.includes('/operating-instructions/'+id),'Unassociated pending work must not become a conversational reply');
 await db.query(`INSERT INTO stockchief_runtime.assistant_interactions(id,workspace_id,actor_user_id,message,intent,status,answer,evidence,created_at)
  VALUES($1,$2,$3,'Current visible rule request',$4::jsonb,'PREPARED','Prepared for review','[]'::jsonb,clock_timestamp())`,['interaction_'+randomUUID(),ctx.workspaceId,ctx.actorId,JSON.stringify({intent:'standing_instruction',proposalId:ruleIds.current})]);
 const currentChat=await web.get('/ask');assert(currentChat.text.includes('/operating-instructions/'+ruleIds.current));assert(!currentChat.text.includes('/operating-instructions/'+ruleIds.old));assert(!currentChat.text.includes('/operating-instructions/'+ruleIds.other));
 const currentCsrf=/name="_csrf" value="([^"]+)"/.exec(currentChat.text)[1];assert.equal((await web.post('/ask/new').type('form').send({_csrf:currentCsrf})).status,303);
 const resetChat=await web.get('/ask');for(const id of Object.values(ruleIds))assert(!resetChat.text.includes('/operating-instructions/'+id));
 assert((await db.query('SELECT status FROM operating_instruction_proposals WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,Object.values(ruleIds)])).rows.every(r=>r.status==='PENDING'),'Conversation scoping never cancels, approves or activates the global pending records');
 const detail=await web.get('/ask/history?goal='+ids[0]);assert.equal(detail.status,200);assert.match(detail.text,/could not confirm/);assert.match(detail.text,/Rule approval does not prove/);assert.match(detail.text,/Operation recorded/);assert(!detail.text.includes('Email delivered'));
 // The recorded slow investigation had to open four individual clarification
 // pages and a blocked page because the index omitted these public states.
 const publicFixtureBefore=(await db.query('SELECT id,status,answer,expires_at,checkpoint,updated_at FROM stockchief_runtime.assistant_goals WHERE id=ANY($1::text[])',[[ids[3],ids[4]]])).rows;
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET status='WAITING_USER',answer='Which location should this use?',
  expires_at=now()+interval '1 day',checkpoint=$2::jsonb WHERE id=$1`,[ids[3],JSON.stringify({harness:{userQuestion:{question:'Which location should this use?',missingInformation:['Location']},native:{private:'PRIVATE_NATIVE_SECRET'}},conversationState:{history:[{text:'PRIVATE_HISTORY_PAYLOAD'}]}})]);
 await db.query(`UPDATE stockchief_runtime.assistant_goals SET answer='TypeError: PRIVATE_DIAGNOSTIC',
  checkpoint=$2::jsonb WHERE id=$1`,[ids[4],JSON.stringify({harness:{interruption:{code:'DURABLE_TOOL_LIMIT'},native:{private:'PRIVATE_NATIVE_SECRET'}}})]);
 const publicList=await history.list(guarded,ctx);
 // Select the status directly because microsecond pagination correctly places
 // these older records outside the first unfiltered page.
 const questions=await history.list(guarded,ctx,{status:'WAITING_USER'});assert.equal(questions.total,1);
 assert.equal(questions.rows[0].publicSummary,'Which location should this use?');assert.equal(questions.rows[0].phase,'clarification');assert.equal(questions.rows[0].expired,false);
 const stopped=await history.list(guarded,ctx,{status:'BLOCKED'}),limited=stopped.rows.find(r=>r.id===ids[4])||
  (await history.list(guarded,ctx,{status:'BLOCKED',before:stopped.next})).rows.find(r=>r.id===ids[4]);
 assert.equal(limited.phase,'goal_limit');assert(limited.publicSummary.includes('allowance'));assert(limited.expired);
 assert(!JSON.stringify([publicList,questions,stopped,limited]).match(/PRIVATE_NATIVE_SECRET|PRIVATE_HISTORY_PAYLOAD|PRIVATE_DIAGNOSTIC/));
 const listPage=await web.get('/ask/history?status=WAITING_USER');assert.equal(listPage.status,200);assert.match(listPage.text,/Request status counts/);assert.match(listPage.text,/Which location should this use\?/);assert.match(listPage.text,/expired/i);
 for(const row of publicFixtureBefore)await db.query('UPDATE stockchief_runtime.assistant_goals SET status=$2,answer=$3,expires_at=$4,checkpoint=$5::jsonb,updated_at=$6 WHERE id=$1',[row.id,row.status,row.answer,row.expires_at,JSON.stringify(row.checkpoint),row.updated_at]);
 assert(!detail.text.includes('PRIVATE_NATIVE_SECRET'));assert(!detail.text.includes('/resume"'));assert(!detail.text.includes('/approval"'));
 for(const id of [otherGoal.id,colleagueGoal.id])assert.equal((await web.get('/ask/history?goal='+id)).status,404);
 // The real restricted renderer discovers this index through the application,
 // without receiving another registered route/command in its tool contracts.
 const inspection=await require('../../scripts/environment-agent-demo/inspection').createInspectionServer({cluster,database:db,ctx});cleanup.push(()=>inspection.close());
 const browser=await require('playwright').chromium.launch();cleanup.push(()=>browser.close());const tab=await browser.newPage({viewport:{width:1200,height:900}});
 await tab.goto(inspection.origin+'/ask');await tab.getByRole('link',{name:'All conversations',exact:true}).click();await tab.locator('#history-status').selectOption('BLOCKED');await tab.getByRole('button',{name:'Filter',exact:true}).click();
 assert.equal(await tab.locator('tbody tr').count(),20);await tab.getByRole('link',{name:'Older requests →',exact:true}).click();assert.equal(await tab.locator('tbody tr').count(),20);
 await tab.goto(inspection.origin+'/ask/history?goal='+ids[0]);await tab.getByRole('heading',{name:'Recorded outcomes',exact:true}).waitFor();assert.equal(await tab.getByRole('link',{name:'Create historical shelf',exact:true}).count(),1);
 const folder=require('node:path').resolve('data/native-request-history');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:folder+'/recorded-effects-read-only.png',fullPage:true});
 assert.deepEqual((await db.query('SELECT id,status,checkpoint,updated_at FROM stockchief_runtime.assistant_goals ORDER BY id')).rows,before);
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,locationCount,'No shelf was executed by a history read');
 t.diagnostic(JSON.stringify({mechanicalBrowserAndPgTest:true,notRealModelCertification:true,paidCalls:0,requests:44,microsecondPagination:true,tenantActorIsolation:true,canonicalEffectsDeduplicated:true,readOnlyInspectionNavigation:true}));
});

test('catalogue reports distinguish parent product status from variant status without changing combined status',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Catalogue owner',businessName:'Catalogue '+randomUUID(),email:randomUUID()+'@example.test',password:'Catalogue!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const make=async name=>require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name,baseCode:randomUUID(),trackingMode:'quantity'});
 const a=await make('Active parent inactive variant'),b=await make('Inactive parent active variant'),c=await make('Both active');
 await db.query('UPDATE skus SET is_active=0 WHERE id=$1',[a.skuIds[0]]);await db.query('UPDATE items SET is_active=0 WHERE id=$1',[b.itemId]);
 const actor=await auth.getMembership(db,ctx.workspaceId,owner.accountId);
 const reports=require('../../src/reports/postgres-service'),spec={dataset:'catalogue',columns:['sku','status','product_status','variant_status']};
 const result=await reports.run(db,ctx,actor,spec),by=Object.fromEntries(result.rows.map(r=>[r.record_id,r]));
 assert.equal(by[a.itemId].status,'inactive');assert.equal(by[a.itemId].product_status,'active');assert.equal(by[a.itemId].variant_status,'inactive');
 assert.equal(by[b.itemId].status,'inactive');assert.equal(by[b.itemId].product_status,'inactive');assert.equal(by[b.itemId].variant_status,'active');assert.equal(by[c.itemId].status,'active');
 const filtered=await reports.run(db,ctx,actor,{...spec,filters:[{field:'product_status',operator:'equals',value:'active'},{field:'variant_status',operator:'equals',value:'inactive'}]});assert.equal(filtered.rows.length,1);assert.equal(filtered.rows[0].record_id,a.itemId);
});

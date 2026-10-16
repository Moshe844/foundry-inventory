'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('actual Ask browser never renders late native tool reads as fresh customer requests outside the visible goal window',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let renderer,browser;
 t.after(async()=>{if(browser)await browser.close();if(renderer)await renderer.close();await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Transcript owner',businessName:'Transcript fixture',email:randomUUID()+'@example.test',password:'History!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},store=require('../../src/assistant/postgres-goal-store'),assistant=require('../../src/assistant/postgres-service');
 const old=await store.create(db,ctx,'OLD-PREPARE-'+randomUUID());
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer='Original verified outcome',checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE id=$1",[old.id]);
 const later=[];for(let i=0;i<13;i++){const goal=await store.create(db,ctx,'Fresh conversation '+i+' '+randomUUID());later.push(goal);await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer='Current saved outcome',checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE id=$1",[goal.id]);}
 const read=()=>({capability:'read.inventory_summary',result:{status:'ANSWERED',answer:'INTERNAL-READ-ONLY',rows:[{units:22}],columns:['units']}});
 await assistant.recordCapabilityOutcome(db,ctx,old.original_request,read(),{batchId:old.id+':'+old.id+':historical-read'});
 await assistant.recordCapabilityOutcome(db,{...ctx,goalId:old.id},old.original_request,read(),{batchId:old.id+':fresh-read'});
 const foreign=await auth.createBusiness(db,{name:'Foreign owner',businessName:'Foreign transcript',email:randomUUID()+'@example.test',password:'History!'+randomUUID()}),foreignGoal=await store.create(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},'FOREIGN-PRIVATE-GOAL');
 const genuine='GENUINE-LEGACY-'+randomUUID();await assistant.recordCapabilityOutcome(db,ctx,genuine,read(),{batchId:foreignGoal.id+':not-this-owner'});
 const rows=await assistant.listInteractions(db,ctx.workspaceId,100,{actorId:ctx.actorId});assert.equal(rows.filter(r=>r.parent_goal_id===old.id).length,2,'Historical batch IDs and explicit future parent IDs must resolve identically');assert.equal(rows.find(r=>r.message===genuine).parent_goal_id,null,'Another tenant cannot supply a parent binding');
 const before=(await db.query('SELECT id,status,checkpoint,updated_at FROM stockchief_runtime.assistant_goals ORDER BY id')).rows;
 renderer=await require('../../scripts/environment-agent-demo/inspection').createInspectionServer({cluster,database:db,ctx});browser=await require('playwright').chromium.launch({headless:true});const page=await browser.newPage();await page.goto(renderer.origin+'/ask',{waitUntil:'networkidle'});
 const text=await page.locator('main').textContent();assert(!text.includes(old.original_request),'Recorded live regression: an old goal\'s late internal read appeared below the newer completed order as a fresh customer question');assert(text.includes(genuine));assert(text.includes(later.at(-1).original_request));assert(!text.includes(foreignGoal.original_request));
 assert.deepEqual((await db.query('SELECT id,status,checkpoint,updated_at FROM stockchief_runtime.assistant_goals ORDER BY id')).rows,before);assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');assert.equal((await db.query('SELECT count(*) AS n FROM movements')).rows[0].n,'0');
 t.diagnostic(JSON.stringify({recordedFailure:'prepare-011 approved-execution-after.png, 2026-10-16T13:33Z',actualBrowser:true,historicalAndNewChildrenBound:true,orphanInternalReadsHidden:true,realLegacyConversationPreserved:true,tenantIsolation:true,paidCalls:0}));
});

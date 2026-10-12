'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{escapeIdentifier:q}=require('pg');
test('unregistered screen/table and changed fields remain inspectable while RLS, write denial and unsafe-view denial hold',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const cleanup=[()=>cluster.stop(),()=>db.close()];t.after(async()=>{for(const close of cleanup.reverse())await close();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const f=await require('../fixtures/environment-agent-unfamiliar-screen').createFixture(db);cleanup.push(()=>f.close());
 const inspection=await require('../../scripts/environment-agent-demo/inspection').createInspectionServer({cluster,database:db,ctx:f.ctx});cleanup.push(()=>inspection.close());
 assert.equal((await inspection.readonly.query(`SELECT * FROM ${q(f.table)}`)).rows.length,1);
 assert.equal((await inspection.readonly.query(`SELECT * FROM ${q(f.table)} WHERE workspace_id=$1`,[f.foreign.workspaceId])).rows.length,0);
 await assert.rejects(()=>inspection.readonly.query(`SELECT * FROM ${q(f.view)}`),error=>error.code==='42501');
 await assert.rejects(()=>inspection.readonly.query(`UPDATE ${q(f.table)} SET units_per_tote=999`),error=>['25006','42501'].includes(error.code));
 const origin=await f.start(inspection),browser=await require('playwright').chromium.launch({headless:true});cleanup.push(()=>browser.close());
 const ui=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});cleanup.push(()=>ui.close());
 let screen=await ui.inspect(),link=screen.controls.find(c=>c.label===f.privateEvaluation.desk);assert.ok(link);
 // These are evaluator-scripted transport assertions, not model decisions.
 screen=await ui.act({action:'click',ref:link.ref});
 assert.ok(!screen.error,JSON.stringify(screen.error));
 screen=await ui.act({action:'click',ref:screen.controls.find(c=>c.label==='Inspect loading inputs').ref});
 assert.ok(!JSON.stringify(screen).includes('PRIVATE HANDLING CANARY'));
 const before=screen.controls.filter(c=>c.name).map(c=>c.name);
 async function fillCurrent(){
  const names=f.privateEvaluation.revisions[screen.text.includes('Ready physical units')?1:0];
  for(const [key,value]of Object.entries(f.privateEvaluation.expected)){
   const field=screen.controls.find(c=>c.name===names[key]);assert.ok(field);
   screen=await ui.act({action:field.tag==='select'?'select':'fill',ref:field.ref,value:String(value)});
  }
  const pack=screen.controls.find(c=>c.name===names.packing);
  if(pack)screen=await ui.act({action:'select',ref:pack.ref,value:f.privateEvaluation.packing});
  screen=await ui.act({action:'click',ref:screen.controls.find(c=>c.label==='Calculate preview').ref});
 }
 await fillCurrent();assert.match(screen.text,/form changed/);
 assert.ok(screen.controls.filter(c=>c.name).every(c=>!before.includes(c.name)));
 await fillCurrent();assert.match(screen.text,/Verified loading preview/);
 const result=await f.verify();assert.equal(result.previewCompleted,true);assert.equal(result.formRevisionsObserved,1);
 assert.equal(result.businessUnchanged,true);assert.equal(result.novelAndForeignRecordsUnchanged,true);
 assert.equal(result.postsReachedServer,0);assert.equal(result.providerCalls,0);
 const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,f.ctx.actorId])).rows[0];
 const datasets=require('../../src/reports/postgres-registry').list(actor);
 assert.ok(!JSON.stringify(datasets).includes(f.table));
});

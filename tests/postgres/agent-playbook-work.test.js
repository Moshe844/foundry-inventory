'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),path=require('node:path');

// Job 213: playbooks that do work. A work step runs another job's routine
// through that job's own service and limits. Steps run in order and each
// result is checked before the next; the run stops and asks on a failure or
// on work left for a person, and continues from there. Scheduled runs keep to
// the first 14 days, pause, Watch only and Ask me first. Every step is
// audited and running the same run again repeats nothing.
test('playbooks run work steps in order, stop and ask, and continue where they stopped',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  const books=require('../../src/autopilot/playbooks'),fixes=require('../../src/catalog/agent-catalog-fixes');
  const catalog=require('../../src/domain/postgres-catalog-service'),modes=require('../../src/autopilot/job-modes');
  const autopilot=require('../../src/autopilot/postgres-service'),{ValidationError}=require('../../src/domain/errors');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
  const at=new Date().toISOString();
  // The fixture product is complete; each spaced SKU is a catalog fix.
  await db.query('UPDATE skus SET weight_grams=350 WHERE workspace_id=$1 AND id=$2',[ws,f.item.skuIds[0]]);
  await db.query('INSERT INTO sku_purchase_costs(id,workspace_id,sku_id,amount_minor,currency,source,created_at) VALUES($1,$2,$3,100,$4,$5,$6)',[randomUUID(),ws,f.item.skuIds[0],'USD','owner',at]);
  const spaced=async(code,name)=>{
    const sku=(await catalog.createItem(db,ctx,{name,baseCode:'TEMP-'+randomUUID().slice(0,6),trackingMode:'quantity',purchaseCost:'1',weightGrams:10})).skuIds[0];
    await db.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2',[ws,sku,code]);
    return sku;
  };
  const codeOf=async sku=>(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  const runOf=async(book,key)=>(await db.query('SELECT * FROM stockchief_runtime.agent_playbook_runs WHERE workspace_id=$1 AND playbook_id=$2 AND request_key=$3',[ws,book,key])).rows[0];
  const latest=async book=>(await db.query('SELECT * FROM stockchief_runtime.agent_playbook_runs WHERE workspace_id=$1 AND playbook_id=$2 ORDER BY created_at DESC LIMIT 1',[ws,book])).rows[0];
  const notices=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>n.sourceId==='agent-notice-213');
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const page=()=>browser.get(books.path).expect(200);
  const asking=async id=>(await db.query('SELECT 1 FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=213 AND reference=$2 AND NOT resolved',[ws,id])).rowCount===1;

  // Starter: no playbooks. Growth: only steps a Growth owner can teach.
  await subscribe('starter');
  assert.equal((await browser.get(books.path).expect(402)).text.includes('data-agent-plan-locked'),true);
  await subscribe('growth');
  assert.equal((await books.list(db,ctx)).choices.some(c=>c.key==='fix-product-data'),false);
  await assert.rejects(books.create(db,ctx,{name:'Fix data',steps:['fix-product-data','value'],cadence:'manual'}),e=>e.code==='entitlement_required');
  const growth=await books.create(db,ctx,{name:'Expiry check',steps:['warn-before-expiry','value'],cadence:'manual'});
  // In the first 14 days a work step waits; reviews still read.
  let results=await books.run(db,ctx,growth,'growth-shadow');
  assert.equal(results.length,0);
  assert.match((await runOf(growth,'growth-shadow')).reason,/first 14 days/);
  await age('30 days');
  results=await books.run(db,ctx,growth,'growth-run');
  assert.deepEqual(results.map(r=>r.outcome),['done',undefined]);assert.equal((await runOf(growth,'growth-run')).status,'DONE');

  // Pro: the owner's playbook reviews, fixes data, then checks low stock.
  await subscribe('pro');
  const first=await spaced(' SP 1 ','Spaced code');
  assert.equal((await books.list(db,ctx)).choices.some(c=>c.key==='fix-product-data'),true);
  const pro=await books.create(db,ctx,{name:'Morning work',steps:['value','fix-product-data','low-stock'],cadence:'manual'});
  // The fix needs a taught limit on Pro, so it waits for a person and the run stops.
  results=await books.run(db,ctx,pro,'pro-1');
  assert.deepEqual(results.map(r=>r.outcome),[undefined,'waiting']);
  assert.equal(results[1].waiting,1);assert.equal(await codeOf(first),' SP 1 ','nothing over the limit changes');
  let run=await runOf(pro,'pro-1');
  assert.equal(run.status,'STOPPED');assert.equal(run.next_step,2);assert.match(run.reason,/left 1 item for a person/);
  assert.equal((await notices()).length,1,'the stop asks in Needs you');assert.equal(await asking(run.id),true);
  assert.match((await page()).text,/Continue the run/);
  // Running the same request again repeats nothing.
  const steps=await audits('Playbook step run');
  assert.deepEqual(await books.run(db,ctx,pro,'pro-1'),results);
  assert.equal(await audits('Playbook step run'),steps);
  // Continue goes on with the next step and finishes.
  const continued=await books.resume(db,ctx,run.id);
  assert.equal(continued.results.length,3);assert.equal((await runOf(pro,'pro-1')).status,'DONE');
  assert.equal(await asking(run.id),false);assert.equal(await audits('Playbook step run'),steps+1);
  assert.equal((await books.resume(db,ctx,run.id)).replayed,true);

  // A failing step stops the run; Continue tries that step again.
  const original=fixes.run;
  fixes.run=async()=>{throw new ValidationError('The catalog changed while it was being checked.');};
  results=await books.run(db,ctx,pro,'pro-2');
  fixes.run=original;
  run=await runOf(pro,'pro-2');
  assert.equal(run.status,'STOPPED');assert.equal(run.next_step,1);assert.match(run.reason,/Step 2 .*stopped: The catalog changed/);
  assert.equal(await audits('Playbook step failed'),1);
  await books.resume(db,ctx,run.id);
  assert.equal((await runOf(pro,'pro-2')).status,'STOPPED','the fix still waits for a person');
  assert.equal((await runOf(pro,'pro-2')).next_step,2);

  // Custom, handling routine work: the fix is done on its own and the scheduled run finishes.
  await subscribe('enterprise');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const second=await spaced(' SP 2 ','Second spaced code');
  const daily=await books.create(db,ctx,{name:'Daily data',steps:['fix-product-data','value'],cadence:'daily'});
  const due=()=>db.query("UPDATE stockchief_runtime.agent_playbooks SET next_at=now()-interval '1 minute' WHERE id=$1",[daily]);
  await due();await db.transaction(books.schedule);
  const job=await queue.processOne(db,handlers,{owner:'playbook-work-test',kinds:['agent.playbook']});
  assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
  assert.equal(job.result.length,2);assert.equal(job.result[0].outcome,'done');assert.equal(job.result[0].done,2);
  assert.equal(await codeOf(first),'SP-1');assert.equal(await codeOf(second),'SP-2');
  assert.equal(Number((await db.query("SELECT count(*) n FROM stockchief_runtime.agent_catalog_fixes WHERE workspace_id=$1 AND kind='SKU' AND status='DONE' AND automatic",[ws])).rows[0].n),2);
  const handler=handlers['agent.playbook'];
  assert.deepEqual(await handler({workspaceId:ws,payload:job.payload},db),job.result,'the scheduled run replays once');
  assert.equal(Number((await db.query('SELECT count(*) n FROM stockchief_runtime.agent_playbook_runs WHERE playbook_id=$1',[daily])).rows[0].n),1);

  // Ask me first for playbooks: a scheduled run waits for the owner to start it.
  await modes.save(db,ctx,213,{mode:'ask',revision:0});
  await due();await db.transaction(books.schedule);
  const asked=await queue.processOne(db,handlers,{owner:'playbook-work-test',kinds:['agent.playbook']});
  assert.equal(asked.result.held,true);
  run=await latest(daily);assert.equal(run.status,'WAITING');assert.equal(await asking(run.id),true);
  let html=(await page()).text;assert.match(html,/Start this run/);
  await browser.post(books.path+'/runs/'+run.id+'/continue').type('form').send({_csrf:f.csrf(html)}).expect(303);
  assert.equal((await latest(daily)).status,'DONE');assert.equal(await asking(run.id),false);
  await modes.save(db,ctx,213,{mode:'inherit',revision:1});

  // Watch only for the step's own job: the work step waits.
  await modes.save(db,ctx,126,{mode:'watch',revision:0});
  await books.run(db,ctx,daily,'watched');
  run=await runOf(daily,'watched');assert.equal(run.status,'STOPPED');assert.equal(run.next_step,0);assert.match(run.reason,/Watch only/);
  await modes.save(db,ctx,126,{mode:'inherit',revision:1});
  await books.resume(db,ctx,run.id);assert.equal((await runOf(daily,'watched')).status,'DONE');

  // Pause: nothing runs, by hand or on schedule.
  await autopilot.pause(db,ctx,{role:'owner',permissions:null},'Stock count');
  await assert.rejects(books.run(db,ctx,daily,'paused'),/paused/);
  await due();await db.transaction(books.schedule);
  assert.equal((await queue.processOne(db,handlers,{owner:'playbook-work-test',kinds:['agent.playbook']})).result.held,true);
  await autopilot.resume(db,ctx,{role:'owner',permissions:null});

  // Downgrade: on Starter nothing runs and earlier results are hidden.
  await subscribe('starter');
  await assert.rejects(books.run(db,ctx,daily,'starter'),e=>e.code==='entitlement_required');
  assert.equal((await books.list(db,ctx)).books.find(b=>b.id===daily).result,null);
  assert.equal(await audits('Playbook stopped')>=4,true);

  // The page reads well on a desktop and on a 390 px phone.
  await subscribe('enterprise');
  await books.run(db,ctx,pro,'pro-page');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(r=>listener.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+listener.address().port,folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+books.path);
    assert(await tab.getByRole('heading',{name:'Morning work'}).isVisible());
    assert(await tab.getByRole('button',{name:'Save playbook'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:path.join(folder,'playbooks-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});

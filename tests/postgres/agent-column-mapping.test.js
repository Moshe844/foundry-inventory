'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const imports=require('../../src/imports/postgres-service');

// Job 133: reads an import file and maps the columns.
test('import columns are mapped on their own on Growth and above, confirmed by a person on Starter, and unclear columns always ask',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
  const autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  await subscribe('pro');
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
  const skus=async prefix=>Number((await db.query('SELECT count(*) n FROM skus WHERE workspace_id=$1 AND code LIKE $2',[ctx.workspaceId,prefix+'%'])).rows[0].n);
  const read=(text,filename='Supplier list.csv',options={})=>imports.analyse(db,ctx,{buffer:Buffer.from(text),filename,allowModel:false,...options});
  const clear=code=>'Product,SKU,Unit cost\nWidget '+code+','+code+'-1,7.50\nGadget '+code+','+code+'-2,3.00';

  // The first 14 days only watch: even Pro proposes the columns for a person.
  const shadow=await read(clear('SHADOW'));
  assert.equal(shadow.transformations.columnReview.state,'confirm');assert.match(shadow.transformations.columnReview.reason,/first 14 days/);
  // The person's approval of the import confirms the proposed columns.
  await imports.approve(db,ctx,shadow.id,shadow.integrityHash);
  const shadowApproved=await imports.get(db,ctx.workspaceId,shadow.id);
  assert.equal(shadowApproved.transformations.columnReview.state,'confirmed');assert.equal(shadowApproved.transformations.columnReview.confirmedBy,ctx.actorId);
  assert.equal(await audits('Import columns confirmed'),1);

  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  // Routine work off: a person confirms.
  const supervised=await read(clear('SUPER'));
  assert.equal(supervised.transformations.columnReview.state,'confirm');assert.match(supervised.transformations.columnReview.reason,/Handle routine work is off/);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // Starter always proposes; the person confirms on the page.
  await subscribe('starter');
  const starter=await read(clear('START'));
  assert.equal(starter.transformations.columnReview.state,'confirm');
  assert.deepEqual(starter.fieldMappings,{name:0,code:1,unitCost:2});
  const blocked=await browser.get('/imports/'+starter.id).expect(200);
  assert.match(blocked.text,/Are these columns read right\?/);assert.match(blocked.text,/On Starter you confirm the columns/);assert.match(blocked.text,/Approving the import also confirms them/);
  await browser.post('/imports/'+starter.id+'/columns').type('form').send({_csrf:f.csrf(blocked.text),integrityHash:starter.integrityHash}).expect(303);
  const confirmed=await imports.get(db,ctx.workspaceId,starter.id);
  assert.equal(confirmed.transformations.columnReview.state,'confirmed');assert.equal(confirmed.transformations.columnReview.confirmedBy,ctx.actorId);
  assert.equal(confirmed.integrityHash,starter.integrityHash,'confirming unchanged columns does not reread the rows');
  assert.equal(await audits('Import columns confirmed'),2);
  const after=(await browser.get('/imports/'+starter.id).expect(200)).text;
  assert.match(after,/Approve and import 2 rows/);assert(!after.includes('id="import-columns-question"'));
  // A second confirmation of an older preview is refused.
  await assert.rejects(require('../../src/imports/agent-column-mapping').confirm(db,ctx,starter.id,{expectedHash:'stale'}),/preview changed/);
  await imports.approve(db,ctx,starter.id,starter.integrityHash);assert.equal(await audits('Import columns confirmed'),2);
  assert.equal(await skus('START'),0,'mapping and approval alone create no products');

  // Growth, Pro and Custom map a clear file on their own, with an audit entry.
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    const code='AUTO'+tier.slice(0,3).toUpperCase(),before=await audits('Import columns mapped by StockChief');
    const plan=await read(clear(code));
    assert.equal(plan.transformations.columnReview.state,'automatic',tier);
    assert.deepEqual(plan.transformations.columnReview.unclear,[]);
    assert.equal(await audits('Import columns mapped by StockChief'),before+1);
    const page=await browser.get('/imports/'+plan.id).expect(200);
    assert(!page.text.includes('id="import-columns-question"'));assert.match(page.text,/Approve and import 2 rows/);
    await imports.approve(db,ctx,plan.id,plan.integrityHash);
    assert.equal(await skus(code),0);
    // Reading the same file again gives the same mapping and decision.
    const again=await read(clear(code)+'\n');
    assert.equal(again.transformations.columnReview.state,'automatic');
    assert.equal(again.transformations.columnReview.mappingHash,plan.transformations.columnReview.mappingHash);
  }

  // A column StockChief does not know stops automatic mapping and asks, on
  // every plan. Approving without an answer keeps it as a product detail.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const plan=await read('Product,SKU,Unit cost,Buyer\nWidget,UNK-'+tier+',7.50,Dana\nGadget,UNK2-'+tier+',3.00,Lee');
    assert.equal(plan.transformations.columnReview.state,'confirm',tier);
    assert.deepEqual(plan.transformations.columnReview.unclear.map(u=>u.name),['Buyer']);
  }
  const kept=await read('Product,SKU,Unit cost,Buyer\nWidget,UNK-K1,7.50,Dana\nGadget,UNK-K2,3.00,Lee');
  await imports.approve(db,ctx,kept.id,kept.integrityHash);
  assert.equal((await imports.get(db,ctx.workspaceId,kept.id)).transformations.columnReview.state,'confirmed');
  assert.equal(await audits('Import columns confirmed'),3);
  const unknown=await read('Product,SKU,Unit cost,Buyer\nWidget,UNK-A,7.50,Dana\nGadget,UNK-B,3.00,Lee');
  const asking=await browser.get('/imports/'+unknown.id).expect(200);
  assert.match(asking.text,/What do these columns hold\?/);assert.match(asking.text,/StockChief does not know what this column holds/);assert.match(asking.text,/name="column_3"/);
  await browser.post('/imports/'+unknown.id+'/columns').type('form').send({_csrf:f.csrf(asking.text),integrityHash:unknown.integrityHash,column_3:'notes'}).expect(303);
  const answered=await imports.get(db,ctx.workspaceId,unknown.id);
  assert.equal(answered.fieldMappings.notes,3);assert.equal(answered.transformations.columnReview.state,'confirmed');
  await imports.approve(db,ctx,answered.id,answered.integrityHash);
  assert.equal(await audits('Import columns confirmed'),4);

  // Values that do not fit the heading stop the import until a person
  // answers, on every plan.
  for(const tier of ['starter','enterprise']){
    await subscribe(tier);
    const wrong=await read('Product,SKU,Unit cost\nWidget,BAD-'+tier+',call us\nGadget,BAD2-'+tier+',ask');
    assert.equal(wrong.transformations.columnReview.state,'ask');
    assert.match(wrong.transformations.columnReview.unclear[0].reason,/do not look like money amounts/);
    await assert.rejects(imports.approve(db,ctx,wrong.id,wrong.integrityHash),/unclear column/);
    const wrongPage=await browser.get('/imports/'+wrong.id).expect(200);assert.match(wrongPage.text,/Tell StockChief what one column holds/);assert(!wrongPage.text.includes('Approve and import'));
  }

  // A column only the AI reader could place is never settled on its own.
  const fake=require('../../src/commercial/relay-provider').register({name:'fixture',model:'offline',complete:async()=>({data:{detectedType:'catalog',columns:[{index:3,field:'category',axisName:''}],note:''}})});
  const byModel=await imports.analyse(db,ctx,{text:'Product,SKU,Unit cost,Grp\nWidget,AI-1,7.50,Tools\nGadget,AI-2,3.00,Toys',filename:'Model list.csv',provider:fake});
  assert.equal(byModel.fieldMappings.category,3);assert.equal(byModel.transformations.columnReview.state,'ask');
  assert.match(byModel.transformations.columnReview.unclear[0].reason,/AI reader/);

  // Ask me first, Watch only and a pause make Pro propose instead.
  await subscribe('pro');
  await modes.save(db,ctx,133,{mode:'ask',revision:0});
  const askFirst=await read(clear('ASKF'));assert.equal(askFirst.transformations.columnReview.state,'confirm');assert.match(askFirst.transformations.columnReview.reason,/Ask me first/);
  await modes.save(db,ctx,133,{mode:'watch',revision:1});
  assert.equal((await read(clear('WATCH'))).transformations.columnReview.state,'confirm');
  await modes.save(db,ctx,133,{mode:'inherit',revision:2});
  await autopilot.pause(db,ctx,{role:'owner'},'Checking imports');
  const paused=await read(clear('PAUSE'));assert.equal(paused.transformations.columnReview.state,'confirm');assert.match(paused.transformations.columnReview.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});

  // A saved mapping for the same daily export is reused on its own.
  await subscribe('growth');
  const first=await read('Product,SKU,Vendor A17\nItem one,DAY-1,Metal','Stock 2026-11-01.csv',{mappings:{name:0,code:1,description:2}});
  await imports.approve(db,ctx,first.id,first.integrityHash);assert.ok((await imports.execute(db,ctx,first.id)).verified);
  const next=await read('Product,SKU,Vendor A17\nItem two,DAY-2,Wood','Stock 2026-11-02.csv');
  assert.equal(next.transformations.columnTemplate.source,first.id);assert.equal(next.fieldMappings.description,2);
  assert.equal(next.transformations.columnReview.state,'automatic');
  assert.equal(next.transformations.columnReview.columns.find(c=>c.name==='Vendor A17').how,'saved');

  // A person can still change any column; the change is theirs.
  const changed=await imports.revise(db,ctx,next.id,{expectedHash:next.integrityHash,fieldMappings:{name:0,code:1,notes:2}});
  assert.equal(changed.transformations.columnReview.state,'confirmed');

  // Older plans without agent terms keep the earlier preview with no question.
  await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  assert.equal((await read(clear('LEGACY'))).transformations.columnReview,undefined);

  // The question page works on a desktop and a 390 px phone.
  await subscribe('starter');
  const shown=await read('Product,SKU,Unit cost,Buyer\nWidget,UI-1,7.50,Dana\nGadget,UI-2,3.00,Lee');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:require('node:crypto').randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
    const page=await chrome.newPage({viewport});
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+'/imports/'+shown.id);
    assert(await page.locator('#import-columns-question').isVisible());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll at '+viewport.width);
    await page.close();
  }
});

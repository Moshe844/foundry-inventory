'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const sharp=require('sharp');
const shelf=require('../../src/warehouse/agent-shelf-photos');

const position=(left,top,right,bottom)=>({left,top,right,bottom});
const clear={isShelfPhoto:true,complete:true,boxes:[
  {position:position(20,30,400,480),label:'CASE-0001',uncertain:false},
  {position:position(420,30,800,480),label:'CASE-0001',uncertain:false}
],shelfLabels:[{position:position(200,500,400,550),label:'BIN C-01',uncertain:false}],obstructions:[]};
const usage={provider:'anthropic',providerVersion:'2023-06-01',model:'claude-haiku-4-5-20251001',inputTokens:1200,outputTokens:350};
function provider(data,hook){return {name:'anthropic',model:usage.model,async complete(request){
  assert.equal(request.prompt[0].type,'image');
  await hook?.();
  return {data,usage};
}};}
const png=color=>sharp({create:{width:640,height:480,channels:3,background:color}}).png().toBuffer();

test('shelf photos preserve original labels, manual Pro review, taught Custom scope, credits and current plan restrictions',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx}=f;
  const entitlements=require('../../src/commercial/entitlements');
  const scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId);
  const input={buffer:await png('#b88f5a'),filename:'aisle-original.png',locationId:f.location.id,requestKey:randomUUID()};
  const upload=options=>shelf.enqueue(db,ctx,{...input,requestKey:randomUUID(),...options});
  const work=data=>{
    const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:provider(data)});
    return require('../../src/operations/postgres-job-queue').processOne(db,{[shelf.kind]:handlers[shelf.kind]},{owner:'shelf-fixture'});
  };
  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    await assert.rejects(upload(),e=>e.code==='entitlement_required'&&e.message.includes('Pro'));
    const locked=await f.browser.get('/autopilot/shelf-photos').expect(200);
    assert.match(locked.text,/available on Pro and Custom/);
    assert.doesNotMatch(locked.text,/name="shelfPhoto"/);
  }
  await f.subscribe('pro');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  f.cleanup(async()=>{app.locals.sessionStore.close();await new Promise(resolve=>server.close(resolve));});
  const browser=await require('playwright').chromium.launch({headless:true});
  f.cleanup(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const base='http://127.0.0.1:'+server.address().port;
  await page.goto(base+'/login');
  await page.getByLabel('Work email',{exact:true}).fill(f.email);
  await page.locator('input[name=password]').fill(f.password);
  await Promise.all([page.waitForURL(url=>!url.pathname.includes('/login')),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(base+'/autopilot/shelf-photos');
  await page.getByLabel('Location',{exact:true}).selectOption(f.location.id);
  await page.getByLabel('Shelf photo',{exact:true}).setInputFiles({name:input.filename,mimeType:'image/png',buffer:input.buffer});
  await Promise.all([page.waitForURL(/\/autopilot\/shelf-photos\/.+/),page.getByRole('button',{name:'Read shelf photo'}).click()]);
  const photoPath=new URL(page.url()).pathname;
  const id=photoPath.split('/').at(-1);
  assert.equal((await upload()).id,id,'the same saved original is only queued once');
  const completed=await work(clear);
  assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
  const pro=await shelf.load(db,ctx,id);
  assert.equal(pro.status,'REVIEW');
  assert.equal(pro.reading.visibleBoxes,2);
  assert.deepEqual(pro.content,input.buffer);
  await assert.rejects(shelf.confirm(db,ctx,id,{count:'2',confirmed:'yes',sourceHash:pro.source_hash,teach:'yes'}),e=>e.code==='entitlement_required');
  await page.getByRole('heading',{name:'Labels on boxes',exact:true}).waitFor();
  assert.match(await page.locator('main').innerText(),/CASE-0001/);
  assert.match(await page.locator('main').innerText(),/BIN C-01/);
  assert.equal(await page.locator('input[name=teach]').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  const original=await page.request.get(base+photoPath+'/original');
  assert.deepEqual(await original.body(),input.buffer);
  await page.getByLabel('I checked the visible boxes and labels against this original.').check();
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Confirm this photo observation'}).click()]);
  assert.equal((await shelf.load(db,ctx,id)).confirmation.mode,'human');

  await f.subscribe('enterprise');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  for(const [meter,limit] of [['ai_work_credits',2000],['agent_documents',20]]){
    await db.query('INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,$3,$4,$5)',
      [randomUUID(),f.owner.accountId,meter,limit,'Funded Custom shelf-photo fixture']);
  }
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const example=await upload({buffer:await png('#b78952')});
  assert.equal((await work(clear)).result.needsReview,true);
  const checked=await shelf.load(db,ctx,example.id);
  await shelf.confirm(db,ctx,example.id,{count:'2',confirmed:'yes',sourceHash:checked.source_hash,teach:'yes'});
  const match=await upload({buffer:await png('#b58952')});
  assert.equal((await work(clear)).result.needsReview,false);
  const matched=await shelf.load(db,ctx,match.id);
  assert.equal(matched.training_example_id,example.id);
  const hidden=await upload({buffer:await png('#b38952')});
  assert.equal((await work({...clear,obstructions:['Rear shelf is covered']})).result.needsReview,true);
  const hiddenRow=await shelf.load(db,ctx,hidden.id);
  await assert.rejects(shelf.confirm(db,ctx,hidden.id,{count:'2',confirmed:'yes',sourceHash:hiddenRow.source_hash}),/could not show/);
  await shelf.confirm(db,ctx,match.id,{count:'1',confirmed:'yes',sourceHash:matched.source_hash,notes:'One shape in this photo was a reflection.'});
  const corrected=await shelf.load(db,ctx,match.id);
  assert.equal(corrected.confirmation.visibleBoxes,1);
  assert.equal(corrected.confirmation.supersedes.mode,'trained');
  assert.equal(corrected.reading.visibleBoxes,2);
  const stopped=await upload({buffer:await png('#b18952')});
  assert.equal((await work(clear)).result.needsReview,true);
  assert.equal((await shelf.load(db,ctx,stopped.id)).status,'REVIEW');
  assert.equal((await entitlements.meterState(db,scope,'agent_documents')).used,5);
  assert.equal((await entitlements.meterState(db,scope,'ai_work_credits')).used,500);

  const duplicate=await upload({buffer:await png('#b08952')});
  const failed=await work({...clear,boxes:[clear.boxes[0],clear.boxes[0]]});
  assert.equal(failed.status,'DEAD');
  assert.match((await shelf.load(db,ctx,duplicate.id)).problem,/twice/);
  assert.equal((await entitlements.meterState(db,scope,'agent_documents')).used,5);
  assert.equal((await entitlements.meterState(db,scope,'ai_work_credits')).used,500);
  await f.subscribe('growth');
  await assert.rejects(shelf.confirm(db,ctx,hidden.id,{count:'2',confirmed:'yes',sourceHash:hiddenRow.source_hash,notes:'Checked the front row.'}),e=>e.code==='entitlement_required');
  assert.equal(await f.balance(),20);
});

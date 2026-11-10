'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const voice=require('../../src/documents/agent-voice-receiving');
const {model,version}=require('../../src/ai/providers/openai-transcription');
const {pricedUsage}=require('../helpers/postgres-model-fixture');

function wave(){
  const size=16000*2*5,buffer=Buffer.alloc(44+size);
  buffer.write('RIFF',0);buffer.writeUInt32LE(size+36,4);
  buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);
  buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);
  buffer.write('data',36);buffer.writeUInt32LE(size,40);
  return buffer;
}

test('voice notes prepare purchase packs and post exact receipts only after an owner confirms',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,workflows}=f,skuId=f.item.skuIds[0];
  const quote='Three boxes of Parcel item arrived at Dispatch.';
  let failed=false,calls=0;
  const transcriber={name:'openai',model,providerVersion:version,async transcribe(recording){
    assert.deepEqual(recording,wave());calls++;
    return {text:failed?'':quote,seconds:5};
  }};
  const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(input){
    assert.equal(input.schemaName,'stockchief_voice_receiving');
    const parsed=JSON.parse(input.prompt);
    assert.equal(parsed.transcript,quote);
    assert.equal(parsed.lines[0].purchaseUnit,'box');
    return {data:{complete:true,rows:[{lineId:parsed.lines[0].id,quantity:'3',basis:'purchase',quote}]},usage:pricedUsage()};
  }};
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),
    aiProvider:provider,audioTranscriber:transcriber});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:f.csrf(login.text),email:f.email,password:f.password});
  const path='/autopilot/receiving-voice-notes';
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{audioTranscriber:transcriber,aiProvider:provider});
  const process=()=>require('../../src/operations/postgres-job-queue').processOne(db,{[voice.kind]:handlers[voice.kind]},{owner:'voice-fixture-worker'});
  async function place(){
    const placed=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId,quantityPurchaseUnits:5,unitsPerPurchaseUnit:10,purchaseUnit:'box',unitCost:'2'}]});
    await workflows.approvePurchaseOrder(db,ctx,placed.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,placed.purchaseOrderId,{idempotencyKey:randomUUID()});
    const number=(await db.query('SELECT po_number FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,placed.purchaseOrderId])).rows[0].po_number;
    return {...placed,number};
  }

  const first=await place();
  await f.subscribe('starter');
  const locked=await browser.get(path).expect(200);
  assert.match(locked.text,/Growth/);assert.doesNotMatch(locked.text,/name="recording"/);
  await assert.rejects(voice.enqueue(db,ctx,{buffer:wave(),orderId:first.purchaseOrderId,confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.equal(calls,0);
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'ai_work_credits',10000,'Synthetic Custom allowance'),($3,$2,'agent_documents',100,'Synthetic Custom allowance')`,
  [randomUUID(),f.owner.accountId,randomUUID()]);

  let expected=20,priorFingerprint;
  for(const tier of ['growth','pro','enterprise']){
    await f.subscribe(tier);
    const incoming=tier==='growth'?first:await place();
    const home=await browser.get(path).expect(200);
    assert.match(home.text,/Record a voice note/);
    const upload=await browser.post(path).field('_csrf',f.csrf(home.text)).field('orderNumber',incoming.number)
      .field('confirmed','yes').attach('recording',wave(),'Receipt.wav').expect(303);
    const href=upload.headers.location,noteId=href.split('/').at(-1);
    const finished=await process();
    assert.equal(finished.status,'COMPLETED',JSON.stringify(finished.lastError));
    const note=await voice.load(db,ctx,noteId);
    const committed=(await db.query(`SELECT sum(units)::int AS credits FROM commercial_usage_events WHERE workspace_id=$1
      AND meter='ai_work_credits' AND status='COMMITTED' AND starts_with(idempotency_key,$2)`,
    [ctx.workspaceId,ctx.workspaceId+':voice:'+noteId+':'])).rows[0].credits;
    assert.equal(note.credits_used,committed,tier);
    if(tier==='enterprise')assert(note.credits_used>=100);
    else assert.equal(note.credits_used,100,tier);
    assert.deepEqual(note.draft.rows.map(row=>[row.quantity,row.spokenUnit,row.unitCostMinor]),[[30,'box',200]]);
    assert.equal(await f.balance(),expected);
    if(priorFingerprint)await assert.rejects(voice.confirm(db,ctx,noteId,{fingerprint:priorFingerprint,confirmed:'yes'}),/checked receiving review/);
    priorFingerprint=note.draft.fingerprint;
    const review=await browser.get(href).expect(200);
    assert.match(review.text,/Three boxes of Parcel item/);assert.match(review.text,/\$2\.00/);
    const audio=await browser.get(href+'/audio').expect(200);
    assert.match(audio.headers['content-type'],/^audio\/wav/);
    await assert.rejects(voice.confirm(db,ctx,noteId,{fingerprint:note.draft.fingerprint,confirmed:'no'}),/physically arrived/);
    if(tier==='pro'){
      await f.subscribe('starter');
      await assert.rejects(voice.confirm(db,ctx,noteId,{fingerprint:note.draft.fingerprint,confirmed:'yes'}),e=>e.code==='entitlement_required');
      await f.subscribe('pro');
    }
    await browser.post(href+'/confirm').type('form').send({_csrf:f.csrf(review.text),fingerprint:note.draft.fingerprint,confirmed:'yes'}).expect(303);
    const replay=await voice.confirm(db,ctx,noteId,{fingerprint:note.draft.fingerprint,confirmed:'yes'});
    assert.equal(replay.replayed,true);
    expected+=30;assert.equal(await f.balance(),expected);
  }

  failed=true;
  const upcoming=await place();
  const cancelled=await voice.enqueue(db,ctx,{filename:'Failure.wav',buffer:wave(),orderId:upcoming.purchaseOrderId,confirmed:'yes'});
  assert.equal((await process()).status,'DEAD');
  const failedNote=await voice.load(db,ctx,cancelled.id);
  assert.equal(failedNote.state,'FAILED');assert.equal(failedNote.credits_used,0);
  assert.equal(await f.balance(),expected);
  const costs=(await db.query(`SELECT count(*)::int AS calls,sum(quantity)::int AS seconds FROM commercial_cost_events
    WHERE workspace_id=$1 AND provider='openai' AND operation='audio_transcription' AND amount_minor IS NOT NULL`,[ctx.workspaceId])).rows[0];
  assert.deepEqual(costs,{calls:4,seconds:20});
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const chromium=await require('playwright').chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  f.cleanup(async()=>{await chromium.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const origin='http://127.0.0.1:'+server.address().port;
  const mobile=await chromium.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,permissions:['microphone']});
  const phone=await mobile.newPage();
  await phone.goto(origin+'/login');
  await phone.getByLabel('Work email').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(origin+path);
  await phone.getByRole('button',{name:'Record a voice note',exact:true}).click();
  const stop=phone.getByRole('button',{name:'Stop recording',exact:true});
  await stop.waitFor({state:'visible'});
  await new Promise(resolve=>setTimeout(resolve,750));
  await stop.click();
  await phone.getByRole('status').filter({hasText:'Recording attached'}).waitFor();
  const recorded=await phone.locator('input[name=recording]').evaluate(async input=>Array.from(new Uint8Array(await input.files[0].arrayBuffer())));
  assert(require('../../src/documents/voice-wave').validate(Buffer.from(recorded)).seconds>0.25);
  assert.equal(calls,4);
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
});

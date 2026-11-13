'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
const paperwork=require('../../src/documents/agent-voice-paperwork');
const {model,version}=require('../../src/ai/providers/openai-transcription');
const {pricedUsage}=require('../helpers/postgres-model-fixture');

function wave(seed){
  const size=16000*2*5,buffer=Buffer.alloc(44+size);
  buffer.write('RIFF',0);buffer.writeUInt32LE(size+36,4);
  buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);
  buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(16000,24);buffer.writeUInt32LE(32000,28);
  buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);
  buffer.write('data',36);buffer.writeUInt32LE(size,40);
  buffer.writeUInt16LE(seed,44);
  return buffer;
}

// Job 141: a voice note becomes its receipt, count, transfer or stock
// correction. Growth drafts; Pro and Custom post within the owner's limits;
// receipts, write-offs and big differences always wait for a person.
test('voice notes become receipts, counts, transfers and corrections under each plan and stop on anything unclear',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,workflows}=f,ws=ctx.workspaceId,skuId=f.item.skuIds[0];
  let said='',answer=null,seed=0;
  const transcriber={name:'openai',model,providerVersion:version,async transcribe(){return {text:said,seconds:5};}};
  const provider={name:'anthropic',model:'claude-haiku-4-5-20251001',async complete(input){
    assert.equal(input.schemaName,'stockchief_voice_paperwork');
    const parsed=JSON.parse(input.prompt);assert.equal(parsed.transcript,said);assert(parsed.locations.includes('Dispatch'));
    return {data:answer,usage:pricedUsage()};
  }};
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:provider,audioTranscriber:transcriber});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:f.csrf(login.text),email:f.email,password:f.password});
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{audioTranscriber:transcriber,aiProvider:provider});
  const work=()=>require('../../src/operations/postgres-job-queue').processOne(db,{[paperwork.kind]:handlers[paperwork.kind]},{owner:'voice-paperwork-worker'});
  const onHand=async(location=f.location.id)=>Number((await db.query('SELECT coalesce(sum(on_hand),0) AS n FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ws,skuId,location])).rows[0].n);
  const line=(product,quantity,unit,quote)=>({product,quantity,unit,quote});
  const reply=(kind,lines,extra={})=>({kind,purchaseOrder:'',location:'',fromLocation:'',toLocation:'',direction:'',reason:'',lines,...extra});
  // The owner records a note on the page; the worker reads it.
  async function record(text,read){
    said=text;answer=read;
    const home=await browser.get(paperwork.path).expect(200);
    const upload=await browser.post(paperwork.path).field('_csrf',f.csrf(home.text)).field('confirmed','yes').attach('recording',wave(++seed),'Note '+seed+'.wav').expect(303);
    const id=upload.headers.location.split('/').at(-1);
    const job=await work();assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
    return paperwork.load(db,ctx,id);
  }
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  const count=(n,where='Dispatch')=>reply('count',[line('Parcel item',String(n),'','Counted '+n+' Parcel item')],{location:where});

  // Starter: the job is not included.
  await f.subscribe('starter');
  await browser.get(paperwork.path).expect(402);
  await assert.rejects(paperwork.enqueue(db,ctx,{buffer:wave(0),confirmed:'yes'}),e=>e.code==='entitlement_required');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'ai_work_credits',100000,'Synthetic Custom allowance'),($3,$2,'agent_documents',200,'Synthetic Custom allowance')`,
  [randomUUID(),f.owner.accountId,randomUUID()]);

  // Growth prepares the paperwork; a person checks the original and confirms.
  await f.subscribe('growth');
  const back=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Back room',kind:'warehouse'});
  let note=await record('Counted 18 Parcel item in Dispatch.',count(18));
  assert.deepEqual([note.status,note.kind],['DRAFT','COUNT']);assert.match(note.reason,/prepares the paperwork for you to confirm/);
  assert.deepEqual([note.draft.rows[0].counted,note.draft.rows[0].change],[18,-2]);assert.equal(await onHand(),20,'nothing changes before a person confirms');
  assert((await needs()).some(n=>n.sourceId==='voice-paperwork:'+note.id),'the paperwork waits in Needs you');
  let html=(await browser.get(paperwork.path+'/'+note.id).expect(200)).text;
  assert.match(html,/Counted 18 each|Counted 18/);assert.match(html,/Confirm and post/);
  await browser.post(paperwork.path+'/'+note.id+'/confirm').type('form').send({_csrf:f.csrf(html),fingerprint:note.draft.fingerprint,confirmed:'yes'}).expect(303);
  assert.equal(await onHand(),18);assert.equal((await paperwork.load(db,ctx,note.id)).status,'POSTED');
  assert.equal((await paperwork.confirm(db,ctx,note.id,{fingerprint:note.draft.fingerprint,confirmed:'yes'})).replayed,true);assert.equal(await onHand(),18);
  assert(!(await needs()).some(n=>n.sourceId==='voice-paperwork:'+note.id));
  // The same recording again is the same note.
  assert.equal((await paperwork.enqueue(db,ctx,{buffer:wave(seed),confirmed:'yes'})).replayed,true);

  // Anything unclear stops and asks; nothing is posted.
  const unclear=async(text,read,pattern)=>{const n=await record(text,read);assert.equal(n.status,'REVIEW',JSON.stringify(n.draft));assert.match(n.reason,pattern);return n;};
  await unclear('Counted 4 blue widgets in Dispatch.',reply('count',[line('blue widgets','4','','Counted 4 blue widgets')],{location:'Dispatch'}),/does not know the product “blue widgets”/);
  await unclear('Counted 4 Parcel item.',count(4,''),/Say which location/);
  await unclear('Counted 4 Parcel item in the attic.',count(4,'attic'),/location “attic” is not in the recording|does not know the location/);
  await unclear('2 crates of Parcel item in Dispatch.',reply('adjustment',[line('Parcel item','2','crates','2 crates of Parcel item')],{location:'Dispatch',direction:'add'}),/cannot tell how many units “2 crates”/);
  await unclear('Counted Parcel item in Dispatch.',reply('count',[line('Parcel item','','','Counted Parcel item')],{location:'Dispatch'}),/could not hear a quantity/);
  await unclear('Three boxes came in on PO 999.',reply('receipt',[line('Parcel item','3','boxes','Three boxes came in')],{purchaseOrder:'PO 999'}),/not in the recording|could not find “Parcel item”/);
  await unclear('Something about the van.',reply('unclear',[]),/receipt, a count, a transfer or a stock correction/);
  await unclear('Counted 3 Parcel item in Dispatch.',reply('count',[line('Parcel item','3','','Counted 9 Parcel item')],{location:'Dispatch'}),/could not find “Parcel item” in the recording/);
  assert.equal(await onHand(),18);

  // Pro posts on its own, but only once shadow, Watch only and its limits allow.
  await f.subscribe('pro');
  note=await record('Counted 17 Parcel item in Dispatch.',count(17));
  assert.equal(note.status,'DRAFT');assert.match(note.reason,/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  note=await record('Counted 17 Parcel item in Dispatch again.',count(17));
  assert.match(note.reason,/ask you first/);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  note=await record('Counted 17 Parcel item in Dispatch once more.',count(17));
  assert.match(note.reason,/Save your limits/);
  html=(await browser.get(paperwork.path).expect(200)).text;assert.match(html,/data-voice-limits/);
  await browser.post(paperwork.path+'/limits').type('form').send({_csrf:f.csrf(html),revision:0,maximumUnits:'5',maximum:'20',enabled:'yes'}).expect(303);

  // A small count difference posts alone, audited once.
  note=await record('Counted 17 Parcel item in Dispatch now.',count(17));
  assert.deepEqual([note.status,note.automatic],['POSTED',true]);assert.equal(await onHand(),17);
  assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Voice note paperwork posted by StockChief' AND reference=$2",[ws,note.id])).rows[0].n,1);
  assert.equal((await paperwork.routine(db,ws,note.id)).replayed,true);assert.equal(await onHand(),17);
  // A big count difference waits for a person.
  note=await record('Counted 5 Parcel item in Dispatch.',count(5));
  assert.equal(note.status,'DRAFT');assert.match(note.reason,/count difference of 12 Parcel item is over your limit of 5 units/);
  // Found stock posts alone; a write-off always waits.
  note=await record('Found 2 Parcel item in Dispatch.',reply('adjustment',[line('Parcel item','2','','Found 2 Parcel item')],{location:'Dispatch',direction:'add',reason:'found'}));
  assert.deepEqual([note.status,note.automatic],['POSTED',true]);assert.equal(await onHand(),19);
  assert.equal((await db.query("SELECT reason_code FROM adjustments WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1",[ws])).rows[0].reason_code,'found');
  note=await record('2 Parcel item broken in Dispatch.',reply('adjustment',[line('Parcel item','2','','2 Parcel item broken')],{location:'Dispatch',direction:'remove',reason:'damaged'}));
  assert.equal(note.status,'DRAFT');assert.match(note.reason,/Writing off stock always waits for a person/);assert.equal(await onHand(),19);
  // A move becomes an approved transfer that reserves the stock.
  note=await record('Moved 3 Parcel item from Dispatch to Back room.',reply('transfer',[line('Parcel item','3','','Moved 3 Parcel item')],{fromLocation:'Dispatch',toLocation:'Back room'}));
  assert.deepEqual([note.status,note.automatic],['POSTED',true],note.reason);
  const transfer=(await db.query('SELECT status,source_location_id,destination_location_id FROM inventory_transfers WHERE workspace_id=$1 AND id=$2',[ws,note.result.transferId])).rows[0];
  assert.deepEqual([transfer.status,transfer.source_location_id,transfer.destination_location_id],['APPROVED',f.location.id,back.id]);
  // Goods arriving: StockChief finds the one placed order and converts boxes; a person confirms.
  const placed=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId,quantityPurchaseUnits:5,unitsPerPurchaseUnit:10,purchaseUnit:'box',unitCost:'2'}]});
  await workflows.approvePurchaseOrder(db,ctx,placed.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,placed.purchaseOrderId,{idempotencyKey:randomUUID()});
  note=await record('3 boxes of Parcel item just came in.',reply('receipt',[line('Parcel item','3','boxes','3 boxes of Parcel item just came in')]));
  assert.equal(note.status,'DRAFT');assert.match(note.reason,/A person confirms every receipt/);
  assert.deepEqual([note.draft.rows[0].quantity,note.draft.order.id],[30,placed.purchaseOrderId]);assert.equal(await onHand(),19);
  await paperwork.confirm(db,ctx,note.id,{fingerprint:note.draft.fingerprint,confirmed:'yes'});
  assert.equal(await onHand(),49);
  assert.equal((await db.query('SELECT quantity_received_units::int n FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',[ws,placed.purchaseOrderId])).rows[0].n,30);
  // More than the order still expects is a question.
  await unclear('3 boxes of Parcel item came in.',reply('receipt',[line('Parcel item','3','boxes','3 boxes of Parcel item came in')]),/More Parcel item than .* still expects/);

  // Ask me first, pause and Watch only hold the routine work.
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  await modes.save(db,ctx,141,{mode:'ask',revision:0});
  note=await record('Counted 48 Parcel item in Dispatch.',count(48));assert.equal(note.status,'DRAFT');assert.match(note.reason,/Ask me first/);
  await modes.save(db,ctx,141,{mode:'inherit',revision:1});
  await autopilot.pause(db,ctx,{role:'owner',permissions:null},'Stocktake');
  note=await record('Counted 48 Parcel item in Dispatch today.',count(48));assert.match(note.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner',permissions:null});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  note=await record('Counted 48 Parcel item in Dispatch this morning.',count(48));assert.match(note.reason,/Watch only/);
  // The person dismisses a note: nothing is posted.
  html=(await browser.get(paperwork.path+'/'+note.id).expect(200)).text;
  await browser.post(paperwork.path+'/'+note.id+'/dismiss').type('form').send({_csrf:f.csrf(html)}).expect(303);
  assert.equal((await paperwork.load(db,ctx,note.id)).status,'STOPPED');assert.equal(await onHand(),49);

  // Custom posts within the same limits without training.
  await f.subscribe('enterprise');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  note=await record('Counted 47 Parcel item in Dispatch.',count(47));
  assert.deepEqual([note.status,note.automatic],['POSTED',true],note.reason);assert.equal(await onHand(),47);

  // Ask reads the notes through job 141's one review; the activity log names the job.
  const review=await require('../../src/autopilot/job-reviews').definitions.find(d=>d.key==='receiving-voice-notes').readPage(db,ctx,{});
  assert(review.rows.some(r=>r.Paperwork==='Count'&&/Posted on its own/.test(r.Review)));
  assert(require('../../src/autopilot/agent-activity').SOURCES.some(s=>s.job===141&&s.actions.includes(paperwork.actions.posted)));

  // The page reads well on a desktop and on a 390 px phone.
  const listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(done=>listener.close(done));});
  const base='http://127.0.0.1:'+listener.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  const waiting=(await db.query("SELECT id FROM stockchief_runtime.agent_voice_paperwork WHERE workspace_id=$1 AND status='DRAFT' ORDER BY created_at DESC LIMIT 1",[ws])).rows[0].id;
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const path of [paperwork.path,paperwork.path+'/'+waiting]){
      await tab.goto(base+path);
      assert(await tab.getByRole('heading',{name:'Voice note paperwork'}).first().isVisible());
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' '+path+' must not scroll sideways');
    }
    assert(await tab.getByRole('button',{name:'Confirm and post'}).isVisible());
    await tab.screenshot({path:require('node:path').join(folder,'voice-paperwork-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});

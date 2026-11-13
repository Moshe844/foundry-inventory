'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const packs=require('../../src/purchasing/agent-supplier-review-packs');
const source=require('../../src/purchasing/agent-supplier-pack');

// Job 164 (Pro and Custom): each supplier's quarterly review pack, kept and sent.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,ws=ctx.workspaceId,w=f.workflows;
  const time=require('../../src/lib/business-time'),{addDays}=require('../../src/accounting/customer-money'),zone='America/New_York';
  await db.query('UPDATE workspaces SET time_zone=$2 WHERE id=$1',[ws,zone]);
  const today=await time.today(db,ws),span=source.quarter(today),at=new Date().toISOString(),sku=f.item.skuIds[0];
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,addDays(span.start,-365)]);
  await db.query(`INSERT INTO suppliers(id,workspace_id,name,email,status,currency,created_at,updated_at)
    VALUES('alt-supplier',$1,'Alternative','alt@example.test','active','USD',$2,$2),('quiet-supplier',$1,'Quiet goods',NULL,'active','USD',$2,$2)`,[ws,at]);
  const day=n=>addDays(span.start,n);
  const order=async(supplierId,units,unitCost,{orderedOn,promised=null,received=[]})=>{
    const key=randomUUID(),po=await w.createPurchaseOrder(db,ctx,{supplierId,destinationLocationId:f.location.id,idempotencyKey:key,lines:[{skuId:sku,quantityUnits:units,unitCost}]});
    await w.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
    for(const [i,[quantity,on]] of received.entries()){
      const reference='R'+i+'-'+key.slice(0,8);
      await w.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r'+i,reference,lines:[{lineId:po.lineIds[0],quantity,locationId:f.location.id}]});
      if(on)await db.query('UPDATE purchase_order_receipts SET received_at=$3 WHERE workspace_id=$1 AND reference=$2',[ws,reference,time.wall(on,12,0,zone).toISOString()]);
    }
    if(orderedOn)await db.query('UPDATE purchase_orders SET ordered_at=$3,expected_date=$4 WHERE workspace_id=$1 AND id=$2',[ws,po.purchaseOrderId,time.wall(orderedOn,10,0,zone).toISOString(),promised]);
    return (await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[po.purchaseOrderId])).rows[0].po_number;
  };
  // Alternative: 4 at $1.25 promised day 20, 1 arrived on day 10 and 2 after the quarter;
  // 2 at $3.00 promised day 40, both arrived on day 35; and one order this quarter.
  const first=await order('alt-supplier',4,1.25,{orderedOn:day(4),promised:day(20),received:[[1,day(10)],[2,null]]});
  const second=await order('alt-supplier',2,3,{orderedOn:day(30),promised:day(40),received:[[2,day(35)]]});
  const later=await order('alt-supplier',5,1.25,{});
  // Quiet goods has no email on file and no promised date.
  await order('quiet-supplier',3,2,{orderedOn:day(50)});
  const mailbox=async name=>{const id=randomUUID();
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
      VALUES($1,$2,$1,$3,'gmail','[]','{}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$6,now(),now())`,[id,ws,name,'connection_credentials:'+id,ctx.actorId,name.toLowerCase().replace(/\W+/g,'-')]);
    await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,id,'provider',{accessToken:'synthetic-token'}));return id;};
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  const outbound=require('../../src/connections/postgres-outbound-mail');
  const effects=async supplierId=>(await db.query(`SELECT e.id,m.status,m.recipient,m.subject,m.body FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
    WHERE e.workspace_id=$1 AND m.supplier_id=$2 AND e.kind='mail.outbound.send' ORDER BY m.created_at,m.id`,[ws,supplierId])).rows;
  const deliver=async id=>outbound.executeSendEffect(db,ws,id,{provider});
  const rows=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_supplier_review_packs WHERE workspace_id=$1 ORDER BY supplier_name',[ws])).rows;
  const one=async supplierId=>(await rows()).find(r=>r.supplier_id===supplierId);
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('supplier-review-packs'));
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[packs.KIND];
  const work=()=>handler({workspaceId:ws,payload:{}},db);
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const binary=req=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
  const pdfText=async body=>{const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs'),loading=pdfjs.getDocument({data:new Uint8Array(body)}),doc=await loading.promise;let text='';
    for(let i=1;i<=doc.numPages;i++)text+=(await (await doc.getPage(i)).getTextContent()).items.map(x=>x.str).join(' ')+'\n';await loading.destroy();return text;};
  return {...f,ws,today,span,first,second,later,mailbox,sent,provider,effects,deliver,rows,one,audits,needs,pilot,work,older,binary,pdfText};
}

test('Supplier review packs are prepared after each quarter, kept, and sent to each supplier on Pro and Custom only',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,span}=f;

  // The pack: only this supplier's orders placed in the quarter, with fill rate and on-time-in-full.
  const facts=await source.facts(db,ws,{id:'alt-supplier',name:'Alternative'},span);
  assert.deepEqual(facts.rows.map(r=>r.Order),[f.first,f.second],'An order this quarter and other suppliers stay out');
  assert.deepEqual(facts.rows.map(r=>[Number(r.Ordered),Number(r['Received by close']),r['On time in full']]),[[4,1,'No'],[2,2,'Yes']]);
  assert.deepEqual(facts.totals,[{currency:'USD',orders:2,lines:2,ordered:6,received:3,fillRate:50,dated:2,onTimeInFull:1,onTimeRate:50,valueMinor:1100,unknownCost:0}]);
  const quiet=await source.facts(db,ws,{id:'quiet-supplier',name:'Quiet goods'},span);
  assert.equal(quiet.rows[0]['On time in full'],'No date');

  // An account on its older terms sees the plan card; nothing runs.
  assert.match((await f.browser.get(packs.href).expect(200)).text,/data-agent-plan-locked/);
  assert.deepEqual(await f.work(),{skipped:'plan'});
  // Starter and Growth are excluded everywhere.
  for(const tier of ['starter','growth']){
    await f.subscribe(tier);
    await f.browser.get(packs.href).expect(402);
    assert.deepEqual(await f.work(),{skipped:'plan'});
    assert.deepEqual(await packs.schedule(db,ws),{queued:0});
    await assert.rejects(packs.prepareNow(db,ctx),e=>e.code==='entitlement_required');
    assert.deepEqual(await packs.inbox(db,ws),[]);
  }

  // Pro, first 14 days: both packs prepared and kept, nothing sent, nothing in Needs you.
  await f.subscribe('pro');
  assert.deepEqual(await packs.schedule(db,ws),{queued:1});
  assert.deepEqual(await packs.schedule(db,ws),{queued:0},'Once a day');
  let result=await f.work();
  assert.equal(result.prepared,2);assert.equal(result.watched,2);
  assert.deepEqual((await f.rows()).map(r=>[r.supplier_name,r.status]),[['Alternative','WATCHED'],['Quiet goods','WATCHED']]);
  assert.equal((await f.effects('alt-supplier')).length,0);assert.deepEqual(await f.needs(),[]);
  assert.equal(await f.audits('StockChief prepared a supplier review pack'),2);
  const shadowPage=await f.browser.get(packs.href).expect(200);
  assert.match(shadowPage.text,/first 14 days/);assert.doesNotMatch(shadowPage.text,/>Send</);
  const kept=await f.one('alt-supplier');
  await assert.rejects(packs.send(db,ctx,kept.id,{fingerprint:kept.fingerprint}),/first 14 days/);
  // The kept copy is the PDF StockChief made.
  const text=await f.pdfText((await f.binary(f.browser.get(packs.href+'/packs/'+kept.id)).expect(200).expect('Content-Type',/pdf/)).body);
  for(const s of ['Alternative','Shipping operation fixture',f.first,f.second,'$11.00','50%','$1.25'])assert(text.includes(s),s);
  for(const s of ['Quiet goods','Fixture parts',f.later])assert(!text.includes(s),s+' stays out');
  assert.equal((await f.work()).prepared,2);assert.equal(await f.audits('StockChief prepared a supplier review pack'),2,'The same facts replay to the same packs');

  // After 14 days, Ask me first (the inventory does not handle routine work yet).
  // No mailbox and no supplier email: both stop and ask.
  await f.older();
  await f.work();
  assert.deepEqual((await f.rows()).map(r=>[r.status,r.problem]),[['STOPPED','mailbox'],['STOPPED','recipient']]);
  let asked=await f.needs();
  assert.deepEqual(asked.map(n=>n.title).sort(),['Add an email for Quiet goods to send the '+span.label+' review pack','Connect a mailbox to send supplier review packs']);
  // Two mailboxes and no choice made: still stops and asks.
  const main=await f.mailbox('Main mailbox'),other=await f.mailbox('Other mailbox');
  await f.work();
  assert.equal((await f.one('alt-supplier')).problem,'mailbox_choice');
  assert((await f.needs()).some(n=>n.title==='Choose the mailbox for supplier review packs'));
  const page=await f.browser.get(packs.href).expect(200);
  await f.browser.post(packs.href+'/mailbox').type('form').send({_csrf:f.csrf(page.text),connectorId:main,revision:0}).expect(303);
  assert.equal(await f.audits('Chose the mailbox for supplier review packs'),1);
  await f.work();
  let alt=await f.one('alt-supplier');
  assert.equal(alt.status,'WAITING');assert.match(alt.reason,/asks before/);
  asked=await f.needs();
  assert(asked.some(n=>n.title==='1 supplier review pack is ready to send for '+span.label));
  assert.equal((await f.effects('alt-supplier')).length,0,'Ask me first sends nothing on its own');

  // Pause holds the worker and any send.
  await f.pilot('paused=1');
  assert.deepEqual(await f.work(),{held:'paused'});
  await assert.rejects(packs.send(db,ctx,alt.id,{fingerprint:alt.fingerprint}),/paused/);
  await f.pilot('paused=0');
  // Watch only keeps the packs and sends nothing.
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,164,{mode:'watch',revision:0});
  await assert.rejects(packs.send(db,ctx,alt.id,{fingerprint:alt.fingerprint}),/Watch only/);
  await f.work();
  assert.deepEqual((await f.rows()).map(r=>r.status),['WATCHED','WATCHED']);
  await modes.save(db,ctx,164,{mode:'ask',revision:1});
  await f.work();
  alt=await f.one('alt-supplier');assert.equal(alt.status,'WAITING');assert.match(alt.reason,/Ask me first/);

  // The owner presses send.
  await assert.rejects(packs.send(db,ctx,alt.id,{fingerprint:'stale'}),/changed after you opened/);
  const ready=await f.browser.get(packs.href).expect(200);
  assert.match(ready.text,/Ready to send/);
  await f.browser.post(packs.href+'/packs/'+alt.id+'/send').type('form').send({_csrf:f.csrf(ready.text),fingerprint:alt.fingerprint}).expect(303);
  alt=await f.one('alt-supplier');
  assert.equal(alt.status,'QUEUED');assert.equal(alt.authorization_kind,'INDIVIDUAL');assert.equal(alt.recipient,'alt@example.test');assert.equal(alt.connector_id,main);
  assert.equal(await f.audits('Sent a supplier review pack'),1);
  assert.equal((await packs.send(db,ctx,alt.id,{fingerprint:alt.fingerprint})).replayed,true,'Pressing send again does not send twice');
  await f.work();
  let mail=await f.effects('alt-supplier');
  assert.equal(mail.length,1);assert.equal(mail[0].recipient,'alt@example.test');
  assert.equal(mail[0].subject,'Quarterly review · '+span.label+' · Shipping operation fixture');
  assert.match(mail[0].body,/^Hello Alternative,/);assert.match(mail[0].body,/3 of 6 units arrived by the quarter close \(50% fill rate\)/);
  // The mailbox sends it with the kept PDF attached.
  await f.deliver(mail[0].id);
  assert.equal(f.sent.length,1);
  const [attached]=f.sent[0].attachments;
  assert.equal(attached.contentType,'application/pdf');assert.equal(attached.filename,alt.filename);assert(attached.content.equals(alt.file));
  assert.match(require('../../src/connections/providers/photo-attachments').mime(f.sent[0]),/Content-Type: application\/pdf/);
  assert.equal((await f.effects('alt-supplier'))[0].status,'SENT');
  assert.match((await f.browser.get(packs.href).expect(200)).text,/Sent to alt@example\.test/);

  // Handle routine work: once the supplier has an email, StockChief sends on its own.
  await modes.save(db,ctx,164,{mode:'routine',revision:2});
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE suppliers SET email='quiet@example.test' WHERE workspace_id=$1 AND id='quiet-supplier'",[ws]);
  result=await f.work();
  assert.equal(result.sent,1);
  let quietPack=await f.one('quiet-supplier');
  assert.equal(quietPack.status,'QUEUED');assert.equal(quietPack.authorization_kind,'AUTOMATIC');
  assert.equal(await f.audits('StockChief sent a supplier review pack'),1);
  assert.deepEqual(await packs.schedule(db,ws),{queued:0},'Every pack for the quarter is sent');
  assert.equal((await f.work()).prepared,0);
  assert.equal((await f.effects('alt-supplier')).length,1,'One pack per supplier per quarter');
  // The send is checked again at the mailbox: a job switched to Watch only sends nothing.
  await modes.save(db,ctx,164,{mode:'watch',revision:3});
  mail=await f.effects('quiet-supplier');
  await assert.rejects(f.deliver(mail[0].id),/Watch only/);
  assert.equal(f.sent.length,1);
  assert((await f.needs()).some(n=>n.title==='1 supplier review pack was not sent'));
  await modes.save(db,ctx,164,{mode:'routine',revision:4});
  const failed=await f.browser.get(packs.href).expect(200);
  assert.match(failed.text,/Send again/);
  quietPack=await f.one('quiet-supplier');
  await f.browser.post(packs.href+'/packs/'+quietPack.id+'/send').type('form').send({_csrf:f.csrf(failed.text),fingerprint:quietPack.fingerprint}).expect(303);
  mail=await f.effects('quiet-supplier');
  assert.equal(mail.length,2);assert.equal((await f.one('quiet-supplier')).attempt,1);
  await f.deliver(mail[1].id);
  assert.equal(f.sent.length,2);assert.equal(f.sent[1].recipient,'quiet@example.test');
  assert.deepEqual(await f.needs(),[]);

  // Custom does the same job alone.
  await f.subscribe('enterprise');
  assert.match((await f.browser.get(packs.href).expect(200)).text,/sends each pack on its own/);
  assert.equal((await f.work()).prepared,0);
});

test('The supplier packs page fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t);
  await f.subscribe('pro');await f.work();
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+packs.href);
    const text=await page.locator('main').innerText();
    assert.match(text,/Supplier review packs/);assert.match(text,/Alternative/);assert.match(text,/Quiet goods/);assert.match(text,/Sending mailbox/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/supplier-review-packs-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});

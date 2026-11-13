'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const pack=require('../../src/accounting/agent-year-end-pack');
const reportRuns=require('../../src/reports/agent-report-runs');

// Job 165 (Growth and up): the year-end stocktake and valuation pack for the accountant.
// The financial year ends with the month that just ended. During the year 10
// Hinges arrived at $2, one was damaged and $3 of value was written down, so $15
// of stock is left at the year end in both the books and the stock records. A
// count approved in the last month found one fewer; another count is still pending.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,ws=ctx.workspaceId,w=f.workflows;
  const time=require('../../src/lib/business-time'),ledger=require('../../src/accounting/postgres-ledger'),zone='America/New_York';
  await db.query('UPDATE workspaces SET time_zone=$2 WHERE id=$1',[ws,zone]);
  const today=await time.today(db,ws),closing=reportRuns.lastCompleted(today),start=reportRuns.addMonths(closing,-11)+'-01',end=reportRuns.monthEnd(closing);
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,reportRuns.addMonths(closing,-13)+'-01']);
  const at=(month,day,hour=12)=>time.wall(month+'-'+String(day).padStart(2,'0'),hour,0,zone).toISOString();
  const made=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Hinge',baseCode:'HINGE-'+randomUUID().slice(0,6),trackingMode:'quantity'});
  const sku=made.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code,location=f.location.id;
  const key=randomUUID(),po=await w.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location,idempotencyKey:key,lines:[{skuId:sku,quantityUnits:10,unitCost:2}]});
  await w.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await w.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
  await w.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r',reference:'Hinge delivery',receivedAt:at(reportRuns.addMonths(closing,-2),3),lines:[{lineId:po.lineIds[0],quantity:10,locationId:location}]});
  await require('../../src/accounting/postgres-stock-removal').issue(db,ctx,{skuId:sku,locationId:location,quantity:1,reasonCode:'damaged',occurredAt:at(reportRuns.addMonths(closing,-1),5),idempotencyKey:randomUUID()});
  // A $3 write-down booked in the last month, as job 17 records one.
  await db.transaction(c=>ledger.ensureSystemAccountInTransaction(c,ctx,'INVENTORY_WRITE_DOWNS'));
  const writeDownId='write-down-'+randomUUID().slice(0,8);
  const journal=await ledger.post(db,ctx,{postingDate:closing+'-20',sourceKey:'inventory-write-down:'+writeDownId,sourceType:'inventory_valuation_write_down',
    description:'Inventory write-down for '+code,lines:[{accountKey:'INVENTORY_WRITE_DOWNS',debitMinor:300,skuId:sku,locationId:location},{accountKey:'INVENTORY_ASSET',creditMinor:300,skuId:sku,locationId:location}]});
  await db.query(`INSERT INTO accounting_inventory_value_adjustments(id,workspace_id,sku_id,location_id,amount_delta_minor,quantity_units,source_type,source_record_id,journal_entry_id,created_at)
    VALUES($1,$2,$3,$4,-300,9,'inventory_valuation_write_down',$5,$6,$7)`,[randomUUID(),ws,sku,location,writeDownId,journal.entry.id,at(closing,20)]);
  await db.query(`INSERT INTO accounting_inventory_write_downs(id,workspace_id,sku_id,location_id,currency,posting_date,quantity_units,before_value_minor,after_value_minor,
      evidence_reference,snapshot,approved_by,journal_entry_id,idempotency_key,payload_hash) VALUES($1,$2,$3,$4,'USD',$5,9,1800,1500,'Supplier clearance price list','{}',$6,$7,$8,'fixture')`,
  [writeDownId,ws,sku,location,closing+'-20',ctx.actorId,journal.entry.id,writeDownId]);
  // A count approved in the last month, and one still pending.
  const counts=require('../../src/operations/postgres-count-reviews');
  const count=await counts.prepare(db,ctx,{locationId:location,reference:'Year close count',lines:[{skuId:sku,quantity:8}]});
  await counts.approve(db,ctx,count.id,(await counts.get(db,ctx,count.id)).integrity_hash);
  await db.query("UPDATE physical_count_reviews SET approved_at=$2 WHERE id=$1",[count.id,at(closing,28)]);
  const pending=await counts.prepare(db,ctx,{locationId:location,reference:'Unfinished count',lines:[{skuId:sku,quantity:9}]});
  await db.query("UPDATE physical_count_reviews SET created_at=$2 WHERE id=$1",[pending.id,at(closing,29)]);
  // A signed-off annual stocktake.
  await db.query(`INSERT INTO stockchief_runtime.agent_annual_stocktakes(id,workspace_id,owner_id,title,stocktake_year,scope,plan_hash,request_key,status,signed_off_at,signoff)
    VALUES($1,$2,$3,'Main warehouse stocktake',$4,'{}','fixture',$1,'SIGNED_OFF',$5,$6)`,
  [randomUUID(),ws,ctx.actorId,Number(closing.slice(0,4)),at(closing,27),JSON.stringify({positions:3,differences:1,value_difference:'-200'})]);
  const mailbox=async name=>{const id=randomUUID();
    await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
      VALUES($1,$2,$1,$3,'microsoft365','[]','{}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$6,now(),now())`,[id,ws,name,'connection_credentials:'+id,ctx.actorId,name.toLowerCase().replace(/\W+/g,'-')]);
    await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,id,'provider',{accessToken:'synthetic-token'}));return id;};
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  const outbound=require('../../src/connections/postgres-outbound-mail');
  const mails=async()=>(await db.query(`SELECT e.id,m.status,m.recipient,m.subject,m.body,m.customer_id FROM stockchief_runtime.provider_effects e JOIN customer_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
    WHERE e.workspace_id=$1 AND e.kind='mail.outbound.send' AND e.payload->'standingAuthority'->>'kind'='accountant_pack' ORDER BY m.created_at,m.id`,[ws])).rows;
  const one=async()=>(await db.query('SELECT * FROM stockchief_runtime.agent_year_end_packs WHERE workspace_id=$1 AND closing=$2',[ws,closing])).rows[0];
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('year-end-pack'));
  const pilot=async set=>{await db.query("INSERT INTO workspace_autopilot(workspace_id,mode,created_at,updated_at) VALUES($1,'SUPERVISED',now()::text,now()::text) ON CONFLICT(workspace_id) DO NOTHING",[ws]);
    await db.query(`UPDATE workspace_autopilot SET ${set} WHERE workspace_id=$1`,[ws]);};
  const handler=require('../../src/operations/postgres-runtime-handlers').create()[pack.KIND];
  const work=()=>handler({workspaceId:ws,payload:{}},db);
  const older=()=>db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const binary=req=>req.buffer(true).parse((res,done)=>{const chunks=[];res.on('data',v=>chunks.push(v));res.on('end',()=>done(null,Buffer.concat(chunks)));});
  const workbook=body=>{const XLSX=require('xlsx'),book=XLSX.read(body,{type:'buffer'});return {names:book.SheetNames,rows:name=>XLSX.utils.sheet_to_json(book.Sheets[name])};};
  const settings=async(input,page)=>{page=page||await f.browser.get(pack.href).expect(200);
    const revision=Number((/name="revision" value="(\d+)"/.exec(page.text)||[])[1]||0);
    return f.browser.post(pack.href+'/settings').type('form').send({_csrf:f.csrf(page.text),revision,...input}).expect(303);};
  return {...f,ws,today,closing,start,end,sku,code,location,ledger,mailbox,sent,provider,outbound,mails,one,audits,needs,pilot,work,older,binary,workbook,settings};
}

test('The year-end pack is made after the financial year ends, kept, and sent to the accountant on Growth, Pro and Custom',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,ws,closing}=f,month=Number(closing.slice(5));
  const deliver=id=>f.outbound.executeSendEffect(db,ws,id,{provider:f.provider});

  // An account on its older terms sees the plan card; Starter is excluded.
  assert.match((await f.browser.get(pack.href).expect(200)).text,/data-agent-plan-locked/);
  assert.deepEqual(await f.work(),{skipped:'plan'});
  await f.subscribe('starter');
  await f.browser.get(pack.href).expect(402);
  await assert.rejects(pack.configure(db,ctx,{revision:0,yearEndMonth:String(month),accountantEmail:'books@example.test'}),e=>e.code==='entitlement_required');
  assert.deepEqual(await f.work(),{skipped:'plan'});assert.deepEqual(await pack.schedule(db,ws),{queued:0});assert.deepEqual(await pack.inbox(db,ws),[]);

  // Growth: the owner saves the year end and the accountant (a saved rule).
  await f.subscribe('growth');
  assert.deepEqual(await f.work(),{skipped:'not_due'},'Nothing is made before the owner says when the year ends');
  await assert.rejects(pack.configure(db,ctx,{revision:0,yearEndMonth:'13'}),/month your financial year ends/);
  await assert.rejects(pack.configure(db,ctx,{revision:0,yearEndMonth:String(month),accountantEmail:'not an email'}),/email address/);
  await f.settings({yearEndMonth:String(month),accountantName:'Dana Ledger',accountantEmail:'Books@Example.test'});
  assert.equal(await f.audits('Saved the yearly pack for the accountant'),1);
  assert.equal((await db.query('SELECT accountant_email FROM stockchief_runtime.agent_year_end_settings WHERE workspace_id=$1 AND enabled',[ws])).rows[0].accountant_email,'books@example.test');

  // The first 14 days: made and kept, nothing sent.
  assert.deepEqual(await pack.schedule(db,ws),{queued:1});
  let result=await f.work();
  assert.equal(result.closing,closing);assert.equal(result.status,'WATCHED');
  assert.deepEqual(await f.mails(),[]);assert.deepEqual(await f.needs(),[]);
  assert.equal(await f.audits('StockChief made the year-end stock pack'),1);
  let kept=await f.one();
  assert.equal(kept.year_start,f.start);assert.equal(kept.year_end,f.end);
  await assert.rejects(pack.send(db,ctx,kept.id,{fingerprint:kept.fingerprint}),/first 14 days/);
  // The kept workbook: valuation method, the year's roll-forward, write-downs, counts and stocktakes.
  const file=await f.binary(f.browser.get(pack.href+'/packs/'+kept.id)).expect(200).expect('Content-Type',/spreadsheetml/);
  const book=f.workbook(file.body);
  assert.deepEqual(book.names,['Summary','Closing valuation','Stock by location','Approved count lines','Write-downs','Stocktakes']);
  const summary=Object.fromEntries(book.rows('Summary').map(r=>[r.Item,r.Value]));
  assert.equal(summary['Valuation method'],'Weighted average cost');assert.equal(summary['Financial year'],f.start+' to '+f.end);
  assert.equal(summary['Business'],'Shipping operation fixture');
  assert.equal(summary['Opening stock value'],0);assert.equal(summary['Received'],20);assert.equal(summary['Written off and written down'],-5);
  assert.equal(summary['Closing stock value in stock records'],15);assert.equal(summary['Closing stock value in the books'],15);assert.equal(summary['Books less stock records'],0);
  assert.equal(summary['Counts not approved by the year end (left out)'],1);assert.equal(summary['Write-downs in the year'],1);
  assert.equal(book.rows('Closing valuation').find(r=>r.SKU===f.code)['Closing value'],15);
  assert.deepEqual(book.rows('Stock by location').map(r=>[r.Location,r.Received,r['Written off'],r.Closing]),[['Dispatch',20,-5,15]]);
  const lines=book.rows('Approved count lines');
  assert.equal(lines.length,1,'The pending count is left out');assert.equal(lines[0].Reference,'Year close count');assert.equal(lines[0].Difference,-1);assert.equal(lines[0].Source,'Count review');
  assert.deepEqual(book.rows('Write-downs').map(r=>[r.SKU,r['Value before'],r['Value after'],r['Written down'],r.Evidence]),[[f.code,18,15,3,'Supplier clearance price list']]);
  assert.deepEqual(book.rows('Stocktakes').map(r=>[r.Stocktake,r['Positions counted'],r['Positions with a difference'],r['Net change in value']]),[['Main warehouse stocktake',3,1,-2]]);
  assert.equal((await f.work()).changed,false,'The same figures replay to the same pack');
  assert.equal(await f.audits('StockChief made the year-end stock pack'),1);

  // After 14 days, Ask me first. No mailbox: stops and asks.
  await f.older();
  await f.work();
  kept=await f.one();assert.deepEqual([kept.status,kept.problem],['STOPPED','mailbox']);
  assert.deepEqual((await f.needs()).map(n=>n.title),['Connect a mailbox to send the year-end stock pack']);
  // Two mailboxes and no choice made: still asks.
  const main=await f.mailbox('Office mailbox');await f.mailbox('Other mailbox');
  await f.work();
  assert.equal((await f.one()).problem,'mailbox_choice');
  assert.deepEqual((await f.needs()).map(n=>n.title),['Choose the mailbox for the year-end stock pack']);
  await f.settings({yearEndMonth:String(month),accountantName:'Dana Ledger',accountantEmail:'books@example.test',connectorId:main});
  await f.work();
  kept=await f.one();
  assert.equal(kept.status,'WAITING');assert.match(kept.reason,/asks before/);
  assert.deepEqual((await f.needs()).map(n=>n.title),['Your year-end stock pack for the year to '+reportRuns.monthName(closing)+' is ready to send']);
  assert.deepEqual(await f.mails(),[],'Ask me first sends nothing on its own');
  // No accountant email: stops and asks.
  await f.settings({yearEndMonth:String(month),accountantEmail:'',connectorId:main});
  await f.work();
  assert.equal((await f.one()).problem,'recipient');
  assert.deepEqual((await f.needs()).map(n=>n.title),['Add your accountant’s email to send the year-end stock pack']);
  await f.settings({yearEndMonth:String(month),accountantName:'Dana Ledger',accountantEmail:'books@example.test',connectorId:main});

  // Pause holds the worker and any send; Watch only keeps the pack and sends nothing.
  await f.pilot('paused=1');
  assert.deepEqual(await f.work(),{held:'paused'});
  kept=await f.one();
  await assert.rejects(pack.send(db,ctx,kept.id,{fingerprint:kept.fingerprint}),/paused/);
  await f.pilot('paused=0');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,165,{mode:'watch',revision:0});
  assert.equal((await f.work()).status,'WATCHED');
  await assert.rejects(pack.send(db,ctx,kept.id,{fingerprint:kept.fingerprint}),/Watch only/);

  // Handle routine work: books that differ from the stock records wait for the owner.
  await modes.save(db,ctx,165,{mode:'routine',revision:1});
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const extra=await f.ledger.post(db,ctx,{postingDate:closing+'-25',sourceKey:'manual-stock-'+randomUUID(),description:'Hand-posted stock',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:500},{accountKey:'CASH',creditMinor:500}]});
  result=await f.work();
  assert.equal(result.status,'WAITING');assert.equal(result.sent,false);
  assert.match((await f.one()).reason,/books and your stock records differ: \$5\.00 USD/);
  assert.deepEqual(await f.mails(),[]);
  await f.ledger.post(db,ctx,{postingDate:closing+'-26',sourceKey:'manual-stock-reversal-'+extra.entry.id,description:'Reverse hand-posted stock',lines:[{accountKey:'INVENTORY_ASSET',creditMinor:500},{accountKey:'CASH',debitMinor:500}]});
  // Once they agree, StockChief sends the pack on its own.
  result=await f.work();
  assert.equal(result.sent,true);
  kept=await f.one();
  assert.equal(kept.status,'QUEUED');assert.equal(kept.authorization_kind,'AUTOMATIC');assert.equal(kept.recipient,'books@example.test');assert.equal(kept.connector_id,main);
  assert.equal(await f.audits('StockChief sent the year-end stock pack to the accountant'),1);
  let mail=await f.mails();
  assert.equal(mail.length,1);assert.equal(mail[0].recipient,'books@example.test');assert.equal(mail[0].customer_id,null);
  assert.equal(mail[0].subject,'Year-end stock pack · '+f.start+' to '+f.end+' · Shipping operation fixture');
  assert.match(mail[0].body,/^Hello Dana Ledger,/);assert.match(mail[0].body,/valued at weighted average cost/);
  assert.match(mail[0].body,/closing stock \$15\.00 in the stock records and \$15\.00 in the books; \$5\.00 written off or written down/);
  assert.match(mail[0].body,/1 count was not approved by the year end and is left out/);
  // The mailbox sends it with the kept workbook attached.
  await deliver(mail[0].id);
  assert.equal(f.sent.length,1);
  const [attached]=f.sent[0].attachments;
  assert.equal(attached.contentType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');assert.equal(attached.filename,'year-end-stock-pack-'+closing+'.xlsx');
  assert(attached.content.equals(kept.file));
  assert.equal(require('../../src/connections/providers/photo-attachments').graph(f.sent[0].attachments)[0].name,attached.filename);
  assert.equal((await f.mails())[0].status,'SENT');
  assert.match((await f.browser.get(pack.href).expect(200)).text,/Sent to books@example\.test/);
  // One pack per financial year: replays and the owner's send add nothing.
  assert.equal((await f.work()).replayed,true);
  assert.deepEqual(await pack.schedule(db,ws),{queued:0});
  assert.equal((await pack.send(db,ctx,kept.id,{fingerprint:kept.fingerprint})).replayed,true);
  assert.equal((await f.mails()).length,1);assert.deepEqual(await f.needs(),[]);

  // Pro and Custom do the same job alone.
  for(const tier of ['pro','enterprise']){
    await f.subscribe(tier);
    assert.match((await f.browser.get(pack.href).expect(200)).text,/sends the pack to your accountant on its own/);
    assert.equal((await f.work()).replayed,true);
  }
  // Stopping the yearly pack stops the worker.
  await f.settings({stop:'yes'});
  assert.equal(await f.audits('Stopped the yearly pack for the accountant'),1);
  assert.deepEqual(await f.work(),{skipped:'not_due'});
});

test('The owner sends a year-end pack by hand under Ask me first, and an earlier year can be made on demand',{timeout:900000},async t=>{
  const f=await setup(t),{db,ctx,closing}=f;
  await f.subscribe('growth');await f.older();
  const main=await f.mailbox('Office mailbox');
  await f.settings({yearEndMonth:String(Number(closing.slice(5))),accountantEmail:'books@example.test'});
  await f.work();
  let kept=await f.one();assert.equal(kept.status,'WAITING');
  await assert.rejects(pack.send(db,ctx,kept.id,{fingerprint:'stale'}),/changed after you opened/);
  const page=await f.browser.get(pack.href).expect(200);
  assert.match(page.text,/Ready to send/);
  await f.browser.post(pack.href+'/packs/'+kept.id+'/send').type('form').send({_csrf:f.csrf(page.text),fingerprint:kept.fingerprint}).expect(303);
  kept=await f.one();
  assert.equal(kept.status,'QUEUED');assert.equal(kept.authorization_kind,'INDIVIDUAL');assert.equal(kept.connector_id,main);
  assert.equal(await f.audits('Sent the year-end stock pack to the accountant'),1);
  // A delivery the mailbox refused can be sent again once; the pack is the same.
  const [mail]=await f.mails();
  await assert.rejects(f.outbound.executeSendEffect(db,f.ws,mail.id,{provider:{send:async()=>{throw Object.assign(new Error('Mailbox refused the message'),{status:400,code:'provider_rejected'});}}}));
  assert.deepEqual((await f.needs()).map(n=>n.title),['The year-end stock pack was not sent']);
  const failed=await f.browser.get(pack.href).expect(200);
  assert.match(failed.text,/Not sent/);assert.match(failed.text,/Send again/);
  await f.browser.post(pack.href+'/packs/'+kept.id+'/send').type('form').send({_csrf:f.csrf(failed.text),fingerprint:kept.fingerprint}).expect(303);
  const again=await f.mails();
  assert.equal(again.length,2);assert.equal((await f.one()).attempt,1);
  await f.outbound.executeSendEffect(db,f.ws,again[1].id,{provider:f.provider});
  assert.equal(f.sent.length,1);assert.deepEqual(await f.needs(),[]);
  assert.equal((await pack.send(db,ctx,kept.id,{fingerprint:kept.fingerprint})).replayed,true);
  // An earlier financial year can be made and kept on demand.
  const earlier=reportRuns.addMonths(closing,-12);
  const made=await f.browser.get(pack.href).expect(200);
  await f.browser.post(pack.href+'/make').type('form').send({_csrf:f.csrf(made.text),closing:earlier}).expect(303);
  const old=(await db.query('SELECT status,made_by FROM stockchief_runtime.agent_year_end_packs WHERE workspace_id=$1 AND closing=$2',[f.ws,earlier])).rows[0];
  assert.equal(old.made_by,ctx.actorId);assert.equal(await f.audits('Made the year-end stock pack'),1);
});

test('The year-end pack page fits a phone and a desktop',{timeout:600000},async t=>{
  const f=await setup(t);
  await f.subscribe('growth');
  await f.settings({yearEndMonth:String(Number(f.closing.slice(5))),accountantName:'Dana Ledger',accountantEmail:'books@example.test'});
  await f.work();
  const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const http=app.listen(0,'127.0.0.1',()=>resolve(http));}),browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const [width,height,name] of [[390,844,'mobile'],[1600,1000,'desktop']]){
    const page=await browser.newPage({viewport:{width,height}});page.setDefaultTimeout(15000);
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+pack.href);
    const text=await page.locator('main').innerText();
    assert.match(text,/Year-end stocktake and valuation pack/);assert.match(text,/Kept packs/);assert.match(text,/books@example\.test/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' fits without sideways scrolling');
    require('node:fs').mkdirSync('output',{recursive:true});
    await page.screenshot({path:'output/year-end-pack-'+name+'.png',fullPage:true,animations:'disabled'});
    await page.close();
  }
});

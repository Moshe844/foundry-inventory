'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const flow=require('../../src/purchasing/invoice-dispute-follow-through');
const disputes=require('../../src/purchasing/agent-invoice-disputes');
const mode=require('../../src/autopilot/job-modes');
const mail=require('../../src/connections/postgres-mail');
const outbound=require('../../src/connections/postgres-outbound-mail');
const auto=require('../../src/autopilot/postgres-service');
const money=require('../../src/domain/currency');

// Job 100: disputes wrong supplier invoices. Excluded on Starter and Growth,
// trained on Pro (an approved example or the owner's saved limit), alone on
// Custom inside the owner's limit. Every message lists its evidence; the
// disputed invoice stays out of the payment run; unanswered disputes get
// reminders; replies, counter-claims, unclear evidence and anything over the
// limit wait for a person; a supplier credit note can settle it.
test('supplier invoice disputes follow up through reminders, replies and credit notes on every plan',{timeout:420000},async t=>{
  const f=await require('../helpers/supplier-invoice-intake-fixture').fixture(t);
  const {db,ctx,connector,sender,browser,csrf}=f,ws=ctx.workspaceId;
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await db.query(`UPDATE workspace_connectors SET capabilities='["MAIL_READ","MAIL_SEND"]',credential_ref=$3 WHERE workspace_id=$1 AND id=$2`,
    [ws,connector,'connection_credentials:'+connector]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  const sent=[];
  const capture=async({threadId,text,subject='Supplier reply',filename='original.txt'})=>{
    const response=await mail.capture(db,{id:connector,workspace_id:ws,provider_type:'gmail'},
      {messageId:randomUUID(),threadId,sender,subject,bodyText:'Please see the attached document or my reply.',
        ...(text?{attachments:[{filename,mimeType:'text/plain',contentBase64:Buffer.from(text).toString('base64')}]}:{})});
    if(!text)return response;
    await require('../../src/connections/postgres-attachments').extractMessage(db,ws,response.messageId);
    await f.runSource();
    const row=(await db.query(`SELECT q.* FROM stockchief_runtime.agent_supplier_invoice_intakes q
      JOIN connection_email_attachments a ON a.id=q.attachment_id WHERE q.workspace_id=$1 AND a.message_id=$2`,[ws,response.messageId])).rows[0];
    assert(row);
    return {...response,row};
  };
  const pending=async()=>{
    const jobs=[];
    for(;;){
      const j=await f.queue.processOne(db,f.handlers,{owner:'invoice-dispute-worker',kinds:[flow.KIND]});
      if(!j)return jobs;
      assert.equal(j.status,'COMPLETED',JSON.stringify(j.lastError));
      jobs.push(j.result);
    }
  };
  const work=async intakeId=>(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND intake_id=$2',[ws,intakeId])).rows[0];
  const workFor=async billId=>(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2',[ws,billId])).rows[0];
  const bill=async id=>(await db.query('SELECT * FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2',[ws,id])).rows[0];
  const messages=async billId=>(await db.query('SELECT * FROM supplier_communications WHERE workspace_id=$1 AND invoice_dispute_bill_id=$2 ORDER BY created_at,id',[ws,billId])).rows;
  const deliver=async(billId,threadId)=>{
    const rows=(await db.query(`SELECT e.id FROM stockchief_runtime.provider_effects e JOIN supplier_communications m ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
      WHERE m.workspace_id=$1 AND m.invoice_dispute_bill_id=$2 AND e.kind='mail.outbound.send' AND e.status='PENDING' ORDER BY e.created_at,e.id`,[ws,billId])).rows;
    for(const r of rows)await outbound.executeSendEffect(db,ws,r.id,{provider:{send:async({message})=>{sent.push(message);
      return {externalMessageId:'gmail-verified-'+message.id,externalThreadId:threadId};}}});
    return rows.length;
  };
  const age=(billId,days)=>db.query("UPDATE supplier_communications SET sent_at=$3 WHERE workspace_id=$1 AND invoice_dispute_bill_id=$2 AND status='SENT'",
    [ws,billId,new Date(Date.now()-days*86400000).toISOString()]);
  const setMode=async value=>mode.save(db,ctx,100,{mode:value,revision:Number((await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=100',[ws])).rows[0]?.revision||0)});
  const ruleRevision=async()=>Number((await db.query('SELECT revision FROM stockchief_runtime.agent_invoice_dispute_rules WHERE workspace_id=$1',[ws])).rows[0]?.revision||0);
  const payables=async()=>(await require('../../src/accounting/customer-money').documents(db,ws,'bills',f.today)).map(b=>[b.id,Number(b.balance_minor)]);
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const inbox=async()=>flow.inbox(db,ws);
  const body=(p,number,price,{quantity=1,tax=0}={})=>f.text(p,{number,tax,rows:[{sku:code,quantity,price,total:price*quantity}]});
  let seq=0;
  const newCase=async(price,options={})=>{
    const number=(options.prefix||'WRONG-')+(++seq);
    const po=options.po||await f.po([{skuId:sku,quantityUnits:options.quantity||1,unitCost:'1.25'}]);
    const original=await capture({threadId:'incoming-'+number,text:body(po,number,price,options),subject:'Original invoice '+number});
    assert.equal(original.row.status,'EXCEPTION',original.row.problem);
    const jobs=await pending();
    return {po,number,row:original.row,jobs,billId:(await work(original.row.id))?.bill_id};
  };
  const note=({number,original,total,tax=0})=>['Supplier credit note','Credit note number: '+number,'Original invoice number: '+original,
    'Credit note date: '+f.today,'Currency: USD','Tax: '+money.fromMinor(tax,'USD'),'Total: '+money.fromMinor(total,'USD')].join('\n');
  const creditArrives=async text=>{const {row}=await capture({threadId:'credit-'+randomUUID(),text,subject:'Credit note',filename:'credit-note.txt'});
    assert.equal(row.status,'CREDIT_REVIEW',row.problem);return row.id;};

  await t.test('Starter and Growth cannot dispute, set a dispute limit or open the review',async()=>{
    for(const tier of ['starter','growth']){
      await f.subscribe(tier);
      await browser.get('/autopilot/reviews/supplier-invoice-disputes').expect(402);
      await assert.rejects(flow.configure(db,ctx,{revision:0,confirmed:'yes',maximum:'1.00',reminderDays:7,reminderLimit:1}),e=>e.code==='entitlement_required');
      assert.deepEqual(await inbox(),[]);
    }
    await f.subscribe('pro');
  });

  await setMode('routine');
  let untrained;
  await t.test('Pro drafts until taught: the dispute waits for approval and its invoice stays out of payment',async()=>{
    untrained=await newCase(175);
    assert(untrained.jobs.some(j=>j.status==='HELD'&&/teach/i.test(j.problem)),JSON.stringify(untrained.jobs));
    assert.equal((await bill(untrained.billId)).status,'DISPUTED');
    assert.equal((await messages(untrained.billId)).length,0);
    assert(!(await payables()).some(([id])=>id===untrained.billId),'A disputed invoice is not payable.');
    const p=await disputes.facts(db,ctx,untrained.billId,connector);
    assert.equal(p.disputedMinor,50);
    assert.equal(p.purchaseOrderNumber,untrained.po.poNumber);
    assert.match(p.differences[0].text,new RegExp('approved purchase-order price is \\$1\\.25 per approved pricing unit on '+untrained.po.poNumber+' \\(1 ordered\\)'));
    assert.match(disputes.compose(p).body,/Amount in question: \$0\.50\./);
    const needs=await inbox();
    assert(needs.some(n=>n.href==='/autopilot/supplier-disputes/'+untrained.billId&&/teach/i.test(n.happened)));
    const all=await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
    assert(all.some(n=>n.sourceId==='invoice-dispute:'+untrained.billId),'The held dispute reaches Needs you.');
  });

  let price,taxed;
  await t.test('Pro taught by the saved dispute limit sends within it, once, and holds a larger dispute',async()=>{
    await assert.rejects(flow.configure(db,ctx,{revision:0,confirmed:'yes',maximum:'0',reminderDays:7,reminderLimit:1}),/above zero/);
    await assert.rejects(flow.configure(db,ctx,{revision:0,confirmed:'yes',maximum:'1.00',reminderDays:0,reminderLimit:1}),/1 to 60/);
    const page=await browser.get('/autopilot/reviews/supplier-invoice-disputes').expect(200);
    assert.match(page.text,/Your dispute limit/);assert.match(page.text,/teaches StockChief/);
    await browser.post('/autopilot/supplier-disputes/settings').type('form')
      .send({_csrf:csrf(page.text),revision:0,maximum:'1.00',reminderDays:'7',reminderLimit:'1',confirmed:'yes'}).expect(303);
    assert.equal(await audits('Supplier invoice dispute limit saved'),1);
    price=await newCase(175);
    assert(price.jobs.some(j=>j.billId===price.billId&&j.status==='QUEUED'),JSON.stringify(price.jobs));
    assert.equal(await deliver(price.billId,'thread-price'),1);
    const body=sent.at(-1).body;
    assert.match(body,new RegExp('purchase order '+price.po.poNumber));assert.match(body,/Amount in question: \$0\.50\./);
    assert.match(body,new RegExp('on '+price.po.poNumber+' \\(1 ordered\\); the invoice shows \\$1\\.75'));
    assert(await audits('Supplier invoice dispute queued')>=1);
    // Replay: rediscovery and the routine do not send it again.
    await db.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,payload,priority,max_attempts,available_at,idempotency_key,created_at,updated_at)
      VALUES($1,$2,$3,$4::jsonb,50,8,0,$5,now(),now())`,[randomUUID(),ws,flow.KIND,JSON.stringify({sourceKind:'bill',sourceId:price.billId}),'replay:'+price.billId]);
    await pending();
    assert.equal((await messages(price.billId)).length,1);
    const over=await newCase(375);
    assert(over.jobs.some(j=>j.billId===over.billId&&j.status==='HELD'&&/over your \$1\.00 dispute limit/.test(j.problem)),JSON.stringify(over.jobs));
    assert.equal((await messages(over.billId)).length,0);
    assert((await inbox()).some(n=>n.href.endsWith(over.billId)&&/over your/.test(n.happened)));
  });

  await t.test('wrong tax and double billing are disputed with their evidence',async()=>{
    const po=await f.po([{skuId:sku,quantityUnits:1,unitCost:'1.25'}]);
    await db.query(`INSERT INTO purchase_order_charges(id,workspace_id,purchase_order_id,label,kind,amount_minor,source,created_at)
      VALUES($1,$2,$3,'Sales tax','tax',10,'Agreed on the order',now()::text)`,[randomUUID(),ws,po.purchaseOrderId]);
    taxed=await newCase(125,{po,tax:30,prefix:'TAX-'});
    const taxBill=await bill(taxed.billId);
    assert(JSON.parse(taxBill.exception_detail).differences.some(d=>d.kind==='invoice_tax_differs'&&d.billedTaxMinor===30&&d.agreedTaxMinor===10));
    assert(taxed.jobs.some(j=>j.billId===taxed.billId&&j.status==='QUEUED'),JSON.stringify(taxed.jobs));
    await deliver(taxed.billId,'thread-tax');
    assert.match(sent.at(-1).body,new RegExp('Purchase order '+po.poNumber+' agreed \\$0\\.10 tax\\. This invoice charges \\$0\\.30 tax\\.'));
    assert.match(sent.at(-1).body,/Amount in question: \$0\.20\./);
    const twice=await f.po([{skuId:sku,quantityUnits:2,unitCost:'1.25'}]);
    const firstNumber='FIRST-'+randomUUID().slice(0,8);
    const first=await f.workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:twice.purchaseOrderId,
      supplierInvoiceNumber:firstNumber,issueDate:f.today,dueDate:f.due,currency:'USD',documentTotalMinor:250,idempotencyKey:randomUUID(),
      lines:[{purchaseOrderLineId:twice.lineIds[0],skuId:sku,quantity:2,unitCostMinor:125}]});
    assert.equal(first.status,'OPEN');
    const double=await newCase(125,{po:twice,quantity:2,prefix:'DOUBLE-'});
    assert(double.jobs.some(j=>j.billId===double.billId&&j.status==='HELD'&&/over your/.test(j.problem)),'The whole double bill is over the limit.');
    const p=await disputes.facts(db,ctx,double.billId,connector);
    assert.equal(p.disputedMinor,250);
    assert.match(p.differences[0].text,/2 stock units received and 2 stock units already billed/);
    assert.match(p.differences[0].text,new RegExp('Received on '+twice.poNumber+': 2 on '+f.today));
    assert.match(p.differences[0].text,new RegExp('Already billed on invoice '+firstNumber));
    const credit=await creditArrives(note({number:'CN-DOUBLE',original:double.number,total:-250}));
    assert.match((await flow.page(db,ctx,double.billId,{credit})).selectedCredit.hold,/goods billed but not received/);
  });

  await t.test('an unanswered dispute gets reminders within the schedule, then waits for the owner',async()=>{
    await flow.schedule(db,ws);
    assert.equal((await messages(price.billId)).length,1,'Nothing is due before the reminder days pass.');
    await age(price.billId,8);
    const scheduled=await flow.schedule(db,ws);
    assert(scheduled.reminders>=1);
    assert.equal((await flow.schedule(db,ws)).reminders,0,'The same reminder is queued once.');
    const jobs=await pending();
    assert(jobs.some(j=>j.billId===price.billId&&j.reminder===1&&j.status==='QUEUED'),JSON.stringify(jobs));
    await pending();
    assert.equal(await deliver(price.billId,'thread-price'),1);
    assert.match(sent.at(-1).subject,/^Reminder: please review invoice /);
    assert.match(sent.at(-1).body,/We wrote on \d{4}-\d{2}-\d{2} about invoice .* and have not had a reply yet/);
    assert.equal(await audits('Supplier invoice dispute reminder queued'),1);
    await age(price.billId,8);
    await flow.schedule(db,ws);await pending();
    assert.equal((await messages(price.billId)).length,2,'The owner allowed one reminder.');
    assert.match((await workFor(price.billId)).attention,/No reply after 1 reminder\. Contact the supplier yourself\./);
    assert((await inbox()).some(n=>n.href.endsWith(price.billId)));
    const detail=(await browser.get('/autopilot/supplier-disputes/'+price.billId).expect(200)).text;
    assert.match(detail,/Messages to the supplier/);assert.match(detail,/Reminder 1/);
    assert.match(detail,/Held\. This invoice stays out of the payment run/);assert.match(detail,/Amount in question/);
  });

  await t.test('Ask me first, Watch only, pause and shadow stop automatic reminders; the owner can send one',async()=>{
    await age(taxed.billId,8);
    await setMode('ask');
    assert.equal((await flow.schedule(db,ws)).reminders,0);
    assert.match((await workFor(taxed.billId)).attention,/Send a reminder\./);
    await setMode('watch');
    await assert.rejects(flow.remind(db,ctx,taxed.billId,{confirmed:'yes',reminder:1}),/Watch only/);
    await setMode('routine');
    await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
    assert.equal((await flow.schedule(db,ws)).reminders,0);
    await assert.rejects(flow.remind(db,ctx,taxed.billId,{confirmed:'yes',reminder:1}),/first 14 days/);
    await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
    await auto.pause(db,ctx,{role:'owner'},'Check supplier mail');
    assert.equal((await flow.schedule(db,ws)).reminders,0);
    await auto.resume(db,ctx,{role:'owner'});
    await setMode('ask');
    const page=(await browser.get('/autopilot/supplier-disputes/'+taxed.billId).expect(200)).text;
    assert.match(page,/Send reminder 1 now/);
    await assert.rejects(flow.remind(db,ctx,taxed.billId,{confirmed:'yes',reminder:2}),/Reload/);
    await browser.post('/autopilot/supplier-disputes/'+taxed.billId+'/remind').type('form').send({_csrf:csrf(page),reminder:'1',confirmed:'yes'}).expect(303);
    await browser.post('/autopilot/supplier-disputes/'+taxed.billId+'/remind').type('form').send({_csrf:csrf(page),reminder:'1',confirmed:'yes'}).expect(303);
    assert.equal((await messages(taxed.billId)).length,2,'A repeated click queues the same reminder once.');
    assert.equal((await workFor(taxed.billId)).attention,null);
    assert.equal(await deliver(taxed.billId,'thread-tax'),1);
    await setMode('routine');
  });

  await t.test('a supplier reply or counter-claim waits for the owner and stops reminders',async()=>{
    await capture({threadId:'thread-price',subject:'We do not agree, our price went up'});
    await flow.schedule(db,ws);
    assert.match((await workFor(price.billId)).attention,/The supplier replied/);
    await assert.rejects(flow.remind(db,ctx,price.billId,{confirmed:'yes',reminder:2}),/replied/);
    const page=(await browser.get('/autopilot/supplier-disputes/'+price.billId).expect(200)).text;
    assert.match(page,/We do not agree, our price went up/);assert.match(page,/always waits for you/);
    await browser.post('/autopilot/supplier-disputes/'+price.billId+'/read').type('form').send({_csrf:csrf(page),confirmed:'yes'}).expect(303);
    assert.equal((await workFor(price.billId)).attention,null);
    await flow.schedule(db,ws);
    assert.equal((await workFor(price.billId)).attention,null,'A read reply does not come back.');
    assert.equal((await bill(price.billId)).status,'DISPUTED','A reply never settles the invoice on its own.');
  });

  await t.test('a credit note for the amount in question settles the dispute once; a smaller one waits',async()=>{
    const partial=await creditArrives(note({number:'CN-PART',original:price.number,total:-30}));
    await flow.schedule(db,ws);
    assert.match((await workFor(price.billId)).attention,/credit note/);
    assert.match((await flow.page(db,ctx,price.billId,{credit:partial})).selectedCredit.hold,/covers \$0\.30 of the \$0\.50 in question/);
    await assert.rejects(flow.settle(db,ctx,price.billId,{sourceId:partial,confirmed:'yes',fingerprint:'x',reason:'Partial'}),/covers/);
    const full=await creditArrives(note({number:'CN-FULL',original:price.number,total:-50}));
    const page=(await browser.get('/autopilot/supplier-disputes/'+price.billId).query({credit:full}).expect(200)).text;
    assert.match(page,/Post invoice and apply credit/);
    const offer=(await flow.page(db,ctx,price.billId,{credit:full})).selectedCredit;
    assert.equal(offer.hold,null);
    const before=Number((await db.query('SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1',[ws])).rows[0].n);
    await browser.post('/autopilot/supplier-disputes/'+price.billId+'/settle-credit').type('form')
      .send({_csrf:csrf(page),sourceId:full,fingerprint:offer.fingerprint,reason:'Supplier credited the price difference',confirmed:'yes'}).expect(303);
    const settled=await bill(price.billId);
    assert(['OPEN','PARTIALLY_PAID'].includes(settled.status),settled.status);assert(settled.journal_entry_id);assert.equal(Number(settled.balance_minor),125);
    assert.deepEqual((await payables()).find(([id])=>id===price.billId),[price.billId,125],'The payment run sees only the agreed amount.');
    assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1',[ws])).rows[0].n),before,'No supplier payment is made.');
    const replay=await flow.settle(db,ctx,price.billId,{sourceId:full,confirmed:'yes',fingerprint:offer.fingerprint,reason:'again'});
    assert.equal(replay.replayed,true);
    assert.equal(Number((await db.query("SELECT count(*) n FROM accounting_supplier_credits WHERE workspace_id=$1 AND lower(credit_number)='cn-full'",[ws])).rows[0].n),1);
    assert.equal(await audits('Supplier invoice dispute settled by credit note'),1);
    assert.match((await browser.get('/autopilot/supplier-disputes/'+price.billId).expect(200)).text,/Settled by credit note/);
    assert.match((await browser.get('/autopilot/reviews/supplier-invoice-disputes').expect(200)).text,/Settled by credit note/);
    assert(!(await inbox()).some(n=>n.href.endsWith(price.billId)));
  });

  await t.test('Custom disputes alone without teaching and holds what is over its limit',async()=>{
    await f.subscribe('enterprise');
    await flow.configure(db,ctx,{revision:await ruleRevision(),stop:'yes'});
    const custom=await newCase(175);
    assert(custom.jobs.some(j=>j.billId===custom.billId&&j.status==='QUEUED'),JSON.stringify(custom.jobs));
    await flow.configure(db,ctx,{revision:await ruleRevision(),confirmed:'yes',maximum:'0.25',reminderDays:3,reminderLimit:2});
    const capped=await newCase(175);
    assert(capped.jobs.some(j=>j.billId===capped.billId&&j.status==='HELD'&&/over your \$0\.25 dispute limit/.test(j.problem)));
    assert.equal((await messages(capped.billId)).length,0);
  });

  await t.test('pages render at desktop and phone width',async()=>{
    const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const chrome=await require('playwright').chromium.launch();
    f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
    const base='http://127.0.0.1:'+server.address().port,path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');
    require('node:fs').mkdirSync(folder,{recursive:true});
    for(const [name,viewport] of [['desktop',{width:1440,height:900}],['phone',{width:390,height:844}]]){
      const page=await chrome.newPage({viewport,...(name==='phone'?{isMobile:true,hasTouch:true}:{})});
      await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
      await page.goto(base+'/autopilot/supplier-disputes/'+taxed.billId);
      assert(await page.getByRole('heading',{name:'Messages to the supplier'}).isVisible());
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' dispute page fits');
      await page.screenshot({path:path.join(folder,'supplier-dispute-follow-up-'+name+'.png'),fullPage:true});
      await page.goto(base+'/autopilot/reviews/supplier-invoice-disputes');
      assert(await page.getByRole('button',{name:'Save dispute limit'}).isVisible());
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' review page fits');
      await page.close();
    }
  });
});

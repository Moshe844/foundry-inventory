'use strict';
process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const service = require('../../src/purchasing/agent-supplier-credit-notes');
const returns = require('../../src/operations/postgres-returns');
const jobModes = require('../../src/autopilot/job-modes');
const reviews = require('../../src/autopilot/job-reviews');
const money = require('../../src/domain/currency');

test('supplier credit notes use exact original amounts and actual posted bill applications on current plans', { timeout:300000 }, async t => {
  const f = await require('../helpers/supplier-invoice-intake-fixture').fixture(t);
  const { db,ctx,workflows } = f;
  const sku = f.item.skuIds[0];
  const code = (await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  let sequence = 0;
  const bill = async (quantity, tax = 0) => {
    const p = await f.po([{ skuId:sku,quantityUnits:quantity,unitCost:'1.25' }]);
    const number = 'BILL-ORIGINAL-'+(++sequence);
    const booked = await workflows.recordSupplierInvoice(db,ctx,{ supplierId:'fixture-supplier',purchaseOrderId:p.purchaseOrderId,
      supplierInvoiceNumber:number,issueDate:f.today,dueDate:f.due,currency:'USD',taxMinor:tax,
      documentTotalMinor:quantity*125+tax,idempotencyKey:randomUUID(),
      lines:[{ purchaseOrderLineId:p.lineIds[0],skuId:sku,description:code,quantity,unitCostMinor:125 }] });
    assert.equal(booked.status,'OPEN');
    return { ...booked, number, p };
  };
  const balance = async id => Number((await db.query('SELECT balance_minor FROM accounting_supplier_bills WHERE id=$1',[id])).rows[0].balance_minor);
  const note = ({ number, original, total, tax=0, returnNumber, date=f.today, currency='USD' }) => [
    'Supplier credit note','Credit note number: '+number,original&&'Original invoice number: '+original,
    returnNumber&&'Supplier return number: '+returnNumber,'Credit note date: '+date,'Currency: '+currency,
    tax!==null&&'Tax: '+money.fromMinor(tax,currency),'Total: '+money.fromMinor(total,currency),
  ].filter(Boolean).join('\n');
  const arrive = async text => {
    const source = await f.arrive(text,{filename:'original-credit-note.txt'});
    await f.runSource();
    const id = await f.intake(source.attachmentId);
    assert(id);
    assert.equal((await f.service.get(db,ctx,id)).status,'CREDIT_REVIEW');
    return { ...source,id };
  };
  const drain = async () => {
    const jobs=[];
    for (;;) {
      const job = await f.queue.processOne(db,f.handlers,{ owner:'credit-note-worker',kinds:[service.KIND] });
      if (!job) return jobs;
      assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
      jobs.push(job.result);
    }
  };
  const preview = async (id,input={}) => (await service.page(db,ctx,{id,...input})).selected;
  const approve = (id, p, extra={}) => service.approve(db,ctx,id,{ fingerprint:p.facts.fingerprint,
    confirmed:'yes',reason:'Confirmed the exact original credit memo and invoice balance',...extra });
  const journal = async id => Object.fromEntries((await db.query(`SELECT a.system_key,sum(l.debit_minor-l.credit_minor)::int amount
    FROM accounting_journal_lines l JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
    WHERE l.workspace_id=$1 AND l.entry_id=$2 GROUP BY a.system_key`,[ctx.workspaceId,id])).rows.map(x=>[x.system_key,x.amount]));
  const creditCount = async number => (await db.query('SELECT count(*)::int n FROM accounting_supplier_credits WHERE workspace_id=$1 AND lower(credit_number)=lower($2)',[ctx.workspaceId,number])).rows[0].n;
  const one = await bill(8,200);
  const original = note({number:'CM-EXACT-ONE',original:one.number,total:-360,tax:-60});
  let received;
  await t.test('Starter cannot track credits. Growth receives one read-only suggestion from actual supplier evidence', async () => {
    await f.subscribe('starter');
    received = await arrive(original);
    await assert.rejects(service.page(db,ctx,{id:received.id}),e=>e.code==='entitlement_required');
    await assert.rejects(reviews.run(db,ctx,'supplier-credits'),e=>e.code==='entitlement_required');
    assert.deepEqual(await service.schedule(db,ctx.workspaceId),{queued:0});
    assert.equal((await service.worker(db,ctx.workspaceId,received.id)).skipped,'no_routine_authority');
    await f.subscribe('growth');
    const growth=await reviews.run(db,ctx,'supplier-credits');
    assert.equal(growth.mode,'suggest');assert.equal(growth.rows.length,1);assert.match(growth.rows[0].Suggestion,/CM-EXACT-ONE/);
    assert.equal((await service.page(db,ctx,{id:received.id})).selected,null);
    await assert.rejects(service.approve(db,ctx,received.id,{confirmed:'yes',fingerprint:'0'.repeat(64)}),e=>e.code==='entitlement_required');
    assert.equal(await balance(one.billId),1200);
    assert.equal((await db.query('SELECT 1 FROM stockchief_runtime.agent_supplier_credit_work WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);
  });
  await t.test('Pro explicitly enables untrained checks and applies exact source tax and payable once after approval', async () => {
    await f.subscribe('pro');
    assert.match((await preview(received.id)).hold,/enable routine/);
    await jobModes.save(db,ctx,105,{mode:'routine',revision:0});
    assert.equal((await service.schedule(db,ctx.workspaceId)).queued,1);
    const jobs=await drain();assert.equal(jobs.find(j=>j.id===received.id)?.status,'READY');
    assert.equal(await balance(one.billId),1200);
    const p=await preview(received.id);assert.equal(p.facts.candidate.amount,360);assert.equal(p.facts.candidate.taxMinor,60);
    const results=await Promise.all([approve(received.id,p),approve(received.id,p)]);
    assert.equal(results.filter(x=>x.replayed).length,1);assert.equal(await creditCount('CM-EXACT-ONE'),1);
    const booked=results.find(x=>!x.replayed);assert.equal(await balance(one.billId),840);
    assert.deepEqual(await journal(booked.journalEntryId),{ACCOUNTS_PAYABLE:360,PURCHASE_PRICE_VARIANCE:-300,SALES_TAX_RECOVERABLE:-60});
    const applied=await preview(received.id);assert.equal(applied.facts.status,'APPLIED');assert.equal(applied.facts.postings[0].journalId,booked.journalEntryId);
    const duplicate=await arrive(original);assert.equal((await drain()).find(j=>j.id===duplicate.id)?.status,'DUPLICATE');
    assert.equal((await preview(duplicate.id)).facts.originId,received.id);
    assert.equal(await creditCount('CM-EXACT-ONE'),1);
    const browser=await f.browser.get('/autopilot/supplier-credits/'+received.id).expect(200);assert.match(browser.text,/Fully applied/);assert.match(browser.text,/Posted applications/);
    const report=await require('../../src/autopilot/time-saved').report(db,ctx);
    assert.equal(report.amounts.find(x=>x.currency==='USD').applied,money.format(360,'USD'));
  });
  await t.test('Custom books a partial application and retains the exact remainder for a separately confirmed alternate bill', async () => {
    await f.subscribe('enterprise');
    const target=await bill(1,75), next=await bill(3);
    // An earlier supplier credit reduces the current bill balance below this note.
    const small=await arrive(note({number:'CM-PRIOR',original:target.number,total:125,tax:0}));await drain();await approve(small.id,await preview(small.id));
    const partial=await arrive(note({number:'CM-PARTIAL',original:target.number,total:150,tax:60}));await drain();
    const p=await preview(partial.id);assert.equal(p.facts.candidate.amount,75);assert.equal(p.facts.candidate.taxMinor,30);
    const first=await approve(partial.id,p);assert.equal(first.remainingMinor,75);assert.equal(await balance(target.billId),0);
    const waiting=await preview(partial.id);assert.equal(waiting.facts.remaining,75);assert.match(waiting.facts.problem,/no remaining balance/);
    const alternate=await preview(partial.id,{targetReference:next.number});assert.equal(alternate.facts.candidate.amount,75);assert.equal(alternate.facts.candidate.taxMinor,30);
    await assert.rejects(approve(partial.id,alternate,{targetReference:next.number}),/Confirm the supplier allows/);
    const second=await approve(partial.id,alternate,{targetReference:next.number,confirmAlternate:'yes'});
    assert.equal(second.remainingMinor,0);assert.equal(await balance(next.billId),300);
    const applied=await preview(partial.id);assert.equal(applied.facts.status,'APPLIED');assert.equal(applied.facts.postings.length,2);
    assert.deepEqual(await journal(second.journalEntryId),{ACCOUNTS_PAYABLE:75,PURCHASE_PRICE_VARIANCE:-45,SALES_TAX_RECOVERABLE:-30});
  });
  await t.test('a delayed physical return is visible before its original arrives and uses native return accounting after approval', async () => {
    await f.subscribe('pro');
    const sourceBill=await bill(4,100);
    const requested=await returns.requestSupplierReturn(db,ctx,{supplierId:'fixture-supplier',supplierBillId:sourceBill.billId,
      expectedCreditMinor:125,idempotencyKey:randomUUID(),lines:[{skuId:sku,locationId:f.location.id,quantity:1}]});
    const id=requested.supplierReturnId;
    await returns.authorizeSupplierReturn(db,ctx,id,{idempotencyKey:randomUUID()});
    const shipment=await returns.shipSupplierReturn(db,ctx,id,{idempotencyKey:randomUUID()});
    const shippedCost=shipment.lines.reduce((total,line)=>total+line.costMinor,0);
    const r=await returns.getSupplierReturn(db,ctx.workspaceId,id);
    const missed=await reviews.run(db,ctx,'supplier-credits',{filter:r.return_number});
    assert.equal(missed.rows[0].Status,'Awaiting credit');assert.equal(missed.rows[0].link,'/supplier-returns/'+id);
    const source=await arrive(note({number:'CM-RETURN',original:sourceBill.number,total:150,tax:25,returnNumber:r.return_number}));
    assert.equal((await drain()).find(j=>j.id===source.id)?.status,'READY');
    const p=await preview(source.id);assert.equal(p.facts.candidate.returnId,id);
    await assert.rejects(approve(source.id,p),/difference from the expected/);
    const booked=await approve(source.id,p,{confirmVariance:'yes'});
    assert.equal((await returns.getSupplierReturn(db,ctx.workspaceId,id)).status,'CREDIT_MISMATCH');
    assert.equal(await balance(sourceBill.billId),450);
    assert.equal(p.facts.candidate.returnCost,shippedCost);
    const expected={ACCOUNTS_PAYABLE:150,SALES_TAX_RECOVERABLE:-25,SUPPLIER_CREDITS_RECEIVABLE:-shippedCost};
    if(shippedCost!==125)expected.PURCHASE_PRICE_VARIANCE=shippedCost-125;
    assert.deepEqual(await journal(booked.journalEntryId),expected);
    assert.equal((await preview(source.id)).facts.status,'APPLIED');
  });
  await t.test('a shipped return can clear its full recorded receivable across separately approved same-supplier bills', async () => {
    const target=await bill(1,25), alternate=await bill(4);
    const prior=await arrive(note({number:'CM-SPLIT-PRIOR',original:target.number,total:100}));
    await drain();await approve(prior.id,await preview(prior.id));
    const {supplierReturnId:id}=await returns.requestSupplierReturn(db,ctx,{supplierId:'fixture-supplier',supplierBillId:target.billId,
      expectedCreditMinor:150,idempotencyKey:randomUUID(),lines:[{skuId:sku,locationId:f.location.id,quantity:1}]});
    await returns.authorizeSupplierReturn(db,ctx,id,{idempotencyKey:randomUUID()});
    const shipment=await returns.shipSupplierReturn(db,ctx,id,{idempotencyKey:randomUUID()});
    const cost=shipment.lines.reduce((sum,line)=>sum+line.costMinor,0);
    const {return_number:returnNumber}=await returns.getSupplierReturn(db,ctx.workspaceId,id);
    const source=await arrive(note({number:'CM-SPLIT-RETURN',original:target.number,total:150,tax:25,returnNumber}));
    assert.equal((await drain()).find(job=>job.id===source.id).status,'READY');
    const first=await approve(source.id,await preview(source.id));
    assert.equal(first.amountMinor,50);assert.equal(first.remainingMinor,100);assert.equal(await balance(target.billId),0);
    let physical=await returns.getSupplierReturn(db,ctx.workspaceId,id);
    assert.equal(physical.status,'AWAITING_CREDIT');assert.equal(Number(physical.actual_credit_minor),50);
    assert.equal(physical.trackedCredit.intake_id,source.id);
    await assert.rejects(returns.reconcileSupplierReturn(db,ctx,id,{amountMinor:100,creditNumber:'CM-MANUAL-ATTEMPT',
      idempotencyKey:randomUUID()}),/Part of this return credit is already recorded/);
    const waiting=await preview(source.id);assert.equal(waiting.facts.remaining,100);assert.equal(waiting.facts.returnId,id);
    const input={targetReference:alternate.number};
    const compare=await preview(source.id,input);
    assert.equal(compare.facts.candidate.amount,100);
    await assert.rejects(approve(source.id,compare,input),/Confirm the supplier allows/);
    const path='/autopilot/supplier-credits/'+source.id;
    const html=(await f.browser.get(path).query(input).expect(200)).text;
    assert.match(html,/Other open bills in USD from this supplier/);
    const form=html.slice(html.indexOf('action="'+path+'/approve"'));
    const idempotencyKey=/name="idempotencyKey" value="(form-[a-f0-9-]+)"/.exec(form)[1];
    const body={_csrf:f.csrf(html),idempotencyKey,fingerprint:compare.facts.fingerprint,confirmed:'yes',confirmAlternate:'yes',
      reason:'Verified the supplier permits use on this bill',...input};
    await f.browser.post(path+'/approve').type('form').send(body).expect(303);
    await f.browser.post(path+'/approve').type('form').send(body).expect(303);
    assert.equal(await creditCount('CM-SPLIT-RETURN'),2);
    const second=await service.approve(db,ctx,source.id,body);
    assert.equal(second.replayed,true);
    physical=await returns.getSupplierReturn(db,ctx.workspaceId,id);
    assert.equal(physical.status,'RECONCILED');assert.equal(Number(physical.actual_credit_minor),150);
    assert.equal(physical.supplier_credit_id,second.supplierCreditId);assert.equal(await balance(alternate.billId),400);
    const a=await journal(first.journalEntryId),b=await journal(second.journalEntryId);
    assert.equal(a.SUPPLIER_CREDITS_RECEIVABLE+b.SUPPLIER_CREDITS_RECEIVABLE,-cost);
    assert.equal(a.SALES_TAX_RECOVERABLE+b.SALES_TAX_RECOVERABLE,-25);
    const dates=(await db.query(`SELECT c.credit_date,j.posting_date FROM accounting_supplier_credits c
      JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id WHERE c.id=$1`,[second.supplierCreditId])).rows[0];
    assert.deepEqual(dates,{credit_date:f.today,posting_date:f.today});
    assert.equal((await preview(source.id)).facts.postings.length,2);
    const program={supplier_id:'fixture-supplier',currency:'USD',scope:{allProducts:true,products:[]}};
    const originals=[{id:target.billId,credit_count:3,return_count:1,source_skus:[sku],net_minor:'125',quantity:'1'},
      {id:alternate.billId,credit_count:1,return_count:0,source_skus:[sku],net_minor:'500',quantity:'4'}];
    const adj=await require('../../src/purchasing/supplier-benefit-return-adjustments').adjustments(db,ctx,program,originals,f.today);
    assert.equal(adj.get(target.billId).netMinor,'125');assert.equal(adj.get(target.billId).quantityScaled,'1000000');
    assert.deepEqual(adj.get(target.billId).reasons,['A supplier credit needs its purchase adjustment or rebate recovery classified']);
    assert.equal(adj.get(alternate.billId).netMinor,'0');assert.deepEqual(adj.get(alternate.billId).reasons,[]);
  });
  await t.test('stale balance, current pause and downgrade prevent a queued or approved credit from booking', async () => {
    const target=await bill(6), n=await arrive(note({number:'CM-STOP',original:target.number,total:200}));await drain();
    const p=await preview(n.id);
    const other=await arrive(note({number:'CM-OTHER',original:target.number,total:125}));await drain();await approve(other.id,await preview(other.id));
    await assert.rejects(approve(n.id,p),/balance changed/);
    const fresh=await preview(n.id);
    const queued=await arrive(note({number:'CM-QUEUED',original:target.number,total:200}));
    await f.subscribe('growth');
    assert.equal((await drain()).find(j=>j.skipped)?.skipped,'no_current_authority');
    await assert.rejects(approve(n.id,fresh),e=>e.code==='entitlement_required');
    assert.equal(await creditCount('CM-QUEUED'),0);
    await f.subscribe('pro');
    await jobModes.save(db,ctx,105,{mode:'watch',revision:1});
    await assert.rejects(approve(n.id,fresh),/Watch only/);
    assert.equal(await creditCount('CM-STOP'),0);assert.equal(await balance(target.billId),625);
    await jobModes.save(db,ctx,105,{mode:'routine',revision:2});
    assert.equal((await service.worker(db,ctx.workspaceId,queued.id)).status,'READY');
  });
  await t.test('the legacy manual return path remains available on Starter and the same original links to its existing application later', async () => {
    await f.subscribe('starter');
    const target=await bill(4),requested=await returns.requestSupplierReturn(db,ctx,{supplierId:'fixture-supplier',supplierBillId:target.billId,
      expectedCreditMinor:125,idempotencyKey:randomUUID(),lines:[{skuId:sku,locationId:f.location.id,quantity:1}]});
    const id=requested.supplierReturnId;
    await returns.authorizeSupplierReturn(db,ctx,id,{idempotencyKey:randomUUID()});
    await returns.shipSupplierReturn(db,ctx,id,{idempotencyKey:randomUUID()});
    const posted=await returns.reconcileSupplierReturn(db,ctx,id,{creditNumber:'CM-LEGACY',creditDate:f.today,amountMinor:125,idempotencyKey:randomUUID()});
    assert.equal(posted.status,'RECONCILED');assert.equal(await balance(target.billId),375);
    const r=await returns.getSupplierReturn(db,ctx.workspaceId,id),source=await arrive(note({number:'CM-LEGACY',original:target.number,total:125,returnNumber:r.return_number}));
    await drain();await f.subscribe('pro');
    const matched=await service.worker(db,ctx.workspaceId,source.id);
    assert.equal(matched.status,'APPLIED');const facts=(await preview(source.id)).facts;
    assert.equal(facts.postings[0].id,posted.supplierCreditId);assert.equal(await creditCount('CM-LEGACY'),1);
  });
  await t.test('duplicate numbers with different amounts, foreign currency and unknown original bills remain held', async () => {
    const target=await bill(4),n=await arrive(note({number:'CM-CONFLICT',original:target.number,total:125}));await drain();
    const p=await preview(n.id);assert.equal(p.facts.status,'READY');
    const other=await arrive(note({number:'CM-CONFLICT',original:target.number,total:126}));await drain();
    assert.equal((await preview(other.id)).facts.status,'CONFLICT');assert.equal((await preview(n.id)).facts.status,'CONFLICT');
    await assert.rejects(approve(n.id,p),/changed/);assert.equal(await creditCount('CM-CONFLICT'),0);
    const foreign=await arrive(note({number:'CM-EUR',original:target.number,total:125,currency:'EUR'}));await drain();
    assert.match((await preview(foreign.id)).facts.problem,/different currency/);
    const absent=await arrive(note({number:'CM-NO-REF',total:25}));await drain();
    assert.match((await preview(absent.id)).facts.problem,/exact original posted/);
    const linked=await preview(absent.id,{originalReference:target.number});assert.equal(linked.facts.status,'READY');
    const finished=await approve(absent.id,linked,{originalReference:target.number});assert.equal(finished.amountMinor,25);
    assert.equal((await preview(absent.id)).facts.status,'APPLIED');
  });
  assert.equal((await db.query('SELECT 1 FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rowCount,0);
});

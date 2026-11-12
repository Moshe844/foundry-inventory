'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 49: a freight, duty or fee bill posted for a recorded delivery updates the
// delivered goods' cost. Starter and Growth are locked. Pro drafts until the owner
// approves one bill of a kind (same supplier or carrier and cost type) and saves a
// limit; Custom needs only the limit. Over the limit, bills not matched to one
// delivery, unclear cost types, other currencies and goods already sold wait.
async function setup(t){
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1}),{db,ctx,workflows}=f,ws=ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');
  const bills=require('../../src/accounting/agent-landed-cost-bills'),queue=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const carrier=(await commerce.createSupplier(db,ctx,{name:'Harbor Freight Lines',currency:'USD'})).id;
  let n=0;
  // One recorded delivery: 2 units at $1.00 and 1 unit at $3.00.
  async function delivery({sku=null}={}){
    const tag=++n;
    const a=sku||(await catalog.createItem(db,ctx,{name:'Landed bill A'+tag,baseCode:'LB-A-'+tag,trackingMode:'quantity'})).skuIds[0];
    const b=(await catalog.createItem(db,ctx,{name:'Landed bill B'+tag,baseCode:'LB-B-'+tag,trackingMode:'quantity'})).skuIds[0];
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),
      lines:[{skuId:a,quantityUnits:2,unitCost:1},{skuId:b,quantityUnits:1,unitCost:3}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    const receipt=await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'DELIVERY-'+tag,
      lines:[{lineId:po.lineIds[0],quantity:2,locationId:f.location.id},{lineId:po.lineIds[1],quantity:1,locationId:f.location.id}]});
    return {receiptId:receipt.receiptId,skus:[a,b],purchaseOrderId:po.purchaseOrderId};
  }
  const work=async()=>{const done=[];for(;;){const next=await queue.processOne(db,handlers,{owner:'landed-bill-worker',kinds:[bills.kind]});
    if(!next)return done;assert.equal(next.status,'COMPLETED',JSON.stringify(next.lastError));done.push(next.result);}};
  async function bill({receiptId=null,amount=101,description='Inbound freight',kind=null,supplierId=carrier,process=true}={}){
    const posted=await workflows.recordSupplierInvoice(db,ctx,{supplierId,supplierInvoiceNumber:'LB-'+randomUUID().slice(0,8),currency:'USD',
      purchaseReceiptId:receiptId,idempotencyKey:randomUUID(),lines:[{description,quantity:1,unitCostMinor:amount,...(kind?{landedCostKind:kind}:{})}]});
    assert.equal(posted.status,'OPEN');
    if(process)await work();
    return (await db.query('SELECT id FROM accounting_supplier_bill_lines WHERE workspace_id=$1 AND bill_id=$2',[ws,posted.billId])).rows[0].id;
  }
  const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_landed_cost_bills WHERE workspace_id=$1 AND bill_line_id=$2',[ws,id])).rows[0];
  const value=async skus=>Number((await db.query('SELECT coalesce(sum(total_cost_minor),0) n FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[ws,skus])).rows[0].n);
  const payable=async()=>Number((await db.query('SELECT coalesce(sum(balance_minor),0) n FROM accounting_supplier_bills WHERE workspace_id=$1',[ws])).rows[0].n);
  const audited=async()=>Object.fromEntries((await db.query(`SELECT action,count(*)::int n FROM security_event_history WHERE workspace_id=$1
    AND action LIKE 'Delivery cost%' GROUP BY action`,[ws])).rows.map(r=>[r.action,r.n]));
  return {...f,ws,bills,work,bill,row,value,payable,audited,delivery,carrier,commerce,
    autopilot:require('../../src/autopilot/postgres-service'),modes:require('../../src/autopilot/job-modes')};
}

test('Pro drafts delivery cost bills until taught, then posts them on its own within the owner limit',{timeout:600000},async t=>{
  const s=await setup(t),{db,ctx,ws,bills,work,bill,row,value,payable,audited,delivery,carrier,autopilot,modes,browser,subscribe}=s;

  // Starter and Growth: the job is not on the plan. Nothing is allocated and the page shows the plan lock.
  const D1=await delivery(),early=[];
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    const id=await bill({receiptId:D1.receiptId,amount:101});
    early.push(id);
    assert.equal(await row(id),undefined,tier+' never allocates delivery costs');
    assert.match((await browser.get(bills.path).expect(200)).text,/data-agent-plan-locked[\s\S]*Pro/);
    await assert.rejects(bills.approve(db,ctx,id,{confirmed:'yes'}),e=>e.code==='entitlement_required');
    assert.deepEqual(await bills.inbox(db,ws),[]);
  }
  assert.equal(await value(D1.skus),500);

  // Pro before teaching: the routine cycle picks up bills posted before the plan and drafts each one.
  await subscribe('pro');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.deepEqual(await bills.schedule(db,ws,'cycle-pro'),{queued:true});
  await work();
  for(const id of early){
    const r=await row(id);
    assert.equal(r.status,'REVIEW');assert.equal(r.category,'freight');assert.equal(r.method,'quantity');assert(r.document_id);
    assert.match(r.reason,/Approve one freight bill from Harbor Freight Lines yourself/);
  }
  assert.equal(await value(D1.skus),500,'Pro does nothing alone before it is taught');
  assert.equal((await bills.inbox(db,ws)).length,2);
  assert((await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='landed-cost-bill:'+early[0]),'the bill shows in Needs you');
  await assert.rejects(bills.configure(db,ctx,early[0],{maximum:'2.00',method:'quantity',confirmed:'yes',revision:0}),
    /Approve one freight bill from Harbor Freight Lines yourself first/);

  // The owner approves one on the page. Stock value moves; quantities and supplier balances do not.
  const ap=await payable(),units=await s.balance();
  const detail=await browser.get(bills.path+'/'+early[0]).expect(200);
  assert.match(detail.text,/\+\$0\.67/);assert.match(detail.text,/\+\$0\.34/);
  const fingerprint=/name="fingerprint" value="([^"]+)"/.exec(detail.text)[1];
  await browser.post(bills.path+'/'+early[0]+'/approve').type('form').send({_csrf:s.csrf(detail.text),fingerprint,confirmed:'yes'}).expect(303);
  let r=await row(early[0]);
  assert.equal(r.status,'POSTED');assert.equal(r.automatic,false);assert.equal(r.decided_by,ctx.actorId);
  assert.equal(await value(D1.skus),601);assert.equal(await payable(),ap);assert.equal(await s.balance(),units);
  assert.deepEqual(await bills.approve(db,ctx,early[0],{confirmed:'yes',fingerprint}),{replayed:true});

  // Teaching: a $2.00 limit for freight from this carrier. The other waiting bill then posts on its own.
  assert.deepEqual(await bills.configure(db,ctx,early[0],{maximum:'2.00',method:'quantity',confirmed:'yes',revision:0}),{saved:true});
  await work();
  r=await row(early[1]);
  assert.equal(r.status,'POSTED');assert.equal(r.automatic,true);assert.equal(await value(D1.skus),702);

  // A new delivery's bill within the limit posts on its own through the ledger, once.
  const D2=await delivery();
  const L2=await bill({receiptId:D2.receiptId,amount:150,description:'Ocean freight'});
  r=await row(L2);
  assert.equal(r.status,'POSTED');assert.equal(r.automatic,true);assert.equal(await value(D2.skus),650);
  const doc=(await db.query('SELECT * FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2',[ws,r.document_id])).rows[0];
  assert.equal(doc.status,'APPLIED');assert.equal(doc.applied_automatically,true);
  assert.equal((await db.query(`SELECT sum(l.debit_minor-l.credit_minor)::int n FROM accounting_journal_lines l JOIN accounting_accounts a
    ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND l.entry_id=$2 AND a.system_key='INVENTORY_ASSET'`,
  [ws,doc.applied_journal_entry_id])).rows[0].n,150);
  assert.deepEqual(await bills.run({workspaceId:ws,payload:{billId:r.bill_id}},db),{posted:0,review:0,held:0,watching:0},'a replay changes nothing');
  assert.equal(await value(D2.skus),650);

  // Over the limit waits. Another cost type from the same carrier needs its own teaching.
  const L3=await bill({receiptId:D2.receiptId,amount:250});
  r=await row(L3);
  assert.equal(r.status,'REVIEW');assert.equal(r.would_post,false);assert.match(r.reason,/over your \$2\.00 limit for freight bills from Harbor Freight Lines/);
  const L4=await bill({receiptId:D2.receiptId,amount:90,description:'Import duty'});
  r=await row(L4);
  assert.equal(r.status,'REVIEW');assert.equal(r.category,'duty');assert.equal(r.method,'value');assert.match(r.reason,/Approve one duty bill/);

  // Ask me first, pause and shadow stop it posting; it shows it would have.
  await modes.save(db,ctx,49,{mode:'ask',revision:0});
  const L5=await bill({receiptId:D2.receiptId,amount:100});
  r=await row(L5);
  assert.equal(r.status,'REVIEW');assert.equal(r.would_post,true);assert.match(r.reason,/Ask me first/);
  await modes.save(db,ctx,49,{mode:'inherit',revision:1});
  assert.deepEqual(await bills.schedule(db,ws,'cycle-1'),{queued:true});await work();
  assert.equal((await row(L5)).status,'POSTED');
  assert.equal((await row(L3)).status,'REVIEW','still over the limit');

  await autopilot.pause(db,ctx,{role:'owner'},'Checking delivery costs');
  const L6=await bill({receiptId:D2.receiptId,amount:120});
  r=await row(L6);
  assert.equal(r.status,'REVIEW');assert.equal(r.would_post,true);assert.match(r.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await bills.schedule(db,ws,'cycle-2');await work();
  assert.equal((await row(L6)).status,'POSTED');

  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[s.owner.accountId]);
  const L7=await bill({receiptId:D2.receiptId,amount:110});
  r=await row(L7);
  assert.equal(r.status,'WATCHING');assert.equal(r.document_id,null);assert.equal(r.would_post,true);assert.match(r.reason,/first 14 days/);
  await assert.rejects(bills.approve(db,ctx,L3,{confirmed:'yes'}),/first 14 days/);
  assert.deepEqual(await bills.schedule(db,ws,'cycle-3'),{queued:false});
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[s.owner.accountId]);
  await bills.schedule(db,ws,'cycle-4');await work();
  r=await row(L7);
  assert.equal(r.status,'POSTED');assert.equal(r.automatic,true);

  // Watch only records what it would do and blocks even a person's approval here.
  await modes.save(db,ctx,49,{mode:'watch',revision:2});
  const L8=await bill({receiptId:D2.receiptId,amount:105});
  r=await row(L8);
  assert.equal(r.status,'WATCHING');assert.match(r.reason,/Watch only/);
  await assert.rejects(bills.approve(db,ctx,L3,{confirmed:'yes'}),/Watch only/);
  await modes.save(db,ctx,49,{mode:'inherit',revision:3});
  await bills.schedule(db,ws,'cycle-5');await work();
  assert.equal((await row(L8)).status,'POSTED');
  assert.equal(await value(D2.skus),500+150+100+120+110+105);

  // Undo posts the reversing entry, once.
  const before=await value(D2.skus);
  await assert.rejects(bills.undo(db,ctx,L2,{}),/Confirm/);
  assert.deepEqual(await bills.undo(db,ctx,L2,{confirmed:'yes'}),{undone:true});
  assert.deepEqual(await bills.undo(db,ctx,L2,{confirmed:'yes'}),{replayed:true});
  assert.equal(await value(D2.skus),before-150);
  const reversed=(await db.query('SELECT status,reversal_journal_entry_id FROM landed_cost_documents WHERE workspace_id=$1 AND id=$2',[ws,(await row(L2)).document_id])).rows[0];
  assert.equal(reversed.status,'REVERSED');assert(reversed.reversal_journal_entry_id);
  assert.equal((await row(L2)).status,'UNDONE');

  // A freight bill that names no delivery waits for a person.
  const U=await bill({amount:95,kind:'freight',description:'Harbor invoice 4471'});
  r=await row(U);
  assert.equal(r.status,'HELD');assert.match(r.reason,/does not say which delivery/);

  const actions=await audited();
  assert.equal(actions['Delivery cost posted to stock on its own'],6);
  assert.equal(actions['Delivery cost taken back out of stock'],1);
  assert.equal(actions['Delivery cost limit saved'],1);

  // The pages at desktop and phone widths; the phone owner approves the duty bill.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));}),chrome=await require('playwright').chromium.launch();
  s.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port,shots=process.env.LANDED_BILL_SHOTS;
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await chrome.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500}),errors=[];
    page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(s.email);await page.locator('[name=password]').fill(s.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const [where,expectText] of [[bills.path,/Delivery cost bills[\s\S]*Waiting for you/],[bills.path+'/'+L4,/How the cost is split/],
      [bills.path+'/'+L5,/What was added to stock cost/],[bills.path+'/'+U,/Choose the delivery, cost type or split/]]){
      await page.goto(origin+where);
      assert.match(await page.locator('main').innerText(),expectText);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scrolling on '+where+' at '+viewport.width);
      if(shots)await page.screenshot({path:require('node:path').join(shots,'landed-bills-'+where.split('/').pop().slice(0,12)+'-'+viewport.width+'.png'),fullPage:true});
    }
    if(viewport.width===390){
      await page.goto(origin+bills.path+'/'+L4);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Add $0.90 to these goods',exact:true}).click()]);
      assert.match(await page.locator('main').innerText(),/The cost was added to the delivered goods/);
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  r=await row(L4);
  assert.equal(r.status,'POSTED');assert.equal(r.automatic,false);

  // A downgrade locks the job at once.
  await subscribe('growth');
  assert.match((await browser.get(bills.path+'/'+L3).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(bills.undo(db,ctx,L5,{confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.deepEqual(await bills.inbox(db,ws),[]);
  assert.equal((await bills.run({workspaceId:ws,payload:{}},db)).skipped,true);
});

test('unmatched, unclear, foreign-currency and sold-goods bills wait for a person; Custom posts within its limit without teaching',{timeout:600000},async t=>{
  const s=await setup(t),{db,ctx,ws,bills,work,bill,row,value,payable,audited,delivery,carrier,commerce,autopilot,browser,subscribe}=s;
  const costs=require('../../src/accounting/postgres-landed-costs');
  await subscribe('enterprise');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const D1=await delivery();

  // A bill marked as freight that names no delivery is held; an ordinary expense is left alone.
  const U=await bill({amount:101,kind:'freight',description:'Freight invoice 4471'});
  let r=await row(U);
  assert.equal(r.status,'HELD');assert.match(r.reason,/does not say which delivery/);
  assert.equal(await row(await bill({amount:500,description:'Outbound shipping to customers'})),undefined);
  await assert.rejects(s.workflows.recordSupplierInvoice(db,ctx,{supplierId:carrier,supplierInvoiceNumber:'LB-BAD',purchaseReceiptId:'not-a-delivery',
    idempotencyKey:randomUUID(),lines:[{description:'Freight',quantity:1,unitCostMinor:100}]}),/delivery is not in this business/);
  await assert.rejects(s.workflows.recordSupplierInvoice(db,ctx,{supplierId:carrier,supplierInvoiceNumber:'LB-BAD-KIND',idempotencyKey:randomUUID(),
    lines:[{description:'Freight',quantity:1,unitCostMinor:100,landedCostKind:'storage'}]}),/freight, duty, insurance or handling/);

  // The owner says which delivery. It then waits for their approval and never posts on its own.
  assert.deepEqual(await bills.choose(db,ctx,U,{receiptId:D1.receiptId,category:'freight',method:'quantity'}),{status:'REVIEW'});
  r=await row(U);
  assert.match(r.reason,/You chose/);assert.equal(r.chosen_by,ctx.actorId);assert.equal(r.would_post,false);
  const chosen=await bills.page(db,ctx,{id:U});
  await bills.approve(db,ctx,U,{confirmed:'yes',fingerprint:chosen.preview.fingerprint});
  assert.equal((await row(U)).status,'POSTED');assert.equal(await value(D1.skus),601);

  // A cost type it cannot read, or two at once, stops and asks.
  const unclear=await bill({receiptId:D1.receiptId,amount:80,description:'Service charge'});
  assert.match((await row(unclear)).reason,/cannot tell if this is freight, duty, insurance or handling/);
  const mixed=await bill({receiptId:D1.receiptId,amount:70,description:'Customs brokerage'});
  assert.equal((await row(mixed)).status,'HELD');

  // A bill in another currency. The ledger cannot post one yet (job 40 adds exchange rates),
  // so a posted bill is switched to EUR here to stand in for one: it stops and asks.
  const eur=await bill({receiptId:D1.receiptId,amount:90,process:false});
  await db.query(`UPDATE accounting_supplier_bills SET currency='EUR' WHERE workspace_id=$1
    AND id=(SELECT bill_id FROM accounting_supplier_bill_lines WHERE workspace_id=$1 AND id=$2)`,[ws,eur]);
  await work();
  r=await row(eur);
  assert.equal(r.status,'HELD');assert.match(r.reason,/This bill is in EUR and your books are in USD\. There is no recorded exchange rate/);

  // Goods partly sold since they arrived: cost of goods sold would change too, so a person decides.
  const sold=await delivery({sku:s.item.skuIds[0]});
  const parcel=await s.parcel();
  await s.shipping.markPacked(db,ctx,parcel.shipmentId);
  await s.shipping.handoff(db,ctx,parcel.shipmentId,{trackingNumber:'LB-SOLD',idempotencyKey:randomUUID()});
  const soldValue=await value(sold.skus),ap=await payable();
  const S=await bill({receiptId:sold.receiptId,amount:101});
  r=await row(S);
  assert.equal(r.status,'HELD');assert.match(r.reason,/sold or moved since they arrived, so their cost of goods sold would change too/);
  assert.equal(r.document_id,null);
  await assert.rejects(bills.keep(db,ctx,S,{}),/Confirm/);
  assert.deepEqual(await bills.keep(db,ctx,S,{confirmed:'yes'}),{kept:true});
  assert.deepEqual(await bills.keep(db,ctx,S,{confirmed:'yes'}),{replayed:true});
  assert.equal((await row(S)).status,'KEPT');assert.equal(await value(sold.skus),soldValue);assert.equal(await payable(),ap+101);

  // Custom: no example needed, only the owner's limit. The waiting bill then posts on its own, split by value.
  const D2=await delivery();
  const C1=await bill({receiptId:D2.receiptId,amount:120});
  r=await row(C1);
  assert.equal(r.status,'REVIEW');assert.match(r.reason,/Save a limit for freight bills from Harbor Freight Lines/);
  assert.deepEqual(await bills.configure(db,ctx,C1,{maximum:'5',method:'value',confirmed:'yes',revision:0}),{saved:true});
  await work();
  r=await row(C1);
  assert.equal(r.status,'POSTED');assert.equal(r.automatic,true);assert.equal(r.method,'value');
  assert.deepEqual((await db.query('SELECT amount_minor::int n FROM landed_cost_allocations WHERE workspace_id=$1 AND document_id=$2 ORDER BY amount_minor',
    [ws,r.document_id])).rows.map(x=>x.n),[48,72]);
  assert.equal(await value(D2.skus),620);
  assert.equal((await db.query("SELECT count(*)::int n FROM landed_cost_documents WHERE workspace_id=$1 AND status='VOID'",[ws])).rows[0].n,1,
    'the earlier quantity draft was set aside, not posted');

  // A split by weight without recorded weights stops and asks.
  const air=(await commerce.createSupplier(db,ctx,{name:'Air Cargo Partners',currency:'USD'})).id;
  const A1=await bill({receiptId:D2.receiptId,amount:60,description:'Air freight',supplierId:air});
  assert.equal((await row(A1)).status,'REVIEW');
  await bills.configure(db,ctx,A1,{maximum:'5',method:'weight',confirmed:'yes',revision:0});
  await work();
  r=await row(A1);
  assert.equal(r.status,'HELD');assert.match(r.reason,/Record the actual unit weight/);assert.equal(r.document_id,null);

  // The owner can ask about every bill of a kind.
  assert.deepEqual(await bills.configure(db,ctx,C1,{stop:'yes',revision:1}),{stopped:true});
  const C2=await bill({receiptId:D2.receiptId,amount:50});
  assert.match((await row(C2)).reason,/You asked to approve every freight bill from Harbor Freight Lines/);

  // The bill form records the delivery and cost type; the routine picks the bill up.
  const form=await browser.get('/accounting/payables/new').expect(200);
  assert.match(form.text,/Delivery this cost is for/);
  await browser.post('/accounting/payables').type('form').send({_csrf:s.csrf(form.text),counterpartyId:carrier,documentNumber:'FORM-INSURANCE-1',
    issueDate:await require('../../src/lib/business-time').today(db,ws),description:'Cargo cover',quantity:'1',unitAmount:'0.75',
    idempotencyKey:randomUUID(),purchaseReceiptId:D2.receiptId,landedCostKind:'insurance'}).expect(303);
  await work();
  const formLine=(await db.query(`SELECT l.id FROM accounting_supplier_bill_lines l JOIN accounting_supplier_bills b ON b.workspace_id=l.workspace_id AND b.id=l.bill_id
    WHERE b.workspace_id=$1 AND b.supplier_invoice_number='FORM-INSURANCE-1'`,[ws])).rows[0].id;
  r=await row(formLine);
  assert.equal(r.status,'REVIEW');assert.equal(r.category,'insurance');assert.equal(r.method,'value');assert.equal(r.receipt_id,D2.receiptId);

  // A held line allocated by hand on the existing form is recognised on the next check.
  await costs.prepareForm(db,ctx,{receipts:[D1.receiptId],expense:mixed,category:'handling',method:'quantity',requestKey:randomUUID()});
  await bills.check(db,ctx);await work();
  r=await row(mixed);
  assert.equal(r.status,'HANDLED');assert.match(r.reason,/Allocated by hand on LC-/);
  assert.equal((await row(unclear)).status,'HELD');assert.equal((await row(eur)).status,'HELD');

  const held=await browser.get(bills.path+'/'+unclear).expect(200);
  assert.match(held.text,/Choose the delivery, cost type or split/);assert.match(held.text,/Keep it as an expense/);
  const actions=await audited();
  assert.equal(actions['Delivery cost kept as an expense'],1);
  assert.equal(actions['Delivery cost details chosen'],1);
  assert.equal(actions['Delivery cost limit saved'],2);
  assert.equal(actions['Delivery cost limit stopped'],1);
});

'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const budgets=require('../../src/purchasing/agent-budgets');
const reviews=require('../../src/autopilot/job-reviews');

test('monthly buying capacity counts a partially billed order once and checks the tier at every entry point',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4});
  const {db,ctx,subscribe,browser,workflows}=f;
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),month=today.slice(0,7);
  const line=(await db.query('SELECT id,purchase_order_id,sku_id FROM purchase_order_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  await db.query('UPDATE purchase_orders SET expected_date=$2 WHERE id=$1',[line.purchase_order_id,today]);
  await workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:line.purchase_order_id,supplierInvoiceNumber:'PARTIAL-BUDGET',
    issueDate:today,dueDate:today,currency:'USD',idempotencyKey:'budget-invoice-1',
    lines:[{purchaseOrderLineId:line.id,skuId:line.sku_id,quantity:2,unitCostMinor:100}]});
  const input={month,category:'',currency:'USD',amount:'10.00',revision:'0'};
  const denied=e=>e.code==='entitlement_required';
  await subscribe('growth');
  const form=await browser.get('/purchasing/budgets').expect(200);
  await browser.post('/purchasing/budgets').type('form').send({...input,_csrf:f.csrf(form.text)}).expect(303);
  await assert.rejects(budgets.save(db,ctx,input),/already exists or changed/);
  await budgets.save(db,ctx,{...input,amount:'3.00',currency:'EUR'});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const actual=await reviews.run(db,ctx,'purchase-budget',{filter:month});
    if(tier==='starter'){
      assert.deepEqual(Object.keys(actual.rows[0]),['Suggestion']);
      await assert.rejects(budgets.save(db,ctx,{...input,revision:1}),denied);
      const locked=await browser.get('/purchasing/budgets').expect(200);
      assert.match(locked.text,/requires the Growth plan/);assert.doesNotMatch(locked.text,/name="amount"/);
    }else{
      const usd=actual.rows.find(r=>r.Currency==='USD');
      assert.equal(usd['Billed purchases'],'$2.00');assert.equal(usd['Budget less actual'],'$8.00');
      assert.equal(usd['Open to buy'],undefined);
    }
    if(tier!=='enterprise'){
      await assert.rejects(reviews.run(db,ctx,'open-to-buy',{scheduled:true}),denied);
      const locked=await browser.get('/autopilot/reviews/open-to-buy').expect(402);
      assert.match(locked.text,/requires the Custom plan/);assert.doesNotMatch(locked.text,/\$6\.00/);
    }else{
      const capacity=await reviews.run(db,ctx,'open-to-buy',{filter:month,scheduled:true});
      const usd=capacity.rows.find(r=>r.Currency==='USD'),eur=capacity.rows.find(r=>r.Currency==='EUR');
      assert.equal(usd['Unbilled commitments'],'$2.00');assert.equal(usd['Open to buy'],'$6.00');assert.equal(eur['Open to buy'],'€3.00');
      assert.match((await browser.get('/autopilot/reviews/open-to-buy').expect(200)).text,/\$6\.00/);
      await budgets.save(db,ctx,{...input,amount:'1.00',revision:1});
      assert.equal((await reviews.run(db,ctx,'open-to-buy')).rows.find(r=>r.Currency==='USD')['Open to buy'],'-$3.00');
    }
  }
  assert.deepEqual((await reviews.run(db,ctx,'open-to-buy',{filter:'2000-01'})).rows,[]);
});

test('monthly budget monitoring uses posted category spend and respects current plan and owner controls',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4});
  const {db,ctx,subscribe,browser,workflows}=f;
  const notices=require('../../src/autopilot/operational-notices');
  const jobModes=require('../../src/autopilot/job-modes');
  const runtime=require('../../src/operations/postgres-runtime-handlers');
  const queue=require('../../src/operations/postgres-job-queue');
  const id=require('node:crypto').randomUUID;
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const month=today.slice(0,7);
  const prior=require('../../src/accounting/customer-money').addDays(month+'-01',-1).slice(0,7);
  const line=(await db.query('SELECT id,purchase_order_id,sku_id FROM purchase_order_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at)
    VALUES($1,$2,'Hardware','{}',now(),now())`,[ctx.workspaceId,f.item.itemId]);
  await subscribe('growth');
  const input={month,category:'Hardware',currency:'USD',amount:'1.00',revision:'0'};
  await budgets.save(db,ctx,input);
  await budgets.save(db,ctx,{...input,currency:'EUR',amount:'0.01'});
  await budgets.save(db,ctx,{...input,month:prior,amount:'0.01'});
  await workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:line.purchase_order_id,
    supplierInvoiceNumber:'MONTHLY-CATEGORY-1',issueDate:today,dueDate:today,currency:'USD',idempotencyKey:id(),
    lines:[{purchaseOrderLineId:line.id,skuId:line.sku_id,quantity:2,unitCostMinor:100}]});
  const refresh=()=>db.transaction(c=>notices.refresh(c,ctx.workspaceId));
  const alert=async()=> (await notices.inbox(db,ctx.workspaceId,ctx.actorId)).find(n=>n.sourceId==='agent-notice-110');
  await db.transaction(c=>runtime.runtimeSweep({payload:{now:Date.now()}},c));
  const processed=await queue.processOne(db,{'autopilot.evaluate':runtime.autopilotEvaluate},{owner:'purchase-budget-check'});
  assert.equal(processed.status,'COMPLETED',JSON.stringify(processed.lastError));
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    await refresh();
    assert.equal((await alert()).href,'/autopilot/reviews/purchase-budget?filter='+month);
    assert.match((await alert()).happened,/^1 category/);
    const report=await reviews.run(db,ctx,'purchase-budget',{filter:month});
    assert.deepEqual(report.rows.map(r=>[r.Currency,r.Category,r['Billed purchases'],r.Status]),[
      ['EUR','hardware','€0.00','Within budget'],['USD','hardware','$2.00','Over budget']]);
    assert.equal((await reviews.run(db,ctx,'purchase-budget',{filter:prior})).rows[0]['Billed purchases'],'$0.00');
  }
  assert.match((await browser.get('/autopilot/reviews/purchase-budget').expect(200)).text,/Over budget/);
  await jobModes.save(db,ctx,110,{mode:'watch',revision:0});
  assert.equal(await alert(),undefined);
  await jobModes.save(db,ctx,110,{mode:'routine',revision:1});
  await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Verify monitoring pause');
  assert.equal(await alert(),undefined);
  await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
  await subscribe('starter');
  assert.equal(await alert(),undefined);
  assert.deepEqual(Object.keys((await reviews.run(db,ctx,'purchase-budget')).rows[0]),['Suggestion']);
  await assert.rejects(reviews.run(db,ctx,'purchase-budget',{scheduled:true}),e=>e.code==='entitlement_required');
  await subscribe('growth');
  await budgets.save(db,ctx,{...input,revision:1,amount:'3.00'});
  await refresh();
  assert.equal(await alert(),undefined);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM accounting_supplier_bills WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});

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
      assert.ok((await browser.get('/purchasing/budgets')).status>=400);
    }else{
      const usd=actual.rows.find(r=>r.Currency==='USD');
      assert.equal(usd['Billed purchases'],'$2.00');assert.equal(usd['Budget less actual'],'$8.00');
      assert.equal(usd['Open to buy'],undefined);
    }
    if(tier!=='enterprise'){
      await assert.rejects(reviews.run(db,ctx,'open-to-buy',{scheduled:true}),denied);
      assert.ok((await browser.get('/autopilot/reviews/open-to-buy')).status>=400);
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

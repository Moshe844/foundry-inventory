'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('document and supplier evidence links render a plan lock before work, while every current paid tier opens them',{timeout:180000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,browser}=f;
  await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  const routes=['/autopilot/contracts','/autopilot/supplier-invoices','/autopilot/supplier-costs'];
  const linked=await browser.get('/autopilot/reviews/contract-readings').expect(303);
  assert.equal(linked.headers.location,routes[0]);
  for(const route of routes){
    const page=await browser.get(route).expect(200);
    assert.match(page.text,/data-agent-plan-locked/);
    assert.match(page.text,/Starter and above/);
    assert.match(page.text,/href="\/settings\/billing"[^>]*>See plans/);
    assert.doesNotMatch(page.text,/name="(?:contract|invoiceFile|supplierItemId)"/);
  }
  const csrf=f.csrf((await browser.get('/autopilot/contracts')).text);
  await browser.post('/autopilot/contracts').set('Accept','application/json').field('_csrf',csrf).field('requestKey',randomUUID())
    .attach('contract',Buffer.from('Supply contract with a documented unit price.'),'locked-contract.txt').expect(402);
  await browser.post('/autopilot/supplier-costs/rates').set('Accept','application/json').type('form').send({_csrf:csrf}).expect(402);
  await browser.post('/autopilot/supplier-invoices/settings').set('Accept','application/json').type('form').send({_csrf:csrf,revision:0,confirmed:'yes'}).expect(402);
  for(const plan of ['starter','growth','pro','enterprise']){
    await f.subscribe(plan);
    for(const route of routes){
      const page=await browser.get(route).expect(200);
      assert.doesNotMatch(page.text,/data-agent-plan-locked/);
    }
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stockchief_runtime.agent_contract_readings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM stockchief_runtime.agent_supplier_invoice_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});

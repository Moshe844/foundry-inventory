
'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-workflow-fixture');
const companions=require('../../src/sales/agent-quote-companions');
const quotes=require('../../src/sales/postgres-quotes');
const pricing=require('../../src/pricing/postgres-service');
const assistant=require('../../src/assistant/postgres-service');
const reviews=require('../../src/autopilot/job-reviews');

test('actual quote companions follow tier authority, shipped evidence and immutable native revisions',{timeout:300000},async t=>{
  const f=await fixture(t,{units:15}),{db,ctx,location,workflows,browser}=f;
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const validUntil=require('../../src/accounting/customer-money').addDays(today,10);
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const customerId='fixture-customer',taxRateId='companion-tax';
  await db.query(`INSERT INTO accounting_tax_rates(id,workspace_id,name,jurisdiction,rate_millionths,applies_to,effective_from,active,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,'Regional sales tax','Fixture',82500,'SALES','2020-01-01',1,$3,$4,$4)`,[taxRateId,ctx.workspaceId,ctx.actorId,new Date().toISOString()]);
  async function product(code,{price=1500,cost='3',precision,increment}={}){
    const skuId=(await catalog.createItem(db,ctx,{name:code,baseCode:code,trackingMode:'quantity',
      ...(precision?{quantityPrecision:precision,quantityIncrement:increment,unitLabel:'m'}:{})})).skuIds[0];
    await receipt.receive(db,ctx,{skuId,locationId:location.id,quantity:15,unitCost:cost,idempotencyKey:randomUUID()});
    await pricing.setPrice(db,ctx,{skuId,amountMinor:price,currency:'USD'});
    return {skuId,sku:code};
  }
  const anchor=await product('ADD-ANCHOR',{price:1000}),add=await product('ADD-PRODUCT'),free=await product('ADD-COSTLESS',{cost:'0'}),
    measured=await product('ADD-MEASURE',{price:600,precision:3,increment:'0.125'});
  async function history(products){
    const order=await workflows.createSalesOrder(db,ctx,{customerId,currency:'USD',deliveryMethod:'PICKUP',
      fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),lines:products.map(p=>({skuId:p.skuId,quantity:1}))});
    await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
    return workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),shipment:{handover:'COLLECTED'},
      lines:order.lineIds.map(lineId=>({lineId,locationId:location.id,quantity:1}))});
  }
  await history([anchor,add,free,measured]);
  await history([anchor,add]);
  const configured=await assistant.prepareAction(db,ctx,'Use the approved customer selling prices.',{action:'pricing.rule.configure',
    pricingDefinition:JSON.stringify({kind:'price_list',name:'Customer companion price',currency:'USD',scope:{customerIds:[customerId]},
      entries:[{skuId:add.skuId,minQuantity:1,unitPriceMinor:1200}]})});
  await assistant.executeProposal(db,ctx,configured.proposal.id);
  const original=(input={})=>quotes.create(db,ctx,{customerId,currency:'USD',taxRateId,orderDate:today,validUntil,deliveryMethod:'PICKUP',
    fulfillmentLocationId:location.id,requestKey:randomUUID(),lines:[{skuId:anchor.skuId,quantity:2}],...input});
  const prepare=(q,lines=[{sku:add.sku,quantity:1}])=>assistant.prepareAction(db,ctx,'Review the exact companion lines.',
    {action:companions.ACTION,recordReference:q.id,companionWarehouse:location.id,companionLines:JSON.stringify(lines)});
  const revisions=async q=>(await db.query('SELECT * FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=$2',
    [ctx.workspaceId,q.id])).rows;
  async function verify(q,result,expected=1200){
    const newer=await quotes.get(db,ctx.workspaceId,result.quoteId);
    assert.equal(newer.status,'OPEN');
    assert.equal(newer.customer_id,customerId);
    assert.equal(newer.supersedes_id,q.id);
    assert.equal(newer.pricing.lines[1].skuId,add.skuId);
    assert.equal(newer.pricing.lines[1].unitPriceMinor,expected);
    assert.equal(newer.pricing.lines[1].taxMinor,Math.round(expected*.0825));
    assert.equal(newer.pricing.totalMinor,q.pricing.totalMinor+expected+Math.round(expected*.0825));
    assert.deepEqual(newer.input.lines[0],q.input.lines[0]);
    assert.deepEqual((await quotes.get(db,ctx.workspaceId,q.id)).pricing,q.pricing);
    assert.equal((await revisions(q)).length,1);
    assert.equal((await companions.retained(db,ctx,q.id)).state,'COMPLETED');
  }

  await t.test('Starter receives one grounded suggestion with no quote write',async()=>{
    await f.subscribe('starter');
    const q=await original(),read=await reviews.run(db,ctx,'bought-together',{filter:anchor.sku});
    assert.deepEqual(Object.keys(read.rows[0]),['Suggestion']);
    assert.match(read.rows[0].Suggestion,/ADD-PRODUCT.*2 shared orders/);
    const page=await browser.get('/quotes/'+q.id+'/companions').expect(200);
    assert.match(page.text,/Consider ADD-PRODUCT/);
    assert.doesNotMatch(page.text,/Prepare quote revision/);
    await assert.rejects(prepare(q),e=>e.code==='entitlement_required');
    assert.equal((await revisions(q)).length,0);
  });

  await t.test('Growth approves one native revision at exact customer price, tax and fractional quantity',async()=>{
    await f.subscribe('growth');
    const q=await original(),page=await browser.get('/quotes/'+q.id+'/companions').expect(200);
    assert.match(page.text,/Prepare quote revision/);
    assert.doesNotMatch(page.text,/Save routine authority/);
    const draft=await prepare(q,[{sku:add.sku,quantity:1},{sku:measured.sku,quantity:'0.25'}]);
    assert.equal(draft.status,'PREPARED',JSON.stringify(draft));
    assert.equal((await revisions(q)).length,0);
    await f.subscribe('starter');
    await assert.rejects(assistant.executeProposal(db,ctx,draft.proposal.id),e=>e.code==='entitlement_required');
    await f.subscribe('growth');
    const {registry}=require('../../src/assistant/postgres-capability-registry');
    await require('../../src/assistant/postgres-capability-plans').save(db,ctx,'Add companions and review products',randomUUID(),
      [{contract:registry.get(companions.ACTION),args:{recordReference:q.id},dependsOn:[]},
       {contract:registry.get('read.agent_review'),args:{agentJob:'bought-together'},dependsOn:[0]}],[{result:draft},{result:{status:'CLARIFY'}}]);
    await assert.rejects(assistant.executeMission(db,ctx,draft.proposal.id),/own confirmation|individual approval/);
    const results=await Promise.all([assistant.executeProposal(db,ctx,draft.proposal.id),assistant.executeProposal(db,ctx,draft.proposal.id)]);
    const [saved]=await revisions(q);
    assert.equal(results[0].result.quoteId,results[1].result.quoteId);
    assert.equal(saved.pricing.lines[1].unitPriceMinor,1200);
    assert.equal(saved.pricing.lines[2].quantity,.25);
    assert.equal(saved.pricing.totalMinor,3626);
    assert.equal(saved.pricing.taxMinor,276);
    assert.equal((await revisions(q)).length,1);
    assert.deepEqual((await quotes.get(db,ctx.workspaceId,q.id)).pricing,q.pricing);
  });

  await t.test('stale prices, duplicate or costless stock, accepted and queued-email quotes hold',async()=>{
    const q=await original(),draft=await prepare(q);
    await pricing.setPrice(db,ctx,{skuId:add.skuId,amountMinor:1550,currency:'USD'});
    await assert.rejects(assistant.executeProposal(db,ctx,draft.proposal.id),/changed/);
    assert.equal((await revisions(q)).length,0);
    await assert.rejects(prepare(q,[{sku:free.sku,quantity:1}]),/zero recorded stock cost/);
    await assert.rejects(prepare(q,[{sku:anchor.sku,quantity:1}]),/distinct companions/);
    const accepted=await original();
    await quotes.decide(db,ctx,accepted.id,{accept:true,expectedHash:accepted.pricing_hash,today});
    await assert.rejects(prepare(accepted),/current open quotation/);
    const sent=await original();
    await db.query(`INSERT INTO customer_communications(id,workspace_id,customer_id,subject,body,status,idempotency_key,created_at,updated_at)
      VALUES($1,$2,$3,'Quote fixture','Pending original message','QUEUED',$4,$5,$5)`,
    [randomUUID(),ctx.workspaceId,customerId,'quotation-email:'+sent.id,new Date().toISOString()]);
    await assert.rejects(prepare(sent),/delivery evidence or a queued email/);
  });

  await t.test('Pro and Custom workers save an authorized private revision with downgrade and replay controls',async()=>{
    await f.subscribe('pro');
    const seed=await original();
    await companions.configuration(db,ctx,seed.id,location.id,{revision:0,confirmed:'yes',anchorSku:anchor.sku,
      companionLines:[{sku:add.sku,quantity:1}],maximum:'14.00'});
    const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
    const worker=()=>jobs.processOne(db,handlers,{owner:'quote-companion-test',kinds:[companions.KIND]});
    const p=await original();
    const physicalAndFinancial=async()=>(await db.query(`SELECT
      (SELECT count(*) FROM movements WHERE workspace_id=$1) movements,
      (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1) journals,
      (SELECT count(*) FROM sales_orders WHERE workspace_id=$1) orders,
      (SELECT count(*) FROM customer_communications WHERE workspace_id=$1) communications`,[ctx.workspaceId])).rows[0];
    const untouched=await physicalAndFinancial();
    assert.equal((await companions.retained(db,ctx,p.id)).state,'QUEUED');
    assert.equal((await revisions(p)).length,0);
    const completed=await worker();
    assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
    const saved=(await companions.retained(db,ctx,p.id)).revision_id;
    await verify(p,{quoteId:saved});
    assert.deepEqual(await physicalAndFinancial(),untouched);
    assert.equal((await companions.run(db,ctx.workspaceId,p.id)).quoteId,saved);

    const pending=await original();
    await f.subscribe('growth');
    await worker();
    assert.equal((await companions.retained(db,ctx,pending.id)).state,'HELD');
    assert.equal((await revisions(pending)).length,0);

    await f.subscribe('enterprise');
    const c=await original();
    await worker();
    await verify(c,{quoteId:(await companions.retained(db,ctx,c.id)).revision_id});
    const duplicate=await original({lines:[{skuId:anchor.skuId,quantity:2},{skuId:add.skuId,quantity:1}]});
    await worker();
    assert.equal((await revisions(duplicate)).length,0);
    assert.match((await companions.retained(db,ctx,duplicate.id)).issue,/already present/);

    const otherSite=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Outside companion scope',kind:'warehouse'});
    const elsewhere=await original({fulfillmentLocationId:otherSite.id});
    assert.equal(await companions.retained(db,ctx,elsewhere.id),undefined);
    const staleScope=await original();
    await companions.configuration(db,ctx,seed.id,location.id,{revision:1,confirmed:'yes',anchorSku:anchor.sku,
      companionLines:[{sku:add.sku,quantity:1}],maximum:'12.00'});
    await worker();
    assert.match((await companions.retained(db,ctx,staleScope.id)).issue,/scope changed/);
    const overCap=await original();
    await worker();
    assert.match((await companions.retained(db,ctx,overCap.id)).issue,/exceeds the owner’s maximum/);
    assert.equal((await revisions(overCap)).length,0);

    await f.subscribe('growth');
    await companions.configuration(db,ctx,seed.id,location.id,{revision:2,stop:'yes'});
    await f.subscribe('pro');
    const stopped=await original();
    assert.equal(await companions.retained(db,ctx,stopped.id),undefined);
  });

  await t.test('a measured companion uses the exact remaining lot weight and its native price per measure',async()=>{
    await f.subscribe('growth');
    const skuId=(await catalog.createItem(db,ctx,{name:'Actual weight companion',baseCode:'ADD-WEIGHED',trackingMode:'lot',
      unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'})).skuIds[0];
    await receipt.receive(db,ctx,{skuId,locationId:location.id,quantity:2,secondaryQuantity:'3.10',lotCode:'WEIGHED-LOT',
      unitCost:'4',idempotencyKey:randomUUID()});
    await pricing.setPrice(db,ctx,{skuId,amountMinor:800,currency:'USD'});
    const order=await workflows.createSalesOrder(db,ctx,{customerId,currency:'USD',deliveryMethod:'PICKUP',
      fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:anchor.skuId,quantity:1},
        {skuId,quantity:1,secondaryQuantity:'1.25'}]});
    await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
    await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),shipment:{handover:'COLLECTED'},
      lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:1},
        {lineId:order.lineIds[1],locationId:location.id,quantity:1,secondaryQuantity:'1.25',lotCode:'WEIGHED-LOT'}]});
    const q=await original();
    await assert.rejects(prepare(q,[{sku:'ADD-WEIGHED',quantity:1,secondaryQuantity:'1.75'}]),/actual weight/);
    const draft=await prepare(q,[{sku:'ADD-WEIGHED',quantity:1}]);
    await assistant.executeProposal(db,ctx,draft.proposal.id);
    const [saved]=await revisions(q);
    assert.equal(saved.input.lines[1].secondaryQuantity,1.85);
    assert.equal(saved.pricing.lines[1].unitPriceMinor,800);
    assert.equal(saved.pricing.lines[1].grossMinor,1480);
    assert.equal(saved.line_units[skuId].price,'kg');
  });

  await t.test('phone form previews and approves the native quote revision',async()=>{
    await f.subscribe('growth');
    const q=await original();
    const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
    const server=await new Promise(r=>{const listening=app.listen(0,'127.0.0.1',()=>r(listening));});
    const chromium=await require('playwright').chromium.launch();
    f.cleanup(async()=>{await chromium.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
    const origin='http://127.0.0.1:'+server.address().port;
    const phone=await chromium.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    phone.setDefaultTimeout(16000);
    await phone.goto(origin+'/login');
    await phone.getByLabel('Work email').fill(f.email);
    await phone.locator('[name=password]').fill(f.password);
    await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await phone.goto(origin+'/quotes/'+q.id);
    await phone.getByRole('link',{name:'Customers also buy',exact:true}).click();
    await phone.getByLabel('Include ADD-PRODUCT',{exact:true}).check();
    await Promise.all([phone.waitForURL('**/actions/*'),phone.getByRole('button',{name:'Prepare quote revision'}).click()]);
    assert.equal((await revisions(q)).length,0);
    assert.match(await phone.locator('main').innerText(),/\$12\.99/);
    await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Approve the quote revision',exact:true}).click()]);
    const [saved]=await revisions(q);
    await verify(q,{quoteId:saved.id});
    await phone.goto(origin+'/quotes/'+q.id);
    await phone.getByRole('link',{name:/Open current revision/}).click();
    assert.match(await phone.locator('main').innerText(),/ADD-PRODUCT/);
    assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  });
});

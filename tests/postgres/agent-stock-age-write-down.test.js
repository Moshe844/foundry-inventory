
'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-workflow-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const receipt=require('../../src/accounting/postgres-stock-receipt');
const reviews=require('../../src/autopilot/job-reviews');
const assistant=require('../../src/assistant/postgres-service');
const writeDown=require('../../src/accounting/agent-inventory-write-downs');

test('recorded stock age and individually approved native valuation use exact quantities and journals',{timeout:300000},async t=>{
  const f=await fixture(t,{units:5}),{db,ctx,location,workflows,browser}=f;
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const old=require('../../src/accounting/customer-money').addDays(today,-210);
  const position=sku=>sku+':'+location.id;
  const age=code=>reviews.run(db,ctx,'stock-age',{filter:code});
  const item=async(code,opts={})=>(await catalog.createItem(db,ctx,{name:code,baseCode:code,trackingMode:'quantity',...opts})).skuIds[0];
  // Noon UTC of the business's today is still in the future before noon UTC,
  // which the receipt rightly refuses; today's receipt happens now instead.
  const receive=(sku,quantity,ageDate=old,extra={})=>receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity,unitCost:'2',
    occurredAt:ageDate===today?new Date().toISOString():ageDate+'T12:00:00Z',idempotencyKey:randomUUID(),...extra});
  const prepare=async(sku,amount,extra={})=>{
    const review=await writeDown.page(db,ctx,position(sku));
    return assistant.prepareAction(db,ctx,'Review the evidenced inventory carrying value.',{
      action:writeDown.ACTION,recordReference:position(sku),amount,reference:'Owner-reviewed resale and selling costs worksheet R-5',
      expectedStockFingerprint:review.fingerprint,...extra
    });
  };
  const values=async sku=>(await db.query(`SELECT b.on_hand::text,b.secondary_on_hand::text,c.quantity_units::text,c.secondary_quantity_units::text,c.total_cost_minor,
    (SELECT count(*) FROM movements m WHERE m.workspace_id=b.workspace_id AND m.sku_id=b.sku_id AND m.location_id=b.location_id) movements
    FROM balances b JOIN accounting_inventory_cost_balances c USING(workspace_id,sku_id,location_id)
    WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=$3`,[ctx.workspaceId,sku,location.id])).rows[0];
  const records=async sku=>(await db.query('SELECT * FROM accounting_inventory_write_downs WHERE workspace_id=$1 AND sku_id=$2 ORDER BY approved_at',
    [ctx.workspaceId,sku])).rows;
  const numeric=v=>Number(v.total_cost_minor);
  async function prove(sku,amount,before,after){
    const [r]=await records(sku);
    assert.equal(r.approved_by,ctx.actorId);
    assert.equal(Number(r.before_value_minor),before);
    assert.equal(Number(r.after_value_minor),after);
    assert(r.snapshot.agedSources.every(s=>s.sourceId&&s.receivedAt));
    const lines=(await db.query(`SELECT a.system_key,l.debit_minor,l.credit_minor,l.sku_id,l.location_id
      FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id
      WHERE l.workspace_id=$1 AND l.entry_id=$2 ORDER BY a.system_key`,[ctx.workspaceId,r.journal_entry_id])).rows;
    assert.deepEqual(lines.map(l=>[l.system_key,Number(l.debit_minor),Number(l.credit_minor)]),
      [['INVENTORY_ASSET',0,amount],['INVENTORY_WRITE_DOWNS',amount,0]]);
    assert(lines.every(l=>l.sku_id===sku&&l.location_id===location.id));
    const delta=(await db.query('SELECT amount_delta_minor,journal_entry_id FROM accounting_inventory_value_adjustments WHERE source_record_id=$1',[r.id])).rows;
    assert.deepEqual(delta.map(x=>[Number(x.amount_delta_minor),x.journal_entry_id]),[[-amount,r.journal_entry_id]]);
  }

  const mixed=await item('AGE-MIXED');
  await receive(mixed,5);
  await receive(mixed,3,today);
  await t.test('Starter sees one grounded suggestion while all three higher tiers inspect both receipt cohorts',async()=>{
    for(const tier of ['starter','growth','pro','enterprise']){
      await f.subscribe(tier);
      const review=await age('AGE-MIXED');
      if(tier==='starter'){
        assert.deepEqual(Object.keys(review.rows[0]),['Suggestion']);
        assert.match(review.rows[0].Suggestion,/5 recorded units received 210 days ago/);
        assert.equal(review.rows.length,1);
        await assert.rejects(prepare(mixed,'9.00'),e=>e.code==='entitlement_required');
        const locked=await browser.get('/autopilot/reviews/stock-age/write-down').query({position:position(mixed)}).expect(200);
        assert.doesNotMatch(locked.text,/Prepare exact write-down/);
      }else{
        assert.deepEqual(review.rows.map(r=>[r.Units,r['Days since receipt']]),[[5,210],[3,0]]);
        assert.equal(review.rows[0]['Position book value'],'$16.00');
        const automatedRead=await reviews.run(db,ctx,'stock-age',{filter:'AGE-MIXED',scheduled:true});
        assert.equal(automatedRead.rows.length,2);
      }
    }
    assert.equal((await records(mixed)).length,0);
  });

  await t.test('Growth approval posts one cost-only write-down and later sale uses the adjusted weighted average',async()=>{
    await f.subscribe('growth');
    const before=await values(mixed),pnlBefore=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId);
    const ready=await prepare(mixed,'8.00');
    assert.equal(ready.status,'PREPARED',JSON.stringify(ready));
    assert.equal(numeric(await values(mixed)),1600);
    const {registry}=require('../../src/assistant/postgres-capability-registry');
    await require('../../src/assistant/postgres-capability-plans').save(db,ctx,'Approve valuation then review stock',randomUUID(),
      [{contract:registry.get(writeDown.ACTION),args:{recordReference:position(mixed),amount:'8.00',reference:'R-5'},dependsOn:[]},
       {contract:registry.get('read.agent_review'),args:{agentJob:'stock-age'},dependsOn:[0]}],[{result:ready},{result:{status:'CLARIFY'}}]);
    await assert.rejects(assistant.executeMission(db,ctx,ready.proposal.id),/own confirmation|individual approval/);
    await assistant.executeProposal(db,ctx,ready.proposal.id);
    await assistant.executeProposal(db,ctx,ready.proposal.id);
    const after=await values(mixed);
    assert.deepEqual({...after,total_cost_minor:before.total_cost_minor},before);
    assert.equal(numeric(after),800);
    assert.equal((await records(mixed)).length,1);
    await prove(mixed,800,1600,800);
    const pnlAfter=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId);
    assert.equal(pnlAfter.stockCountMinor,pnlBefore.stockCountMinor);
    assert.equal(pnlAfter.operatingExpenseMinor,pnlBefore.operatingExpenseMinor+800);
    await assert.rejects(prepare(mixed,'8.00'),/below the current recorded carrying value/);
    const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',
      fulfillmentLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:mixed,quantity:1,unitPriceMinor:500}]});
    await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
    await workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],quantity:1,locationId:location.id}],
      shipment:{handover:'COLLECTED'}});
    assert.equal(numeric(await values(mixed)),700);
    const [unknown]=(await age('AGE-MIXED')).rows;
    assert.equal(unknown['Days since receipt'],null);
    assert.equal(unknown.Units,7);
    await assert.rejects(prepare(mixed,'6.00'),/no old stock with a proven receipt age/);
  });

  await t.test('Pro lot and measured pool holds stale, downgraded, watched and closed proposals',async()=>{
    await f.subscribe('pro');
    const sku=await item('AGE-WEIGHT',{trackingMode:'lot',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'});
    await receive(sku,2,old,{lotCode:'LOT-WEIGHT',lotReceivedAt:old,secondaryQuantity:'2.35'});
    const row=(await age('AGE-WEIGHT')).rows[0];
    assert.equal(row['Lot or serial'],'LOT-WEIGHT');
    assert.equal(row['Actual second measure'],'2.35 kg');
    const review=await writeDown.page(db,ctx,position(sku));
    const stale=await prepare(sku,'3.00');
    await receive(sku,1,today,{lotCode:'LOT-FRESH',secondaryQuantity:'1.10'});
    await assert.rejects(prepare(sku,'3.00',{expectedStockFingerprint:review.fingerprint}),/changed/);
    await assert.rejects(assistant.executeProposal(db,ctx,stale.proposal.id),/changed/);
    const exact=await prepare(sku,'3.00');
    await f.subscribe('starter');
    await assert.rejects(assistant.executeProposal(db,ctx,exact.proposal.id),e=>e.code==='entitlement_required');
    await f.subscribe('pro');
    await require('../../src/autopilot/job-modes').save(db,ctx,17,{mode:'watch',revision:0});
    await assert.rejects(assistant.executeProposal(db,ctx,exact.proposal.id),/Watch only/);
    await require('../../src/autopilot/job-modes').save(db,ctx,17,{mode:'inherit',revision:1});
    await db.query("UPDATE accounting_periods SET status='CLOSED' WHERE workspace_id=$1 AND starts_on<=$2 AND ends_on>=$2",[ctx.workspaceId,today]);
    await assert.rejects(assistant.executeProposal(db,ctx,exact.proposal.id),/closed/);
    await db.query("UPDATE accounting_periods SET status='OPEN' WHERE workspace_id=$1 AND starts_on<=$2 AND ends_on>=$2",[ctx.workspaceId,today]);
    const before=await values(sku);
    await assistant.executeProposal(db,ctx,exact.proposal.id);
    const after=await values(sku);
    assert.equal(Number(after.secondary_on_hand),3.45);
    assert.deepEqual({...after,total_cost_minor:before.total_cost_minor},before);
    await prove(sku,390,690,300);
  });

  await t.test('Custom preserves serial identities and a deliberate zero valuation',async()=>{
    await f.subscribe('enterprise');
    const sku=await item('AGE-SERIAL',{trackingMode:'serial'});
    await receive(sku,2,old,{serials:['AGE-SN1','AGE-SN2']});
    const review=await age('AGE-SERIAL');
    assert.deepEqual(review.rows.map(r=>r['Lot or serial']),['AGE-SN1','AGE-SN2']);
    const serials=async()=>(await db.query('SELECT * FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 ORDER BY serial',[ctx.workspaceId,sku])).rows;
    const before=await serials(),p=await prepare(sku,'0');
    await assistant.executeProposal(db,ctx,p.proposal.id);
    assert.deepEqual(await serials(),before);
    assert.equal(numeric(await values(sku)),0);
    await prove(sku,400,400,0);
  });

  await t.test('starting stock with an old posting date has no proven receipt age',async()=>{
    const sku=await item('AGE-OPENING');
    await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:sku,locationId:location.id,
      quantity:2,unitCost:'2',occurredAt:old+'T12:00:00Z',idempotencyKey:randomUUID()});
    const [row]=(await age('AGE-OPENING')).rows;
    assert.equal(row['Days since receipt'],null);
    assert.equal(row.Units,2);
    assert.equal(row.linkLabel,undefined);
    await assert.rejects(prepare(sku,'1.00'),/no old stock with a proven receipt age/);
  });

  await t.test('received inter-warehouse transfers preserve proven origin age and hold mixed untracked origins',async()=>{
    await f.subscribe('pro');
    const transfer=require('../../src/transfers/postgres-transfer-service');
    const destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Age transfer destination',kind:'warehouse'});
    const sku=await item('AGE-TRANSFER');
    await receive(sku,4);
    async function move(quantity){
      const request=await transfer.request(db,ctx,{fromLocationId:location.id,toLocationId:destination.id,
        expectedArrivalDate:today,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity}]});
      await transfer.approve(db,ctx,request.id,{idempotencyKey:randomUUID()});
      await transfer.pick(db,ctx,request.id,{idempotencyKey:randomUUID()});
      await transfer.dispatch(db,ctx,request.id,{idempotencyKey:randomUUID()});
      await transfer.markInTransit(db,ctx,request.id,{idempotencyKey:randomUUID()});
      const line=(await transfer.get(db,ctx.workspaceId,request.id)).lines[0];
      await transfer.receive(db,ctx,request.id,{idempotencyKey:randomUUID(),lines:[{lineId:line.id,received:quantity,lost:0,damaged:0}]});
    }
    const receivedRows=async()=>(await age('AGE-TRANSFER')).rows.filter(r=>r.Location===destination.name);
    await move(2);
    assert.deepEqual((await receivedRows()).map(r=>[r.Units,r['Days since receipt'],r['Age evidence']]),[[2,210,'Recorded transfer origin']]);
    await receive(sku,1,today);
    await move(1);
    assert.deepEqual((await receivedRows()).map(r=>[r.Units,r['Days since receipt']]),[[2,210],[1,null]]);
  });

  await t.test('phone forms prepare and separately approve the exact fractional stock write-down',async()=>{
    await f.subscribe('pro');
    const sku=await item('AGE-FRACTION',{unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'});
    await receive(sku,'2.5');
    const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
    const server=await new Promise(r=>{const listening=app.listen(0,'127.0.0.1',()=>r(listening));});
    const browser=await require('playwright').chromium.launch();
    f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
    const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    const origin='http://127.0.0.1:'+server.address().port;
    page.setDefaultTimeout(16000);
    await page.goto(origin+'/login');
    await page.getByLabel('Work email').fill(f.email);
    await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+'/autopilot/reviews/stock-age?filter=AGE-FRACTION');
    await page.getByRole('link',{name:'Review write-down',exact:true}).click();
    assert.match(await page.locator('main').innerText(),/2\.5 m/);
    await page.getByLabel('Net recoverable value in USD').fill('3.25');
    await page.getByLabel('Valuation evidence').fill('Reviewed price and costs worksheet F-30');
    await page.getByLabel('My evidence covers this whole product and location.').check();
    await Promise.all([page.waitForURL('**/actions/*'),page.getByRole('button',{name:'Prepare exact write-down'}).click()]);
    assert.equal(numeric(await values(sku)),500);
    assert.match(await page.locator('main').innerText(),/\$1\.75/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve this write-down',exact:true}).click()]);
    assert.equal(numeric(await values(sku)),325);
    assert.equal(Number((await values(sku)).on_hand),2.5);
    await prove(sku,175,500,325);
  });
});

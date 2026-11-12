'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 135: Starter and Growth are locked, Pro drafts until the owner approves one
// change from a supplier and saves a limit, Custom updates alone. Over 5% always
// waits for a person, and only exact supplier, product and unit matches change a cost.
test('supplier price lists update exact supplier costs on each plan and ask over 5%',{timeout:600000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');
  const lists=require('../../src/purchasing/agent-supplier-price-lists'),costs=require('../../src/pricing/agent-supplier-price-updates');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const prices=require('../../src/pricing/postgres-service'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const reviews=require('../../src/autopilot/job-reviews');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await subscribe('pro');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const main='fixture-supplier';
  const link=async(skuId,supplierSku,purchaseUnit,units,cost,supplierId=main)=>(await commerce.linkSupplierItem(db,ctx,
    {skuId,supplierId,supplierSku,purchaseUnit,unitsPerPurchaseUnit:units,lastUnitCost:cost})).id;
  const product=async code=>(await catalog.createItem(db,ctx,{name:'Cost '+code,baseCode:code,trackingMode:'quantity'})).skuIds[0];
  const A=f.item.skuIds[0],B=await product('COST-B'),C=await product('COST-C'),D=await product('COST-D');
  const itemA=await link(A,'VEND-A','case',6,'1.20');
  await link(B,'VEND-B','each',1,'2.00');await link(C,'VEND-C','case',12,'0.50');await link(D,'VEND-D','case',4,'3.00');
  // A's own purchase cost follows this supplier, so it moves with the supplier's price.
  for(const amountMinor of [119,120])await prices.setPurchaseCost(db,ctx,{skuId:A,amountMinor,currency:'USD',supplierItemId:itemA});
  assert.equal((await prices.purchaseCost(db,ws,A)).supplier_item_id,itemA);

  const csv=rows=>Buffer.from(['Supplier SKU,Price,Currency,Unit,Pack size',...rows.map(r=>r.join(','))].join('\n')+'\n');
  let count=0;
  const work=async()=>{const done=[];for(;;){const next=await queue.processOne(db,handlers,{owner:'supplier-cost-worker',kinds:[costs.kind]});
    if(!next)return done;assert.equal(next.status,'COMPLETED',JSON.stringify(next.lastError));done.push(next.result);}};
  const upload=async(rows,supplierId=main)=>{
    const saved=await lists.upload(db,ctx,{buffer:csv(rows),filename:'supplier-prices-'+(++count)+'.csv',supplierId});
    const read=await queue.processOne(db,handlers,{owner:'price-list-reader',kinds:[lists.kind]});
    assert.equal(read.status,'COMPLETED',JSON.stringify(read.lastError));
    await work();
    return saved.id;
  };
  const rows=async id=>(await db.query(`SELECT f.ordinal,u.status,u.automatic,u.reason,u.would_apply,u.cost_id FROM stockchief_runtime.agent_supplier_price_list_findings f
    LEFT JOIN stockchief_runtime.agent_supplier_cost_updates u ON u.workspace_id=f.workspace_id AND u.source_id=f.source_id AND u.ordinal=f.ordinal
    WHERE f.workspace_id=$1 AND f.source_id=$2 ORDER BY f.ordinal`,[ws,id])).rows;
  const statuses=async id=>(await rows(id)).map(r=>r.status);
  const cost=async(skuId,supplierId=main)=>Number((await db.query('SELECT last_unit_cost FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2 AND supplier_id=$3',[ws,skuId,supplierId])).rows[0].last_unit_cost);
  const hashOf=async(id,ordinal)=>(await costs.page(db,ctx,{id})).rows.find(r=>r.ordinal===ordinal).reviewHash;
  const approve=async(id,ordinal)=>costs.approve(db,ctx,id,ordinal,{confirmed:'yes',reviewHash:await hashOf(id,ordinal)});
  const needs=async()=>costs.inbox(db,ws);
  const stock=async()=>(await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ws,A])).rows[0].total_cost_minor;
  const valueBefore=await stock();

  // Starter and Growth: the job is not on the plan. Nothing is checked and the page shows the plan lock.
  const early=[];
  for(const [tier,price] of [['starter','2.08'],['growth','2.10']]){
    await subscribe(tier);
    const id=await upload([['VEND-B',price,'USD','stock unit','']]);
    early.push(id);
    assert.deepEqual(await statuses(id),[null],tier+' never checks costs');
    assert.match((await browser.get(costs.path).expect(200)).text,/data-agent-plan-locked[\s\S]*available on Pro/);
    await assert.rejects(costs.approve(db,ctx,id,1,{confirmed:'yes'}),e=>e.code==='entitlement_required');
    await assert.rejects(costs.check(db,ctx,id),e=>e.code==='entitlement_required');
    assert.deepEqual(await needs(),[]);
    assert.equal(await cost(B),2);
  }

  // Pro before teaching: every exact change waits. Unclear rows are held with a reason.
  await subscribe('pro');
  await costs.check(db,ctx,early[1]);await work();
  assert.deepEqual(await statuses(early[1]),['REVIEW'],'the owner can ask for a list read before the plan to be checked');
  const L2=await upload([['VEND-A','7.44','USD','case',6],['VEND-B','2.20','USD','stock unit',''],['VEND-C','6.12','USD','case',12],
    ['VEND-D','3.10','USD','kg',''],['UNKNOWN-1','1.00','USD','stock unit','']]);
  let found=await rows(L2);
  assert.deepEqual(found.map(r=>r.status),['REVIEW','REVIEW','REVIEW','HELD','HELD']);
  assert.match(found[0].reason,/Approve one change from this supplier yourself/);
  assert.match(found[1].reason,/over 5%/);
  assert.match(found[3].reason,/price unit is unclear/);
  assert.match(found[4].reason,/No single active product/);
  assert.deepEqual([await cost(A),await cost(B),await cost(C)],[1.2,2,0.5],'Pro does nothing alone before it is taught');
  const listed=await needs();
  assert.equal(listed.length,2);
  assert.match(listed.find(n=>n.href.endsWith(L2)).happened,/3 changes wait for your approval\. 2 rows do not match exactly\./);
  const home=await require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  assert(home.some(n=>n.sourceId==='supplier-cost-update:'+L2),'the change shows in Needs you');
  await assert.rejects(costs.configure(db,ctx,L2,{maximumPercent:'3',confirmed:'yes',revision:0}),/Approve one cost change from this supplier yourself first/);

  // The owner approves A on the page. A's own purchase cost moves with it; stock value does not.
  const detail=await browser.get(costs.path+'/'+L2).expect(200);
  assert.match(detail.text,/\$1\.20 → \$1\.24 per [a-z]+ \(\+3\.3%\)/);
  assert.match(detail.text,/Waiting for you/);
  assert.match(detail.text,/does not match|price unit is unclear/);
  await browser.post(costs.path+'/'+L2+'/rows/1/approve').type('form')
    .send({_csrf:f.csrf(detail.text),reviewHash:await hashOf(L2,1),confirmed:'yes'}).expect(303);
  assert.equal(await cost(A),1.24);
  assert.equal((await prices.purchaseCost(db,ws,A)).amount_minor,124);
  found=await rows(L2);
  assert.equal(found[0].status,'APPLIED');assert.equal(found[0].automatic,false);assert(found[0].cost_id);
  assert.deepEqual(await costs.approve(db,ctx,L2,1,{confirmed:'yes',reviewHash:(await db.query(
    'SELECT review_hash FROM stockchief_runtime.agent_supplier_cost_updates WHERE workspace_id=$1 AND source_id=$2 AND ordinal=1',[ws,L2])).rows[0].review_hash}),{replayed:true});
  await assert.rejects(costs.approve(db,ctx,L2,2,{confirmed:'yes',reviewHash:'stale'}),/confirm this exact change/);

  // Teaching: the owner saves a 3% limit for this supplier. Small waiting changes then go alone.
  assert.deepEqual(await costs.configure(db,ctx,L2,{maximumPercent:'3',confirmed:'yes',revision:0}),{saved:true,points:300});
  await work();
  found=await rows(L2);
  assert.equal(found[2].status,'APPLIED');assert.equal(found[2].automatic,true);
  assert.equal(await cost(C),0.51);
  assert.equal(found[1].status,'REVIEW','over 5% still waits after teaching');
  assert.match((await rows(early[1]))[0].reason,/over your 3% limit/);
  await approve(L2,2);
  assert.equal(await cost(B),2.2);
  const stale=(await costs.page(db,ctx,{id:early[1]})).rows[0];
  assert.equal(stale.reviewHash,undefined);assert.match(stale.reason,/changed after this list was read/);

  // Limits: over the owner's 3% waits, under it goes alone.
  const L3=await upload([['VEND-A','7.74','USD','case',6],['VEND-C','6.24','USD','case',12]]);
  found=await rows(L3);
  assert.equal(found[0].status,'REVIEW');assert.match(found[0].reason,/over your 3% limit/);assert.equal(found[0].would_apply,false);
  assert.equal(found[1].status,'APPLIED');assert.equal(await cost(C),0.52);
  assert.equal(await cost(A),1.24);

  // Ask me first, pause and shadow stop automatic work; StockChief shows it would have done it.
  await modes.save(db,ctx,135,{mode:'ask',revision:0});
  const L4=await upload([['VEND-C','6.36','USD','case',12]]);
  found=await rows(L4);
  assert.equal(found[0].status,'REVIEW');assert.equal(found[0].would_apply,true);assert.match(found[0].reason,/Ask me first/);
  assert.equal(await cost(C),0.52);
  await modes.save(db,ctx,135,{mode:'inherit',revision:1});
  assert.deepEqual(await costs.schedule(db,ws,'cycle-1'),{queued:true});await work();
  assert.equal((await rows(L4))[0].status,'APPLIED');assert.equal(await cost(C),0.53);

  await autopilot.pause(db,ctx,{role:'owner'},'Checking supplier costs');
  const L5=await upload([['VEND-C','6.48','USD','case',12]]);
  found=await rows(L5);
  assert.equal(found[0].status,'REVIEW');assert.equal(found[0].would_apply,true);assert.match(found[0].reason,/paused/);
  assert.equal(await cost(C),0.53);
  await autopilot.resume(db,ctx,{role:'owner'});
  await costs.schedule(db,ws,'cycle-2');await work();
  assert.equal(await cost(C),0.54);

  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const L6=await upload([['VEND-C','6.60','USD','case',12]]);
  found=await rows(L6);
  assert.equal(found[0].status,'REVIEW');assert.equal(found[0].would_apply,true);assert.match(found[0].reason,/first 14 days/);
  await assert.rejects(approve(L6,1),/first 14 days/);
  assert.deepEqual(await costs.schedule(db,ws,'cycle-3'),{queued:false});
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await costs.schedule(db,ws,'cycle-4');await work();
  found=await rows(L6);
  assert.equal(found[0].status,'APPLIED');assert.equal(found[0].automatic,true);assert.equal(await cost(C),0.55);

  // Watch only and the inventory's watch mode block even a person's approval here.
  await modes.save(db,ctx,135,{mode:'watch',revision:2});
  await assert.rejects(approve(L3,1),/Watch only/);
  await modes.save(db,ctx,135,{mode:'inherit',revision:3});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(approve(L3,1),/watch-only/);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // Replays change nothing.
  assert.equal((await lists.run({workspaceId:ws,payload:{sourceId:L6}},db)).replayed,true);
  assert.deepEqual(await costs.run({workspaceId:ws,payload:{sourceId:L6}},db),{applied:0,review:0,held:0,unchanged:0});
  assert.equal(await cost(C),0.55);

  // Undo restores the previous cost, once.
  await assert.rejects(costs.undo(db,ctx,L6,1,{}),/Confirm/);
  assert.deepEqual(await costs.undo(db,ctx,L6,1,{confirmed:'yes'}),{undone:true});
  assert.deepEqual(await costs.undo(db,ctx,L6,1,{confirmed:'yes'}),{replayed:true});
  assert.equal(await cost(C),0.54);
  await browser.post(costs.path+'/'+L2+'/rows/1/undo').type('form').send({_csrf:f.csrf(detail.text),confirmed:'yes'}).expect(303);
  assert.equal(await cost(A),1.2);assert.equal((await prices.purchaseCost(db,ws,A)).amount_minor,120,'the item cost comes back too');
  await assert.rejects(costs.undo(db,ctx,L4,1,{confirmed:'yes'}),/changed after this update/);
  assert.equal((await costs.page(db,ctx,{id:L4})).rows[0].undoable,false,'no undo is offered once a later change exists');
  assert.equal((await costs.page(db,ctx,{id:L2})).rows.find(r=>r.ordinal===2).undoable,true);

  // Bad data stops and asks: a price that is not an exact cost per unit, and terms changed after reading.
  const L7=await upload([['VEND-A','7.45','USD','case',6],['VEND-C','6.12','EUR','case',12],['VEND-C','6.12','USD','case',6]]);
  found=await rows(L7);
  assert.deepEqual(found.map(r=>r.status),['HELD','HELD','HELD']);
  assert.match(found[0].reason,/exact cost per/);
  const L8=await upload([['VEND-C','6.84','USD','case',12]]);
  assert.equal((await rows(L8))[0].status,'REVIEW','0.57 is over the 3% limit from 0.54');
  await link(C,'VEND-C','case',12,'0.54');
  await assert.rejects(approve(L8,1),/changed after this list was read/);
  await assert.rejects(costs.approve(db,ctx,L8,1,{confirmed:'yes',reviewHash:'x'}),/changed after this list was read/);
  assert.equal(await cost(C),0.54);
  assert.deepEqual(await costs.keep(db,ctx,L8,1,{confirmed:'yes'}),{kept:1});
  await browser.post(costs.path+'/'+L2+'/keep').type('form').send({_csrf:f.csrf(detail.text),confirmed:'yes'}).expect(303);
  assert.deepEqual(await statuses(L2),['UNDONE','APPLIED','APPLIED','KEPT','KEPT']);
  assert(!(await needs()).some(n=>n.href.endsWith(L2)),'a finished list leaves Needs you');

  // Custom: a new supplier's small changes update alone without teaching; over 5% still waits.
  await subscribe('enterprise');
  const second=(await commerce.createSupplier(db,ctx,{name:'Second source',currency:'USD'})).id;
  const E=await product('COST-E'),F=await product('COST-F');
  await link(E,'S2-E','each',1,'4.00',second);await link(F,'S2-F','each',1,'1.00',second);
  const extra=[];
  for(let n=0;n<100;n++)extra.push(await product('COST-BULK-'+n));
  await db.transaction(c=>commerce.linkSupplierItemsInTransaction(c,ctx,extra.map((skuId,n)=>({skuId,supplierId:second,supplierSku:'S2-BULK-'+n,
    purchaseUnit:'each',unitsPerPurchaseUnit:1,lastUnitCost:'1.00'}))));
  const L9=await upload([['S2-E','4.20','USD','stock unit',''],['S2-F','1.06','USD','stock unit',''],
    ...extra.map((_,n)=>['S2-BULK-'+n,'1.01','USD','stock unit',''])],second);
  found=await rows(L9);
  assert.equal(found.length,102);
  assert.equal(found[0].status,'APPLIED');assert.equal(found[0].automatic,true,'exactly 5% goes alone on Custom');
  assert.equal(found[1].status,'REVIEW');assert.match(found[1].reason,/over 5%/);
  assert(found.slice(2).every(r=>r.status==='APPLIED'&&r.automatic),'every page of a long list is checked');
  assert.equal(await cost(E,second),4.2);assert.equal(await cost(extra[99],second),1.01);
  assert.equal((await costs.page(db,ctx,{id:L9})).more,true);
  assert.equal((await costs.page(db,ctx,{id:L9,page:2})).rows.length,2);

  // Custom: the owner can ask for every change from one supplier, or set a lower limit.
  assert.deepEqual(await costs.configure(db,ctx,L9,{stop:'yes',revision:0}),{stopped:true});
  const L10=await upload([['S2-E','4.30','USD','stock unit','']],second);
  assert.match((await rows(L10))[0].reason,/approve every cost change from this supplier/);
  await costs.configure(db,ctx,L10,{maximumPercent:'2',confirmed:'yes',revision:1});await work();
  assert.match((await rows(L10))[0].reason,/over your 2% limit/);
  assert.equal(await cost(E,second),4.2);
  await assert.rejects(costs.configure(db,ctx,L10,{maximumPercent:'6',confirmed:'yes',revision:2}),/0\.01% to 5%/);

  // The phone owner approves the 6% change on the page, at desktop and phone widths.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port,shots=process.env.SUPPLIER_COST_SHOTS;
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await chrome.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500}),errors=[];
    page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+costs.path);
    assert.match(await page.locator('main').innerText(),/Supplier cost updates/);
    await page.goto(origin+costs.path+'/'+L9);
    const text=await page.locator('main').innerText();
    assert.match(text,/\$1\.00 → \$1\.06/);assert.match(text,/Updated on its own/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scrolling at '+viewport.width);
    if(shots)await page.screenshot({path:require('node:path').join(shots,'supplier-costs-'+viewport.width+'.png'),fullPage:false});
    if(shots){await page.goto(origin+costs.path+'/'+L2);await page.screenshot({path:require('node:path').join(shots,'supplier-costs-pro-'+viewport.width+'.png'),fullPage:true});await page.goto(origin+costs.path+'/'+L9);}
    if(viewport.width===390){
      const row=page.locator('[data-cost-row="2"]');
      await Promise.all([page.waitForNavigation(),row.getByRole('button',{name:'Approve $1.06',exact:true}).click()]);
      assert.match(await page.locator('main').innerText(),/The supplier’s cost was updated/);
    }
    assert.deepEqual(errors,[]);
    await page.close();
  }
  assert.equal(await cost(F,second),1.06);
  const review=await reviews.run(db,ctx,'supplier-price-updates');
  assert(review.rows.some(r=>r.link===costs.path+'/'+L9));

  // Every change is in the security audit, and stock already received keeps its value.
  const audited=(await db.query(`SELECT action,count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Supplier cost%' GROUP BY action`,[ws])).rows;
  const by=Object.fromEntries(audited.map(r=>[r.action,r.n]));
  assert.equal(by['Supplier cost updated from a price list'],3);
  assert(by['Supplier cost updated on its own from a price list']>=105);
  assert.equal(by['Supplier cost update undone'],2);
  assert.equal(await f.balance(),4);
  assert.equal(await stock(),valueBefore);

  // A downgrade locks the job at once.
  await subscribe('growth');
  assert.match((await browser.get(costs.path+'/'+L9).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(costs.undo(db,ctx,L9,1,{confirmed:'yes'}),e=>e.code==='entitlement_required');
  assert.deepEqual(await needs(),[]);
  assert.equal((await costs.run({workspaceId:ws,payload:{}},db)).skipped,true);
});

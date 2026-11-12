'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 127: creates products from a supplier catalog or price list.
test('supplier catalogs create new products, link existing ones and wait for a person on unclear lines, per plan',{timeout:600000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe,browser}=f;
  const catalogs=require('../../src/catalog/agent-supplier-catalog'),autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const only=Object.fromEntries(['agent.supplier-catalog.v1','import.execute-approved','records.remove-import'].map(k=>[k,handlers[k]]));
  // The worker retries a job after its back-off; the test does not wait for the clock.
  const work=async()=>{for(let i=0;i<60;i++){const job=await queue.processOne(db,only,{owner:'catalog-test'});if(!job){const retry=await db.query("UPDATE stockchief_runtime.jobs SET available_at=0 WHERE workspace_id=$1 AND status='RETRY' AND kind=ANY($2::text[]) RETURNING id",[ctx.workspaceId,Object.keys(only)]);if(!retry.rowCount)return;continue;}assert.notEqual(job.status,'DEAD',JSON.stringify(job.lastError));}assert.fail('worker did not settle');};
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  const at=new Date().toISOString();
  async function supplier(name){const id='sup-'+randomUUID().slice(0,8);await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES($1,$2,$3,'active','USD',$4,$4)",[id,ctx.workspaceId,name,at]);return id;}
  async function product(name,code,{barcode=null,supplierId=null,supplierSku=null,cost=null}={}){
    const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name,baseCode:code,trackingMode:'quantity'});
    if(barcode)await db.query('UPDATE skus SET barcode=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.skuIds[0],barcode]);
    if(supplierId)await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId,skuId:item.skuIds[0],supplierSku,lastUnitCost:cost});
    return item.skuIds[0];
  }
  const lines=async id=>Object.fromEntries((await db.query('SELECT row_number,kind,status,reason,target_sku_id FROM stockchief_runtime.agent_supplier_catalog_rows WHERE catalog_id=$1',[id])).rows.map(r=>[r.row_number,r]));
  const skuCount=async code=>Number((await one('SELECT count(*) n FROM skus WHERE workspace_id=$1 AND lower(btrim(code))=lower($2)',[ctx.workspaceId,code])).n);
  const link=async(sup,sku)=>{const r=await one('SELECT supplier_sku,units_per_purchase_unit pack,purchase_unit,last_unit_cost cost,is_active FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3',[ctx.workspaceId,sup,sku]);return r&&{...r,pack:String(Number(r.pack)),cost:Number(r.cost),is_active:Number(r.is_active)};};
  const cost=async code=>(await one('SELECT p.amount_minor::int amount FROM sku_purchase_costs p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id WHERE s.workspace_id=$1 AND s.code=$2 ORDER BY p.created_at DESC LIMIT 1',[ctx.workspaceId,code]))?.amount;
  const audits=async action=>Number((await one('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).n);
  // One catalog per plan: prefixes keep the products apart.
  async function setup(p){
    const sup=await supplier('Supplier '+p);
    const barcode='0'+String(Math.floor(Math.random()*1e12)).padStart(12,'1');
    const skus={bar:await product('Bar '+p,p+'-BAR',{barcode}),code:await product('Code '+p,p+'-CODE'),
      mug:await product('Mug '+p,p+'-MUG-OLD'),same:await product('Same '+p,p+'-SAME',{supplierId:sup,supplierSku:p+'-S1',cost:4}),
      dear:await product('Dear '+p,p+'-DEAR',{supplierId:sup,supplierSku:p+'-S2',cost:5})};
    const csv=['Product,SKU,Barcode,Pack,Unit cost',
      `Bolt ${p},${p}-BOLT,,12,0.40`,`Nut ${p},${p}-NUT,,,0.10`,`Bar listed ${p},${p}-SUPBAR,${barcode},6,2.00`,
      `Code ${p},${p.toLowerCase()}-code,,,3.00`,`Mug ${p},${p}-MUG-NEW,,,5.00`,`Same ${p},${p}-S1,,,4.00`,`Dear ${p},${p}-S2,,,6.00`,`Free ${p},${p}-FREE,,,`].join('\n');
    return {sup,skus,csv,start:()=>catalogs.start(db,ctx,{buffer:Buffer.from(csv),filename:'Catalog '+p+'.csv',supplierId:sup})};
  }

  // Starter cannot use the job: the page shows the plan lock.
  await subscribe('starter');
  const locked=await setup('STA');
  await assert.rejects(locked.start(),e=>e.code==='entitlement_required');
  assert.match((await browser.get(catalogs.path)).text,/Growth/);

  // Pro during the first 14 days only drafts, and nobody can approve yet.
  await subscribe('pro');
  const shadowed=await setup('SHD'),shadow=await shadowed.start();
  const shadowRow=await one('SELECT status,hold_reason FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[shadow.id]);
  assert.equal(shadowRow.status,'WAITING');assert.match(shadowRow.hold_reason,/first 14 days/);
  await assert.rejects(catalogs.approve(db,ctx,shadow.id),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // Growth drafts the product list; a person approves and answers.
  await subscribe('growth');
  const g=await setup('GRO'),growth=await g.start();
  let rows=await lines(growth.id);
  assert.deepEqual(Object.values(rows).map(r=>r.kind).sort(),['LINK','LINK','NEW','NEW','SAME','UNCLEAR','UNCLEAR','UNCLEAR']);
  assert.equal(rows[4].target_sku_id,g.skus.bar,'same barcode links to the existing product');
  assert.equal(rows[5].target_sku_id,g.skus.code,'same SKU apart from capitals links');
  assert.match(rows[6].reason,/same name and options/i);assert.match(rows[8].reason,/price .* changed/);assert.match(rows[9].reason,/no unit cost/);
  await work();assert.equal(await skuCount('GRO-BOLT'),0,'nothing is created before approval');
  const page=await browser.get(catalogs.path+'/'+growth.id).expect(200);
  assert.match(page.text,/Approve the product list/);assert.match(page.text,/Create a new product/);
  // A downgrade between approval and the worker creates nothing.
  await catalogs.approve(db,ctx,growth.id,{decisions:{6:'CREATE',8:'LINK',9:'SKIP'}});
  await subscribe('starter');await work();
  assert.equal(await skuCount('GRO-BOLT'),0);assert.equal((await one('SELECT status FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[growth.id])).status,'WAITING');
  await subscribe('growth');
  await catalogs.approve(db,ctx,growth.id,{decisions:{6:'CREATE',8:'LINK',9:'SKIP'}});
  await work();
  assert.equal((await one('SELECT status FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[growth.id])).status,'DONE');
  assert.equal(await skuCount('GRO-BOLT'),1);assert.equal(await cost('GRO-BOLT'),40);
  const bolt=(await one('SELECT id FROM skus WHERE workspace_id=$1 AND code=$2',[ctx.workspaceId,'GRO-BOLT'])).id;
  assert.deepEqual(await link(g.sup,bolt),{supplier_sku:'GRO-BOLT',pack:'12',purchase_unit:'pack',cost:0.4,is_active:1});
  assert.equal(await skuCount('GRO-MUG-NEW'),1,'the person chose to create the name-only match');
  assert.equal(await skuCount('gro-code'),1,'an existing product is linked, never duplicated');
  assert.equal((await link(g.sup,g.skus.bar)).supplier_sku,'GRO-SUPBAR');assert.equal((await link(g.sup,g.skus.bar)).pack,'6');
  assert.equal(await cost('GRO-BAR'),undefined,'linking never sets the existing product’s cost');
  assert.equal((await link(g.sup,g.skus.dear)).cost,6,'the person accepted the new supplier price');
  assert.equal(await skuCount('GRO-FREE'),0);
  assert.equal(await audits('Supplier catalog approved'),2);assert.equal(await audits('Supplier catalog products created'),1);
  // Replaying the same file for the same supplier opens the same catalog.
  assert.deepEqual(await g.start(),{id:growth.id,replayed:true});await work();assert.equal(await skuCount('GRO-BOLT'),1);
  // Undo puts the links back and removes the products it created.
  await catalogs.undo(db,ctx,growth.id);await work();
  assert.equal((await link(g.sup,g.skus.bar)).is_active,0);assert.equal((await link(g.sup,g.skus.dear)).cost,5);
  assert.equal((await one('SELECT i.is_active FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.id=$1',[bolt])).is_active,'0');
  assert.equal((await one('SELECT status FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[growth.id])).status,'UNDONE');
  assert.equal(await audits('Supplier catalog undone'),1);

  // Pro and Custom create exact lines on their own; unclear lines wait.
  for(const tier of ['pro','enterprise']){
    await subscribe(tier);
    const p=tier==='pro'?'PRO':'CUS',s=await setup(p),run=await s.start();
    assert.equal((await one('SELECT status,automatic FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[run.id])).automatic,true);
    await work();
    const done=await lines(run.id);
    assert.equal(done[2].status,'DONE');assert.equal(done[4].status,'DONE');assert.equal(done[6].status,'PENDING');assert.equal(done[9].status,'PENDING');
    assert.equal(await skuCount(p+'-BOLT'),1);assert.equal(await skuCount(p+'-MUG-NEW'),0,'a name-only match waits');
    assert.equal((await link(s.sup,s.skus.dear)).cost,5,'a changed supplier price waits for a person');
    assert.equal((await one('SELECT status FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[run.id])).status,'WAITING');
    const needs=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
    assert(needs.some(n=>n.href===catalogs.path+'/'+run.id),'unclear lines show in Needs you');
  }
  assert.equal(await audits('Supplier catalog products created by StockChief'),2);

  // Ask me first, Watch only and a pause make Pro draft instead.
  await subscribe('pro');
  await modes.save(db,ctx,127,{mode:'ask',revision:0});
  const asked=await (await setup('ASK')).start();
  assert.match((await one('SELECT hold_reason FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[asked.id])).hold_reason,/Ask me first/);
  await modes.save(db,ctx,127,{mode:'inherit',revision:1});
  await autopilot.pause(db,ctx,{role:'owner'},'Checking catalogs');
  const paused=await (await setup('PAU')).start();await work();
  assert.equal(await skuCount('PAU-BOLT'),0);assert.match((await one('SELECT hold_reason FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[paused.id])).hold_reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});

  // A file with stock quantities is refused; it is not a catalog.
  const stocked=await catalogs.start(db,ctx,{buffer:Buffer.from('Product,SKU,Qty,Unit cost\nStocked,STK-1,5,1.00'),filename:'Stock.csv',supplierId:await supplier('Stock supplier')});
  assert.match((await one('SELECT hold_reason FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[stocked.id])).hold_reason,/stock quantities/);

  // A larger catalog on Custom stays fast through the native import.
  await subscribe('enterprise');
  const bigSupplier=await supplier('Big supplier'),big=['Product,SKU,Pack,Unit cost',...Array.from({length:1500},(_,i)=>`Part ${i},BIG-${i},10,${(i%90)+1}.25`)].join('\n');
  const started=Date.now(),bigRun=await catalogs.start(db,ctx,{buffer:Buffer.from(big),filename:'Big catalog.pdf.csv',supplierId:bigSupplier});await work();
  assert.equal((await one('SELECT status FROM stockchief_runtime.agent_supplier_catalogs WHERE id=$1',[bigRun.id])).status,'DONE',
    JSON.stringify((await db.query("SELECT kind,status,last_error,attempt_count FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND status<>'COMPLETED' ORDER BY created_at DESC LIMIT 5",[ctx.workspaceId])).rows));
  assert.equal(Number((await one("SELECT count(*) n FROM skus WHERE workspace_id=$1 AND code LIKE 'BIG-%'",[ctx.workspaceId])).n),1500);
  assert(Date.now()-started<120000,'1,500 catalog lines took '+(Date.now()-started)+' ms');

  // The catalog pages work on a desktop and a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port,waiting=(await one("SELECT id FROM stockchief_runtime.agent_supplier_catalogs WHERE workspace_id=$1 AND status='WAITING' ORDER BY created_at LIMIT 1",[ctx.workspaceId])).id;
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
    const tab=await chrome.newPage({viewport});
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const href of [catalogs.path,catalogs.path+'/'+waiting]){
      await tab.goto(origin+href);
      assert(await tab.locator('h1').first().isVisible());
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll on '+href+' at '+viewport.width);
    }
    await tab.close();
  }
});

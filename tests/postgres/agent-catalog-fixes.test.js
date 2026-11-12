'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 126: Starter suggests. Growth drafts a bulk fix list for approval. Pro
// drafts until the owner approved one fix of a kind and saved a daily limit;
// Custom fixes on its own inside a daily limit. Merges never move stock.
test('duplicates, missing costs and weights, and bad SKUs are fixed in bulk on each plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,workflows}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const commerce=require('../../src/operations/postgres-commerce'),fixes=require('../../src/catalog/agent-catalog-fixes');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const reviews=require('../../src/autopilot/job-reviews'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
  await age('30 days');
  const product=async(code,name,extra={})=>{
    const made=await catalog.createItem(db,ctx,{name,baseCode:code,trackingMode:'quantity',...extra});
    return {sku:made.skuIds[0],item:made.itemId,skus:made.skuIds};
  };
  const set=(sku,column,value)=>db.query(`UPDATE skus SET ${column}=$3 WHERE workspace_id=$1 AND id=$2`,[ws,sku,value]);
  const bought=async(sku,quantity,unitCost)=>{
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:quantity,unitCost}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity,locationId:location.id}]});
    return (await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[po.purchaseOrderId])).rows[0].po_number;
  };

  // Duplicates by barcode; the copy is linked to a sales channel and a supplier code.
  const mugA=await product('MUG-A','Blue mug',{purchaseCost:'3',weightGrams:300}),mugB=await product('MUG-B','Blue Mug');
  await set(mugA.sku,'barcode','7001');await set(mugB.sku,'barcode','7001');
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:mugB.sku,supplierSku:'FS-MUG',lastUnitCost:2.75});
  const at=new Date().toISOString();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,created_at,updated_at) VALUES('fixture-shop',$1,'shop','Web shop',$2,$2)`,[ws,at]);
  await db.query(`INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,created_at,updated_at)
    VALUES('fixture-listing',$1,'fixture-shop','sku','listing-9',$2,$3,$3)`,[ws,mugB.sku,at]);
  // Duplicates that both hold stock wait for a person.
  const capA=await product('CAP-A','Red cap',{purchaseCost:'2',weightGrams:90}),capB=await product('CAP-B','Red cap XL',{purchaseCost:'2',weightGrams:90});
  await set(capA.sku,'barcode','7002');await set(capB.sku,'barcode','7002');
  for(const sku of [capA.sku,capB.sku])await receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity:3,idempotencyKey:randomUUID()});
  // The same name alone needs a person to confirm.
  const tea1=await product('TEA-1','Green tea 50g',{purchaseCost:'4',weightGrams:55}),tea2=await product('TEA-2','green tea, 50 g',{purchaseCost:'4',weightGrams:55});
  // Bad SKUs: spaces are cleaned; characters channels reject need a person.
  const spaced=await product('SP-TEMP','Spaced code',{purchaseCost:'1',weightGrams:10}),hashed=await product('HASH-TEMP','Hashed code',{purchaseCost:'1',weightGrams:10});
  await set(spaced.sku,'code',' SP 1 ');await set(hashed.sku,'code','HASH#1');
  // Missing costs: one receipt, or a receipt and a supplier price that disagree.
  const costR=await product('COST-R','Bought once',{weightGrams:40}),costX=await product('COST-X','Bought twice',{weightGrams:40});
  const poR=await bought(costR.sku,2,2.5);await bought(costX.sku,2,2);
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:costX.sku,supplierSku:'FS-X',lastUnitCost:2.4});
  // Missing weights: the other sizes agree, or disagree.
  const hoodie=await product('HOOD','Hoodie',{purchaseCost:'9',hasVariants:true,options:[{name:'Size',values:['S','M','L']}]});
  const jacket=await product('JACK','Jacket',{purchaseCost:'9',hasVariants:true,options:[{name:'Size',values:['S','M','L']}]});
  await set(hoodie.skus[0],'weight_grams',500);await set(hoodie.skus[1],'weight_grams',500);
  await set(jacket.skus[0],'weight_grams',800);await set(jacket.skus[1],'weight_grams',900);
  await set(f.item.skuIds[0],'weight_grams',350);await db.query('INSERT INTO sku_purchase_costs(id,workspace_id,sku_id,amount_minor,currency,source,created_at) VALUES($1,$2,$3,100,$4,$5,$6)',
    [randomUUID(),ws,f.item.skuIds[0],'USD','owner',at]);

  const sweep=()=>fixes.run({workspaceId:ws,payload:{}},db);
  const fixOf=async(sku,kind)=>(await db.query(`SELECT * FROM stockchief_runtime.agent_catalog_fixes WHERE workspace_id=$1 AND sku_id=$2 AND kind=$3
    ORDER BY created_at DESC,id DESC LIMIT 1`,[ws,sku,kind])).rows[0];
  const approve=async(sku,kind,extra={})=>{const x=await fixOf(sku,kind);return fixes.approve(db,ctx,x.id,{confirmed:'yes',fingerprint:x.fingerprint,...extra});};
  const skuRow=async sku=>(await db.query('SELECT code,barcode,weight_grams::text AS grams,is_active FROM skus WHERE id=$1',[sku])).rows[0];
  const cost=async sku=>(await db.query('SELECT amount_minor::int AS minor,currency FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ws,sku])).rows[0]||null;
  const audits=action=>db.query('SELECT count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action]).then(r=>r.rows[0].n);
  const mapped=async()=>(await db.query("SELECT foundry_record_id FROM connection_mappings WHERE id='fixture-listing'")).rows[0].foundry_record_id;

  // Starter: one suggestion naming the fix; the page and drafting are locked.
  await subscribe('starter');
  const [suggestion]=(await reviews.run(db,ctx,'catalog-fixes',{filter:'MUG-B'})).rows;
  assert.deepEqual(Object.keys(suggestion),['Suggestion']);
  assert.match(suggestion.Suggestion,/Review Blue Mug\. Looks like a duplicate of MUG-A \(same barcode 7001, same name and options\)\. Merge it into MUG-A\./);
  assert.match((await browser.get(fixes.path).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(fixes.check(db,ctx),e=>e.code==='entitlement_required');
  assert.equal((await sweep()).skipped,true);
  assert.deepEqual(await fixes.inbox(db,ws),[]);

  // Growth: the routine drafts every fix. Nothing changes until a person approves.
  await subscribe('growth');
  const listed=await reviews.run(db,ctx,'catalog-fixes',{});
  const line=code=>listed.rows.find(r=>r.SKU===code);
  assert.match(line('COST-R')['What to fix'],new RegExp('No purchase cost\\. Fill \\$2\\.50 from the latest receipt on '+poR));
  assert.match(line('COST-X')['What to fix'],/The records disagree: \$2\.00 \(the latest receipt on [^)]+\), \$2\.40 \(Fixture parts price\)/);
  assert.equal(line('HOOD-L')['Fix ready'],'Yes');assert.match(line('HOOD-L')['What to fix'],/Fill 500 g from variant HOOD-M and variant HOOD-S/);
  assert.match(line(' SP 1 ')['What to fix'],/Change it to SP-1/);
  assert.equal(line('CAP-B')['Fix ready'],'Needs you');
  await fixes.check(db,ctx);
  const processed=await queue.processOne(db,handlers,{owner:'catalog-fix-worker',kinds:[fixes.kind]});
  assert.equal(processed.status,'COMPLETED',JSON.stringify(processed.lastError));
  const merge=await fixOf(mugB.sku,'MERGE');
  assert.deepEqual([merge.status,merge.target_sku_id,merge.reason],['DRAFT',mugA.sku,'A person approves each fix on this plan.']);
  assert.match((await fixOf(capB.sku,'MERGE')).reason,/CAP-B still holds stock\. Move it to CAP-A yourself first/);
  assert.equal((await fixOf(capB.sku,'MERGE')).status,'HELD');
  assert.match((await fixOf(tea2.sku,'MERGE')).reason,/share only a name/);
  assert.deepEqual([(await fixOf(spaced.sku,'SKU')).status,(await fixOf(hashed.sku,'SKU')).status],['DRAFT','HELD']);
  assert.deepEqual([(await fixOf(costR.sku,'COST')).status,(await fixOf(costX.sku,'COST')).status],['DRAFT','HELD']);
  assert.deepEqual([(await fixOf(hoodie.skus[2],'WEIGHT')).status,(await fixOf(jacket.skus[2],'WEIGHT')).status],['DRAFT','HELD']);
  assert.equal(await fixOf(mugB.sku,'COST'),undefined,'a duplicate is merged, not filled');
  assert.equal((await skuRow(mugB.sku)).is_active,'1');assert.equal(await cost(costR.sku),null);
  assert.match((await fixes.inbox(db,ws))[0].happened,/fixes are ready for your approval\. \d+ fixes need your answer\./);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===126).allowed,['inherit','watch','ask']);
  await assert.rejects(fixes.configure(db,ctx,'COST',{revision:0,confirmed:'yes',dailyLimit:'5'}),e=>e.code==='entitlement_required');

  // The bulk fix list: the ticked fixes are approved together through the page.
  const page=await browser.get(fixes.path).expect(200);
  for(const marker of ['data-catalog-bulk','data-catalog-waiting','data-catalog-kinds'])assert.ok(page.text.includes(marker),marker);
  const ticked=[...page.text.matchAll(/name="fix" value="([^"]+)"/g)].map(m=>m[1]);
  const keep=[merge.id,(await fixOf(spaced.sku,'SKU')).id,(await fixOf(costR.sku,'COST')).id];
  const chosen=ticked.filter(v=>keep.includes(v.split(':')[0]));
  assert.equal(chosen.length,3);
  await browser.post(fixes.path+'/approve').type('form').send({_csrf:f.csrf(page.text),confirmed:'yes',fix:chosen}).expect(303);
  assert.deepEqual(await skuRow(mugB.sku),{code:'MUG-B',barcode:'7001',grams:null,is_active:'0'});
  assert.equal((await skuRow(mugA.sku)).barcode,'7001');
  assert.equal(await mapped(),mugA.sku,'the channel listing now sells the kept product');
  const carried=(await db.query("SELECT supplier_sku,last_unit_cost FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2 AND supplier_id='fixture-supplier' AND is_active=1",[ws,mugA.sku])).rows;
  assert.deepEqual(carried.map(r=>[r.supplier_sku,Number(r.last_unit_cost)]),[['FS-MUG',2.75]]);
  assert.equal((await skuRow(spaced.sku)).code,'SP-1');
  assert.deepEqual(await cost(costR.sku),{minor:250,currency:'USD'});
  assert.equal(await audits('Catalog fix approved'),3);assert.equal(await audits('Catalog fixes approved in bulk'),1);
  // The merged product keeps its own history; both pages say where it went.
  assert.match((await browser.get('/inventory/'+mugA.item).expect(200)).text,/data-merge-note[\s\S]*MUG-B<\/a> was merged into MUG-A/);
  assert.match((await browser.get('/inventory/'+mugB.item).expect(200)).text,/MUG-B was merged into <a href="\/inventory\/[^"]+"[^>]*>MUG-A<\/a>/);
  // A replay changes nothing more.
  assert.deepEqual(await fixes.approveMany(db,ctx,{confirmed:'yes',fix:chosen}),{done:0,failed:[]});
  // Fixes that ask: a chosen cost, a typed SKU and a confirmed name match.
  await assert.rejects(approve(costX.sku,'COST',{choice:'7'}),/Choose one of the recorded values/);
  await approve(costX.sku,'COST',{choice:'1'});
  assert.deepEqual(await cost(costX.sku),{minor:240,currency:'USD'});
  await assert.rejects(approve(hashed.sku,'SKU',{code:'HASH #1'}),/letters, numbers/);
  await assert.rejects(approve(hashed.sku,'SKU',{code:'mug-a'}),/Another product already uses mug-a/);
  await approve(hashed.sku,'SKU',{code:'HASH-1'});
  assert.equal((await skuRow(hashed.sku)).code,'HASH-1');
  await approve(tea2.sku,'MERGE');
  assert.equal((await skuRow(tea2.sku)).is_active,'0');
  // Stock is never moved to merge; a stale fix stops.
  await assert.rejects(approve(capB.sku,'MERGE'),/still holds stock/);
  const jacketFix=await fixOf(jacket.skus[2],'WEIGHT');
  await set(jacket.skus[1],'weight_grams',800);
  await assert.rejects(fixes.approve(db,ctx,jacketFix.id,{confirmed:'yes',fingerprint:jacketFix.fingerprint,grams:'850'}),/changed since this fix was prepared/);
  // Kept as it is: the same fix is not prepared again.
  await sweep();
  const fresh=await fixOf(jacket.skus[2],'WEIGHT');
  assert.equal(fresh.status,'DRAFT','the sizes now agree');
  await fixes.dismiss(db,ctx,fresh.id,{confirmed:'yes'});
  await sweep();
  assert.equal((await fixOf(jacket.skus[2],'WEIGHT')).status,'DISMISSED');
  // Undo: the cost goes back to missing; the merge is reversed exactly.
  await fixes.undo(db,ctx,(await fixOf(costR.sku,'COST')).id,{confirmed:'yes'});
  assert.equal(await cost(costR.sku),null);
  await fixes.undo(db,ctx,merge.id,{confirmed:'yes'});
  assert.deepEqual([(await skuRow(mugB.sku)).is_active,(await skuRow(mugB.sku)).barcode,(await skuRow(mugA.sku)).barcode],['1','7001','7001']);
  assert.equal(await mapped(),mugB.sku);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2 AND is_active=1",[ws,mugA.sku])).rows[0].n,0);
  assert.deepEqual(await fixes.undo(db,ctx,merge.id,{confirmed:'yes'}),{replayed:true});
  assert.equal(await audits('Catalog fix undone'),2);

  // Pro: fixes wait until the owner approved one of a kind and saved a limit.
  await subscribe('pro');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.ok((await modes.page(db,ctx)).find(x=>x.id===126).allowed.includes('routine'));
  await sweep();
  assert.match((await fixOf(hoodie.skus[2],'WEIGHT')).reason,/Approve one fix of this kind yourself and save a daily limit/);
  assert.match((await fixOf(mugB.sku,'MERGE')).reason,/You undid this fix before|Approve one fix/);
  await assert.rejects(fixes.configure(db,ctx,'WEIGHT',{revision:0,confirmed:'yes',dailyLimit:'1'}),/Approve one fix of this kind yourself first/);
  // Teach it: answer one weight fix by hand, then save a daily limit of one.
  await set(jacket.skus[1],'weight_grams',900);
  await sweep();
  assert.equal((await fixOf(jacket.skus[2],'WEIGHT')).status,'HELD','the sizes disagree again');
  await approve(jacket.skus[2],'WEIGHT',{grams:'850'});
  assert.equal((await skuRow(jacket.skus[2])).grams,'850');
  await fixes.configure(db,ctx,'WEIGHT',{revision:0,confirmed:'yes',dailyLimit:'1'});
  await sweep();
  const autoHood=await fixOf(hoodie.skus[2],'WEIGHT');
  assert.deepEqual([autoHood.status,autoHood.automatic,(await skuRow(hoodie.skus[2])).grams],['DONE',true,'500']);
  // Weights from an approved supplier file wait over the daily limit.
  const box=await product('BOX-W','Shipping box',{purchaseCost:'1'}),bag=await product('BAG-W','Paper bag',{purchaseCost:'1'});
  const imports=require('../../src/imports/postgres-service'),facts=require('../../src/domain/postgres-catalog-facts');
  const file=await imports.analyse(db,ctx,{text:'Name,SKU,Location,Qty\nCarton,CART-1,Dispatch,0',allowModel:false});
  await imports.approve(db,ctx,file.id,file.integrityHash);assert.ok((await imports.execute(db,ctx,file.id)).verified);
  for(const [n,sku,name,value] of [[2,box.sku,'Weight g','250'],[3,bag.sku,'Weight kg','0.1']])
    await db.transaction(c=>facts.saveManyInTransaction(c,ctx,[{skuId:sku,rowNumber:n,importId:file.id,name,value}]));
  await sweep();
  assert.match((await fixOf(box.sku,'WEIGHT')).reason,/over your limit of 1 weights fixed a day/);
  assert.match((await fixOf(box.sku,'WEIGHT')).details.source,/supplier file/);
  assert.equal((await fixOf(bag.sku,'WEIGHT')).details.after.grams,'100');
  await fixes.configure(db,ctx,'WEIGHT',{revision:1,confirmed:'yes',dailyLimit:'5'});
  // Pause, shadow and Ask me first keep it a draft and say it would act.
  await autopilot.pause(db,ctx,{role:'owner'},'checking');
  await sweep();
  const paused=await fixOf(box.sku,'WEIGHT');
  assert.deepEqual([paused.status,paused.would_apply,/paused/.test(paused.reason)],['DRAFT',true,true]);
  await autopilot.resume(db,ctx,{role:'owner'});
  await age('1 day');
  await sweep();
  assert.match((await fixOf(box.sku,'WEIGHT')).reason,/watching during the first 14 days/);
  await assert.rejects(approve(box.sku,'WEIGHT'),/watching during the first 14 days/);
  await age('30 days');
  await modes.save(db,ctx,126,{mode:'ask',revision:0});
  await sweep();
  assert.match((await fixOf(box.sku,'WEIGHT')).reason,/Ask me first/);
  await modes.save(db,ctx,126,{mode:'inherit',revision:1});
  assert.equal((await skuRow(box.sku)).grams,null);
  await sweep();
  const autoBox=await fixOf(box.sku,'WEIGHT');
  assert.deepEqual([autoBox.status,autoBox.automatic,(await skuRow(box.sku)).grams],['DONE',true,'250']);
  assert.equal((await skuRow(bag.sku)).grams,'100');
  assert.equal(await audits('Catalog fix made on its own'),3);
  await sweep();
  assert.equal(await audits('Catalog fix made on its own'),3,'a replay makes no second fix');
  await fixes.undo(db,ctx,autoBox.id,{confirmed:'yes'});
  assert.equal((await skuRow(box.sku)).grams,null);
  await sweep();
  assert.match((await fixOf(box.sku,'WEIGHT')).reason,/You undid this fix before/);

  // Custom: no teaching. Clear fixes are made on its own inside the daily limit.
  await subscribe('enterprise');
  const costC=await product('COST-C','Bought by Custom',{weightGrams:20});await bought(costC.sku,1,3.25);
  const supA=await product('SUP-A','Steel bolt',{purchaseCost:'1',weightGrams:5}),supB=await product('SUP-B','Bolt, steel',{purchaseCost:'1',weightGrams:5});
  for(const sku of [supA.sku,supB.sku])await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:sku,supplierSku:'BOLT-77'});
  await fixes.configure(db,ctx,'SKU',{revision:0,stop:'yes'});
  const bad=await product('NEW-TEMP','New bad code',{purchaseCost:'1',weightGrams:5});await set(bad.sku,'code','NEW CODE');
  await sweep();
  const autoCost=await fixOf(costC.sku,'COST');
  assert.deepEqual([autoCost.status,autoCost.automatic],['DONE',true]);
  assert.deepEqual(await cost(costC.sku),{minor:325,currency:'USD'});
  const autoMerge=await fixOf(supB.sku,'MERGE');
  assert.deepEqual([autoMerge.status,autoMerge.automatic,autoMerge.target_sku_id,(await skuRow(supB.sku)).is_active],['DONE',true,supA.sku,'0']);
  assert.match((await fixOf(bad.sku,'SKU')).reason,/You chose to approve every fix of this kind yourself/);
  assert.equal((await skuRow(bad.sku)).code,'NEW CODE');
  assert.match((await fixOf(costR.sku,'COST')).reason,/You undid this fix before/);
  await fixes.configure(db,ctx,'COST',{revision:0,confirmed:'yes',dailyLimit:'1'});
  const costD=await product('COST-D','Bought later',{weightGrams:20});await bought(costD.sku,1,4);
  await sweep();
  assert.match((await fixOf(costD.sku,'COST')).reason,/over your limit of 1 purchase costs fixed a day/);
  // Undo an automatic merge; watch mode stops a person's approval too.
  await fixes.undo(db,ctx,autoMerge.id,{confirmed:'yes'});
  assert.equal((await skuRow(supB.sku)).is_active,'1');
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(approve(bad.sku,'SKU'),/watch-only mode/);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // The routine is queued once a day, and the pages render.
  assert.equal((await fixes.schedule(db,ws,'cycle-1')).queued,true);
  assert.equal((await fixes.schedule(db,ws,'cycle-2')).queued,false);
  const custom=await browser.get(fixes.path).expect(200);
  for(const marker of ['data-catalog-waiting','data-catalog-done','data-catalog-limit="MERGE"','data-catalog-limit="COST"'])assert.ok(custom.text.includes(marker),marker);
  assert.match((await browser.get('/autopilot/reviews/catalog-fixes').expect(200)).text,/Open the bulk fix list/);
  assert.match((await browser.get(fixes.path+'?kind=SKU').expect(200)).text,/NEW CODE/);

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+fixes.path);
    assert(await view.getByRole('heading',{name:'Fix product data',exact:true}).isVisible());
    assert(await view.getByRole('button',{name:'Approve the ticked fixes'}).isVisible());
    assert(await view.getByRole('heading',{name:'Fixes it makes on its own'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.screenshot({path:require('node:path').join(folder,'catalog-fixes-'+name+'.png'),fullPage:true});
    await view.close();
  }
});

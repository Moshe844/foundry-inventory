'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t,tier){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await f.subscribe(tier);
 const locations=require('../../src/domain/postgres-location-service'),engine=require('../../src/domain/postgres-inventory-engine'),costing=require('../../src/accounting/postgres-costing'),catalog=require('../../src/domain/postgres-catalog-service');
 const bin=(name,barcode)=>locations.createLocation(db,ctx,{name,kind:'bin',parentLocationId:f.location.id,barcode});
 const a=await bin('Shelf A','BIN-A'),b=await bin('Shelf B','BIN-B'),c=await bin('Shelf C','BIN-C');
 await db.query("UPDATE skus SET barcode='MIX-ITEM' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.item.skuIds[0]]);await db.query("UPDATE locations SET barcode='DOCK' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.location.id]);
 await db.transaction(async x=>{const moved=await engine.transferInTransaction(x,ctx,{skuId:f.item.skuIds[0],sourceLocationId:f.location.id,destinationLocationId:a.id,quantity:20,idempotencyKey:'seed-shelf-a'});await costing.transferInTransaction(x,ctx,{...moved,sourceType:'fixture',sourceRecordId:'seed-shelf-a'});},{isolation:'SERIALIZABLE'});
 const service=require('../../src/warehouse/agent-bin-corrections'),sku=f.item.skuIds[0];
 const report=(found,recorded,extra={},who=ctx)=>service.report(db,who,{requestKey:randomUUID(),productCode:'MIX-ITEM',foundCode:'BIN-B',foundCount:String(found),recordedCode:'BIN-A',recordedCount:String(recorded),...extra});
 const mix=async(q,to='BIN-B',who=ctx)=>{const toId=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND barcode=$2',[ctx.workspaceId,to])).rows[0].id;return service.report(db,who,{requestKey:randomUUID(),productCode:'MIX-ITEM',foundCode:to,foundCount:String(await at(toId)+q),recordedCode:'BIN-A',recordedCount:String(await at(a.id)-q)});};
 const at=async(locationId,skuId=sku)=>Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,locationId])).rows[0]?.on_hand||0);
 const totals=async()=>{const r=(await db.query('SELECT sum(quantity_units)::text units,sum(total_cost_minor)::text cost FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];return {units:Number(r.units),cost:Number(r.cost)};};
 const row=id=>service.get(db,ctx,id),approve=async id=>service.approve(db,ctx,id,{confirmed:'yes',expectedFingerprint:(await row(id)).fingerprint});
 const configure=async(maximumUnits,maximumValue='')=>{const revision=(await db.query('SELECT revision FROM stockchief_runtime.agent_bin_correction_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.revision||0;return service.configure(db,ctx,{maximumUnits,maximumValue,confirmed:'yes',revision});};
 const mode=async m=>{const revision=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=11',[ctx.workspaceId])).rows[0]?.revision||0;await require('../../src/autopilot/job-modes').save(db,ctx,11,{mode:m,revision});};
 const audit=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ctx.workspaceId,action])).rows[0].n);
 const item=async(code,options)=>{const made=await catalog.createItem(db,ctx,{name:code+' goods',baseCode:code,...options});await db.query('UPDATE skus SET barcode=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,made.skuIds[0],code]);return made.skuIds[0];};
 const stock=(skuId,locationId,quantity,extra={})=>require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId,locationId,quantity,unitCost:'1.00',reference:'SEED',idempotencyKey:randomUUID(),...extra});
 const decline=id=>service.cancel(db,ctx,id,{confirmed:'yes'});
 return {...f,a,b,c,sku,service,report,mix,decline,at,totals,row,approve,configure,mode,audit,item,stock};
}
test('found-stock scans: Starter and Growth are locked, Pro proposes until taught, Custom corrects alone within unit and value limits, and records can be undone',{timeout:300000},async t=>{
 const f=await fixture(t,'starter'),{db,ctx,service,a,b,c}=f,before=await f.totals();
 for(const tier of ['starter','growth']){await f.subscribe(tier);await assert.rejects(f.report(2,18),e=>e.code==='entitlement_required');}
 await f.subscribe('pro');await f.configure(5,'4.00');
 await assert.rejects(f.report(2,19),/more than a bin mix-up/);await assert.rejects(f.report(0,20),/Record a stock count instead/);
 const first=await f.report(2,18);assert.equal(first.needsApproval,true,'Pro proposes until the owner teaches it');assert.equal(await f.at(a.id),20);assert.equal(await f.at(b.id),0);
 const pending=await f.row(first.id);assert.equal(pending.kind,'RECORD');assert.equal(pending.status,'SCANNED');assert.equal(pending.evidence.source,'scan');
 assert.equal((await require('../../src/domain/postgres-stock-availability').read(db,ctx.workspaceId,f.sku,a.id)).available,18,'The missing units are reserved so nobody picks them from the wrong bin');
 const done=await f.approve(first.id);assert.equal(done.automatic,false);assert.equal(await f.at(a.id),18);assert.equal(await f.at(b.id),2);assert.equal(await f.audit('Stock records moved to the bin where the stock was found'),1);
 await service.teach(db,ctx,first.id,{maximumUnits:3,confirmed:'yes',revision:0});
 const key=randomUUID(),again={requestKey:key,productCode:'MIX-ITEM',foundCode:'BIN-B',foundCount:'3',recordedCode:'BIN-A',recordedCount:'17'};
 assert.equal((await service.report(db,ctx,again)).automatic,true);assert.equal((await service.report(db,ctx,again)).replayed,true);assert.equal(await f.at(b.id),3);
 const costly=await f.mix(4);assert.equal(costly.needsApproval,true);assert.match(costly.reason,/lower owner-taught limit/);await f.decline(costly.id);assert.equal((await f.row(costly.id)).status,'CANCELLED');
 assert.equal((await require('../../src/domain/postgres-stock-availability').read(db,ctx.workspaceId,f.sku,a.id)).available,await f.at(a.id),'Declining releases the held units');
 await f.configure(5,'2.00');const valued=await f.mix(3);assert.equal(valued.needsApproval,true);assert.match(valued.reason,/value limit/);await f.decline(valued.id);
 await f.subscribe('enterprise');await f.configure(5,'10.00');const fresh=await f.mix(2,'BIN-C');
 assert.equal(fresh.automatic,true,'Custom corrects a new scope without teaching');assert.equal(await f.at(c.id),2);
 await f.mode('ask');const asked=await f.mix(1,'BIN-C');assert.equal(asked.needsApproval,true);assert.match(asked.reason,/Ask me first/);await f.decline(asked.id);
 await f.mode('watch');await assert.rejects(f.mix(1,'BIN-C'),/Watch only/);await f.mode('routine');
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);const paused=await f.mix(1,'BIN-C');assert.equal(paused.needsApproval,true);assert.match(paused.reason,/paused/);await f.decline(paused.id);await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(f.mix(1,'BIN-C'),/watching/);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const beforeUndo={a:await f.at(a.id),c:await f.at(c.id)};const undone=await service.undo(db,ctx,fresh.id,{confirmed:'yes'});assert.equal(await f.at(c.id),beforeUndo.c-2);assert.equal(await f.at(a.id),beforeUndo.a+2);
 assert.equal((await f.row(fresh.id)).status,'UNDONE');assert.equal((await service.undo(db,ctx,fresh.id,{confirmed:'yes'})).replayed,true);assert.equal((await require('../../src/transfers/postgres-transfer-service').verify(db,ctx.workspaceId,undone.transferId)).ok,true);
 assert.equal(await f.audit('Bin correction undone'),1);assert.deepEqual(await f.totals(),before,'Moving records between bins never creates or loses stock value');
 assert.equal(Number((await db.query("SELECT count(*) n FROM movements WHERE workspace_id=$1 AND operation='adjust'",[ctx.workspaceId])).rows[0].n),0,'Corrections go through bin transfers, never write-offs');
});
test('reserved, picked, counted, batch and serial stock waits for a person, who can still approve it',{timeout:300000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service,a,b,c}=f,transfers=require('../../src/transfers/postgres-transfer-service');await f.configure(10,'100.00');
 const hold=await transfers.request(db,ctx,{fromLocationId:a.id,toLocationId:c.id,idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantity:19}]});
 const reserved=await f.report(2,18);assert.equal(reserved.needsApproval,true);assert.match(reserved.reason,/reserved/);assert.equal((await f.row(reserved.id)).status,'PROPOSED');assert.equal(await f.at(b.id),0);
 await assert.rejects(f.approve(reserved.id),/enough free stock/);await transfers.cancel(db,ctx,hold.id,{idempotencyKey:randomUUID()});
 await f.approve(reserved.id);assert.equal(await f.at(b.id),2);assert.equal((await f.row(reserved.id)).status,'COMPLETED');
 const picking=await transfers.request(db,ctx,{fromLocationId:a.id,toLocationId:c.id,idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantity:1}]});await transfers.approve(db,ctx,picking.id,{idempotencyKey:randomUUID()});
 const picked=await f.mix(1);assert.equal(picked.needsApproval,true);assert.match(picked.reason,/being picked/);await transfers.cancel(db,ctx,picking.id,{idempotencyKey:randomUUID()});await f.approve(picked.id);assert.equal(await f.at(b.id),3);assert.equal(await f.at(a.id),17);
 await require('../../src/operations/postgres-count-reviews').prepare(db,ctx,{locationId:c.id,lines:[{skuId:f.sku,quantity:'0'}]});
 const counting=await f.mix(1,'BIN-C');assert.equal(counting.needsApproval,true);assert.match(counting.reason,/count is in progress/);
 const batch=await f.item('MIX-BATCH',{trackingMode:'lot'});await f.stock(batch,a.id,5,{lotCode:'LOT-9'});
 const lot=await service.report(db,ctx,{requestKey:randomUUID(),productCode:'MIX-BATCH',lotCode:'LOT-9',foundCode:'BIN-B',foundCount:'2',recordedCode:'BIN-A',recordedCount:'3'});assert.equal(lot.needsApproval,true);assert.match(lot.reason,/batch or serial/);
 await f.approve(lot.id);assert.equal(Number((await db.query("SELECT lb.quantity FROM lot_balances lb JOIN lots l ON l.id=lb.lot_id WHERE lb.workspace_id=$1 AND lb.location_id=$2 AND l.code='LOT-9'",[ctx.workspaceId,b.id])).rows[0].quantity),2);
 const serialSku=await f.item('MIX-SERIAL',{trackingMode:'serial'});await f.stock(serialSku,a.id,2,{serials:['MX-1','MX-2']});
 const serial=await service.report(db,ctx,{requestKey:randomUUID(),productCode:'MIX-SERIAL',foundCode:'BIN-B',recordedCode:'BIN-A',serials:'MX-2'});assert.equal(serial.needsApproval,true);
 await f.approve(serial.id);const where=async s=>(await db.query('SELECT location_id FROM serial_units WHERE workspace_id=$1 AND serial=$2',[ctx.workspaceId,s])).rows[0].location_id;
 assert.equal(await where('MX-2'),b.id);assert.equal(await where('MX-1'),a.id);await service.undo(db,ctx,serial.id,{confirmed:'yes'});assert.equal(await where('MX-2'),a.id);
 await assert.rejects(service.report(db,ctx,{requestKey:randomUUID(),productCode:'MIX-SERIAL',foundCode:'BIN-B',recordedCode:'BIN-C',serials:'MX-1'}),/not recorded in Shelf C/);
 await f.decline(counting.id);assert.equal((await f.row(counting.id)).status,'CANCELLED');assert.equal(await f.at(c.id),0);
 assert.equal((await require('../../src/domain/postgres-stock-availability').read(db,ctx.workspaceId,f.sku,a.id)).available,await f.at(a.id),'Declining a waiting correction releases the units it held');
});
test('two counts showing one bin short by what another has extra become a bin correction instead of a write-off',{timeout:300000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service,a,b,c}=f,counts=require('../../src/operations/postgres-count-reviews');await f.configure(5,'10.00');
 const count=(location,quantity)=>counts.prepare(db,ctx,{locationId:location.id,lines:[{skuId:f.sku,quantity:String(quantity),unitCost:'1.00'}]});
 const short=await count(a,17),over=await count(b,3);assert.equal(await f.at(a.id),17);assert.equal(await f.at(b.id),3);
 const made=(await db.query("SELECT * FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1 AND kind='RECORD'",[ctx.workspaceId])).rows;assert.equal(made.length,1);assert.equal(made[0].status,'COMPLETED');assert.equal(made[0].automatic,true);assert.deepEqual(made[0].evidence.reviews.sort(),[short.id,over.id].sort());
 for(const id of [short.id,over.id]){const r=await counts.get(db,ctx,id);assert.equal(r.status,'COMPLETED');assert.equal(r.result.binCorrectionId,made[0].id);}
 assert.equal(Number((await db.query("SELECT count(*) n FROM movements WHERE workspace_id=$1 AND operation='adjust'",[ctx.workspaceId])).rows[0].n),0,'No write-off or found-stock adjustment was posted');
 const odd=await count(a,15),bigger=await count(c,3);assert.equal(await f.at(c.id),0,'Unequal counts are a count difference, not a bin mix-up');
 for(const id of [odd.id,bigger.id])assert.equal((await counts.get(db,ctx,id)).status,'PENDING');
});
test('a count pair on untaught Pro waits for the owner and holds both counts until the correction is settled',{timeout:300000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx,service,a,b}=f,counts=require('../../src/operations/postgres-count-reviews');await f.configure(5,'10.00');
 const count=(location,quantity)=>counts.prepare(db,ctx,{locationId:location.id,lines:[{skuId:f.sku,quantity:String(quantity),unitCost:'1.00'}]});
 const short=await count(a,18),over=await count(b,2),made=(await db.query("SELECT id,status FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1",[ctx.workspaceId])).rows;
 assert.equal(made.length,1);assert.equal(made[0].status,'SCANNED');assert.equal(await f.at(b.id),0);
 await assert.rejects(counts.approve(db,ctx,short.id,(await counts.get(db,ctx,short.id)).integrity_hash),/Settle its bin correction first/);
 await f.approve(made[0].id);assert.equal(await f.at(b.id),2);assert.equal(await f.at(a.id),18);for(const id of [short.id,over.id])assert.equal((await counts.get(db,ctx,id)).status,'COMPLETED');
});
test('a put-away scanned into another bin is moved to the planned bin: Custom opens the move, untaught Pro proposes it, Growth only records it',{timeout:300000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service,a,b}=f,putaway=require('../../src/warehouse/agent-putaway');await f.configure(5,'10.00');
 async function receive(quantity=2){
  const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.sku,quantityUnits:quantity,unitCost:1}]});
  await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  const r=await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity,locationId:f.location.id}]});
  return (await db.query('SELECT id FROM purchase_order_receipt_lines WHERE workspace_id=$1 AND receipt_id=$2',[ctx.workspaceId,r.receiptId])).rows[0].id;
 }
 const wrongPutaway=async()=>{const plan=await putaway.prepare(db,ctx,await receive(),a.id);const done=await putaway.confirm(db,ctx,plan.id,{requestKey:randomUUID(),method:'scan',productCode:'MIX-ITEM',binCode:'BIN-B',wrongBin:'yes'});assert.equal(done.wrongBin,true);
  return (await db.query("SELECT * FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1 AND evidence->>'confirmationId'=$2",[ctx.workspaceId,done.id])).rows[0];};
 const scanMove=async id=>{const r=await f.row(id);return service.scan(db,ctx,id,{productCode:r.source.productBarcode,fromCode:r.source.from.barcode,toCode:r.source.to.barcode,quantity:r.source.quantity,confirmed:'yes',expectedFingerprint:r.fingerprint});};
 const custom=await wrongPutaway();assert.equal(custom.kind,'MOVE');assert.equal(custom.status,'OPEN');assert.equal(custom.source.from.id,b.id);assert.equal(custom.source.to.id,a.id);assert.equal(await f.at(b.id),2);
 assert.equal((await scanMove(custom.id)).automatic,true);assert.equal(await f.at(b.id),0);assert.equal(await f.at(a.id),22);
 await f.subscribe('pro');const proposed=await wrongPutaway();assert.equal(proposed.status,'PROPOSED');assert.equal(await f.at(b.id),2);
 await assert.rejects(scanMove(proposed.id),/owner must approve this move/);assert.equal((await f.approve(proposed.id)).opened,true);
 const moved=await scanMove(proposed.id);assert.equal(moved.automatic,false);assert.equal(await f.at(b.id),0);assert.equal(await f.at(a.id),24);
 await f.subscribe('growth');const before=Number((await db.query('SELECT count(*) n FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 assert.equal(await wrongPutaway(),undefined);assert.equal(await f.at(b.id),2,'Growth records where the goods went');assert.equal(Number((await db.query('SELECT count(*) n FROM stockchief_runtime.agent_bin_corrections WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),before);
});
test('bin correction pages render on a phone and at desktop width, with the plan lock on lower plans',{timeout:300000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,b}=f;await f.configure(5,'10.00');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),chrome=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 for(const [width,height,mobile] of [[1440,900,false],[390,844,true]]){
  const page=await chrome.newPage({viewport:{width,height},isMobile:mobile,hasTouch:mobile});page.setDefaultTimeout(15000);
  await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(base+'/warehouse/bin-corrections/found');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),width+' px found-stock form fits');
  const inB=await f.at(b.id),inA=await f.at(f.a.id);
  await page.getByLabel('Product code').fill('MIX-ITEM');await page.getByLabel('Bin where you found it').fill('BIN-B');await page.getByLabel('Units you counted there').fill(String(inB+1));
  await page.getByLabel('Bin the records show').fill('BIN-A');await page.getByLabel('Units you counted in that bin').fill(String(inA-1));
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Report stock in the wrong bin',exact:true}).click()]);
  assert.match(await page.locator('main').innerText(),/Completed/);assert.match(await page.locator('main').innerText(),/Records follow the stock/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),width+' px correction fits');await page.screenshot({path:path.join(folder,'bin-found-'+width+'.png'),fullPage:true});
  await page.getByLabel('I want the stock records moved back to where they were.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Undo this correction',exact:true}).click()]);
  assert.match(await page.locator('main').innerText(),/Undone/);await page.close();
 }
 await f.subscribe('growth');const locked=await f.browser.get('/warehouse/bin-corrections/found').expect(200);assert.match(locked.text,/need Pro/);assert(!locked.text.includes('Report stock in the wrong bin</button>'));
});

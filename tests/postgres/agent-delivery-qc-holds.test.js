'use strict';process.env.NODE_ENV='test';
// Job 51 end to end: per-plan QC hold authority, supplier-wide and
// product-wide rules, tracked and measured goods, release on a person's pass,
// failed goods written off by the owner, and every stop condition.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-quality-fixture');
const catalog=require('../../src/domain/postgres-catalog-service'),availability=require('../../src/domain/postgres-stock-availability');
const jobModes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),returnHolds=require('../../src/operations/postgres-return-holds');
const pass=(revision=1,count=2)=>({revision,decision:'PASS',physicallyChecked:'yes',checks:Array.from({length:count},(_,i)=>String(i))});
async function staff(f){
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(f.db,{name:'QC receiver',businessName:'Receiver home '+randomUUID().slice(0,8),email:randomUUID()+'@example.test',password:'Staff!'+randomUUID()}),id=randomUUID();
 await f.db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,'QC receiver','staff',$4,NULL,now())",
  [id,f.ctx.workspaceId,other.accountId,JSON.stringify(['VIEW','OPERATE','VIEW_PURCHASING','RECEIVE_PO'])]);
 return {workspaceId:f.ctx.workspaceId,actorId:id};
}
async function purchase(f,lines,supplierId='fixture-supplier'){
 const p=await f.workflows.createPurchaseOrder(f.db,f.ctx,{supplierId,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines});
 await f.workflows.approvePurchaseOrder(f.db,f.ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(f.db,f.ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});return p;
}
const take=(f,po,input={},ctx=f.ctx)=>f.workflows.receivePurchaseOrder(f.db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:po.quantity,locationId:f.location.id}],...input});
const receive=(f,p,lines,input={},ctx=f.ctx)=>f.workflows.receivePurchaseOrder(f.db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID(),lines:p.lineIds.map((lineId,i)=>({lineId,locationId:f.location.id,...lines[i]})),...input});
const audits=async(f,action)=>(await f.db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[f.ctx.workspaceId,action])).rows[0].n;
const free=async(f,skuId,options={})=>Number((await availability.read(f.db,f.ctx.workspaceId,skuId,f.location.id,options)).available);
async function product(f,options){return (await catalog.createItem(f.db,f.ctx,{name:options.name,baseCode:options.code+'-'+randomUUID().slice(0,6),...options})).skuIds[0];}

test('each plan follows its QC mode: Starter refused, Growth suggests until taught by a saved rule or completed example, Pro and Custom hold alone',{timeout:420000},async t=>{
 const f=await fixture(t,'growth'),{db,ctx,quality}=f,s=await staff(f);await f.subscribe('starter');
 await assert.rejects(quality.save(db,ctx,{supplierName:'Fixture parts',checklist:['Check seals'],maxUnits:10,confirmed:'yes'}),/Growth/);
 await f.subscribe('growth');
 await assert.rejects(quality.save(db,ctx,{checklist:['Check seals'],maxUnits:10,confirmed:'yes'}),/supplier, a product or both/);
 const supplierRule=await quality.save(db,ctx,{supplierName:'Fixture parts',checklist:['Check seals','Count cartons'],maxUnits:20,confirmed:'yes'});
 assert.equal((await f.rule(supplierRule.id)).sku_id,null);assert.equal((await f.rule(supplierRule.id)).location_id,null);
 // Untaught Growth suggests the hold; the goods stay available until the owner decides.
 let r=await take(f,await f.order(10),{},s);const suggestion=r.qualitySuggestionIds[0];
 assert.equal(r.qualityHoldIds,undefined);assert.equal((await f.available()).available,18);
 assert.match((await f.hold(suggestion)).proposal_reason,/teach/);
 assert.match((await quality.inbox(db,ctx.workspaceId,ctx.actorId)).find(i=>i.sourceId==='delivery-quality:'+suggestion).title,/Suggested QC hold/);
 await assert.rejects(quality.decide(db,s,suggestion,{revision:1,decision:'hold'}),/Only the inventory owner/);
 await quality.decide(db,ctx,suggestion,{revision:1,decision:'hold'});assert.equal((await f.available()).available,8);
 assert.equal((await quality.decide(db,ctx,suggestion,{revision:1,decision:'hold'})).replayed,true);
 // The person who inspects releases a pass on Growth.
 const first=await quality.inspect(db,s,suggestion,pass(2));assert.deepEqual([first.released,first.byRule],[true,false]);
 assert.equal((await f.hold(suggestion)).released_by,s.actorId);assert.equal((await f.available()).available,18);
 // Teaching from that completed example lets Growth hold on its own.
 await quality.configure(db,ctx,supplierRule.id,{revision:1,confirmed:'yes',exampleId:suggestion});
 assert.equal((await f.rule(supplierRule.id)).trained_hold_id,suggestion);
 r=await take(f,await f.order(10),{},s);const taught=r.qualityHoldIds[0];assert.equal((await f.hold(taught)).automatic,true);assert.equal((await f.available()).available,18);
 // A saved product rule on Growth teaches it too; the more specific rule wins for any supplier.
 const gasket=await product(f,{name:'Gasket',code:'QC-GASKET',trackingMode:'quantity'}),code=(await db.query('SELECT code FROM skus WHERE id=$1',[gasket])).rows[0].code;
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('second-supplier',$1,'Second parts','active','USD',now()::text,now()::text)",[ctx.workspaceId]);
 const productRule=await quality.save(db,ctx,{skuCode:code,checklist:['Measure the gasket'],maxUnits:5,mode:'automatic',confirmed:'yes'});
 for(const supplierId of ['second-supplier','fixture-supplier']){
  const g=await receive(f,await purchase(f,[{skuId:gasket,quantityUnits:3,unitCost:2}],supplierId),[{quantity:3}]);
  const h=await f.hold(g.qualityHoldIds[0]);assert.deepEqual([h.policy_id,h.automatic,h.status],[productRule.id,true,'HELD']);
 }
 assert.equal(await free(f,gasket),0);
 // Starter after a downgrade: new deliveries are not held, but existing holds can be finished.
 await f.subscribe('starter');
 r=await take(f,await f.order(5),{},s);const notHeld=await f.hold(r.qualityNotHeldIds[0]);
 assert.equal(notHeld.status,'NOT_HELD');assert.match(notHeld.proposal_reason,/Growth/);assert.equal((await f.available()).available,23);
 await assert.rejects(quality.save(db,ctx,{skuCode:code,locationName:f.location.name,checklist:['Check'],maxUnits:2,confirmed:'yes'}),/Growth/);
 assert.equal((await quality.inspect(db,s,taught,pass())).released,true);assert.equal((await f.available()).available,33);
 // Pro holds under the owner's rule and releases a staff pass by that rule.
 await f.subscribe('pro');
 r=await take(f,await f.order(5),{},s);const pro=r.qualityHoldIds[0];assert.equal((await f.hold(pro)).automatic,true);
 const released=await quality.inspect(db,s,pro,pass());assert.deepEqual([released.released,released.byRule],[true,true]);
 assert.equal((await f.hold(pro)).released_by,ctx.actorId);assert.equal((await f.hold(pro)).released_by_rule,true);
 // Custom uses an explicit rule without training at one location.
 await f.subscribe('enterprise');
 const valve=await product(f,{name:'Valve',code:'QC-VALVE',trackingMode:'quantity'});
 await quality.save(db,ctx,{skuId:valve,locationId:f.location.id,checklist:['Pressure test'],maxUnits:4,mode:'automatic',confirmed:'yes'});
 const v=await receive(f,await purchase(f,[{skuId:valve,quantityUnits:4,unitCost:3}],'second-supplier'),[{quantity:4}]);
 assert.equal((await f.hold(v.qualityHoldIds[0])).automatic,true);assert.equal(await free(f,valve),0);
 assert.equal((await quality.inspect(db,ctx,v.qualityHoldIds[0],pass(1,1))).byRule,true);assert.equal(await free(f,valve),4);
 for(const action of ['QC hold suggested for received goods','Suggested QC hold approved by owner','Passed delivery released by the inspector','Passed delivery released by the owner’s QC rule','Routine delivery QC authorized','Received goods not held: QC is not on this plan'])
  assert(await audits(f,action)>0,action);
 const digest=await require('../../src/autopilot/agent-work-digest').report(db,ctx,{filter:(await require('../../src/lib/business-time').forWorkspace(db,ctx.workspaceId)).calendarDate});
 assert(digest.rows.some(row=>/Released passed QC goods under your rule/.test(row.Action)));
});

test('held batches, serial units and measured goods stay out of sales, moves and channels; passes release and owner write-offs post as damaged stock',{timeout:420000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx,quality}=f,ws=ctx.workspaceId,loc=f.location.id,s=await staff(f);
 const lot=await product(f,{name:'Batch syrup',code:'QC-LOT',trackingMode:'lot'}),serial=await product(f,{name:'Serial pump',code:'QC-SERIAL',trackingMode:'serial'});
 const weight=await product(f,{name:'Cheese wheel',code:'QC-WEIGHT',trackingMode:'quantity',unitLabel:'wheel',secondaryUnitLabel:'kg'});
 const cloth=await product(f,{name:'Cloth roll',code:'QC-CLOTH',trackingMode:'quantity',unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'});
 // Older released stock exists before the rule.
 await receive(f,await purchase(f,[{skuId:lot,quantityUnits:3,unitCost:2},{skuId:serial,quantityUnits:1,unitCost:5}]),[{quantity:3,lotCode:'OLD-BATCH'},{quantity:1,serials:['OLD-PUMP']}]);
 await quality.save(db,ctx,{supplierId:'fixture-supplier',locationId:loc,checklist:['Check seals','Check labels'],maxUnits:10,mode:'automatic',confirmed:'yes'});
 const p=await purchase(f,[{skuId:lot,quantityUnits:4,unitCost:2},{skuId:serial,quantityUnits:2,unitCost:5},{skuId:weight,quantityUnits:2,secondaryQuantity:'3.5',unitCost:4},{skuId:cloth,quantityUnits:'2.5',unitCost:1}]);
 const r=await receive(f,p,[{quantity:4,lotCode:'NEW-BATCH'},{quantity:2,serials:['NEW-PUMP-1','NEW-PUMP-2']},{quantity:2,secondaryQuantity:'3.5'},{quantity:'2.5'}]);
 assert.equal(r.qualityHoldIds.length,4);
 const holds=new Map((await db.query('SELECT * FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND id=ANY($2)',[ws,r.qualityHoldIds])).rows.map(h=>[h.sku_id,h]));
 const lotIds=Object.fromEntries((await db.query('SELECT code,id FROM lots WHERE workspace_id=$1 AND sku_id=$2',[ws,lot])).rows.map(l=>[l.code,l.id]));
 const pumps=Object.fromEntries((await db.query('SELECT serial,id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2',[ws,serial])).rows.map(u=>[u.serial,u.id]));
 assert.equal(holds.get(lot).lot_id,lotIds['NEW-BATCH']);assert.deepEqual(holds.get(serial).serial_unit_ids,[pumps['NEW-PUMP-1'],pumps['NEW-PUMP-2']].sort());
 assert.equal(holds.get(cloth).quantity,'2.500000');
 // Nothing held is available, reservable, movable or offered on a sales channel.
 assert.equal(await free(f,lot),3);assert.equal(await free(f,lot,{lotId:lotIds['NEW-BATCH']}),0);assert.equal(await free(f,lot,{lotId:lotIds['OLD-BATCH']}),3);
 assert.equal((await returnHolds.heldLots(db,ws,lot,loc)).get(lotIds['NEW-BATCH']),4);
 assert.equal((await require('../../src/connections/postgres-commerce-sync').local(db,{workspace_id:ws,sku_id:lot,location_id:loc,field:'quantity',id:'no-channel-position'})).value,3);
 await assert.rejects(f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:lot,locationId:loc,quantity:1,lotId:lotIds['NEW-BATCH']}),/inspection/);
 await assert.rejects(f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:serial,locationId:loc,quantity:1,serialUnitIds:[pumps['NEW-PUMP-1']]}),/held for delivery QC/);
 assert.equal(await free(f,cloth),0);assert.equal(await free(f,weight),0);
 // Batch: two units fail and the owner writes them off; the inspector passes the rest.
 const lotHold=holds.get(lot).id;
 await quality.inspect(db,s,lotHold,{revision:1,decision:'FAIL',physicallyChecked:'yes',note:'Two bottles leaked',damagedQuantity:'2'});
 const key=randomUUID(),off={requestKey:key,quantity:'2',note:'Leaking bottles',confirmed:'yes'};
 await assert.rejects(quality.writeOff(db,s,lotHold,off),/Only the inventory owner/);
 await assert.rejects(quality.writeOff(db,ctx,lotHold,{...off,requestKey:randomUUID(),quantity:'5'}),/at most the 4/);
 const written=await quality.writeOff(db,ctx,lotHold,off);assert.equal(written.valueMinor,400);
 assert.equal((await quality.writeOff(db,ctx,lotHold,off)).replayed,true);
 const journal=(await db.query(`SELECT a.system_key,l.debit_minor::int debit FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id WHERE l.workspace_id=$1 AND l.entry_id=$2 AND l.debit_minor>0`,[ws,written.journalEntryId])).rows;
 assert.deepEqual(journal,[{system_key:'INVENTORY_ADJUSTMENTS',debit:400}]);
 assert.equal(Number((await db.query('SELECT quantity FROM lot_balances WHERE workspace_id=$1 AND lot_id=$2 AND location_id=$3',[ws,lotIds['NEW-BATCH'],loc])).rows[0].quantity),2);
 assert.equal(await free(f,lot,{lotId:lotIds['NEW-BATCH']}),0);
 assert.equal((await quality.inspect(db,s,lotHold,pass(3))).released,true);assert.equal(await free(f,lot,{lotId:lotIds['NEW-BATCH']}),2);assert.equal(await free(f,lot),5);
 // Serial: one exact unit is written off, the other passes and can then be sold.
 const serialHold=holds.get(serial).id;
 await quality.inspect(db,ctx,serialHold,{revision:1,decision:'FAIL',physicallyChecked:'yes',note:'Cracked housing'});
 await assert.rejects(quality.writeOff(db,ctx,serialHold,{requestKey:randomUUID(),quantity:'1',serialUnitIds:[pumps['OLD-PUMP']],note:'Cracked',confirmed:'yes'}),/exact held serial/);
 await quality.writeOff(db,ctx,serialHold,{requestKey:randomUUID(),quantity:'1',serialUnitIds:[pumps['NEW-PUMP-1']],note:'Cracked housing',confirmed:'yes'});
 assert.equal((await db.query('SELECT status FROM serial_units WHERE id=$1',[pumps['NEW-PUMP-1']])).rows[0].status,'issued');
 await assert.rejects(f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:serial,locationId:loc,quantity:1,serialUnitIds:[pumps['NEW-PUMP-2']]}),/held for delivery QC/);
 await quality.inspect(db,ctx,serialHold,pass(3));
 await f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:serial,locationId:loc,quantity:1,serialUnitIds:[pumps['NEW-PUMP-2']],reasonCode:'sold'});
 // Measured: the actual weight is required and leaves stock with the units.
 const weightHold=holds.get(weight).id;
 await quality.inspect(db,ctx,weightHold,{revision:1,decision:'FAIL',physicallyChecked:'yes',note:'Mould on one wheel',damagedQuantity:'1'});
 await assert.rejects(quality.writeOff(db,ctx,weightHold,{requestKey:randomUUID(),quantity:'1',note:'Mould',confirmed:'yes'}),/kg/);
 await quality.writeOff(db,ctx,weightHold,{requestKey:randomUUID(),quantity:'1',secondaryQuantity:'1.75',note:'Mould',confirmed:'yes'});
 const wheel=(await db.query('SELECT on_hand::text,secondary_on_hand::text,quality_held::text FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ws,weight,loc])).rows[0];
 assert.deepEqual([Number(wheel.on_hand),Number(wheel.secondary_on_hand),Number(wheel.quality_held)],[1,1.75,1]);
 // Fractional: the exact decimal quantity is released on a pass.
 await quality.inspect(db,s,holds.get(cloth).id,pass());assert.equal(await free(f,cloth),2.5);
 assert.equal(Number((await db.query('SELECT sum(quality_held) n FROM balances WHERE workspace_id=$1',[ws])).rows[0].n),1);
 const page=await quality.page(db,ctx,{id:weightHold});assert.equal(page.selected.remaining,'1');assert.equal(page.writeoffs.length,1);
});

test('pause, watch, shadow, Ask me first and unit limits turn holds into suggestions; stale stock, replay and older writers stop safely',{timeout:420000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx,quality}=f,s=await staff(f),owner={role:'owner'};
 await quality.save(db,ctx,{...f.scope,mode:'automatic'});
 const suggest=async(pattern,input={})=>{const r=await take(f,await f.order(4),input,s);assert.equal(r.qualityHoldIds,undefined);const h=await f.hold(r.qualitySuggestionIds[0]);assert.match(h.proposal_reason,pattern);return h;};
 await jobModes.save(db,ctx,51,{mode:'ask',revision:0});const asked=await suggest(/Ask me first/);
 await quality.decide(db,ctx,asked.id,{revision:1,decision:'hold'});assert.equal((await f.available()).available,8);
 await jobModes.save(db,ctx,51,{mode:'watch',revision:1});const watched=await suggest(/Watch only/);
 await quality.decide(db,ctx,watched.id,{revision:1,decision:'skip'});assert.equal((await f.hold(watched.id)).status,'NOT_HELD');assert.equal((await f.available()).available,12);
 await jobModes.save(db,ctx,51,{mode:'inherit',revision:2});
 await autopilot.pause(db,ctx,owner,'QC pause test');await suggest(/paused/);
 const confirmed=await take(f,await f.order(4),{qcConfirmed:'yes'},s),manual=await f.hold(confirmed.qualityHoldIds[0]);
 assert.deepEqual([manual.automatic,manual.created_by,manual.status],[false,s.actorId,'HELD']);
 const pausedPass=await quality.inspect(db,s,manual.id,pass());assert.deepEqual([pausedPass.released,pausedPass.byRule],[true,false]);assert.match(pausedPass.reason,/paused/);
 await autopilot.resume(db,ctx,owner);
 await autopilot.setMode(db,ctx,owner,'OBSERVE');await suggest(/watch-only/);await autopilot.setMode(db,ctx,owner,'POLICY_AUTOMATED');
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await suggest(/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const over=await take(f,await f.order(11),{},s);assert.match((await f.hold(over.qualitySuggestionIds[0])).proposal_reason,/10-unit limit/);
 // Units sold after a suggestion: StockChief stops instead of holding other stock.
 const before=(await f.available()).available;
 await f.inventory.issue(db,ctx,{idempotencyKey:randomUUID(),skuId:f.scope.skuId,locationId:f.location.id,quantity:before-3,reasonCode:'sold'});
 await assert.rejects(quality.decide(db,ctx,over.qualitySuggestionIds[0],{revision:1,decision:'hold'}),/Only 3 of these 11 units are still free/);
 assert.equal((await f.hold(over.qualitySuggestionIds[0])).status,'PROPOSED');
 // A routine receipt holds alone again; replaying the same receipt adds nothing.
 const po=await f.order(4),input={idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:4,locationId:f.location.id}]};
 const auto=await f.workflows.receivePurchaseOrder(db,s,po.purchaseOrderId,input);assert.equal((await f.hold(auto.qualityHoldIds[0])).automatic,true);
 const count=async()=>(await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,n=await count();
 assert.equal((await f.workflows.receivePurchaseOrder(db,s,po.purchaseOrderId,input)).replayed,true);assert.equal(await count(),n);
 assert.equal((await quality.inspect(db,s,auto.qualityHoldIds[0],pass())).byRule,true);assert.equal((await quality.inspect(db,s,auto.qualityHoldIds[0],pass())).replayed,true);
 // Uninspected goods cannot be written off, and suggestions cannot be inspected.
 const held=await take(f,await f.order(2),{},s);await jobModes.save(db,ctx,51,{mode:'ask',revision:3});const proposed=await suggest(/Ask me first/);
 await assert.rejects(quality.writeOff(db,ctx,held.qualityHoldIds[0],{requestKey:randomUUID(),quantity:'1',note:'Not inspected',confirmed:'yes'}),/failed their physical inspection/);
 await assert.rejects(quality.inspect(db,s,proposed.id,pass()),/not on QC hold/);
 // An older receipt writer that skips QC cannot book a covered delivery.
 const apply=quality.applyReceipt;quality.applyReceipt=async()=>({held:[],suggested:[],notHeld:[]});
 try{await assert.rejects(take(f,await f.order(1),{},s),/Quality inspection hold required/);}finally{quality.applyReceipt=apply;}
 const rows=(await db.query("SELECT status,count(*)::int n FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 GROUP BY status ORDER BY status",[ctx.workspaceId])).rows;
 assert.deepEqual(rows.map(r=>r.status),['HELD','NOT_HELD','PASSED','PROPOSED']);
 assert(await audits(f,'Suggested QC hold declined by owner')>0);
});

test('upgrade keeps existing QC rules, holds and held stock, then finishes them with the new release rules',{timeout:300000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 const migrate=require('../../src/db/migrate-postgres').migratePostgres;await migrate(db,{through:'396-agent-supplier-price-updates.sql'});
 const before=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'QC upgrade owner',businessName:'QC upgrade stock',email:randomUUID()+'@example.test',password:'Upgrade!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Upgrade dock',kind:'warehouse'});
 const sku=(await catalog.createItem(db,ctx,{name:'Upgrade part',baseCode:'QC-UPGRADE-PART',trackingMode:'quantity'})).skuIds[0],workflows=require('../../src/operations/postgres-business-workflows');
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('upgrade-supplier',$1,'Upgrade parts','active','USD',now()::text,now()::text)",[ctx.workspaceId]);
 const p=await workflows.createPurchaseOrder(db,ctx,{supplierId:'upgrade-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:6,unitCost:1}]});
 await workflows.approvePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID()});
 await workflows.receivePurchaseOrder(db,ctx,p.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:p.lineIds[0],quantity:6,locationId:location.id}]});
 const line=(await db.query('SELECT id FROM purchase_order_receipt_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].id;
 await db.query(`INSERT INTO stockchief_runtime.agent_quality_policies(id,workspace_id,supplier_id,sku_id,location_id,checklist,max_units,authorized_by)
  VALUES('old-rule',$1,'upgrade-supplier',$2,$3,'["Check the carton"]',10,$4)`,[ctx.workspaceId,sku,location.id,ctx.actorId]);
 await db.query(`INSERT INTO stockchief_runtime.agent_quality_holds(id,workspace_id,policy_id,receipt_line_id,sku_id,location_id,quantity,policy_revision,checklist,created_by,automatic,returned_quantity)
  VALUES('old-hold',$1,'old-rule',$2,$3,$4,6,1,'["Check the carton"]',$5,false,1)`,[ctx.workspaceId,line,sku,location.id,ctx.actorId]);
 const held=async()=>Number((await db.query('SELECT quality_held FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,sku])).rows[0].quality_held);
 assert.equal(await held(),5);
 await migrate(db);
 const after=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 assert.deepEqual(after.filter(r=>before.some(b=>b.name===r.name)),before);assert(after.some(r=>r.name==='408-agent-quality-hold-scope.sql'));assert(after.some(r=>r.name==='409-agent-quality-writeoffs.sql'));
 assert.equal(await held(),5);
 const h=(await db.query("SELECT status,quantity::text,returned_quantity::text,written_off_quantity::text,serial_unit_ids FROM stockchief_runtime.agent_quality_holds WHERE id='old-hold'")).rows[0];
 assert.deepEqual(h,{status:'HELD',quantity:'6.000000',returned_quantity:'1.000000',written_off_quantity:'0.000000',serial_unit_ids:[]});
 await assert.rejects(db.query(`INSERT INTO stockchief_runtime.agent_quality_policies(id,workspace_id,supplier_id,sku_id,location_id,checklist,max_units,authorized_by)
  VALUES('duplicate-rule',$1,'upgrade-supplier',$2,$3,'["Again"]',10,$4)`,[ctx.workspaceId,sku,location.id,ctx.actorId]),/agent_quality_policy_exact_scope/);
 const quality=require('../../src/operations/agent-quality-holds');
 assert.equal((await quality.inspect(db,ctx,'old-hold',{revision:1,decision:'PASS',physicallyChecked:'yes',checks:['0']})).released,true);assert.equal(await held(),0);
});

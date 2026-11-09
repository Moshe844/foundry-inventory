'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t,{flat=false}={}){const f=await require('../helpers/postgres-shipping-fixture').fixture(t);await f.db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,'growth','approved-2026-11-02:growth','ACTIVE') ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),f.owner.accountId]);if(flat){
 // An existing agreement may predate the separate site/sublocation contract.
 await f.db.query(`INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters,configuration) SELECT 'fixture-removal-flat-growth',v.plan_id,(SELECT max(version_number)+1 FROM commercial_plan_versions WHERE plan_id='growth'),'RETIRED',v.currency,v.monthly_amount_minor,v.annual_amount_minor,v.entitlements,v.meters,v.configuration-'locationAccounting' FROM commercial_plan_versions v WHERE v.id='approved-2026-11-02:growth'`);await f.db.query("UPDATE account_subscriptions SET plan_version_id='fixture-removal-flat-growth' WHERE account_id=$1",[f.owner.accountId]);}return f;}

test('removing a product cannot write off supplier-owned consignment goods or strand its agreement counters',{timeout:240000},async t=>{
 const f=await fixture(t,{flat:true}),{db,ctx}=f;
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),custody=require('../../src/custody/postgres-service'),removal=require('../../src/domain/postgres-record-removal');
 const agreement=await custody.create(db,ctx,{kind:'CONSIGN_IN',supplierId:'fixture-supplier',inspectionParentLocationId:f.location.id,startDate:today,dueDate:today,requestKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:2,unitCostMinor:150,unitPriceMinor:200}]});
 await custody.operate(db,ctx,agreement.id,'receive_consigned',{confirmed:'yes',requestKey:randomUUID(),lineId:agreement.lines[0].id,quantity:2});
 const before=await f.balance(),preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId);
 await assert.rejects(removal.remove(db,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/consign|custody|agreement/i);
 assert.equal(await f.balance(),before);assert.equal(Number((await custody.get(db,ctx,agreement.id)).lines[0].external_quantity),2);assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],agreement.external_location_id])).rows[0].on_hand),2);
});

test('removing a product with physical units missing recorded stock cost is held instead of writing a zero-value loss',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Legacy units awaiting cost',baseCode:'UNCOSTED-'+randomUUID().slice(0,8),trackingMode:'quantity'});
 await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:item.skuIds[0],locationId:f.location.id,quantity:2,reference:'Recorded quantity with missing cost',idempotencyKey:randomUUID()});
 const removal=require('../../src/domain/postgres-record-removal'),before=await f.balance(),preview=await removal.review(db,ctx,{role:'owner'},'product',item.itemId);
 await assert.rejects(removal.remove(db,ctx,{role:'owner'},'product',item.itemId,{expectedHash:preview.hash}),/cost/i);assert.equal(await f.balance(),before);
});

test('a new sales reservation after deletion review is checked again inside the write transaction',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal'),preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance();let changed=false;
 const changing={query:(...a)=>db.query(...a),transaction:async(work,options)=>{if(!changed){changed=true;const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]});await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});}return db.transaction(work,options);}};
 await assert.rejects(removal.remove(changing,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/sales order|changed/i);assert.equal(await f.balance(),before);
});

test('a revoked owner cannot delete with an earlier cached owner role',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal'),preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance();let changed=false;
 const changing={query:(...a)=>db.query(...a),transaction:async(work,options)=>{if(!changed){changed=true;await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);}return db.transaction(work,options);}};
 await assert.rejects(removal.remove(changing,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/owner|allowed/i);assert.equal(await f.balance(),before);
});

async function recordedFreeReceipt(db,ctx,skuId,locationId){return db.transaction(async c=>{const m=await require('../../src/domain/postgres-inventory-engine').receiveInTransaction(c,ctx,{skuId,locationId,quantity:1,reference:'Confirmed zero-cost receipt fixture',idempotencyKey:randomUUID()});await require('../../src/accounting/postgres-costing').receiveInTransaction(c,ctx,{movementId:m.movementId,totalCostMinor:0,sourceType:'opening_inventory',sourceRecordId:randomUUID()});});}
test('new stock arriving after deletion review is retained and requires a new approval',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal'),preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance();let changed=false;
 const changing={query:(...a)=>db.query(...a),transaction:async(work,options)=>{if(!changed){changed=true;await recordedFreeReceipt(db,ctx,f.item.skuIds[0],f.location.id);}return db.transaction(work,options);}};
 await assert.rejects(removal.remove(changing,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/changed/i);assert.equal(await f.balance(),before+1);
});
test('genuinely recorded zero-cost owned stock can still be removed',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Recorded free goods',baseCode:'FREE-'+randomUUID().slice(0,8),trackingMode:'quantity'});await recordedFreeReceipt(db,ctx,item.skuIds[0],f.location.id);const removal=require('../../src/domain/postgres-record-removal'),preview=await removal.review(db,ctx,{role:'owner'},'product',item.itemId);assert.equal(preview.blockers.length,0);const result=await removal.remove(db,ctx,{role:'owner'},'product',item.itemId,{expectedHash:preview.hash});assert.equal(result.removed.valueMinor,0);assert.equal(result.removed.units,'1');
});

test('a future rental booking keeps its reserved product active and its stock intact',{timeout:240000},async t=>{
 const f=await fixture(t,{flat:true}),{db,ctx}=f,today=new Date().toISOString().slice(0,10),custody=require('../../src/custody/postgres-service'),removal=require('../../src/domain/postgres-record-removal');
 const a=await custody.create(db,ctx,{kind:'RENTAL',customerId:'fixture-customer',startDate:today,dueDate:today,requestKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:2,unitPriceMinor:0,unitCostMinor:0}]});
 await custody.operate(db,ctx,a.id,'schedule',{startsAt:new Date(Date.now()+3600000).toISOString(),endsAt:new Date(Date.now()+7200000).toISOString(),timeZone:'UTC',bufferMinutes:0,expectedRevision:0,lines:[{lineId:a.lines[0].id,locationId:f.location.id,quantity:2}],requestKey:randomUUID()});
 const preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance();await assert.rejects(removal.remove(db,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/rental|booking|agreement/i);assert.equal(await f.balance(),before);
});

test('active production keeps both its output and its committed component products available',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,service=require('../../src/manufacturing/postgres-service'),removal=require('../../src/domain/postgres-record-removal'),catalog=require('../../src/domain/postgres-catalog-service');
 const output=await catalog.createItem(db,ctx,{name:'Open production output',baseCode:'OPEN-PRODUCTION',trackingMode:'quantity'}),wip=await require('../../src/accounting/postgres-ledger').createAccount(db,ctx,{code:'1226',name:'Removal test work in progress',type:'ASSET'});await service.configure(db,ctx,{wipAccountId:wip.id});
 const bom=await service.createBom(db,ctx,{outputSkuId:output.skuIds[0],outputQuantity:1,components:[{skuId:f.item.skuIds[0],quantity:2}]});await service.activateBom(db,ctx,bom.id,{expectedHash:bom.integrity_hash});const job=await service.createWorkOrder(db,ctx,{bomId:bom.id,quantity:1,neededBy:new Date().toISOString().slice(0,10),requestKey:randomUUID()});
 await service.start(db,ctx,job.id,{idempotencyKey:randomUUID(),confirmed:'yes',materials:[{component:0,skuId:f.item.skuIds[0],locationId:f.location.id,quantity:2}]});
 for(const id of [output.itemId,f.item.itemId]){const preview=await removal.review(db,ctx,{role:'owner'},'product',id);await assert.rejects(removal.remove(db,ctx,{role:'owner'},'product',id,{expectedHash:preview.hash}),/production|work order|manufactur/i);}
 assert.equal((await service.getWorkOrder(db,ctx.workspaceId,job.id)).status,'IN_PROGRESS');
});

test('an approved transfer keeps its reserved product active until the transfer is resolved',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Transfer destination',kind:'warehouse'}),transfers=require('../../src/transfers/postgres-transfer-service'),removal=require('../../src/domain/postgres-record-removal');
 const transfer=await transfers.request(db,ctx,{fromLocationId:f.location.id,toLocationId:destination.id,lines:[{skuId:f.item.skuIds[0],quantity:1}],idempotencyKey:randomUUID()});await transfers.approve(db,ctx,transfer.id,{idempotencyKey:randomUUID()});
 const preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance();await assert.rejects(removal.remove(db,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/transfer/i);assert.equal(await f.balance(),before);
});

test('undoing an import cannot reverse a later fully received purchase as opening stock',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),removal=require('../../src/domain/postgres-record-removal');
 const plan=await imports.analyse(db,ctx,{text:'Product name,SKU,Location,Quantity,Unit cost\nImported later used,IMPORT-LATER,Dispatch,2,1.00',allowModel:false});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);assert((await imports.execute(db,ctx,plan.id)).verified);
 const sku=(await db.query("SELECT id FROM skus WHERE workspace_id=$1 AND code='IMPORT-LATER'",[ctx.workspaceId])).rows[0].id;
 const addReceipt=async()=>{const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:1,unitCost:2}]});await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'Actual later purchase',lines:[{lineId:po.lineIds[0],quantity:1,locationId:f.location.id}]});};
 const reviewed=await removal.review(db,ctx,{role:'owner'},'import',plan.id);assert.equal(reviewed.blockers.length,0);await removal.remove(db,ctx,{role:'owner'},'import',plan.id,{expectedHash:reviewed.hash});
 await addReceipt();const before=await f.balance(),job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='records.remove-import'",[ctx.workspaceId])).rows[0];
 await removal.runImportRemoval({workspaceId:ctx.workspaceId,payload:job.payload,attemptCount:1,maxAttempts:5},db);
 assert.equal(await f.balance(),before,'a delayed undo must preserve later receipts');assert.equal(Number((await db.query('SELECT is_active FROM skus WHERE id=$1',[sku])).rows[0].is_active),1);
 const now=await removal.review(db,ctx,{role:'owner'},'import',plan.id);assert(now.blockers.some(v=>/later|changed|opening/i.test(v)),'the owner is told to review later stock work separately');
});

function background(t,removal){const before=removal.settings.backgroundPositions;removal.settings.backgroundPositions=0;t.after(()=>{removal.settings.backgroundPositions=before;});}
test('background product removal rechecks the current owner before hiding the product',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal');background(t,removal);const preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId);let changed=false;
 const changing={query:(...a)=>db.query(...a),transaction:async(work,options)=>{if(!changed){changed=true;await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);}return db.transaction(work,options);}};
 await assert.rejects(removal.remove(changing,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash}),/owner|allowed/i);assert.equal(Number((await db.query('SELECT is_active FROM items WHERE id=$1',[f.item.itemId])).rows[0].is_active),1);
});
test('a background product worker cannot write off stock using a revoked owner',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal');background(t,removal);const preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance();await removal.remove(db,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash});const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='records.remove-product'",[ctx.workspaceId])).rows[0];await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 const result=await removal.runProductRemoval({workspaceId:ctx.workspaceId,payload:job.payload,attemptCount:1,maxAttempts:5},db);assert.equal(await f.balance(),before);assert.match(result.failed,/owner|allowed/i);assert.equal(Number((await db.query('SELECT is_active FROM items WHERE id=$1',[f.item.itemId])).rows[0].is_active),1);
});
test('a failed background removal restores only the variants that were previously active',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal'),item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Mixed active and archived variants',baseCode:'RESTORE-STATES',trackingMode:'quantity',hasVariants:true,options:[{name:'Style',values:'A,B'}]});background(t,removal);assert.equal(item.skuIds.length,2);await recordedFreeReceipt(db,ctx,item.skuIds[0],f.location.id);await db.query('UPDATE skus SET is_active=0 WHERE id=$1',[item.skuIds[1]]);const preview=await removal.review(db,ctx,{role:'owner'},'product',item.itemId);await removal.remove(db,ctx,{role:'owner'},'product',item.itemId,{expectedHash:preview.hash});const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='records.remove-product'",[ctx.workspaceId])).rows[0];let fail=true;
 const interrupted={query:(...a)=>db.query(...a),transaction:async(work,options)=>{if(fail){fail=false;throw new (require('../../src/domain/errors').ValidationError)('Synthetic current-state hold before the next write-off');}return db.transaction(work,options);}};
 assert.match((await removal.runProductRemoval({workspaceId:ctx.workspaceId,payload:job.payload,attemptCount:1,maxAttempts:5},interrupted)).failed,/current-state hold/);const states=(await db.query('SELECT id,is_active FROM skus WHERE workspace_id=$1 AND item_id=$2',[ctx.workspaceId,item.itemId])).rows;assert.equal(Number(states.find(r=>r.id===item.skuIds[0]).is_active),1);assert.equal(Number(states.find(r=>r.id===item.skuIds[1]).is_active),0,'a failure must not reactivate an older archived variant');
});

test('an older queued removal without variant states keeps its remaining stock and requires explicit variant review',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,removal=require('../../src/domain/postgres-record-removal');background(t,removal);const preview=await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId),before=await f.balance(),started=await removal.remove(db,ctx,{role:'owner'},'product',f.item.itemId,{expectedHash:preview.hash});await db.query("UPDATE record_removals SET summary=summary-'variantStatesRecorded'-'previouslyInactiveSkuIds' WHERE id=$1",[started.removalId]);const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='records.remove-product'",[ctx.workspaceId])).rows[0];let fail=true;
 const interrupted={query:(...a)=>db.query(...a),transaction:async(work,options)=>{if(fail){fail=false;throw new (require('../../src/domain/errors').ValidationError)('Synthetic paused legacy removal');}return db.transaction(work,options);}};
 assert.match((await removal.runProductRemoval({workspaceId:ctx.workspaceId,payload:job.payload,attemptCount:1,maxAttempts:5},interrupted)).failed,/older deletion record/);assert.equal(await f.balance(),before);assert.equal(Number((await db.query('SELECT is_active FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].is_active),0);assert.match((await removal.review(db,ctx,{role:'owner'},'product',f.item.itemId)).lastFailure,/older deletion record/);
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('READ COMMITTED retains stock, idempotency, supplier, price, catalogue, number and journal invariants',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const rc={...db,transaction:(fn,settings={})=>db.transaction(fn,{...settings,isolation:'READ COMMITTED',retrySafe:true})};
 const engine=require('../../src/domain/postgres-inventory-engine'),catalog=require('../../src/domain/postgres-catalog-service'),prices=require('../../src/pricing/postgres-service'),commerce=require('../../src/operations/postgres-commerce');
 const item=await catalog.createItem(db,ctx,{name:'Concurrent stock',baseCode:'RC-STOCK',trackingMode:'quantity'}),skuId=item.skuIds[0];
 const quantity=async()=>Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,skuId,f.location.id])).rows[0]?.on_hand||0);
 await engine.receive(rc,ctx,{skuId,locationId:f.location.id,quantity:10,idempotencyKey:'rc-opening'});
 await t.test('simultaneous issues use the guarded stock update and cannot overdraw',async()=>{
  const results=await Promise.allSettled(['a','b'].map(key=>engine.issue(rc,ctx,{skuId,locationId:f.location.id,quantity:6,idempotencyKey:'rc-issue-'+key})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(await quantity(),4);
  assert.equal((await db.query('SELECT count(*)::int n FROM balances WHERE workspace_id=$1 AND on_hand<0',[ctx.workspaceId])).rows[0].n,0);
 });
 await t.test('simultaneous receipt keys apply once and replay their original movement',async()=>{
  const input={skuId,locationId:f.location.id,quantity:3,idempotencyKey:'rc-same-receipt'},results=await Promise.all([engine.receive(rc,ctx,input),engine.receive(rc,ctx,input)]);
  assert.equal(results[0].movementId,results[1].movementId);assert.equal(await quantity(),7);
  const bulk=[{skuId,locationId:f.location.id,quantity:2,idempotencyKey:'rc-bulk-same'}];
  const attempts=await Promise.allSettled([rc.transaction(c=>engine.receiveManyInTransaction(c,ctx,bulk)),rc.transaction(c=>engine.receiveManyInTransaction(c,ctx,bulk))]);
  assert(attempts.some(r=>r.status==='fulfilled'));await rc.transaction(c=>engine.receiveManyInTransaction(c,ctx,bulk));assert.equal(await quantity(),9);
 });
 await t.test('supplier find-or-create has one database-owned identity across case variants',async()=>{
  const rows=await Promise.all(['Race supplier','RACE SUPPLIER'].map(name=>rc.transaction(c=>commerce.createSupplierInTransaction(c,ctx,{name,currency:'USD'},{reuseExisting:true}))));
  assert.equal(rows[0].id,rows[1].id);assert.equal((await db.query("SELECT count(*)::int n FROM suppliers WHERE workspace_id=$1 AND canonical_name='race supplier'",[ctx.workspaceId])).rows[0].n,1);
  await assert.rejects(commerce.createSupplier(rc,ctx,{name:'Race supplier'}),/already exists/);
 });
 await t.test('price and cost previews cannot both replace the same current version',async()=>{
  const price=await prices.setPrice(rc,ctx,{skuId,amount:'10',currency:'USD'});
  const changes=await Promise.allSettled(['11','12'].map(amount=>rc.transaction(c=>prices.setPriceInTransaction(c,ctx,{skuId,amount,currency:'USD',expectedCurrentId:price.id}))));
  assert.equal(changes.filter(r=>r.status==='fulfilled').length,1);assert.equal(changes.filter(r=>r.status==='rejected').length,1);
  const cost=await rc.transaction(c=>prices.setPurchaseCostInTransaction(c,ctx,{skuId,amount:'5',currency:'USD'}));
  const costs=await Promise.allSettled(['6','7'].map(amount=>rc.transaction(c=>prices.setPurchaseCostInTransaction(c,ctx,{skuId,amount,currency:'USD',expectedCurrentId:cost.id}))));
  assert.equal(costs.filter(r=>r.status==='fulfilled').length,1);assert.equal(costs.filter(r=>r.status==='rejected').length,1);
 });
 await t.test('first supplier links and preferred supplier changes lock the exact variant',async()=>{
  const supplier=await commerce.createSupplier(rc,ctx,{name:'Another concurrent supplier',currency:'USD'});
  await Promise.all(['fixture-supplier',supplier.id].map(supplierId=>rc.transaction(c=>commerce.linkSupplierItemsInTransaction(c,ctx,[{skuId,supplierId,isPreferred:true}]))));
  assert.equal((await db.query('SELECT count(*)::int n FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2 AND is_preferred=1',[ctx.workspaceId,skuId])).rows[0].n,1);
  const fresh=await catalog.createItem(db,ctx,{name:'Unlinked concurrent variant',baseCode:'RC-LINK',trackingMode:'quantity'});
  const results=await Promise.allSettled([1,2].map(()=>rc.transaction(c=>commerce.linkSupplierItemsInTransaction(c,ctx,[{skuId:fresh.skuIds[0],supplierId:supplier.id,expectAbsent:true}]))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 });
 await t.test('the catalogue session lock, import-plan row lock and unique bindings survive lower isolation',async()=>{
  const imports=require('../../src/imports/postgres-service'),settings=[];
  const scoped={...rc,withSessionLock:(key,fn)=>db.withSessionLock(key,locked=>fn({...locked,transaction:(fn,s={})=>{settings.push(s);return locked.transaction(fn,s);}}))};
  const plan=await imports.analyse(scoped,ctx,{text:'Product,SKU,Location,Quantity,Unit cost\nConcurrent stock,RC-STOCK,'+f.location.name+',1,1',importMode:'add',allowModel:false});
  await imports.approve(scoped,ctx,plan.id,plan.integrityHash);
  await db.withSessionLock('catalog:'+ctx.workspaceId,async()=>{await assert.rejects(imports.execute(scoped,ctx,plan.id),/already running/);});
  assert((await imports.execute(scoped,ctx,plan.id)).verified);assert.equal(await quantity(),10);
  assert(settings.some(s=>s.isolation==='READ COMMITTED'));assert(!settings.some(s=>s.isolation==='SERIALIZABLE'));
  const replay=await imports.execute(scoped,ctx,plan.id);assert(replay.duplicate||replay.replayed);assert.equal(await quantity(),10);
  const mismatch=(await db.query('SELECT entry_id FROM accounting_journal_lines WHERE workspace_id=$1 GROUP BY entry_id HAVING sum(debit_minor)<>sum(credit_minor)',[ctx.workspaceId])).rows;assert.deepEqual(mismatch,[]);
 });
 await t.test('concurrent documents allocate unique numbers atomically',async()=>{
  const wf=require('../../src/operations/postgres-business-workflows'),orders=await Promise.all(Array.from({length:8},(_,n)=>wf.createPurchaseOrder(rc,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:'rc-number-'+n,lines:[{skuId,quantityUnits:1,unitCost:1}]})));
  const rows=(await db.query('SELECT po_number FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,orders.map(o=>o.purchaseOrderId)])).rows;assert.equal(rows.length,8);assert.equal(new Set(rows.map(r=>r.po_number)).size,8);
 });
 await t.test('journal validation rolls back the stock write in the same transaction',async()=>{
  const ledger=require('../../src/accounting/postgres-ledger'),before=await quantity();
  await assert.rejects(rc.transaction(async c=>{
   await engine.receiveInTransaction(c,ctx,{skuId,locationId:f.location.id,quantity:1,idempotencyKey:'rc-unbalanced-receipt'});
   await ledger.postInTransaction(c,ctx,{sourceType:'manual',sourceKey:'rc-unbalanced',description:'Must roll back',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:100},{accountKey:'CASH',creditMinor:99}]});
  }),/not balanced/);
  assert.equal(await quantity(),before);
  assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key='rc-unbalanced-receipt'",[ctx.workspaceId])).rows[0].n,0);
  const input={sourceType:'manual',sourceKey:'rc-journal-idempotency',description:'One balanced entry',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:100},{accountKey:'CASH',creditMinor:100}]};
  const posted=await Promise.all([1,2].map(()=>rc.transaction(c=>ledger.postInTransaction(c,ctx,input))));
  assert.equal(posted[0].entry.id,posted[1].entry.id);
  assert.deepEqual((await db.query('SELECT entry_id FROM accounting_journal_lines WHERE workspace_id=$1 GROUP BY entry_id HAVING sum(debit_minor)<>sum(credit_minor)',[ctx.workspaceId])).rows,[]);
 });
});

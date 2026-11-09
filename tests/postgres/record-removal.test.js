'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// Delete means erase when nothing refers to a record, and archive when it has
// history. A deleted product's stock leaves the books as a recorded write-off;
// an undone import reverses the opening stock of the products it created.
test('deleting customers, suppliers, products and imports keeps stock, cost and the books in agreement',{timeout:300000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),locations=require('../../src/domain/postgres-location-service'),imports=require('../../src/imports/postgres-service');
 const removal=require('../../src/domain/postgres-record-removal'),owner={role:'owner'};
 const business=async name=>{const made=await auth.createBusiness(db,{name:'Owner',businessName:name,email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),ctx={workspaceId:made.workspaceId,actorId:made.userId};
  await locations.createLocation(db,ctx,{name:'Main Warehouse',kind:'warehouse'});await locations.createLocation(db,ctx,{name:'Back Room',kind:'store'});return ctx;};
 const csv=['Product name,SKU,Color,Location,Quantity,Unit cost',...Array.from({length:30},(_,n)=>['Gone product '+(n%6),'GP-'+n,['Red','Blue','Green','Black','White'][n%5],n%2?'Main Warehouse':'Back Room',3+n%7,(2+n%4)+'.50'].join(','))].join('\n');
 const load=async ctx=>{const plan=await imports.analyse(db,ctx,{text:csv,allowModel:false});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);assert((await imports.execute(db,ctx,plan.id)).verified);return plan;};
 const books=async ctx=>{
  const asset=(await db.query(`SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::bigint v FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id WHERE l.workspace_id=$1 AND a.system_key='INVENTORY_ASSET'`,[ctx.workspaceId])).rows[0].v;
  const costs=(await db.query('SELECT coalesce(sum(total_cost_minor),0)::bigint v FROM accounting_inventory_cost_balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].v;
  const drift=(await db.query(`SELECT count(*)::int n FROM balances b WHERE b.workspace_id=$1 AND b.on_hand<>(SELECT coalesce(sum(quantity_delta),0) FROM movements m WHERE m.sku_id=b.sku_id AND m.location_id=b.location_id)`,[ctx.workspaceId])).rows[0].n;
  const unbalanced=(await db.query(`SELECT count(*)::int n FROM(SELECT entry_id FROM accounting_journal_lines WHERE workspace_id=$1 GROUP BY entry_id HAVING sum(debit_minor)<>sum(credit_minor))x`,[ctx.workspaceId])).rows[0].n;
  return {asset:String(asset),costs:String(costs),drift,unbalanced};};

 // A product with imported stock: archived, stock written off as an expense.
 const ctx=await business('Removal business');await load(ctx);
 const item=(await db.query("SELECT id FROM items WHERE workspace_id=$1 AND name='Gone product 1'",[ctx.workspaceId])).rows[0].id;
 const product=await removal.review(db,ctx,owner,'product',item);
 assert.equal(product.outcome,'archive');assert(product.history.includes('stock history'));assert(product.stock.positions>0);assert.equal(product.blockers.length,0);
 await assert.rejects(removal.remove(db,ctx,owner,'product',item,{expectedHash:'stale'}),/changed after you opened/);
 await assert.rejects(removal.review(db,ctx,{role:'staff',permissions:[]},'product',item),/Only an owner/);
 const before=await books(ctx),done=await removal.remove(db,ctx,owner,'product',item,{expectedHash:product.hash});
 assert.equal(done.outcome,'archived');assert.equal(done.removed.positions,product.stock.positions);assert.equal(done.removed.valueMinor,product.stock.valueMinor);
 assert.equal(Number((await db.query('SELECT is_active FROM items WHERE id=$1',[item])).rows[0].is_active),0);
 assert.equal((await db.query("SELECT count(*)::int n FROM balances b JOIN skus s ON s.id=b.sku_id WHERE s.item_id=$1 AND b.on_hand<>0",[item])).rows[0].n,0);
 const after=await books(ctx);assert.equal(after.asset,after.costs);assert.equal(after.drift,0);assert.equal(after.unbalanced,0);
 assert.equal(BigInt(before.asset)-BigInt(after.asset),BigInt(product.stock.valueMinor));
 const expense=(await db.query(`SELECT coalesce(sum(l.debit_minor-l.credit_minor),0)::bigint v FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id WHERE l.workspace_id=$1 AND a.system_key='INVENTORY_ADJUSTMENTS'`,[ctx.workspaceId])).rows[0].v;
 assert.equal(String(expense),String(product.stock.valueMinor),'the write-off is recorded as an inventory adjustment');
 assert.equal((await removal.review(db,ctx,owner,'product',item)).outcome,'archived');

 // A large product leaves the lists at once and its stock is written off in the background.
 const big=(await db.query("SELECT id FROM items WHERE workspace_id=$1 AND name='Gone product 2'",[ctx.workspaceId])).rows[0].id;
 removal.settings.backgroundPositions=0;t.after(()=>{removal.settings.backgroundPositions=1000;});
 const bigReview=await removal.review(db,ctx,owner,'product',big),bigStarted=await removal.remove(db,ctx,owner,'product',big,{expectedHash:bigReview.hash});
 assert.equal(bigStarted.outcome,'running');assert.equal(Number((await db.query('SELECT is_active FROM items WHERE id=$1',[big])).rows[0].is_active),0,'gone from the lists immediately');
 const bigJob=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='records.remove-product'",[ctx.workspaceId])).rows[0];
 assert.deepEqual(await removal.runProductRemoval({workspaceId:ctx.workspaceId,payload:bigJob.payload,attemptCount:1,maxAttempts:5},db),{completed:true});
 assert.equal((await db.query("SELECT count(*)::int n FROM balances b JOIN skus s ON s.id=b.sku_id WHERE s.item_id=$1 AND b.on_hand<>0",[big])).rows[0].n,0);
 assert.equal((await removal.review(db,ctx,owner,'product',big)).removal.status,'COMPLETED');
 const afterBig=await books(ctx);assert.equal(afterBig.asset,afterBig.costs);assert.equal(afterBig.drift,0);assert.equal(afterBig.unbalanced,0);
 removal.settings.backgroundPositions=1000;

 // A product nobody used is erased.
 const fresh=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Never used',baseCode:'NEVER-1',trackingMode:'quantity'});
 const freshId=fresh.itemId,unused=await removal.review(db,ctx,owner,'product',freshId);assert.equal(unused.outcome,'erase');
 assert.equal((await removal.remove(db,ctx,owner,'product',freshId,{expectedHash:unused.hash})).outcome,'erased');
 assert.equal((await db.query('SELECT count(*)::int n FROM items WHERE id=$1',[freshId])).rows[0].n,0);

 // Customers and suppliers without history are erased.
 const customer=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'Mistaken customer'});
 const customerReview=await removal.review(db,ctx,owner,'customer',customer.id);assert.equal(customerReview.outcome,'erase');
 assert.equal((await removal.remove(db,ctx,owner,'customer',customer.id,{expectedHash:customerReview.hash})).outcome,'erased');
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('sup-gone',$1,'Gone supplier','active','USD',now()::text,now()::text)",[ctx.workspaceId]);
 const supplierReview=await removal.review(db,ctx,owner,'supplier','sup-gone');assert.equal(supplierReview.outcome,'erase');
 assert.equal((await removal.remove(db,ctx,owner,'supplier','sup-gone',{expectedHash:supplierReview.hash})).outcome,'erased');

 // An import is undone: every product it created leaves, its opening stock is reversed.
 const other=await business('Undo business'),plan=await load(other),opening=await books(other);
 const undo=await removal.review(db,other,owner,'import',plan.id);assert.equal(undo.outcome,'undo');assert.equal(undo.products,6);assert.equal(undo.variants,30);
 const started=await removal.remove(db,other,owner,'import',plan.id,{expectedHash:undo.hash});assert.equal(started.outcome,'running');
 const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='records.remove-import'",[other.workspaceId])).rows[0];assert(job,'the undo runs in the background');
 assert.deepEqual(await removal.runImportRemoval({workspaceId:other.workspaceId,payload:job.payload,attemptCount:1,maxAttempts:5},db),{completed:true});
 const record=await removal.importRemoval(db,other,plan.id);assert.equal(record.status,'COMPLETED');assert.equal(record.progress.products,6);
 assert.equal((await db.query('SELECT count(*)::int n FROM items WHERE workspace_id=$1 AND is_active=1',[other.workspaceId])).rows[0].n,0);
 const undone=await books(other);assert.equal(undone.asset,'0');assert.equal(undone.costs,'0');assert.equal(undone.drift,0);assert.equal(undone.unbalanced,0);
 const equity=(await db.query(`SELECT coalesce(sum(l.credit_minor-l.debit_minor),0)::bigint v FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id WHERE l.workspace_id=$1 AND a.system_key='OPENING_BALANCE_EQUITY'`,[other.workspaceId])).rows[0].v;
 assert.equal(String(equity),'0','the opening balance the import brought in is fully reversed');assert.notEqual(opening.asset,'0');
 // Deleting again is a no-op that reports the finished removal.
 assert.equal((await removal.remove(db,other,owner,'import',plan.id,{expectedHash:undo.hash})).outcome,'removed');
});

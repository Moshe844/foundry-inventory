'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// A brand-new catalogue (no mode chosen, every SKU created by the import) may
// save its stock in parallel lanes when the operator enables them. The result
// must be the same business data a single session produces, SKU for SKU.
test('a new catalogue saves stock in parallel lanes with exactly the single-session result',{timeout:300000},async t=>{
 const old=process.env.FOUNDRY_IMPORT_STOCK_WORKERS;t.after(()=>{if(old===undefined)delete process.env.FOUNDRY_IMPORT_STOCK_WORKERS;else process.env.FOUNDRY_IMPORT_STOCK_WORKERS=old;});
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),locations=require('../../src/domain/postgres-location-service'),imports=require('../../src/imports/postgres-service');
 const business=async name=>{const owner=await auth.createBusiness(db,{name:'Owner',businessName:name,email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  await locations.createLocation(db,ctx,{name:'Main Warehouse',kind:'warehouse'});return ctx;};
 const rows=[];for(let p=0;p<301;p++)for(let v=0;v<20;v++)rows.push(['Lane product '+p,'NL-'+p+'-'+v,['Black','White'][v%2],String(v),1+(p+v)%9,(4+v%3)+'.25',(19+v%5)+'.00',v%4===0?'890'+String(p*100+v).padStart(9,'0'):'',['Furniture','Lighting','Tools'][p%3],2+v%6].join(','));
 const text=['Product name,SKU,Color,Size,Quantity,Unit cost,Price,Barcode,Category,Reorder point',...rows].join('\n');
 const run=async(workers,ctx,source=text,input={})=>{process.env.FOUNDRY_IMPORT_STOCK_WORKERS=String(workers);
  const plan=await imports.analyse(db,ctx,{text:source,allowModel:false,...input});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);
  const result=await imports.execute(db,ctx,plan.id);assert(result.verified);
  const checkpoint=(await db.query('SELECT apply_checkpoint FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id])).rows[0].apply_checkpoint;return {plan,result,checkpoint};};
 const fingerprint=async ctx=>({
  skus:(await db.query(`SELECT s.code,i.name,s.variant_label,coalesce(s.barcode,'') barcode,b.on_hand::text,c.quantity_units::text,c.total_cost_minor::text,
   (SELECT string_agg(amount_minor::text||currency,',') FROM sku_prices p WHERE p.sku_id=s.id) price,
   (SELECT count(*)::int FROM movements m WHERE m.sku_id=s.id) movements,
   (SELECT string_agg(coalesce(l.name,'all')||'='||p.reorder_point::text,',' ORDER BY l.name) FROM reorder_policies p LEFT JOIN locations l ON l.id=p.location_id WHERE p.sku_id=s.id) reorder,
   (SELECT category FROM catalogue_item_facts f WHERE f.item_id=s.item_id) category
   FROM skus s JOIN items i ON i.id=s.item_id LEFT JOIN balances b ON b.sku_id=s.id LEFT JOIN accounting_inventory_cost_balances c ON c.sku_id=s.id AND c.workspace_id=s.workspace_id
   WHERE s.workspace_id=$1 ORDER BY s.code`,[ctx.workspaceId])).rows,
  accounts:(await db.query(`SELECT a.code,sum(l.debit_minor)::text debit,sum(l.credit_minor)::text credit FROM accounting_journal_lines l JOIN accounting_accounts a ON a.id=l.account_id
   WHERE l.workspace_id=$1 GROUP BY a.code ORDER BY a.code`,[ctx.workspaceId])).rows});

 const serialCtx=await business('Serial catalogue'),serial=await run(0,serialCtx);
 // With lanes off, a catalogue with no mode chosen keeps its original order.
 assert.equal(serial.checkpoint.executionOrder,'source');assert.equal(serial.result.stockLanes,undefined);
 const laneCtx=await business('Lane catalogue'),lanes=await run(2,laneCtx);
 assert.equal(lanes.result.stockLanes,4,'a new stocked catalogue uses the parallel lanes');assert.equal(lanes.checkpoint.executionOrder,'item');
 assert.equal(lanes.result.rowsImported,6020);assert.equal(lanes.result.batchReceipts.rows,6020);
 const expected=await fingerprint(serialCtx),observed=await fingerprint(laneCtx);
 assert.equal(observed.skus.length,6020);assert.deepEqual(observed.skus,expected.skus);assert.deepEqual(observed.accounts,expected.accounts);
 assert(observed.skus.some(s=>s.barcode)&&observed.skus.every(s=>s.price),'prices and barcodes saved while preparing are kept');
 assert(observed.skus.every(s=>s.reorder&&s.category),'reorder points and categories are saved by the lanes too');
 assert.equal((await db.query(`SELECT count(*)::int n FROM(SELECT entry_id FROM accounting_journal_lines WHERE workspace_id=$1 GROUP BY entry_id HAVING sum(debit_minor)<>sum(credit_minor))x`,[laneCtx.workspaceId])).rows[0].n,0);

 // A catalogue-only row (no stock) would leave a reserved journal number unused: single session.
 const zero=await run(2,await business('Zero stock catalogue'),text.replace(/\n(Lane product 0,NL-0-1,White,1),\d+,/,'\n$1,0,'));
 assert.equal(zero.result.stockLanes,undefined);assert.equal(zero.result.rowsImported,6020);
 // An explicit "set quantities" import keeps its own batches.
 const set=await run(2,await business('Set catalogue'),text,{importMode:'set'});
 assert.equal(set.result.stockLanes,undefined);assert.equal(set.result.rowsImported,6020);
});

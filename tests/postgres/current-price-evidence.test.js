'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('current price evidence covers inactive records and distinguishes zero, missing, cleared and historical prices',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),catalog=require('../../src/domain/postgres-catalog-service'),pricing=require('../../src/pricing/postgres-service'),assistant=require('../../src/assistant/postgres-service'),reports=require('../../src/reports/postgres-service');
 const make=async name=>{const owner=await auth.createBusiness(db,{name,businessName:name,email:randomUUID()+'@example.test',password:'Prices!'+randomUUID()});return {workspaceId:owner.workspaceId,actorId:owner.userId};},ctx=await make('Price evidence'),other=await make('Other prices'),actor={role:'owner'};
 const add=async(scope,code)=>{const item=await catalog.createItem(db,scope,{name:'Unfamiliar '+code,baseCode:code,trackingMode:'quantity'});return {itemId:item.itemId,skuId:item.skuIds[0]};};
 const zero=await add(ctx,'FREE'),never=await add(ctx,'MISSING'),cleared=await add(ctx,'CLEARED'),inactive=await add(ctx,'INACTIVE'),archived=await add(ctx,'ARCHIVED'),foreign=await add(other,'PRIVATE-FOREIGN');
 await pricing.setPrice(db,ctx,{skuId:zero.skuId,amount:'0',currency:'CAD'});
 await pricing.setPrice(db,ctx,{skuId:cleared.skuId,amount:'12',currency:'USD'});await pricing.setPrice(db,ctx,{skuId:cleared.skuId,amountMinor:null,currency:'USD'});
 await pricing.setPrice(db,ctx,{skuId:inactive.skuId,amount:'3',currency:'USD'});await pricing.setPrice(db,ctx,{skuId:inactive.skuId,amount:'7',currency:'GBP'});
 await pricing.setPrice(db,other,{skuId:foreign.skuId,amount:'999',currency:'AUD'});
 await db.query('UPDATE skus SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,inactive.skuId]);await db.query('UPDATE items SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,archived.itemId]);
 const readOnly={query:(sql,args)=>{assert.match(sql.trim(),/^(SELECT|WITH)\b/i);return db.query(sql,args);}};
 const read=await assistant.lookup(readOnly,ctx,{view:'prices'}),rows=new Map(read.rows.map(row=>[row.sku,row]));
 assert.equal(read.extent.totalRows,5);assert.equal(read.extent.complete,true);assert.equal(rows.get('FREE').sellingPriceMinor,0);assert.equal(rows.get('FREE').sellingPriceRecorded,true);assert.equal(rows.get('FREE').currency,'CAD');
 for(const code of ['MISSING','CLEARED','ARCHIVED']){assert.equal(rows.get(code).sellingPriceMinor,null);assert.equal(rows.get(code).sellingPriceRecorded,false);}
 assert.equal(rows.get('INACTIVE').variantStatus,'inactive');assert.equal(rows.get('INACTIVE').sellingPriceMinor,700);assert.equal(rows.get('INACTIVE').currency,'GBP');assert.equal(rows.get('ARCHIVED').productStatus,'inactive');assert(!JSON.stringify(read).includes('PRIVATE-FOREIGN'));
 const spec={dataset:'catalogue',columns:['sku','product_status','variant_status','selling_price_minor','selling_price_recorded','currency'],sort:'sku',direction:'asc'};
 const all=await reports.run(db,ctx,actor,spec);assert.equal(all.extent.totalRows,5);const bySku=new Map(all.rows.map(row=>[row.sku,row]));assert.equal(Number(bySku.get('FREE').selling_price_minor),0);assert.equal(bySku.get('FREE').selling_price_recorded,'yes');assert.equal(Number(bySku.get('INACTIVE').selling_price_minor),700);assert.equal(bySku.get('CLEARED').selling_price_minor,null);
 const missing=await reports.run(db,ctx,actor,{...spec,filters:[{field:'selling_price_recorded',operator:'equals',value:'no'}]});assert.deepEqual(missing.rows.map(row=>row.sku),['ARCHIVED','CLEARED','MISSING']);
 const zeros=await reports.run(db,ctx,actor,{...spec,filters:[{field:'selling_price_minor',operator:'equals',value:'0'}]});assert.deepEqual(zeros.rows.map(row=>row.sku),['FREE']);
 assert.throws(()=>reports.normalize({dataset:'catalogue',summary:true,aggregate:'sum',measure:'selling_price_minor',groups:['currency']},actor),/not known for every record/);
 assert.throws(()=>reports.normalize({dataset:'catalogue',summary:true,aggregate:'sum',measure:'selling_price_minor',filters:[{field:'selling_price_recorded',operator:'equals',value:'yes'}]},actor),/currency/);
 const totals=await reports.run(db,ctx,actor,{dataset:'catalogue',groups:['currency'],aggregate:'sum',measure:'selling_price_minor',filters:[{field:'selling_price_recorded',operator:'equals',value:'yes'}],sort:'currency',direction:'asc'});assert.deepEqual(totals.rows.map(row=>[row.currency,Number(row.total)]),[['CAD',0],['GBP',700]]);
 assert.equal((await assistant.lookup(readOnly,ctx,{view:'prices',search:'does-not-exist'})).extent.totalRows,0);
 for(let n=0;n<97;n++)await add(ctx,'EXTRA-'+n);
 const capped=await assistant.lookup(readOnly,ctx,{view:'prices'});assert.equal(capped.rows.length,100);assert.equal(capped.extent.totalRows,102);assert.equal(capped.extent.complete,false);
 assert.equal((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 t.diagnostic(JSON.stringify({inactiveAndArchivedIncluded:true,zeroDistinctFromMissing:true,clearedAndLatestPriceCorrect:true,tenantIsolation:true,exactCappedCoverage:true,currencyAndCompletenessGuards:true,paidCalls:0}));
});

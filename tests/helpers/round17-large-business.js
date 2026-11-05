'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const warehouses=['NJ-Main','NY-Store','PA-DC','CA-West','TX-South'];
async function fixture(t,{onProgress=()=>{}}={}){
 const cluster=await require('./postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Round17!'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Scale owner',businessName:'Round 17 large business qualification',email,password}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('round17-large-subscription',$1,'enterprise','COMP','ISOLATED_TEST')",[owner.accountId]);
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{currency:'USD',startDate:'2026-01-01'});
 const locations=[];for(const name of warehouses)locations.push(await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name,kind:'warehouse'}));
 const catalogue=['Product,SKU,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Barcode,Cost,Price,Supplier,Category,Serial Tracked,Lot Tracked,Reorder level,Target stock'];
 const stock=['Product,SKU,Location,Quantity,Unit cost,Lot,Lot Tracked,Serial Tracked,Expiry date,Source reference'];
 for(let p=0;p<5000;p++){
  const category=['Apparel','Grocery','Electronics','Hardware'][p%4],axis1=['Size','Flavor','Model','Voltage'][p%4],axis2=['Color','Bag size','Color','Length'][p%4];
  for(let v=0;v<10;v++){
   const code='R17-'+p+'-'+v,tracked=category==='Grocery',name=category+' product '+p;
   catalogue.push([name,code,axis1,'Option '+Math.floor(v/5),axis2,'Value '+v%5,'0017'+String(p*10+v).padStart(9,'0'),2,5,'Supplier '+p%200,category,'No',tracked?'Yes':'No',35,60].join(','));
   for(let position=0;position<3;position++)stock.push([name,code,warehouses[(p+v+position)%5],10,2,tracked?'LOT-'+code:'',tracked?'Yes':'No','No',tracked?'2027-12-31':'','R17-RECEIPT-'+p+'-'+v+'-'+position].join(','));
  }
 }
 const imports=require('../../src/imports/postgres-service'),catalogueStarted=performance.now();
 const plan=await imports.analyse(db,ctx,{text:catalogue.join('\n'),filename:'round17-catalogue-no-stock.csv',allowModel:false,onProgress:p=>onProgress('catalogue-analysis',p)});
 assert.equal(plan.recordsInvalid,0);assert.equal(plan.recordsValid,50000);await imports.approve(db,ctx,plan.id,plan.integrityHash);const catalogResult=await imports.execute(db,ctx,plan.id,{onProgress:p=>onProgress('catalogue-execution',p)});assert(catalogResult.verified);
 const catalogueMs=performance.now()-catalogueStarted;
 assert.equal((await db.query('SELECT count(*)::int n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,5000);assert.equal((await db.query('SELECT count(*)::int n FROM skus WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,50000);
 assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 const measured=(await db.query("SELECT item_id FROM skus WHERE workspace_id=$1 AND code='R17-4999-9'",[ctx.workspaceId])).rows[0];
 await db.transaction(c=>require('../../src/domain/stock-quantity').save(c,ctx,measured.item_id,{unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'}));
 const profiler=process.env.STOCKCHIEF_IMPORT_PROFILE==='1'?require('./postgres-query-profile').profile(db):null,importDb=profiler?.database||db;
 const progress=phase=>p=>{profiler?.phase(phase+':'+p.stage);return onProgress(phase,p);};
 let additivePreviewPositionReads=0;const observe=target=>({...target,query:(sql,...values)=>{if(sql.includes('AS has_history'))additivePreviewPositionReads++;return target.query(sql,...values);}}),previewDb={...observe(importDb),transaction:(fn,options)=>importDb.transaction(c=>fn(observe(c)),options)};
 const started=performance.now(),stockPlan=await imports.analyse(previewDb,ctx,{text:stock.join('\n'),filename:'round17-mixed-opening-stock.csv',importMode:'add',allowModel:false,onProgress:progress('stock-analysis')});
 assert.equal(stockPlan.recordsInvalid,0);assert.equal(stockPlan.recordsValid,150000);await imports.approve(importDb,ctx,stockPlan.id,stockPlan.integrityHash);const stockResult=await imports.execute(importDb,ctx,stockPlan.id,{onProgress:progress('stock-execution')});assert(stockResult.verified);const stockImportMs=performance.now()-started;if(profiler)console.log(JSON.stringify({importQueryProfile:profiler.report()}));
 const actual=(await db.query(`SELECT (SELECT count(*)::int FROM suppliers WHERE workspace_id=$1) suppliers,(SELECT count(*)::int FROM balances WHERE workspace_id=$1) positions,(SELECT sum(on_hand)::text FROM balances WHERE workspace_id=$1) units,(SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1) value_minor`,[ctx.workspaceId])).rows[0];
 assert.deepEqual(actual,{suppliers:200,positions:150000,units:'1500000',value_minor:'300000000'});
 // A mature inventory also has completed background history. Customer pages
 // must not scan it just to discover that no work has failed.
 await db.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,status,available_at,idempotency_key,created_at,updated_at)
 SELECT 'round17-history-'||n,$1,'qualification.history','COMPLETED',0,'round17-history-'||n,now(),now() FROM generate_series(1,20000)n`,[ctx.workspaceId]);
 await db.query('ANALYZE stockchief_runtime.jobs');
 return {db,ctx,owner,email,password,locations,plan,stockPlan,catalogueMs,stockImportMs,additivePreviewPositionReads,imports,actual};
}
module.exports={fixture,warehouses};

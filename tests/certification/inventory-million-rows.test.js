'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const count=Number(process.env.STOCKCHIEF_IMPORT_CERTIFICATION_ROWS||1000000);
test('large PostgreSQL import certifies source, approval, inventory, money, plan limits and replay',
 {skip:process.env.STOCKCHIEF_RUN_LARGE_IMPORT!=='1',timeout:4*60*60*1000},async t=>{
 assert(Number.isSafeInteger(count)&&count>=1000&&count<=2000000);
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Scale owner',businessName:'Large import certification',email:randomUUID()+'@example.test',password:randomUUID()+'!A'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('scale-subscription',$1,'enterprise','COMP','ISOLATED_TEST')",[owner.accountId]);
 await require('../../src/accounting/postgres-ledger').configure(db,ctx,{currency:'USD',startDate:'2026-01-01'});
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-scale-source-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'inventory.csv'),tag=randomUUID().slice(0,8);
 fs.writeFileSync(file,'Name,SKU,Location,Quantity,Unit cost,Selling price,Supplier,Lead time days,Reorder level,Target stock,Source tag\n');
 let expectedUnits=0;
 for(let start=0;start<count;start+=5000){let text='';for(let i=start;i<Math.min(start+5000,count);i++){
  const units=i%7+1;expectedUnits+=units;text+=`Product ${i},${tag}-${i},Count room,${units},1.25,3.75,Supplier ${i%5},14,2,10,detail-${i}\n`;
 }fs.appendFileSync(file,text);}
 const service=require('../../src/imports/postgres-service'),started=performance.now();let maxRss=0,lastStage='',lastReported=-1;
 const progress=phase=>p=>{maxRss=Math.max(maxRss,process.memoryUsage().rss);const completed=Number(p.processedRows||p.preparedRows||0),stage=phase+':'+p.stage,bucket=Math.floor(completed/10000);
  if(stage!==lastStage||bucket!==lastReported){lastStage=stage;lastReported=bucket;console.log(JSON.stringify({phase:stage,rows:completed,total:count,elapsedMs:Math.round(performance.now()-started),rss:process.memoryUsage().rss}));}};
 const plan=await service.analyse(db,ctx,{buffer:fs.readFileSync(file),filename:'inventory.csv',allowModel:false,onProgress:progress('analysis')});
 assert.equal(plan.recordsDetected,count);assert.equal(plan.recordsValid,count);assert.equal(plan.recordsInvalid,0);
 await service.approve(db,ctx,plan.id,plan.integrityHash);
 const result=await service.execute(db,ctx,plan.id,{onProgress:progress('execution')});
 assert(result.verified);assert.equal(result.itemsCreated,count);assert.equal(result.skusCreated,count);assert.equal(result.rowsImported,count);assert.equal(result.units,expectedUnits);
 const state=(await db.query(`SELECT (SELECT count(*) FROM skus WHERE workspace_id=$1)::text skus,
  (SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::text units,
  (SELECT sum(total_cost_minor) FROM accounting_inventory_cost_balances WHERE workspace_id=$1)::text value,
  (SELECT count(*) FROM supplier_items WHERE workspace_id=$1)::text links,
  (SELECT count(*) FROM reorder_policies WHERE workspace_id=$1)::text policies`,[ctx.workspaceId])).rows[0];
 assert.deepEqual(state,{skus:String(count),units:String(expectedUnits),value:String(expectedUnits*125),links:String(count),policies:String(count)});
 assert.equal((await require('../../src/commercial/entitlements').meterState(db,{accountId:owner.accountId,workspaceId:ctx.workspaceId},'active_skus')).used,count);
 assert((await service.execute(db,ctx,plan.id)).duplicate);
 assert(maxRss<1536*1024*1024,`Import RSS exceeded 1.5 GiB: ${maxRss}`);
 console.log(JSON.stringify({certifiedRows:count,elapsedMs:Math.round(performance.now()-started),maxRss,verified:true,units:expectedUnits,valueMinor:expectedUnits*125,paidCalls:0}));
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('mixed lot and ordinary imports run independent product lanes and resume exact receipts after interruption',{timeout:180000},async t=>{
 const prior=process.env.FOUNDRY_IMPORT_STOCK_WORKERS;process.env.FOUNDRY_IMPORT_STOCK_WORKERS='4';
 t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_IMPORT_STOCK_WORKERS;else process.env.FOUNDRY_IMPORT_STOCK_WORKERS=prior;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{ctx}=f,db=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:5});
 t.after(()=>db.close());
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('mixed-lanes',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const other=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Overflow',kind:'warehouse'});
 const definitions=Array.from({length:500},(_,p)=>({name:'Mixed lane product '+p,trackingMode:p%2?'lot':'quantity',variants:Array.from({length:10},(_,v)=>({code:'MIXED-LANE-'+p+'-'+v,options:[{name:'Flavor',value:String(v)}]}))}));
 const ids=[];for(let start=0;start<definitions.length;start+=50){const made=await db.transaction(c=>require('../../src/domain/postgres-catalog-service').createImportedItemsInTransaction(c,ctx,definitions.slice(start,start+50)),{isolation:'READ COMMITTED'});ids.push(...made.flatMap(p=>p.skus.map(s=>s.skuId)));}
 const text=['Product,SKU,Location,Quantity,Unit cost,Lot,Lot Tracked,Expiry date,Source reference',...definitions.flatMap(p=>p.variants.flatMap(v=>[f.location,other].map(l=>[p.name,v.code,l.name,1,2,p.trackingMode==='lot'?'LOT-'+v.code:'',p.trackingMode==='lot'?'Yes':'No',p.trackingMode==='lot'?'2027-12-31':'',v.code+'-'+l.id].join(','))))].join('\n');
 const imports=require('../../src/imports/postgres-service'),plan=await imports.analyse(db,ctx,{text,importMode:'add',allowModel:false});
 assert.equal(plan.recordsValid,10000);assert.equal(plan.recordsInvalid,0);
 assert.equal((await db.query('SELECT bool_and(parallel_stock) eligible FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id])).rows[0].eligible,true);
 await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const facts=require('../../src/domain/postgres-catalog-facts'),original=facts.saveManyInTransaction,pids=new Set();let release,interrupted=false;
 const claims=[];
 const watch=target=>({...target,query:(sql,values)=>{if(sql.startsWith('SELECT * FROM import_execution_lanes ')&&sql.endsWith('FOR UPDATE'))claims.push(values[2]);return target.query(sql,values);},
  ...(target.transaction?{transaction:(fn,options)=>target.transaction(c=>fn(watch(c)),options)}:{}),
  ...(target.withSessionLock?{withSessionLock:(key,fn)=>target.withSessionLock(key,c=>fn(watch(c)))}:{}),
  ...(target.withSharedSession?{withSharedSession:fn=>target.withSharedSession(c=>fn(watch(c)))}:{})});
 let timedOut=false;const gate=new Promise(resolve=>{release=resolve;}),timer=setTimeout(()=>{timedOut=true;release();},10000);
 let concurrentReceipt=false;
 facts.saveManyInTransaction=async(client,...args)=>{
  pids.add((await client.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  if(pids.size===4&&!concurrentReceipt){concurrentReceipt=true;
   await db.transaction(c=>require('../../src/domain/postgres-inventory-engine').receiveManyInTransaction(c,ctx,[{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'ordinary-receipt-during-import'}]),{isolation:'READ COMMITTED'});
   release();
  }
  await gate;return original(client,...args);
 };
 try{
  await assert.rejects(imports.execute(watch(db),ctx,plan.id,{onProgress:p=>{if(p.stage==='processing'&&p.processedRows>0)interrupted=true;},beforeBatchCommit:()=>{if(interrupted&&claims.length>=4)throw new Error('simulated mixed-lane interruption');}}),/simulated mixed-lane interruption/);
 }finally{release();clearTimeout(timer);facts.saveManyInTransaction=original;}
 assert.equal(pids.size,4,'All four database sessions must actually apply independent mixed batches.');
 assert.equal(db.poolMetrics().max,5);assert.equal(concurrentReceipt,true,'The fifth connection must support ordinary stock work during the import.');
 assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.item.skuIds[0],f.location.id])).rows[0].on_hand),5);
 assert.deepEqual(claims.slice(0,4),[0,1,2,3],'Every lane gets a first batch before one lane takes a second turn.');
 assert.equal(timedOut,false,'All four batches must overlap before any transaction commits.');
 const checkpoint=(await db.query('SELECT apply_checkpoint FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id])).rows[0].apply_checkpoint;
 assert.equal(checkpoint.stockLaneVersion,1);assert(checkpoint.savedRows>0&&checkpoint.savedRows<10000);
 // Resuming with concurrency disabled retains the approved lane order and
 // durable receipts rather than re-applying already committed stock.
 process.env.FOUNDRY_IMPORT_STOCK_WORKERS='0';
 const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.stockLanes,4);assert.equal(result.rowsImported,10000);
 const actual=(await db.query(`SELECT (SELECT sum(on_hand)::text FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])) units,
  (SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])) value,
  (SELECT count(*)::int FROM lots WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND expires_at::date='2027-12-31') lots`,[ctx.workspaceId,ids])).rows[0];
 assert.deepEqual(actual,{units:'10000',value:'2000000',lots:2500});
 const again=await imports.execute(db,ctx,plan.id);assert.equal(again.duplicate,true);assert.equal(again.execution.status,'SUCCEEDED');
 assert.equal((await db.query('SELECT sum(on_hand)::text units FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',[ctx.workspaceId,ids])).rows[0].units,'10000');
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('parallel stock lanes overlap, retain catalogue ownership and resume verified batches without duplicate stock or money',{timeout:240000},async t=>{
 const old=process.env.FOUNDRY_IMPORT_STOCK_WORKERS;process.env.FOUNDRY_IMPORT_STOCK_WORKERS='2';t.after(()=>{if(old===undefined)delete process.env.FOUNDRY_IMPORT_STOCK_WORKERS;else process.env.FOUNDRY_IMPORT_STOCK_WORKERS=old;});
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),catalog=require('../../src/domain/postgres-catalog-service');
 const definitions=Array.from({length:601},(_,i)=>({name:'Lane stock '+i,trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({key:'v'+v,code:'LS-'+i+'-'+v,options:[{name:'Flavor',value:String(v)}]}))}));
 for(let start=0;start<definitions.length;start+=100)await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions.slice(start,start+100)),{isolation:'READ COMMITTED'});
 const second=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second lane warehouse',kind:'warehouse'});
 const text=['Product,SKU,Location,Quantity,Unit cost,Source reference',...definitions.flatMap(p=>p.variants.flatMap(v=>['Dispatch',second.name].map(n=>[p.name,v.code,n,1,'4.50',v.code+'-'+n].join(','))))].join('\n');
 const before=await f.balance(),plan=await imports.analyse(db,ctx,{text,importMode:'add',allowModel:false});assert.equal(plan.recordsValid,12020);assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 let entered=0,resolve,failed=false;const barrier=new Promise(r=>{resolve=r;}),timer=setTimeout(()=>resolve(),10000);let checked=false;
 await assert.rejects(imports.execute(db,ctx,plan.id,{beforeRow:async({rowsImported})=>{if(rowsImported===0){entered++;if(entered===2)resolve();await barrier;assert.equal(entered,2,'Two database batches must enter before either commits');}},onProgress:async p=>{
  if(p.stage==='processing'&&p.processedRows>0&&!checked){checked=true;await assert.rejects(imports.execute(db,ctx,plan.id),/already running/);await assert.rejects(catalog.createItem(db,ctx,{name:'Cannot change catalogue',baseCode:'LOCKED',trackingMode:'quantity'}),/product update is running/i);
   await Promise.all([f.parcel(),f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:'during-lanes-po',lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost:1}]}),require('../../src/transfers/postgres-transfer-service').request(db,ctx,{fromLocationId:f.location.id,toLocationId:second.id,idempotencyKey:'during-lanes-transfer',lines:[{skuId:f.item.skuIds[0],quantity:1}]})]);
   failed=true;throw Error('Lane interruption after commit');}
 }}),/Lane interruption after commit/);clearTimeout(timer);assert(checked&&failed);
 const checkpoint=(await db.query('SELECT apply_checkpoint FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id])).rows[0].apply_checkpoint;
 assert.equal(checkpoint.stockLaneVersion,1);assert(checkpoint.savedRows>0&&checkpoint.savedRows<plan.recordsValid);assert.equal(await f.balance(),before+checkpoint.savedRows);
 const proof=await require('../../src/imports/postgres-stock-lanes').progress(db,ctx,plan);assert.equal(proof.rows,checkpoint.savedRows);assert.equal(proof.value,checkpoint.savedRows*450);
 process.env.FOUNDRY_IMPORT_STOCK_WORKERS='0';
 await assert.rejects(imports.execute(db,ctx,plan.id,{beforeCommit:()=>{throw Error('Lane finalization interruption');}}),/Lane finalization interruption/);
 assert.equal(await f.balance(),before+12020);
 const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.stockLanes,4);assert.equal(result.rowsImported,12020);assert.equal(result.batchReceipts.rows,12020);assert.equal(result.batchReceipts.legacyFullScan,false);
 const observed=(await db.query(`SELECT
  (SELECT count(*)::int FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED') rows,
  (SELECT count(*)::int FROM import_rows r JOIN movements m ON m.id=r.movement_ids::jsonb->>0 AND m.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.import_id=$2) movements,
  (SELECT count(*)::int FROM accounting_journal_entries WHERE workspace_id=$1 AND source_record_type='import_batch' AND source_record_id=$2) journals,
  (SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id<>$3) value`,[ctx.workspaceId,plan.id,f.item.skuIds[0]])).rows[0];
 assert.deepEqual(observed,{rows:12020,movements:12020,journals:result.batchReceipts.batches,value:'5409000'});
 assert.equal((await db.query(`SELECT count(*)::int n FROM(SELECT entry_id FROM accounting_journal_lines WHERE workspace_id=$1 GROUP BY entry_id HAVING sum(debit_minor)<>sum(credit_minor))x`,[ctx.workspaceId])).rows[0].n,0);
 assert.equal((await imports.execute(db,ctx,plan.id)).duplicate,true);assert.equal(await f.balance(),before+12020);
 const profit=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{from:'2026-01-01',to:'2026-12-31'});assert.equal(profit.revenueMinor,0);assert.equal(profit.netIncomeMinor,0);
 await assert.rejects(db.query('UPDATE import_lane_batch_receipts SET value_minor=value_minor+1 WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id]),/immutable|cannot|verification/i);
 await t.test('revoking the operator during an in-flight batch rolls back that batch and leaves its lanes resumable',async()=>{
  process.env.FOUNDRY_IMPORT_STOCK_WORKERS='2';
  const lines=text.split('\n'),revokedPlan=await imports.analyse(db,ctx,{text:lines[0]+',Permission case\n'+lines.slice(1,5003).map(r=>r+',revocation').join('\n'),importMode:'add',allowModel:false});assert.equal(revokedPlan.recordsValid,5002);await imports.approve(db,ctx,revokedPlan.id,revokedPlan.integrityHash);
  const prior=(await db.query('SELECT role,permissions FROM users WHERE id=$1',[ctx.actorId])).rows[0],start=await f.balance();let revoked=false;
  try{await assert.rejects(imports.execute(db,ctx,revokedPlan.id,{beforeRow:async()=>{if(!revoked){revoked=true;await db.query("UPDATE users SET role='viewer',permissions='{}' WHERE id=$1",[ctx.actorId]);}}}),/permission|allowed|cannot|role/i);assert(revoked);assert.equal(await f.balance(),start);}
  finally{await db.query('UPDATE users SET role=$2,permissions=$3 WHERE id=$1',[ctx.actorId,prior.role,prior.permissions]);}
  assert.equal((await require('../../src/imports/postgres-stock-lanes').progress(db,ctx,revokedPlan)).rows,0);
  assert((await imports.execute(db,ctx,revokedPlan.id)).verified);assert.equal(await f.balance(),start+5002);
 });
 t.diagnostic(JSON.stringify({overlappingTransactions:entered,savedBeforeResume:checkpoint.savedRows,rows:12020,sourceRowsAndStockAndMoneyExact:true,paidCalls:0}));
});

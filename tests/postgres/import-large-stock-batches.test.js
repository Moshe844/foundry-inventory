'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('large quantity imports save bounded 2,000-row batches and resume exactly around ordinary stock activity',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),imports=require('../../src/imports/postgres-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('large-stock-fixture',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const definitions=[];for(let n=0;n<5001;n+=10)definitions.push({name:'Stock family '+n,trackingMode:'quantity',variants:Array.from({length:Math.min(10,5001-n)},(_,v)=>({code:'LARGE-STOCK-'+(n+v)}))});
 const created=await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions)),ids=created.flatMap(p=>p.skus.map(s=>s.skuId));assert.equal(ids.length,5001);
 let plan=await imports.analyse(db,ctx,{filename:'large-stock.csv',allowModel:false,text:'SKU,Location,Quantity,Unit cost\n'+Array.from({length:5001},(_,n)=>'LARGE-STOCK-'+n+',Dispatch,2,1.25').join('\n')});assert.equal(plan.recordsInvalid,0);plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,importMode:'add'});await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const state=async()=>(await db.query('SELECT (SELECT sum(on_hand) FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]))::text units,(SELECT sum(total_cost_minor) FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]))::text value',[ctx.workspaceId,ids])).rows[0];
 const postings=require('../../src/imports/postgres-opening-values'),originalPosting=postings.post;postings.post=(client,context,source,values)=>originalPosting(client,context,{...source,recordsValid:4999},values);
 let selectedAttempts=0;
 try{await assert.rejects(imports.execute(db,ctx,plan.id,{beforeRow:async({rowsImported,row})=>{
  if(rowsImported===0){await assert.rejects(db.transaction(c=>c.query('SELECT id FROM import_rows WHERE id=$1 FOR UPDATE NOWAIT',[row.id]),{isolation:'READ COMMITTED'}),e=>e.code==='55P03','The selected source stays locked until its applying transaction commits');if(selectedAttempts++===0)throw Object.assign(Error('Retry the selected source page'),{code:'40001'});}
  if(rowsImported===2500)throw Error('interrupt second stock batch');
 }}),/interrupt second stock batch/);}finally{postings.post=originalPosting;}
 assert.equal(selectedAttempts,2,'The rolled-back page is reread and relocked on its retry');
 let paused=await imports.report(db,ctx.workspaceId,plan.id);assert.equal(paused.rowsImported,2000);assert.deepEqual(await state(),{units:'4000',value:'500000'});
 const sourceHistory=require('../../src/imports/postgres-source-history'),recorded=(await db.query("SELECT row_number,raw FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED' ORDER BY row_number",[ctx.workspaceId,plan.id])).rows;
 const partial=await db.transaction(async c=>{await c.query("SET LOCAL plan_cache_mode='force_generic_plan'");return sourceHistory.read(c,ctx.workspaceId,plan.sourceHash);},{readOnly:true,isolation:'REPEATABLE READ'});assert.deepEqual(partial.sort((a,b)=>Number(a.row_number)-Number(b.row_number)),recorded);assert.equal(partial.length,2000,'Committed rows of a paused import remain protected from duplicate receipt');
 await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:ids.at(-1),locationId:f.location.id,quantity:3,unitCost:'2',idempotencyKey:'activity-between-large-batches'});
 const ledger=require('../../src/accounting/postgres-ledger'),originalPostMany=ledger.postManyInTransaction;
 for(const tamperedLine of [0,1500]){
  ledger.postManyInTransaction=(client,context,entries)=>originalPostMany(client,context,entries.map(entry=>entry.sourceRecordType==='import_batch'?{...entry,lines:entry.lines.map((line,i)=>i===tamperedLine?{...line,skuId:f.item.skuIds[0]}:line)}:entry));
  try{await assert.rejects(imports.execute(db,ctx,plan.id,{retryExecutionId:paused.id}),/source rows.*receipt values do not match/);}finally{ledger.postManyInTransaction=originalPostMany;}
  assert.deepEqual(await state(),{units:'4003',value:'500600'});assert.equal((await db.query("SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1 AND source_record_type='import_batch'",[ctx.workspaceId])).rows[0].n,0,'A balanced journal with a wrong early or late SKU must roll back with its whole stock batch');paused=await imports.report(db,ctx.workspaceId,plan.id);
 }
 const result=await imports.execute(db,ctx,plan.id,{retryExecutionId:paused.id});assert(result.verified);assert.equal(result.rowsImported,5001);assert.deepEqual(await state(),{units:'10005',value:'1250850'});assert((await imports.execute(db,ctx,plan.id)).duplicate);assert.deepEqual(await state(),{units:'10005',value:'1250850'});
 const evidence=(await db.query(`SELECT (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1 AND source_type='opening_inventory' AND source_record_type='import_row')::int legacy_entries,(SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1 AND source_record_type='import_batch')::int batch_entries,(SELECT count(*) FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.workspace_id=l.workspace_id AND e.id=l.entry_id WHERE e.workspace_id=$1 AND e.source_record_type='import_batch' AND l.metadata::jsonb ? 'importRowId')::int traced_rows`,[ctx.workspaceId])).rows[0];assert.deepEqual(evidence,{legacy_entries:2000,batch_entries:2,traced_rows:3001});const pnl=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId);assert.equal(pnl.revenueMinor,0);assert.equal(pnl.netIncomeMinor,0,'Opening stock is an asset, not income');
 const total=(await db.query('SELECT missing_units::text FROM inventory_cost_coverage_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(total.missing_units,'0');
 const sourceIds=(await db.query('SELECT id FROM import_rows WHERE workspace_id=$1 AND import_id=$2 ORDER BY row_number,id',[ctx.workspaceId,plan.id])).rows.map(r=>r.id),verification=require('../../src/imports/postgres-verification');let verificationQueries=0;
 const measured={query:(sql,values)=>{verificationQueries++;assert(values[1].length<=2000);return db.query(sql,values);}};
 assert.deepEqual(await verification.totals(measured,ctx.workspaceId,sourceIds),{value:{value:'1250250',movements:5001},posted:{value:'1250250'}});assert.equal(verificationQueries,3,'One reconciliation query per bounded source batch');
 verificationQueries=0;
 assert.deepEqual(await verification.totals(measured,ctx.workspaceId,[0,1999,2000,3500,5000].map(n=>sourceIds[n])),{value:{value:'1250',movements:5},posted:{value:'1250'}});assert.equal(verificationQueries,1,'Partial legacy and shared-journal sources count only the requested rows');
 // Lots now use the canonical bulk identity path. Serial/measured pages retain
 // the smaller durable boundary; neither mode skips source rows.
 const store=require('../../src/imports/postgres-row-store'),sample=Array.from({length:2000},(_,n)=>({id:'row-'+n,row_number:n,parsed:{trackingMode:n===700?'lot':'quantity'},status:'VALID'}));
 for(const [mode,expected]of [['lot',[2000]],['serial',[500,500,500,500]]]){sample[700].parsed.trackingMode=mode;let reads=0;const pages=[];for await(const page of store.executionPages({query:async()=>({rows:reads++?[]:sample})},ctx.workspaceId,'bounded-identity-fixture',{batchSize:2000}))pages.push(page);assert.deepEqual(pages.map(p=>p.length),expected);assert.equal(new Set(pages.flat().map(r=>r.id)).size,2000);}
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('durable import receipts bind exact values, approval, scope and contiguous committed progress',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service'),receipts=require('../../src/imports/postgres-batch-receipts');
 let plan=await imports.analyse(db,ctx,{text:'Product,SKU\nReceipt fixture,PROOF-1\nReceipt fixture,PROOF-2',allowModel:false});await imports.approve(db,ctx,plan.id,plan.integrityHash);
 const row=id=>({id}),input=(offset,id)=>({offset,rows:[row(id)],units:0.125,costRecords:1,valueMinor:50,totals:{value:{value:'50',movements:1},posted:{value:'50'}}});
 await assert.rejects(receipts.record(db,ctx,plan,{...input(0,'bad'),totals:{value:{value:'49',movements:1},posted:{value:'50'}}}),/Saved import verification/);
 await assert.rejects(receipts.record(db,{...ctx,workspaceId:'foreign-workspace'},plan,input(0,'foreign')),/Saved import verification/);
 await receipts.record(db,ctx,plan,input(0,'first'));
 assert.deepEqual(await receipts.progress(db,ctx,plan),{batches:1,rows:1,units:0.125,costRecords:1,value:50,asset:50});
 await assert.rejects(receipts.totals(db,ctx,plan),/Saved import verification/,'A partial receipt set cannot mark an import verified');
 await assert.rejects(db.query('UPDATE import_batch_receipts SET quantity_delta=999 WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id]),/cannot be changed/);
 await db.query('UPDATE import_plans SET apply_checkpoint=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id,JSON.stringify({savedRows:1})]);await receipts.record(db,ctx,plan,{...input(1,'second'),units:-0.025,valueMinor:-10,totals:{value:{value:'-10',movements:1},posted:{value:'-10'}}});
 assert.deepEqual(await receipts.totals(db,ctx,plan),{batches:2,rows:2,units:0.1,costRecords:2,value:40,asset:40});
 await assert.rejects(receipts.totals(db,{...ctx,workspaceId:'foreign-workspace'},plan),/Saved import verification/);
 await assert.rejects(receipts.totals(db,ctx,{...plan,integrityHash:'changed-approval'}),/Saved import verification/);
 // A forged offset must be rejected even when its values and total row count
 // are balanced; existing immutable receipts cannot be rewritten to conceal it.
 const other=await imports.analyse(db,ctx,{text:'Product,SKU\nGap,PROOF-GAP',allowModel:false});
 await db.query('INSERT INTO import_batch_receipts(workspace_id,import_id,start_offset,end_offset,row_count,approval_hash,source_rows_hash,quantity_delta,cost_records,value_minor,asset_minor) VALUES($1,$2,2,3,1,$3,$4,0,0,0,0)',[ctx.workspaceId,other.id,other.integrityHash,'gap']);
 await assert.rejects(receipts.totals(db,ctx,other),/Saved import verification/);
 await assert.rejects(receipts.progress(db,ctx,other),/Saved import verification/,'Partial progress must also reject gaps');
});
test('an older saved import retains canonical reconciliation when durable receipts were not recorded',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('legacy-receipt-fixture',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const catalog=require('../../src/domain/postgres-catalog-service'),definitions=Array.from({length:600},(_,p)=>({name:'Legacy receipt '+p,trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({code:'LEGACY-RECEIPT-'+p+'-'+v}))}));await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions));
 const plan=await imports.analyse(db,ctx,{text:'SKU,Location,Quantity,Unit cost,Source reference\n'+Array.from({length:6000},(_,n)=>['LEGACY-RECEIPT-'+Math.floor(n/10)+'-'+n%10,'Dispatch',1,'1.25','legacy-'+n].join(',')).join('\n'),allowModel:false,importMode:'add'});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);
 await assert.rejects(imports.execute(db,ctx,plan.id,{beforeRow:({rowsImported})=>{if(rowsImported===2100)throw Error('legacy fixture interruption');}}),/legacy fixture interruption/);
 await db.query("UPDATE import_plans SET apply_checkpoint=apply_checkpoint-'batchReceiptVersion' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,plan.id]);
 const paused=await imports.report(db,ctx.workspaceId,plan.id),verification=require('../../src/imports/postgres-verification'),original=verification.totals;let verifying=false,finalPages=0,result;
 const mock=t.mock.method(verification,'totals',(...args)=>{if(verifying)finalPages++;return original(...args);});
 try{result=await imports.execute(db,ctx,plan.id,{retryExecutionId:paused.id,onProgress:p=>{verifying=p.stage==='verifying';}});}finally{mock.mock.restore();}
 assert(result.verified);assert.equal(result.batchReceipts,undefined);assert.equal(finalPages,3,'Older partial imports must retain their original full reconciliation');assert.equal(result.rowsImported,6000);
 assert.equal(Number((await db.query('SELECT sum(on_hand)::text units FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].units),6004);
});

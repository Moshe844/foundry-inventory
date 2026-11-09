'use strict';
const {createHash}=require('node:crypto'),{ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity');
const ledger=require('../accounting/postgres-ledger'),rowStore=require('./postgres-row-store'),identities=require('./postgres-execution-identities'),enforcement=require('../commercial/enforcement');
const SIZE=2000,number=value=>exact.safeNumber(value,{signed:true}),add=(a,b)=>number(exact.add(a,b));
const invalid=()=>new ValidationError('Saved import batches need reconciliation. Their recorded stock remains safe.');
// An explicit "add" import, or one with no mode chosen whose every SKU is new:
// every position then starts empty, so no row is a count and adding is exact.
// An explicit "set" import keeps its own smaller batches and the serial path.
async function additive(client,ctx,plan){
 const mode=plan.transformations.importMode;
 if(mode==='add')return true;
 if(mode!==undefined&&mode!==null)return false;
 return !(await client.query('SELECT EXISTS(SELECT 1 FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 AND existing_sku_id IS NOT NULL) touches',[ctx.workspaceId,plan.id])).rows[0].touches;
}
function workers(){const value=Number(process.env.FOUNDRY_IMPORT_STOCK_WORKERS||0);return Number.isInteger(value)&&value>=1&&value<=4?value:0;}
async function prepare(client,ctx,plan,saved){
 if(saved.stockLaneVersion===1)return saved;
 if(!workers()||Number(saved.savedRows)||saved.version!==3||saved.executionOrder!=='item'||plan.recordsValid<5000||!await additive(client,ctx,plan))return saved;
 const eligibility=(await client.query(`SELECT count(*)::int rows,bool_and(parallel_stock AND execution_lane IS NOT NULL) eligible,count(DISTINCT currency)::int currencies
  FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2`,[ctx.workspaceId,plan.id])).rows[0];
 if(eligibility.rows!==plan.recordsValid||!eligibility.eligible||eligibility.currencies!==1)return saved;
 // Freeze execution only for existing ordinary stock. Recheck live metadata;
 // the protected catalogue lease prevents it changing beneath these lanes.
 // A SKU this import created is checked through its own catalogue binding.
 const unsafe=(await client.query(`SELECT EXISTS(SELECT 1 FROM
  (SELECT DISTINCT coalesce(i.existing_sku_id,b.sku_id) sku_id FROM import_execution_identities i
   LEFT JOIN import_catalogue_bindings b ON i.existing_sku_id IS NULL AND b.workspace_id=i.workspace_id AND b.import_id=i.import_id AND b.product_key=i.product_key AND b.variant_key=i.variant_key
   WHERE i.workspace_id=$1 AND i.import_id=$2)e
  LEFT JOIN skus s ON s.id=e.sku_id AND s.workspace_id=$1
  LEFT JOIN items i ON i.id=s.item_id AND i.workspace_id=$1
  WHERE s.id IS NULL OR s.is_active<>1 OR i.is_active<>1 OR i.tracking_mode<>'quantity' OR i.secondary_unit_label IS NOT NULL) unsafe`,[ctx.workspaceId,plan.id])).rows[0].unsafe;
 if(unsafe)return saved;
 const counts=(await client.query(`SELECT execution_lane lane,count(*)::int rows FROM import_execution_identities
  WHERE workspace_id=$1 AND import_id=$2 GROUP BY execution_lane ORDER BY execution_lane`,[ctx.workspaceId,plan.id])).rows;
 const batches=counts.reduce((n,r)=>n+Math.ceil(r.rows/SIZE),0);
 await ledger.reserveImportNumbersInTransaction(client,ctx,{importId:plan.id,approvalHash:plan.integrityHash,count:batches,postingDate:saved.postingDate});
 let offset=0;
 for(let lane=0;lane<4;lane++){const count=counts.find(r=>r.lane===lane)?.rows||0,journals=Math.ceil(count/SIZE);
  await client.query(`INSERT INTO import_execution_lanes(workspace_id,import_id,lane,approval_hash,planned_rows,journal_offset,journal_count,complete)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[ctx.workspaceId,plan.id,lane,plan.integrityHash,count,offset,journals,count===0]);offset+=journals;}
 return {...saved,version:4,stockLaneVersion:1,batchReceiptVersion:2};
}
async function progress(client,ctx,plan,{complete=false}={}){
 const lanes=(await client.query('SELECT * FROM import_execution_lanes WHERE workspace_id=$1 AND import_id=$2 ORDER BY lane',[ctx.workspaceId,plan.id])).rows;
 if(lanes.length!==4||lanes.some((l,i)=>l.lane!==i||l.approval_hash!==plan.integrityHash))throw invalid();
 const rows=(await client.query(`SELECT r.*,lag(end_offset,1,0::bigint) OVER(PARTITION BY lane ORDER BY start_offset) previous_end
  FROM import_lane_batch_receipts r WHERE workspace_id=$1 AND import_id=$2 ORDER BY lane,start_offset`,[ctx.workspaceId,plan.id])).rows;
 const result={batches:rows.length,rows:0,units:0,costRecords:0,value:0,asset:0};let planned=0,journalOffset=0;
 for(const lane of lanes){const receipts=rows.filter(r=>r.lane===lane.lane);let saved=0,units=0;
  if(lane.journal_offset!==journalOffset||lane.journal_count!==Math.ceil(Number(lane.planned_rows)/SIZE))throw invalid();journalOffset+=lane.journal_count;
  for(let i=0;i<receipts.length;i++){const r=receipts[i];
   if(r.approval_hash!==plan.integrityHash||Number(r.start_offset)!==Number(r.previous_end)||r.row_count!==(i===receipts.length-1?Math.min(SIZE,Number(lane.planned_rows)-saved):SIZE)||r.cost_records!==r.row_count||number(r.value_minor)!==number(r.asset_minor)||number(r.quantity_delta)<=0)throw invalid();
   saved+=r.row_count;units=add(units,r.quantity_delta);result.costRecords+=r.cost_records;result.value=add(result.value,r.value_minor);result.asset=add(result.asset,r.asset_minor);
  }
  if(saved!==Number(lane.saved_rows)||units!==number(lane.quantity_delta)||lane.complete!==(saved===Number(lane.planned_rows))||complete&&!lane.complete)throw invalid();
  planned+=Number(lane.planned_rows);result.rows+=saved;result.units=add(result.units,units);
 }
 if(planned!==plan.recordsValid||complete&&result.rows!==plan.recordsValid)throw invalid();return result;
}
async function execute(database,ctx,plan,executionId,{deps,inputOptions,applyChunk,save,onProgress}){
 let nextLane=0,failure=null;
 // Once an import has durable lanes, turning concurrency off still resumes
 // the same frozen order with one session. Never switch its receipt format.
 const count=Math.min(Math.max(1,workers()),Math.max(1,Number(database.sharedSessionCapacity||2)-1));let delivery=Promise.resolve();
 const deliver=checkpoint=>{const task=delivery.then(()=>onProgress(checkpoint));delivery=task.catch(()=>{});return task;};
 await database.shareLock();
 const work=async session=>{
  while(!failure){const lane=nextLane++;if(lane>=4)return;
   for(;;){if(failure)return;
    try{const outcome=await session.transaction(async client=>{
     const savedLane=(await client.query('SELECT * FROM import_execution_lanes WHERE workspace_id=$1 AND import_id=$2 AND lane=$3 FOR UPDATE',[ctx.workspaceId,plan.id,lane])).rows[0];
     if(!savedLane||savedLane.approval_hash!==plan.integrityHash)throw invalid();if(savedLane.complete)return {done:true};
     await deps.assertOperator(client,ctx);await deps.assertSourceClaim(client,ctx,plan);await enforcement.workspace(client,ctx.workspaceId,'imports.spreadsheet');await deps.bulkPlanning(client);
     await client.query("SET LOCAL stockchief.defer_import_coverage='on'");
     const cursor={itemKey:savedLane.cursor_item,key:savedLane.cursor_key,rowNumber:Number(savedLane.cursor_row),rowId:savedLane.cursor_id};
     const selected=await rowStore.executionPages(client,ctx.workspaceId,plan.id,{lane,orderByItem:true,batchSize:SIZE,cursor}).next();
     if(selected.done||selected.value.length!==Math.min(SIZE,Number(savedLane.planned_rows)-Number(savedLane.saved_rows)))throw invalid();
     const checkpoint=(await client.query('SELECT apply_checkpoint,integrity_hash,approval_status FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id])).rows[0];
     if(!checkpoint||checkpoint.integrity_hash!==plan.integrityHash||checkpoint.approval_status!=='APPROVED'||checkpoint.apply_checkpoint.stockLaneVersion!==1)throw invalid();
     const chunk=selected.value;await identities.hydrate(client,ctx,plan,chunk,checkpoint.apply_checkpoint);
     const sourceHash=createHash('sha256').update(JSON.stringify(chunk.map(r=>r.id))).digest('hex');
     const token=await ledger.importNumberTokenInTransaction(client,ctx,{importId:plan.id,approvalHash:plan.integrityHash,offset:savedLane.journal_offset+Math.floor(Number(savedLane.saved_rows)/SIZE),sourceRowsHash:sourceHash});
     const applied=await applyChunk(client,checkpoint.apply_checkpoint,chunk,Number(checkpoint.apply_checkpoint.savedRows),token);
     await client.query('SELECT stockchief_flush_import_coverage()');
     await deps.assertOperator(client,ctx);
     // Foreign-key checks hold KEY SHARE on the plan. NO KEY UPDATE serializes
     // checkpoint merges without deadlocking independently verified lanes.
     const parent=(await client.query('SELECT apply_checkpoint,integrity_hash,approval_status FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',[ctx.workspaceId,plan.id])).rows[0];
     if(!parent||parent.integrity_hash!==plan.integrityHash||parent.approval_status!=='APPROVED'||parent.apply_checkpoint.stockLaneVersion!==1)throw invalid();
     const savedRows=Number(savedLane.saved_rows)+chunk.length,cursorNext=chunk.at(-1).executionCursor,covered=false;
     await client.query(`INSERT INTO import_lane_batch_receipts(workspace_id,import_id,lane,start_offset,end_offset,row_count,approval_hash,source_rows_hash,quantity_delta,cost_records,value_minor,asset_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[ctx.workspaceId,plan.id,lane,savedLane.saved_rows,savedRows,chunk.length,plan.integrityHash,sourceHash,applied.units,applied.valued,applied.value,applied.totals.posted.value]);
     await client.query(`UPDATE import_execution_lanes SET saved_rows=$4,quantity_delta=quantity_delta+$5,cursor_item=$6,cursor_key=$7,cursor_row=$8,cursor_id=$9,complete=$10,default_reorders_covered=$11
      WHERE workspace_id=$1 AND import_id=$2 AND lane=$3`,[ctx.workspaceId,plan.id,lane,savedRows,applied.units,cursorNext.itemKey,cursorNext.key,cursorNext.rowNumber,cursorNext.rowId,savedRows===Number(savedLane.planned_rows),covered]);
     const next=await save(client,{...parent.apply_checkpoint,defaultReordersCovered:false,savedRows:Number(parent.apply_checkpoint.savedRows)+chunk.length,units:add(parent.apply_checkpoint.units||0,applied.units),lastBatch:{executionId,lane,checks:applied.checks}});
     await client.query('UPDATE import_executions SET items_created=$3,skus_created=$4,rows_imported=$5,units_established=$6,stage=$7 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,executionId,next.itemsCreated,next.skusCreated,next.savedRows,next.units,'processing']);
     await inputOptions.beforeBatchCommit?.();return {checkpoint:next,done:savedRows===Number(savedLane.planned_rows)};
    },{isolation:'READ COMMITTED',retrySafe:true});
    if(outcome.checkpoint)await deliver(outcome.checkpoint);if(outcome.done)break;
    }catch(error){failure ||=error;return;}
   }
  }
 };
 // The coordinator also owns a lane. Leave a pool slot for lease fencing;
 // a small qualification pool must not wait for a connection it already owns.
 const jobs=Array.from({length:count},(_,index)=>(index===0?work(database):database.withSharedSession(work)).catch(error=>{failure ||=error;}));
 await Promise.all(jobs);await delivery;if(failure)throw failure;
 return (await database.query('SELECT apply_checkpoint FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,plan.id])).rows[0].apply_checkpoint;
}
module.exports={prepare,progress,execute,additive,enabled:()=>workers()>0,totals:(client,ctx,plan)=>progress(client,ctx,plan,{complete:true})};

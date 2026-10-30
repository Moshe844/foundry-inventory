'use strict';

const {newId,nowIso}=require('../lib/util');

const INVARIANTS=Object.freeze([
  {key:'inventory.balance_equals_movements',table:'skus',query:`WITH expected AS MATERIALIZED (
      SELECT sku_id,location_id,SUM(quantity_delta)::numeric AS quantity FROM movements
      WHERE workspace_id=$1 /* scope:sku_id */ GROUP BY sku_id,location_id), actual AS MATERIALIZED (
      SELECT sku_id,location_id,on_hand::numeric AS quantity FROM balances WHERE workspace_id=$1 /* scope:sku_id */)
    SELECT COALESCE(expected.sku_id,actual.sku_id) AS sku_id,
      COALESCE(expected.location_id,actual.location_id) AS location_id,
      COALESCE(expected.quantity,0)::numeric AS expected_quantity,
      COALESCE(actual.quantity,0)::numeric AS actual_quantity
    FROM expected FULL OUTER JOIN actual USING(sku_id,location_id)
    WHERE COALESCE(expected.quantity,0)<>COALESCE(actual.quantity,0) LIMIT 100`},
  {key:'accounting.posted_journals_balance',table:'accounting_journal_entries',query:`WITH posted AS MATERIALIZED (
      SELECT id,entry_number FROM accounting_journal_entries WHERE workspace_id=$1 /* scope:id */ AND status='POSTED'),
    totals AS MATERIALIZED (SELECT entry_id,COALESCE(SUM(debit_minor),0)::bigint AS debits,
      COALESCE(SUM(credit_minor),0)::bigint AS credits FROM accounting_journal_lines
      WHERE workspace_id=$1 /* scope:entry_id */ GROUP BY entry_id)
    SELECT entry.id AS journal_entry_id,entry.entry_number,COALESCE(line.debits,0)::numeric AS debits,
      COALESCE(line.credits,0)::numeric AS credits FROM posted entry LEFT JOIN totals line ON line.entry_id=entry.id
    WHERE COALESCE(line.debits,0)<>COALESCE(line.credits,0) LIMIT 100`},
  {key:'purchasing.received_quantity_matches_evidence',table:'purchase_order_lines',query:`SELECT line.id AS purchase_order_line_id,
      line.quantity_received_units::numeric AS recorded_quantity,
      COALESCE(SUM(receipt.quantity_units),0)::numeric AS evidenced_quantity
    FROM purchase_order_lines line LEFT JOIN purchase_order_receipt_lines receipt
      ON receipt.workspace_id=line.workspace_id AND receipt.purchase_order_line_id=line.id
    WHERE line.workspace_id=$1 /* scope:line.id */ GROUP BY line.id,line.quantity_received_units
    HAVING line.quantity_received_units<>COALESCE(SUM(receipt.quantity_units),0) LIMIT 100`},
  {key:'accounting.invoice_balance_is_bounded',table:'accounting_customer_invoices',query:`SELECT id AS invoice_id,invoice_number,
      total_minor::bigint AS total_minor,balance_minor::bigint AS balance_minor
    FROM accounting_customer_invoices WHERE workspace_id=$1 /* scope:id */
      AND (balance_minor<0 OR balance_minor>total_minor) LIMIT 100`},
  {key:'communications.provider_success_is_applied',table:'stockchief_runtime.provider_effects',query:`SELECT effect.id AS effect_id,effect.aggregate_id,
      effect.kind,effect.status,COALESCE(supplier.status,customer.status) AS record_status
    FROM stockchief_runtime.provider_effects effect
    LEFT JOIN supplier_communications supplier ON supplier.workspace_id=effect.workspace_id
      AND supplier.id=effect.aggregate_id AND effect.aggregate_type='supplier_communication'
    LEFT JOIN customer_communications customer ON customer.workspace_id=effect.workspace_id
      AND customer.id=effect.aggregate_id AND effect.aggregate_type='customer_communication'
    WHERE effect.workspace_id=$1 /* scope:effect.id */ AND effect.kind='mail.outbound.send' AND effect.status='SUCCEEDED'
      AND (COALESCE(supplier.status,customer.status) IS DISTINCT FROM 'SENT'
        OR COALESCE(supplier.external_message_id,customer.external_message_id) IS NULL
        OR NULLIF(effect.result->>'externalMessageId','') IS NULL) LIMIT 100`},
]);

function affected(rows){return rows.map((row)=>Object.fromEntries(Object.entries(row)
  .filter(([key])=>/(?:_id|_number)$/.test(key))));}


// The SQL above remains the sole definition of each invariant. Record-scoped
// batches change its input set, never the stock or accounting calculation.
function scopedQuery(invariant){return invariant.query.replace(/\/\* scope:([a-z_.]+) \*\//g,(_,column)=>'AND '+column+'=ANY($2::text[])');}

async function storedResult(database,workspaceId,row){
  const checks=(await database.query('SELECT invariant_key,status,observed FROM stockchief_runtime.business_reconciliation_checks WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at,id',[workspaceId,row.id])).rows
    .map(c=>({key:c.invariant_key,status:c.status,material:true,rows:c.observed.rows}));
  return {id:row.id,status:row.status,checks,materialIssueCount:row.material_issue_count,
    partial:false,checkedRecords:Number(row.summary.checkedRecords||0)};
}

async function finish(database,workspaceId,id,summary){
  const row=(await database.query('SELECT * FROM stockchief_runtime.business_reconciliation_runs WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  const result=await storedResult(database,workspaceId,row);
  const failed=result.checks.filter(c=>c.status==='FAIL'),status=failed.length?'FAILED':'VERIFIED',at=nowIso();
  await database.query(`UPDATE stockchief_runtime.business_reconciliation_runs SET status=$3,material_issue_count=$4,
    check_count=$5,completed_at=$6,summary=$7::jsonb WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,id,status,failed.length,result.checks.length,at,JSON.stringify({...summary,
      failed:failed.map(c=>c.key),passed:result.checks.filter(c=>c.status==='PASS').map(c=>c.key)})]);
  await database.query(`INSERT INTO stockchief_runtime.workspace_reconciliation_state
    (workspace_id,last_run_id,last_checked_at,next_check_at,status,updated_at) VALUES($1,$2,$3,$4,$5,$3)
    ON CONFLICT(workspace_id) DO UPDATE SET last_run_id=EXCLUDED.last_run_id,last_checked_at=EXCLUDED.last_checked_at,
      next_check_at=EXCLUDED.next_check_at,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
    [workspaceId,id,at,new Date(Date.now()+15*60_000).toISOString(),status]);
  if(failed.length)await suspend(database,workspaceId,failed.map(c=>c.key));
  else await database.query(`UPDATE workspace_autopilot SET suspended=0,suspended_scope=NULL,suspended_reason=NULL,
    updated_at=$2 WHERE workspace_id=$1 AND suspended=1 AND suspended_reason LIKE 'Reconciliation stopped automatic work:%'`,[workspaceId,at]);
  return {...result,status,materialIssueCount:failed.length};
}

function suspend(database,workspaceId,keys){return database.query(`UPDATE workspace_autopilot SET suspended=1,
  suspended_scope=NULL,suspended_reason=$2,updated_at=$3 WHERE workspace_id=$1`,
  [workspaceId,'Reconciliation stopped automatic work: '+keys.join(', '),nowIso()]);}

// Called inside the durable job transaction: a check page, its progress and
// its continuation either commit together or all roll back together.
async function runBatch(database,workspaceId,{runId=null}={}){
  if(!runId){runId=newId('recon');await require('../autopilot/postgres-service').ensure(database,workspaceId);
    await database.query(`INSERT INTO stockchief_runtime.business_reconciliation_runs(id,workspace_id,status,started_at)
      VALUES($1,$2,'RUNNING',$3)`,[runId,workspaceId,nowIso()]);}
  const row=(await database.query('SELECT * FROM stockchief_runtime.business_reconciliation_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,runId])).rows[0];
  if(!row)throw Object.assign(new Error('Reconciliation run not found.'),{retryable:false});
  if(row.status!=='RUNNING'&&!row.summary.incomplete)return storedResult(database,workspaceId,row);
  if(row.summary.incomplete){delete row.summary.incomplete;delete row.summary.error;
    await database.query("UPDATE stockchief_runtime.business_reconciliation_runs SET status='RUNNING',completed_at=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,runId]);}
  const progress={phase:0,afterId:'',checkedRecords:0,mismatches:[],mismatchCount:0,...row.summary};
  const invariant=INVARIANTS[progress.phase];if(!invariant)throw new Error('Invalid reconciliation checkpoint.');
  // Table names are constants from INVARIANTS, never request input.
  const ids=(await database.query('SELECT id FROM '+invariant.table+' WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 251',[workspaceId,progress.afterId])).rows;
  const page=ids.slice(0,250).map(r=>r.id);
  const mismatches=page.length?(await database.query(scopedQuery(invariant),[workspaceId,page])).rows:[];
  progress.checkedRecords+=page.length;
  progress.mismatchCount+=mismatches.length;
  progress.mismatches=[...progress.mismatches,...mismatches].slice(0,100);
  if(mismatches.length)await suspend(database,workspaceId,[invariant.key]);
  if(ids.length>250)progress.afterId=page.at(-1);
  else{
    await database.query(`INSERT INTO stockchief_runtime.business_reconciliation_checks
      (id,run_id,workspace_id,invariant_key,status,material,observed,expected,affected_records)
      VALUES($1,$2,$3,$4,$5,TRUE,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [newId('recheck'),runId,workspaceId,invariant.key,progress.mismatchCount?'FAIL':'PASS',
        JSON.stringify({mismatchCount:progress.mismatchCount,rows:progress.mismatches,detailsLimited:progress.mismatchCount>100}),
        JSON.stringify({mismatchCount:0}),JSON.stringify(affected(progress.mismatches))]);
    progress.phase++;progress.afterId='';progress.mismatchCount=0;progress.mismatches=[];
  }
  await database.query('UPDATE stockchief_runtime.business_reconciliation_runs SET summary=$3::jsonb,check_count=$4 WHERE workspace_id=$1 AND id=$2',[workspaceId,runId,JSON.stringify(progress),progress.phase]);
  if(progress.phase===INVARIANTS.length)return finish(database,workspaceId,runId,progress);
  return {id:runId,status:'RUNNING',partial:true,checkedRecords:progress.checkedRecords,
    phase:progress.phase,afterId:progress.afterId,invariant:INVARIANTS[progress.phase].key};
}

async function run(database,workspaceId){let result,runId;
  do{result=await database.transaction(client=>runBatch(client,workspaceId,{runId}));runId=result.id;}while(result.partial);
  return result;
}

async function job(job,database){
  if(!job.workspaceId)throw Object.assign(new Error('Reconciliation needs a business.'),{retryable:false});
  if(!job.payload?.runId&&job.createdAt){
    const covering=(await database.query(`SELECT id FROM stockchief_runtime.business_reconciliation_runs
      WHERE workspace_id=$1 AND started_at>=$2 AND status IN ('VERIFIED','FAILED') AND check_count=$3
      AND NOT(summary?'incomplete') ORDER BY completed_at DESC LIMIT 1`,
      [job.workspaceId,job.createdAt,INVARIANTS.length])).rows[0];
    if(covering)return {skipped:'covered_by_completed_check',coveringRunId:covering.id};
  }
  const result=await runBatch(database,job.workspaceId,{runId:job.payload?.runId});
  if(result.partial)await require('./postgres-job-queue').enqueue(database,{workspaceId:job.workspaceId,
    kind:'system.reconcile-business',idempotencyKey:'reconciliation:'+result.id+':'+result.phase+':'+result.afterId,
    payload:{runId:result.id},priority:79,maxAttempts:3});
  return result;
}

async function failedJob(database,job,error){
  if(job.kind!=='system.reconcile-business'||!job.payload?.runId)return;
  await database.query(`UPDATE stockchief_runtime.business_reconciliation_runs SET status='FAILED',completed_at=now(),
    summary=summary||$3::jsonb WHERE workspace_id=$1 AND id=$2 AND status='RUNNING'`,
    [job.workspaceId,job.payload.runId,JSON.stringify({incomplete:true,error:String(error.code||'check_interrupted')})]);
}

async function dueWorkspaces(database,at=nowIso()){return (await database.query(`SELECT w.id FROM workspaces w
  LEFT JOIN stockchief_runtime.workspace_reconciliation_state state ON state.workspace_id=w.id
  WHERE w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs active
    WHERE active.workspace_id=w.id AND active.kind='system.reconcile-business' AND active.status IN ('PENDING','RETRY','RUNNING'))
    AND (state.next_check_at IS NULL OR state.next_check_at<=$1) ORDER BY w.id`,[at])).rows.map((row)=>row.id);}

module.exports={INVARIANTS,scopedQuery,run,runBatch,job,failedJob,dueWorkspaces};

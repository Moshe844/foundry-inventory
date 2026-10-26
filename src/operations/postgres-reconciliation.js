'use strict';

const {newId,nowIso}=require('../lib/util');

const INVARIANTS=Object.freeze([
  {key:'inventory.balance_equals_movements',query:`WITH expected AS MATERIALIZED (
      SELECT sku_id,location_id,SUM(quantity_delta)::bigint AS quantity FROM movements
      WHERE workspace_id=$1 GROUP BY sku_id,location_id), actual AS MATERIALIZED (
      SELECT sku_id,location_id,on_hand::bigint AS quantity FROM balances WHERE workspace_id=$1)
    SELECT COALESCE(expected.sku_id,actual.sku_id) AS sku_id,
      COALESCE(expected.location_id,actual.location_id) AS location_id,
      COALESCE(expected.quantity,0)::bigint AS expected_quantity,
      COALESCE(actual.quantity,0)::bigint AS actual_quantity
    FROM expected FULL OUTER JOIN actual USING(sku_id,location_id)
    WHERE COALESCE(expected.quantity,0)<>COALESCE(actual.quantity,0) LIMIT 100`},
  {key:'accounting.posted_journals_balance',query:`WITH posted AS MATERIALIZED (
      SELECT id,entry_number FROM accounting_journal_entries WHERE workspace_id=$1 AND status='POSTED'),
    totals AS MATERIALIZED (SELECT entry_id,COALESCE(SUM(debit_minor),0)::bigint AS debits,
      COALESCE(SUM(credit_minor),0)::bigint AS credits FROM accounting_journal_lines
      WHERE workspace_id=$1 GROUP BY entry_id)
    SELECT entry.id AS journal_entry_id,entry.entry_number,COALESCE(line.debits,0)::bigint AS debits,
      COALESCE(line.credits,0)::bigint AS credits FROM posted entry LEFT JOIN totals line ON line.entry_id=entry.id
    WHERE COALESCE(line.debits,0)<>COALESCE(line.credits,0) LIMIT 100`},
  {key:'purchasing.received_quantity_matches_evidence',query:`SELECT line.id AS purchase_order_line_id,
      line.quantity_received_units::bigint AS recorded_quantity,
      COALESCE(SUM(receipt.quantity_units),0)::bigint AS evidenced_quantity
    FROM purchase_order_lines line LEFT JOIN purchase_order_receipt_lines receipt
      ON receipt.workspace_id=line.workspace_id AND receipt.purchase_order_line_id=line.id
    WHERE line.workspace_id=$1 GROUP BY line.id,line.quantity_received_units
    HAVING line.quantity_received_units<>COALESCE(SUM(receipt.quantity_units),0) LIMIT 100`},
  {key:'accounting.invoice_balance_is_bounded',query:`SELECT id AS invoice_id,invoice_number,
      total_minor::bigint AS total_minor,balance_minor::bigint AS balance_minor
    FROM accounting_customer_invoices WHERE workspace_id=$1
      AND (balance_minor<0 OR balance_minor>total_minor) LIMIT 100`},
  {key:'communications.provider_success_is_applied',query:`SELECT effect.id AS effect_id,effect.aggregate_id,
      effect.kind,effect.status,COALESCE(supplier.status,customer.status) AS record_status
    FROM stockchief_runtime.provider_effects effect
    LEFT JOIN supplier_communications supplier ON supplier.workspace_id=effect.workspace_id
      AND supplier.id=effect.aggregate_id AND effect.aggregate_type='supplier_communication'
    LEFT JOIN customer_communications customer ON customer.workspace_id=effect.workspace_id
      AND customer.id=effect.aggregate_id AND effect.aggregate_type='customer_communication'
    WHERE effect.workspace_id=$1 AND effect.kind='mail.outbound.send' AND effect.status='SUCCEEDED'
      AND (COALESCE(supplier.status,customer.status) IS DISTINCT FROM 'SENT'
        OR COALESCE(supplier.external_message_id,customer.external_message_id) IS NULL
        OR NULLIF(effect.result->>'externalMessageId','') IS NULL) LIMIT 100`},
]);

function affected(rows){return rows.map((row)=>Object.fromEntries(Object.entries(row)
  .filter(([key])=>/(?:_id|_number)$/.test(key))));}

async function run(database,workspaceId){const id=newId('recon');const started=nowIso();
  // A business may be reconciled before its Autopilot page is ever opened.
  // Create the default (non-automated) authority row so a material mismatch
  // always has a durable stop state to update.
  await require('../autopilot/postgres-service').ensure(database,workspaceId);
  await database.query(`INSERT INTO stockchief_runtime.business_reconciliation_runs
    (id,workspace_id,status,started_at) VALUES($1,$2,'RUNNING',$3)`,[id,workspaceId,started]);
  const checks=[];
  try{for(const invariant of INVARIANTS){const rows=(await database.query(invariant.query,[workspaceId])).rows;
      const status=rows.length?'FAIL':'PASS';const check={key:invariant.key,status,material:true,rows};checks.push(check);
      await database.query(`INSERT INTO stockchief_runtime.business_reconciliation_checks
        (id,run_id,workspace_id,invariant_key,status,material,observed,expected,affected_records)
        VALUES($1,$2,$3,$4,$5,TRUE,$6::jsonb,$7::jsonb,$8::jsonb)`,
      [newId('recheck'),id,workspaceId,invariant.key,status,JSON.stringify({mismatchCount:rows.length,rows}),
        JSON.stringify({mismatchCount:0}),JSON.stringify(affected(rows))]);}
    const failed=checks.filter((check)=>check.status==='FAIL');const status=failed.length?'FAILED':'VERIFIED';const at=nowIso();
    await database.transaction(async(client)=>{await client.query(`UPDATE stockchief_runtime.business_reconciliation_runs
        SET status=$3,material_issue_count=$4,check_count=$5,completed_at=$6,summary=$7::jsonb
        WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,status,failed.length,checks.length,at,
        JSON.stringify({failed:failed.map((check)=>check.key),passed:checks.filter((check)=>check.status==='PASS').map((check)=>check.key)})]);
      await client.query(`INSERT INTO stockchief_runtime.workspace_reconciliation_state
        (workspace_id,last_run_id,last_checked_at,next_check_at,status,updated_at)
        VALUES($1,$2,$3,$4,$5,$3) ON CONFLICT(workspace_id) DO UPDATE SET last_run_id=EXCLUDED.last_run_id,
          last_checked_at=EXCLUDED.last_checked_at,next_check_at=EXCLUDED.next_check_at,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [workspaceId,id,at,new Date(Date.now()+15*60_000).toISOString(),status]);
      if(failed.length)await client.query(`UPDATE workspace_autopilot SET suspended=1,suspended_scope=NULL,
        suspended_reason=$2,updated_at=$3 WHERE workspace_id=$1`,[workspaceId,
        `Reconciliation stopped automatic work: ${failed.map((check)=>check.key).join(', ')}`,at]);
      else await client.query(`UPDATE workspace_autopilot SET suspended=0,suspended_scope=NULL,suspended_reason=NULL,
        updated_at=$2 WHERE workspace_id=$1 AND suspended=1 AND suspended_reason LIKE 'Reconciliation stopped automatic work:%'`,
      [workspaceId,at]);
    },{isolation:'SERIALIZABLE',retrySafe:true});
    return {id,status,checks,materialIssueCount:failed.length};
  }catch(error){await database.query(`UPDATE stockchief_runtime.business_reconciliation_runs SET status='FAILED',
      completed_at=now(),summary=$3::jsonb WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,
    JSON.stringify({error:String(error.code||error.message).slice(0,200)})]).catch(()=>{});throw error;}}

async function dueWorkspaces(database,at=nowIso()){return (await database.query(`SELECT w.id FROM workspaces w
  LEFT JOIN stockchief_runtime.workspace_reconciliation_state state ON state.workspace_id=w.id
  WHERE w.deletion_requested_at IS NULL AND (state.next_check_at IS NULL OR state.next_check_at<=$1) ORDER BY w.id`,[at])).rows.map((row)=>row.id);}

module.exports={INVARIANTS,run,dueWorkspaces};

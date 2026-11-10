'use strict';

const {newId,nowIso}=require('../lib/util');

// The books total for one control account, as debits less credits (or credits
// less debits for sign -1): every line on it, less lines of entries not posted.
// Reading lines by account and subtracting the rare unposted entries avoids
// joining every line to its entry, which is what keeps this cheap at scale.
// Unposted entries are almost always none, so that side starts from them.
function ledgerMinor(systemKey,sign){
  const accounts=`SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='${systemKey}'`;
  return `(${sign<0?'-':''}((SELECT COALESCE(SUM(l.debit_minor-l.credit_minor),0) FROM accounting_journal_lines l
      WHERE l.workspace_id=$1 AND l.account_id IN (${accounts}))
    -(SELECT COALESCE(SUM(unposted.minor),0) FROM accounting_journal_entries e
      CROSS JOIN LATERAL(SELECT SUM(l.debit_minor-l.credit_minor) AS minor FROM accounting_journal_lines l
        WHERE l.workspace_id=e.workspace_id AND l.entry_id=e.id AND l.account_id IN (${accounts})) unposted
      WHERE e.workspace_id=$1 AND e.status<>'POSTED')))`;
}
// A whole-business check: the books figure against the records' figure, for
// businesses that keep books. No rows means they agree.
function tieOut(key,systemKey,sign,recordsSql){return {key,whole:true,query:`WITH books AS (
      SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1),
    totals AS MATERIALIZED (SELECT ${ledgerMinor(systemKey,sign)}::bigint AS ledger_minor,(${recordsSql})::bigint AS records_minor)
    SELECT books.base_currency AS currency,totals.ledger_minor,totals.records_minor,
      (totals.ledger_minor-totals.records_minor)::bigint AS difference_minor
    FROM books CROSS JOIN totals WHERE totals.ledger_minor<>totals.records_minor`};}

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
  // Stock positions: none below zero unless the product allows it, and the
  // value records never count more units than the shelf holds.
  // The page's positions below zero are read first, by the stock key; joining
  // every product first made the planner walk the whole catalogue (4 s a page
  // on a million-position business instead of 20 ms).
  {key:'inventory.no_negative_stock',table:'skus',query:`WITH page AS MATERIALIZED (SELECT b.sku_id,b.location_id,b.on_hand FROM balances b
      WHERE b.workspace_id=$1 /* scope:b.sku_id */ AND b.on_hand<0)
    SELECT page.sku_id,page.location_id,page.on_hand::numeric AS on_hand FROM page
    JOIN skus s ON s.workspace_id=$1 AND s.id=page.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE COALESCE(i.allow_negative,0)=0 LIMIT 100`},
  {key:'inventory.costed_units_within_stock',table:'skus',query:`SELECT c.sku_id,c.location_id,
      c.quantity_units::numeric AS costed_quantity,c.total_cost_minor::bigint AS value_minor,COALESCE(b.on_hand,0)::numeric AS on_hand
    FROM accounting_inventory_cost_balances c LEFT JOIN balances b
      ON b.workspace_id=c.workspace_id AND b.sku_id=c.sku_id AND b.location_id=c.location_id
    WHERE c.workspace_id=$1 /* scope:c.sku_id */ AND (c.quantity_units<0 OR c.total_cost_minor<0
      OR c.quantity_units>GREATEST(COALESCE(b.on_hand,0),0)) LIMIT 100`},
  // Each control account in the books equals the sum of the records that keep it.
  tieOut('accounting.inventory_ledger_matches_stock_value','INVENTORY_ASSET',1,
    'SELECT COALESCE(SUM(total_cost_minor),0) FROM accounting_inventory_cost_balances WHERE workspace_id=$1'),
  tieOut('accounting.receivables_ledger_matches_invoices','ACCOUNTS_RECEIVABLE',1,
    "SELECT COALESCE(SUM(balance_minor),0) FROM accounting_customer_invoices WHERE workspace_id=$1 AND status NOT IN ('DRAFT','VOID') AND voided_at IS NULL"),
  tieOut('accounting.payables_ledger_matches_bills','ACCOUNTS_PAYABLE',-1,
    "SELECT COALESCE(SUM(balance_minor),0) FROM accounting_supplier_bills WHERE workspace_id=$1 AND journal_entry_id IS NOT NULL AND status<>'VOID' AND voided_at IS NULL"),
  tieOut('accounting.deposits_ledger_matches_held_payments','CUSTOMER_DEPOSITS',-1,`SELECT COALESCE((SELECT SUM(p.amount_minor-COALESCE(applied.minor,0))
      FROM accounting_payments p CROSS JOIN LATERAL(SELECT SUM(a.amount_minor) AS minor FROM accounting_payment_allocations a
        WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id) applied
      WHERE p.workspace_id=$1 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'),0)
    -(SELECT COALESCE(SUM(amount_minor),0) FROM accounting_deposit_refunds WHERE workspace_id=$1)`),
  {key:'accounting.invoice_total_matches_parts',whole:true,query:`SELECT id AS invoice_id,invoice_number,total_minor::bigint AS total_minor,
      (subtotal_minor-discount_minor+tax_minor+COALESCE(charges_minor,0))::bigint AS parts_minor
    FROM accounting_customer_invoices WHERE workspace_id=$1 AND status<>'DRAFT'
      AND total_minor<>subtotal_minor-discount_minor+tax_minor+COALESCE(charges_minor,0) LIMIT 100`},
  // A payment is the cash its entry moved, never applied for more than it paid,
  // and a void one has its void entry. A payment entry always has its payment.
  {key:'accounting.payments_match_their_entries',whole:true,query:`SELECT p.id AS payment_id,p.payment_number,p.status,
      p.amount_minor::bigint AS amount_minor,COALESCE(cash.minor,0)::bigint AS entry_cash_minor,COALESCE(applied.minor,0)::bigint AS applied_minor
    FROM accounting_payments p
    LEFT JOIN accounting_journal_entries e ON e.workspace_id=p.workspace_id AND e.id=p.journal_entry_id AND e.status='POSTED'
    CROSS JOIN LATERAL(SELECT SUM(CASE WHEN p.direction='CUSTOMER_RECEIPT' THEN l.debit_minor-l.credit_minor ELSE l.credit_minor-l.debit_minor END) AS minor
      FROM accounting_journal_lines l WHERE l.workspace_id=p.workspace_id AND l.entry_id=e.id AND l.account_id=p.cash_account_id) cash
    CROSS JOIN LATERAL(SELECT SUM(a.amount_minor) AS minor FROM accounting_payment_allocations a
      WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id) applied
    WHERE p.workspace_id=$1 AND (e.id IS NULL OR COALESCE(cash.minor,0)<>p.amount_minor OR COALESCE(applied.minor,0)>p.amount_minor
      OR (p.status='VOID' AND (COALESCE(applied.minor,0)<>0 OR NOT EXISTS(SELECT 1 FROM accounting_journal_entries v
        WHERE v.workspace_id=p.workspace_id AND v.source_type='payment_void' AND v.source_record_id=p.id AND v.status='POSTED'))))
    LIMIT 100`},
  {key:'accounting.payment_entries_have_payments',whole:true,query:`SELECT e.id AS journal_entry_id,e.entry_number,e.source_type
    FROM accounting_journal_entries e WHERE e.workspace_id=$1 AND e.status='POSTED'
      AND e.source_type IN ('customer_payment','supplier_payment','customer_deposit')
      AND NOT EXISTS(SELECT 1 FROM accounting_payments p WHERE p.workspace_id=e.workspace_id AND p.journal_entry_id=e.id) LIMIT 100`},
  // What an order line says shipped is what its invoices charged for.
  {key:'sales.shipped_quantity_matches_invoices',whole:true,query:`SELECT line.id AS sales_order_line_id,o.order_number,
      line.quantity_fulfilled::numeric AS shipped_quantity,COALESCE(invoiced.quantity,0)::numeric AS invoiced_quantity
    FROM sales_order_lines line JOIN sales_orders o ON o.workspace_id=line.workspace_id AND o.id=line.sales_order_id
    LEFT JOIN (SELECT sales_order_line_id,SUM(quantity) AS quantity FROM accounting_customer_invoice_lines
      WHERE workspace_id=$1 AND sales_order_line_id IS NOT NULL GROUP BY sales_order_line_id) invoiced ON invoiced.sales_order_line_id=line.id
    WHERE line.workspace_id=$1 AND line.quantity_fulfilled<>COALESCE(invoiced.quantity,0) LIMIT 100`},
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
  // A whole-business check runs as one statement; the rest page through their
  // table. Table names are constants from INVARIANTS, never request input.
  const ids=invariant.whole?[]:(await database.query('SELECT id FROM '+invariant.table+' WHERE workspace_id=$1 AND id>$2 ORDER BY id LIMIT 251',[workspaceId,progress.afterId])).rows;
  const page=ids.slice(0,250).map(r=>r.id);
  const mismatches=invariant.whole?(await database.query(invariant.query,[workspaceId])).rows
    :page.length?(await database.query(scopedQuery(invariant),[workspaceId,page])).rows:[];
  progress.checkedRecords+=invariant.whole?1:page.length;
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
    if(job.kind==='agent.slack.answer.v1')return require('../connections/agent-slack').recover(database,job);
    if(job.kind==='import.read-product-facts.v1')return require('../documents/agent-product-source').recover(database,job);
    if(job.kind==='catalog.channel-copy.v1')return require('../catalog/agent-channel-copy').failInterrupted(database,job.workspaceId,job.payload.copyId,job.payload.runId);
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

// What each check means to an owner, and where to look when it fails.
const WORDS=Object.freeze({
  'inventory.balance_equals_movements':{title:'Stock on hand does not match its stock history',href:'/inventory'},
  'accounting.posted_journals_balance':{title:'A posted accounting entry does not balance',href:'/accounting'},
  'purchasing.received_quantity_matches_evidence':{title:'A purchase order shows a different amount received than its receipts',href:'/purchasing/orders'},
  'accounting.invoice_balance_is_bounded':{title:'An invoice balance is below zero or above its total',href:'/accounting/receivables'},
  'communications.provider_success_is_applied':{title:'An email that was sent is not marked as sent',href:'/needs-you'},
  'inventory.no_negative_stock':{title:'Stock is below zero on a product that does not allow it',href:'/inventory'},
  'inventory.costed_units_within_stock':{title:'Stock value records count more units than are on the shelf',href:'/inventory'},
  'accounting.inventory_ledger_matches_stock_value':{title:'Stock value in your books does not match your stock records',href:'/accounting',books:'Stock value'},
  'accounting.receivables_ledger_matches_invoices':{title:'Money owed to you in your books does not match your open invoices',href:'/accounting/receivables',books:'Money owed to you'},
  'accounting.payables_ledger_matches_bills':{title:'Money you owe suppliers in your books does not match your open bills',href:'/accounting/payables',books:'Money you owe suppliers'},
  'accounting.deposits_ledger_matches_held_payments':{title:'Customer deposits in your books do not match deposits held on orders',href:'/money',books:'Customer deposits'},
  'accounting.invoice_total_matches_parts':{title:'An invoice total does not add up from its subtotal, discount, tax and charges',href:'/accounting/receivables'},
  'accounting.payments_match_their_entries':{title:'A payment does not match its accounting entry',href:'/accounting/receivables'},
  'accounting.payment_entries_have_payments':{title:'An accounting entry for a payment has no payment behind it',href:'/accounting'},
  'sales.shipped_quantity_matches_invoices':{title:'An order line shows a different quantity shipped than was invoiced',href:'/orders'},
});

// The failed checks from the latest finished check, worded for an owner.
async function failures(database,workspaceId){
  const rows=(await database.query(`SELECT c.invariant_key,c.observed,r.completed_at
    FROM stockchief_runtime.workspace_reconciliation_state state
    JOIN stockchief_runtime.business_reconciliation_runs r ON r.workspace_id=state.workspace_id AND r.id=state.last_run_id
    JOIN stockchief_runtime.business_reconciliation_checks c ON c.workspace_id=r.workspace_id AND c.run_id=r.id
    WHERE state.workspace_id=$1 AND state.status='FAILED' AND c.status='FAIL' ORDER BY c.created_at,c.id`,[workspaceId])).rows;
  const money=require('../pricing/postgres-service').formatMinor;
  // Stock positions are named by product code and place, so the owner can open them.
  const positions=rows.flatMap(row=>(row.observed?.rows||[]).filter(r=>r.sku_id&&r.location_id).map(r=>({sku_id:r.sku_id,location_id:r.location_id})));
  const places=new Map(positions.length?(await database.query(`SELECT s.id AS sku_id,l.id AS location_id,s.code,s.item_id,l.name AS location_name
    FROM jsonb_to_recordset($2::jsonb) x(sku_id text,location_id text) JOIN skus s ON s.workspace_id=$1 AND s.id=x.sku_id
    JOIN locations l ON l.workspace_id=$1 AND l.id=x.location_id`,[workspaceId,JSON.stringify(positions)])).rows.map(p=>[p.sku_id+':'+p.location_id,p]):[]);
  return rows.map(row=>{const words=WORDS[row.invariant_key]||{title:'A record does not match the books',href:'/needs-you'};
    const observed=row.observed||{},list=observed.rows||[],sample=list[0]||{},count=Number(observed.mismatchCount||0);
    const place=r=>places.get(r.sku_id+':'+r.location_id);
    const named=[...new Set(list.map(r=>r.invoice_number||r.payment_number||r.order_number||(r.entry_number!=null?'entry #'+r.entry_number:null)
      ||(place(r)?place(r).code+' at '+place(r).location_name:null)).filter(Boolean))].slice(0,3);
    const items=[...new Set(list.map(r=>place(r)?.item_id).filter(Boolean))];
    const happened=sample.ledger_minor!==undefined
      ?`${words.books} in your books is ${money(Number(sample.ledger_minor),sample.currency)}; your records add up to ${money(Number(sample.records_minor),sample.currency)}.`
      :`${count} ${count===1?'record does':'records do'} not match${named.length?': '+named.join(', '):''}.`;
    return {key:row.invariant_key,title:words.title,href:items.length===1?'/inventory/'+items[0]:words.href,happened,checkedAt:row.completed_at};});
}

module.exports={INVARIANTS,WORDS,scopedQuery,run,runBatch,job,failedJob,dueWorkspaces,failures};

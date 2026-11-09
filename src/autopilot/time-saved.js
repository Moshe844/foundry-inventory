'use strict';

const { ValidationError, AuthorizationError } = require('../domain/errors');
const policy = require('../commercial/agent-plan');
const activities = new Map([
  ['repeat-order','Prepare and send a repeat purchase order'],
  ['supplier-response','File a supplier confirmation or document'],
  ['staff-request','Create a purchase order from an approved staff request'],
  ['invoice-match','Enter and match a supplier invoice from an agent proposal'],
  ['customer-receipt','Match a recorded customer bank receipt to its invoice'],
  ['accounting-export','Export and verify an agent-queued accounting journal'],
  ['count-adjustment','Post a stock count difference within the owner’s limit'],
  ['repeat-sale','Prepare a repeat customer order at current prices'],
  ['margin-price','Calculate and record an individually approved price change'],
  ['combine-purchases','Combine compatible purchase order drafts'],
  ['split-purchase','Split a purchase order into separate drafts']
]);

async function access(db, ctx) {
  const member = await db.query("SELECT 1 FROM users WHERE id=$1 AND workspace_id=$2 AND role='owner'",[ctx.actorId,ctx.workspaceId]);
  if (!member.rowCount) throw new AuthorizationError('The business owner can view this report.');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,161,'automatic');
}

async function sample(db, ctx, input) {
  await access(db,ctx);
  const minutes = [input.manualMinutes,input.reviewMinutes];
  if (!activities.has(input.activity) || !minutes.every(v => /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(String(v)) && Number(v)<=1440) ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey || '')) throw new ValidationError('Choose a task and enter both timed samples in minutes.');
  await db.query(`INSERT INTO stockchief_runtime.agent_time_samples(id,workspace_id,recorded_by,activity,manual_minutes,review_minutes)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,id) DO NOTHING`,
    [input.requestKey,ctx.workspaceId,ctx.actorId,input.activity,...minutes]);
}

async function report(db,ctx,window='week') {
  await access(db,ctx);
  if (!['week','month'].includes(window)) throw new ValidationError('Choose the last seven or thirty days.');
  const days = window==='week' ? 7 : 30;
  const completed = (await db.query(`WITH first_send AS (
    SELECT m.purchase_order_id,min(m.sent_at::timestamptz) AS occurred FROM supplier_communications m
    WHERE m.workspace_id=$1 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM work_items w WHERE w.workspace_id=m.workspace_id AND w.purchase_order_id=m.purchase_order_id
      AND w.source='postgres_autopilot' AND w.approval_requirement='NONE' AND w.outcome::jsonb->>'communicationId'=m.id)
    GROUP BY m.purchase_order_id
  ), responses AS (
    SELECT l.purchase_order_id,s.kind,s.fingerprint,min(s.created_at) AS occurred
    FROM stockchief_runtime.supplier_link_submissions s JOIN stockchief_runtime.supplier_order_links l
    ON l.workspace_id=s.workspace_id AND l.token_hash=s.token_hash WHERE s.workspace_id=$1
    GROUP BY l.purchase_order_id,s.kind,s.fingerprint
  ), events AS (
    SELECT 'repeat-order' AS activity,occurred FROM first_send UNION ALL
    SELECT 'supplier-response',occurred FROM responses UNION ALL
    SELECT 'staff-request',r.decided_at FROM stockchief_runtime.purchase_requests r
      JOIN purchase_orders p ON p.workspace_id=r.workspace_id AND p.id=r.purchase_order_id WHERE r.workspace_id=$1 AND r.status='APPROVED' UNION ALL
    SELECT 'invoice-match',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a JOIN accounting_supplier_bills b
      ON b.workspace_id=a.workspace_id AND b.id=a.result->>'billId'
      WHERE a.workspace_id=$1 AND a.status='EXECUTED' AND a.action_type='purchase_order.record_supplier_invoice'
        AND a.result->>'status' IN ('OPEN','DISPUTED') GROUP BY b.id UNION ALL
    SELECT 'customer-receipt',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a
      JOIN accounting_bank_transactions t ON t.workspace_id=a.workspace_id AND t.id=a.result->>'bankTransactionId' AND t.status IN ('MATCHED','RECONCILED')
      JOIN accounting_payments p ON p.workspace_id=t.workspace_id AND p.id=t.matched_payment_id AND p.id=a.result->>'paymentId'
        AND p.source_key='agent-bank-receipt:'||t.id AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'
      JOIN accounting_payment_allocations l ON l.workspace_id=p.workspace_id AND l.payment_id=p.id AND l.customer_invoice_id=a.payload->>'recordId' AND l.amount_minor=t.amount_minor
      JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id AND j.status='POSTED'
      WHERE a.workspace_id=$1 AND a.action_type='customer_payment.match_bank_line' AND a.status='EXECUTED' AND a.result->>'replayed' IS DISTINCT FROM 'true'
        AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')
      GROUP BY t.id UNION ALL
    SELECT 'accounting-export',min(e.completed_at) FROM stockchief_runtime.provider_effects e
      WHERE e.workspace_id=$1 AND e.kind='accounting.journal.export' AND e.status='SUCCEEDED'
        AND e.payload->>'agentExport'='true' AND e.provider_reference->>'externalId' IS NOT NULL GROUP BY e.aggregate_id UNION ALL
    SELECT 'count-adjustment',r.approved_at FROM physical_count_reviews r
      WHERE r.workspace_id=$1 AND r.status='COMPLETED' AND r.agent_decision->>'action'='post'
        AND (r.result->>'changed')::int>0 UNION ALL
    SELECT 'repeat-sale',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a
      JOIN sales_orders o ON o.workspace_id=a.workspace_id AND o.id=a.result->>'salesOrderId'
      WHERE a.workspace_id=$1 AND a.status='EXECUTED' AND a.action_type='sales_order.repeat' GROUP BY o.id UNION ALL
    SELECT 'margin-price',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a
      JOIN sku_prices p ON p.workspace_id=a.workspace_id AND p.id=a.result->>'id'
      WHERE a.workspace_id=$1 AND a.status='EXECUTED' AND a.action_type='catalog.restore_margin' GROUP BY p.id UNION ALL
    SELECT CASE a.action_type WHEN 'purchase_order.combine_drafts' THEN 'combine-purchases' ELSE 'split-purchase' END,a.executed_at
      FROM stockchief_runtime.assistant_action_proposals a
      WHERE a.workspace_id=$1 AND a.status='EXECUTED' AND a.action_type IN ('purchase_order.combine_drafts','purchase_order.split_draft')
        AND jsonb_array_length(a.result->'drafts')>0 AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(a.result->'drafts') d(id)
          WHERE NOT EXISTS (SELECT 1 FROM purchase_orders p WHERE p.workspace_id=a.workspace_id AND p.id=d.id))
  )
  SELECT activity,count(*)::integer AS n FROM events
  WHERE occurred>=CURRENT_TIMESTAMP-($2::int * interval '24 hours') AND occurred<=CURRENT_TIMESTAMP GROUP BY activity`,[ctx.workspaceId,days])).rows;
  const timings = (await db.query(`SELECT activity,count(*)::integer AS n,avg(manual_minutes-review_minutes) AS net_minutes
    FROM stockchief_runtime.agent_time_samples WHERE workspace_id=$1 GROUP BY activity`,[ctx.workspaceId])).rows;
  const rows = [...activities].map(([key,label])=>{
    const count=completed.find(r=>r.activity===key)?.n || 0, time=timings.find(r=>r.activity===key);
    return {key,label,count,samples:time?.n || 0,minutes:time ? count*Number(time.net_minutes) : null};
  });
  const coverage=rows.reduce((sum,r)=>sum+(r.samples?0:r.count),0);
  const monetary=await moneyReview(db,ctx,days);
  return {days,rows,coverage,...monetary,minutes:rows.some(r=>r.samples>0)?rows.reduce((n,r)=>n+(r.minutes??0),0):null};
}
async function moneyReview(db,ctx,days){
  const money=require('../domain/currency');
  const amounts=(await db.query(`WITH open_differences AS (
    SELECT b.currency,sum(round(l.quantity * ((d->>'billedUnitCostMinor')::numeric-(d->>'approvedUnitCostMinor')::numeric))) AS amount
    FROM accounting_supplier_bills b JOIN purchase_orders p ON p.workspace_id=b.workspace_id AND p.id=b.purchase_order_id AND p.currency=b.currency
    CROSS JOIN LATERAL jsonb_array_elements(b.exception_detail::jsonb->'differences') d
    JOIN accounting_supplier_bill_lines l ON l.workspace_id=b.workspace_id AND l.bill_id=b.id AND l.line_number=(d->>'line')::int
    WHERE b.workspace_id=$1 AND b.status='DISPUTED' AND b.created_at::timestamptz BETWEEN now()-make_interval(days=>$2) AND now()
      AND d->>'kind'='price_outside_approved_cost' AND (d->>'billedUnitCostMinor')::numeric>(d->>'approvedUnitCostMinor')::numeric
    GROUP BY b.currency
  ), applied AS (
    SELECT b.currency,sum(c.amount_minor) AS amount FROM accounting_supplier_credits c
    JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
    JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id AND j.status='POSTED'
    WHERE c.workspace_id=$1 AND c.created_at::timestamptz BETWEEN now()-make_interval(days=>$2) AND now()
      AND EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals a WHERE a.workspace_id=c.workspace_id
        AND a.action_type='supplier_return.reconcile' AND a.status='EXECUTED' AND a.result->>'supplierCreditId'=c.id)
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=j.workspace_id AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
    GROUP BY b.currency)
    SELECT currency,coalesce(d.amount,0)::bigint AS flagged,coalesce(a.amount,0)::bigint AS applied
    FROM open_differences d FULL JOIN applied a USING(currency) ORDER BY currency`,[ctx.workspaceId,days])).rows;
  const terms=(await db.query(`SELECT v.currency,v.monthly_amount_minor,v.annual_amount_minor,s.billing_interval
    FROM workspaces w JOIN account_subscriptions s ON s.account_id=w.owner_account_id JOIN commercial_plan_versions v ON v.id=s.plan_version_id
    WHERE w.id=$1`,[ctx.workspaceId])).rows[0];
  const annual=terms?.billing_interval==='ANNUAL';
  const price=annual?terms?.annual_amount_minor:terms?.monthly_amount_minor;
  return {amounts:amounts.map(r=>({currency:r.currency,flagged:money.format(r.flagged,r.currency),applied:money.format(r.applied,r.currency)})),
    planPrice:price==null?null:money.format(price,terms.currency),planInterval:annual?'year':'month'};
}
module.exports = { report,sample };

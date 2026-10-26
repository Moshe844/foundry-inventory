'use strict';

// Financial observations never receive stock. A review can close automatically
// only when an unambiguous, fully received and financially posted return already
// supplies that separate evidence. Partial or ambiguous refunds remain open.
function payload(row) {
  try { return typeof row.normalized_payload === 'string' ? JSON.parse(row.normalized_payload) : row.normalized_payload; }
  catch { return null; }
}

async function reconcileInTransaction(client, workspaceId, options = {}) {
  const issues = (await client.query(`SELECT i.id AS issue_id,e.* FROM connection_issues i
    JOIN connector_feed_events e ON e.workspace_id=i.workspace_id AND e.connector_id=i.connector_id
      AND e.external_event_id=i.external_event_id
    WHERE i.workspace_id=$1 AND ($2::text IS NULL OR i.connector_id=$2)
      AND i.issue_type='RETURN_REVIEW_REQUIRED' AND i.status='OPEN'
      AND e.event_type='return.reported' AND e.status='IGNORED'
    ORDER BY i.created_at,i.id LIMIT 200 FOR UPDATE OF i,e`,
  [workspaceId, options.connectorId || null])).rows;
  let resolved = 0;
  for (const issue of issues) {
    const data = payload(issue)?.data;
    if (!data || !Number.isSafeInteger(data.amountMinor) || data.amountMinor <= 0
      || !/^[A-Z]{3}$/.test(data.currency || '') || !data.externalPaymentId) continue;
    const paymentId = String(data.externalPaymentId);
    // A provider refund may have its own order identifier. Resolve its original
    // sale through the independently saved payment observation, not free text.
    const sources = (await client.query(`SELECT normalized_payload FROM connector_feed_events
      WHERE workspace_id=$1 AND connector_id=$2 AND event_type='payment.reported'
        AND status IN ('COMPLETED','IGNORED')
        AND normalized_payload::jsonb->'data'->>'externalPaymentId'=$3`,
    [workspaceId, issue.connector_id, paymentId])).rows;
    const externalOrders = [...new Set(sources.map(r => payload(r)?.data?.externalOrderId).filter(Boolean).map(String))];
    if (externalOrders.length !== 1 || !sources.some(r => payload(r)?.data?.amountMinor === data.amountMinor
      && payload(r)?.data?.currency === data.currency)) continue;
    const mapped = (await client.query(`SELECT m.foundry_record_id,so.currency FROM connection_mappings m
      JOIN sales_orders so ON so.workspace_id=m.workspace_id AND so.id=m.foundry_record_id
      WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type='sales_order' AND m.external_id=$3`,
    [workspaceId, issue.connector_id, externalOrders[0]])).rows;
    if (mapped.length !== 1 || mapped[0].currency !== data.currency) continue;
    const orderId = mapped[0].foundry_record_id;
    if (options.salesOrderId && options.salesOrderId !== orderId) continue;
    if (data.externalOrderId) {
      const direct = (await client.query(`SELECT foundry_record_id FROM connection_mappings
        WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sales_order' AND external_id=$3`,
      [workspaceId, issue.connector_id, String(data.externalOrderId)])).rows;
      if (direct.some(r => r.foundry_record_id !== orderId)) continue;
    }
    // Do not combine several financial observations, payments or returns based
    // merely on equal totals. Those cases need an explicit reconciliation.
    const observations = (await client.query(`SELECT external_event_id FROM connector_feed_events
      WHERE workspace_id=$1 AND connector_id=$2 AND event_type='return.reported'
        AND status IN ('COMPLETED','IGNORED')
        AND normalized_payload::jsonb->'data'->>'externalPaymentId'=$3`,
    [workspaceId, issue.connector_id, paymentId])).rows;
    if (observations.length !== 1 || observations[0].external_event_id !== issue.external_event_id) continue;
    const payments = (await client.query(`SELECT p.id,p.reference,p.amount_minor,p.currency FROM accounting_payments p
      WHERE p.workspace_id=$1 AND p.sales_order_id=$2 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'`,
    [workspaceId, orderId])).rows;
    if (payments.length !== 1 || payments[0].reference !== paymentId || payments[0].currency !== data.currency
      || Number(payments[0].amount_minor) !== data.amountMinor) continue;
    const returns = (await client.query(`SELECT id,status,resolution,refund_id FROM customer_returns
      WHERE workspace_id=$1 AND sales_order_id=$2 AND status<>'CANCELLED'`, [workspaceId, orderId])).rows;
    if (returns.length !== 1 || returns[0].status !== 'COMPLETED'
      || returns[0].resolution !== 'REFUND' || !returns[0].refund_id) continue;
    const returned = returns[0];
    const lines = (await client.query(`SELECT sol.quantity_ordered,sol.quantity_fulfilled,rl.quantity_authorized,rl.quantity_received,
        rl.quantity_restocked,rl.quantity_scrapped,rl.quantity_repair
      FROM sales_order_lines sol LEFT JOIN customer_return_lines rl
        ON rl.workspace_id=sol.workspace_id AND rl.sales_order_line_id=sol.id AND rl.customer_return_id=$3
      WHERE sol.workspace_id=$1 AND sol.sales_order_id=$2`,
    [workspaceId, orderId, returned.id])).rows;
    if (!lines.length || lines.some(l => Number(l.quantity_fulfilled) !== Number(l.quantity_ordered)
      || Number(l.quantity_authorized) !== Number(l.quantity_fulfilled)
      || Number(l.quantity_received) !== Number(l.quantity_fulfilled)
      || Number(l.quantity_restocked) + Number(l.quantity_scrapped) + Number(l.quantity_repair) !== Number(l.quantity_fulfilled))) continue;
    const refunds = (await client.query(`SELECT r.id,r.revenue_minor,r.tax_minor,r.settled_amount_minor,r.payment_journal_entry_id,r.destination,je.status,payout.status AS payout_status,
        ARRAY(SELECT DISTINCT jl.currency FROM accounting_journal_lines jl
          WHERE jl.workspace_id=je.workspace_id AND jl.entry_id=je.id) AS currencies
      FROM accounting_sale_refunds r JOIN accounting_journal_entries je
        ON je.workspace_id=r.workspace_id AND je.id=r.journal_entry_id
      LEFT JOIN accounting_journal_entries payout ON payout.workspace_id=r.workspace_id AND payout.id=r.payment_journal_entry_id
      WHERE r.workspace_id=$1 AND je.source_record_type='customer_return' AND je.source_record_id=$2`,
    [workspaceId, returned.id])).rows;
    if (!refunds.some(r => r.id === returned.refund_id) || refunds.some(r => r.status !== 'POSTED'
      || r.currencies.length !== 1 || r.currencies[0] !== data.currency || r.destination !== 'CASH'||(r.settled_amount_minor!==null&&Number(r.settled_amount_minor)>0&&r.payout_status!=='POSTED'))
      || refunds.reduce((n,r) => n + (r.settled_amount_minor===null?Number(r.revenue_minor)+Number(r.tax_minor):Number(r.settled_amount_minor)), 0) !== data.amountMinor) continue;
    const at = new Date().toISOString();
    await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3,
      detail=detail||$4 WHERE workspace_id=$1 AND id=$2 AND status='OPEN'`,
    [workspaceId, issue.issue_id, at, ` Reconciled with completed customer return ${returned.id}; physical receipt and posted refund verified.`]);
    await client.query(`UPDATE connector_feed_events SET action_type='return.reconciled',action_record_id=$3,
      error_message=NULL WHERE workspace_id=$1 AND id=$2`, [workspaceId, issue.id, returned.id]);
    resolved++;
  }
  return { resolved };
}

async function reconcile(database, workspaceId, options = {}) {
  return database.transaction(client => reconcileInTransaction(client, workspaceId, options),
    { isolation: 'SERIALIZABLE', retrySafe: true });
}

module.exports = { reconcile, reconcileInTransaction };

'use strict';

const { ValidationError, AuthorizationError } = require('../domain/errors');
const policy = require('../commercial/agent-plan');
const activities = new Map([
  ['repeat-order','Prepare and send a repeat purchase order'],
  ['supplier-response','File a supplier confirmation or document'],
  ['staff-request','Create a purchase order from an approved staff request'],
  ['invoice-match','Read, enter and match one original supplier invoice'],
  ['customer-receipt','Match a recorded customer bank receipt to its invoice'],
  ['customer-reminder','Prepare and send a customer invoice payment reminder'],
  ['arrived-stock','Reserve arrived stock for a waiting customer order'],
  ['stock-ready','Send a customer an update when waiting stock is reserved'],
  ['invoice-dispute','Prepare and send a sourced supplier invoice dispute'],
  ['customer-statement','Prepare and send a requested customer account statement'],
  ['quote-followup','Prepare and send a follow-up on a customer quotation'],
  ['supplier-forecast','Prepare and share a supplier stock and demand forecast'],
  ['return-email','Prepare an RMA from an original customer return email'],
  ['bin-correction','Post a physically confirmed stock bin correction'],
  ['supplier-details','Update known supplier details from an original email'],
  ['po-delivery-date','Update a purchase order from an original supplier delivery promise'],
  ['po-supplier-amendment','Update a purchase order from original supplier quantity or price changes'],
  ['receiving-document','Prepare one packing-slip receiving form from the original (administration only)'],
  ['supplier-direct-purchase','Prepare and send one supplier-direct purchase'],
  ['supplier-direct-dispatch','Record one actual supplier dispatch and customer invoice'],
  ['delivery-comparison','Compare one actual supplier delivery with its purchase order'],
  ['container-plan','Calculate a container load plan from confirmed carton facts'],
  ['team-procedure','Write a private app procedure from verified completed team work'],
  ['product-facts','Read one complete product source and save its verified facts on one native product'],
  ['channel-copy','Prepare and export one product-copy batch for one sales channel'],
  ['blanket-release','Prepare one unapproved scheduled supplier release (administration only)'],
  ['product-retirement','Retire one checked supplier notice batch and record its replacements'],
  ['shutdown-purchase','Prepare one reviewed supplier shutdown purchase draft'],
  ['promotion-purchase','Prepare one promotion purchase draft'],
  ['delivery-qc','Apply a QC hold to one received product line'],
  ['supplier-rfq','Prepare and send one supplier quotation request'],
  ['supplier-claim','Prepare and send one physically evidenced supplier damage claim'],
  ['customer-reservation','Reserve one complete customer order from actual available stock'],
  ['customer-priority','Apply one checked customer stock priority'],
  ['channel-buffer','Publish and verify one buffered channel stock update'],
  ['export-papers','Prepare and review one shipment export packet'],
  ['return-disposition','Prepare and approve one rule-based return disposition (administration only)'],
  ['customer-page-order','Copy one reviewed customer page request into an unconfirmed order (administration only)'],
  ['return-label','Prepare and send one purchased return label and its instructions'],
  ['partial-shipment','Prepare and complete one partial shipment (administration only)'],
  ['annual-stocktake','Coordinate and sign off one completed stocktake (administration only)'],
  ['accounting-export','Export and verify an agent-queued accounting journal'],
  ['count-adjustment','Post a stock count difference within the owner’s limit'],
  ['repeat-sale','Prepare a repeat customer order at current prices'],
  ['margin-price','Calculate and record an individually approved price change'],
  ['combine-purchases','Combine compatible purchase order drafts'],
  ['split-purchase','Split a purchase order into separate drafts']
]);

async function access(db, ctx) {
  const member = await db.query(`SELECT to_regclass('stockchief_runtime.agent_direct_orders') IS NOT NULL AS supplier_direct,
    to_regclass('stockchief_runtime.agent_delivery_comparisons') IS NOT NULL AS delivery_comparisons
    FROM users WHERE id=$1 AND workspace_id=$2 AND role='owner'`,[ctx.actorId,ctx.workspaceId]);
  if (!member.rowCount) throw new AuthorizationError('The business owner can view this report.');
  await policy.requireWorkspaceJob(db,ctx.workspaceId,161,'automatic');
  return member.rows[0];
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
  const features=await access(db,ctx);
  if (!['week','month'].includes(window)) throw new ValidationError('Choose the last seven or thirty days.');
  const days = window==='week' ? 7 : 30;
  const directEvents=features?.supplier_direct?`
    SELECT 'supplier-direct-purchase',min(m.sent_at::timestamptz)
      FROM stockchief_runtime.agent_direct_orders d JOIN supplier_communications m
        ON m.workspace_id=d.workspace_id AND m.purchase_order_id=d.purchase_order_id
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id
        AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      WHERE d.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='supplier_direct_purchase'
        AND e.payload->'standingAuthority'->>'recordId'=d.id AND e.payload->'standingAuthority'->>'sourceHash'=d.source_hash
      GROUP BY d.id UNION ALL
    SELECT 'supplier-direct-dispatch',r.created_at::timestamptz
      FROM stockchief_runtime.agent_direct_dispatches d JOIN stockchief_runtime.agent_direct_orders p
        ON p.workspace_id=d.workspace_id AND p.id=d.direct_order_id
      JOIN purchase_order_receipts r ON r.workspace_id=d.workspace_id AND r.id=d.purchase_receipt_id AND r.purchase_order_id=p.purchase_order_id
      JOIN sales_shipments s ON s.workspace_id=d.workspace_id AND s.id=d.shipment_id AND s.sales_order_id=p.sales_order_id
        AND s.delivery_kind='CUSTOMER_DIRECT' AND s.status IN ('SHIPPED','DELIVERED')
      JOIN stockchief_runtime.business_operations o ON o.workspace_id=d.workspace_id AND o.kind='sales_order.fulfill'
        AND o.idempotency_key='supplier-direct:'||d.id AND o.status='COMPLETED' AND o.result->>'salesOrderId'=p.sales_order_id
      JOIN accounting_customer_invoices i ON i.workspace_id=d.workspace_id AND i.id=o.result->>'invoiceId' AND i.sales_order_id=p.sales_order_id
        AND i.status IN ('OPEN','PARTIALLY_PAID','PAID')
      WHERE d.workspace_id=$1 AND d.state='APPLIED' AND r.result::jsonb->>'dispatchId'=d.id
        AND EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_dispatch_lines l WHERE l.workspace_id=d.workspace_id AND l.dispatch_id=d.id)
        AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_direct_dispatch_lines l WHERE l.workspace_id=d.workspace_id AND l.dispatch_id=d.id
          AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries j WHERE j.workspace_id=l.workspace_id AND j.id=l.journal_entry_id
            AND j.status='POSTED' AND j.source_type='sale_fulfillment' AND j.metadata::jsonb->'supplierDirect'->>'dispatchLineId'=l.id
            AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=j.workspace_id
              AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED'))) UNION ALL`:'';
  const comparisonEvents=features?.delivery_comparisons?`
    SELECT 'delivery-comparison',min(c.recorded_at) FROM stockchief_runtime.agent_delivery_comparisons c
      WHERE c.workspace_id=$1 AND c.result->>'version'='1' AND jsonb_array_length(c.result->'original')>0
      GROUP BY c.purchase_order_id,lower(trim(c.source_reference)) UNION ALL`:'';
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
  ), events(activity,occurred) AS (
    ${directEvents}
    ${comparisonEvents}
    SELECT 'repeat-order' AS activity,occurred FROM first_send UNION ALL
    SELECT 'supplier-response',occurred FROM responses UNION ALL
    SELECT 'staff-request',r.decided_at FROM stockchief_runtime.purchase_requests r
      JOIN purchase_orders p ON p.workspace_id=r.workspace_id AND p.id=r.purchase_order_id WHERE r.workspace_id=$1 AND r.status='APPROVED' UNION ALL
    SELECT 'invoice-match',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a JOIN accounting_supplier_bills b
      ON b.workspace_id=a.workspace_id AND b.id=a.result->>'billId'
      WHERE a.workspace_id=$1 AND a.status='EXECUTED' AND a.action_type='purchase_order.record_supplier_invoice'
        AND a.result->>'status' IN ('OPEN','DISPUTED') AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_intakes q WHERE q.workspace_id=b.workspace_id AND q.bill_id=b.id AND q.status='POSTED') GROUP BY b.id UNION ALL
    SELECT 'invoice-match',min(b.opened_at::timestamptz) FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN accounting_supplier_bills b ON b.workspace_id=q.workspace_id AND b.id=q.bill_id JOIN accounting_journal_entries j ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED' WHERE q.workspace_id=$1 AND q.status='POSTED' AND b.status IN('OPEN','PARTIALLY_PAID','PAID') AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') GROUP BY b.id UNION ALL
    SELECT 'customer-receipt',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a
      JOIN accounting_bank_transactions t ON t.workspace_id=a.workspace_id AND t.id=a.result->>'bankTransactionId' AND t.status IN ('MATCHED','RECONCILED')
      JOIN accounting_payments p ON p.workspace_id=t.workspace_id AND p.id=t.matched_payment_id AND p.id=a.result->>'paymentId'
        AND p.source_key='agent-bank-receipt:'||t.id AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'
      JOIN accounting_payment_allocations l ON l.workspace_id=p.workspace_id AND l.payment_id=p.id AND l.customer_invoice_id=a.payload->>'recordId' AND l.amount_minor=t.amount_minor
      JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id AND j.status='POSTED'
      WHERE a.workspace_id=$1 AND a.action_type='customer_payment.match_bank_line' AND a.status='EXECUTED' AND a.result->>'replayed' IS DISTINCT FROM 'true'
        AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')
      GROUP BY t.id UNION ALL
    SELECT 'customer-reminder',min(m.sent_at::timestamptz) FROM customer_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      WHERE m.workspace_id=$1 AND m.customer_invoice_id IS NOT NULL AND m.status='SENT' AND m.external_message_id IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='invoice_reminder' GROUP BY m.id UNION ALL
    SELECT 'arrived-stock',min(a.executed_at) FROM stockchief_runtime.assistant_action_proposals a
      JOIN stockchief_runtime.business_operations op ON op.workspace_id=a.workspace_id AND op.idempotency_key=a.idempotency_key AND op.kind='sales_order.confirm' AND op.status='COMPLETED'
      WHERE a.workspace_id=$1 AND a.status='EXECUTED' AND a.action_type='sales_order.reserve_arrived' AND a.result->>'replayed' IS DISTINCT FROM 'true'
        AND jsonb_array_length(a.result->'allocations')>0 AND op.result->'allocations'=a.result->'allocations'
        AND op.result->>'salesOrderId'=a.payload->>'recordId' GROUP BY op.id UNION ALL
    SELECT 'stock-ready',min(m.sent_at::timestamptz) FROM customer_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      WHERE m.workspace_id=$1 AND m.stock_ready_order_id IS NOT NULL AND m.status='SENT' AND m.external_message_id IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='stock_ready_notice' GROUP BY m.id UNION ALL
    SELECT 'bin-correction',c.completed_at FROM stockchief_runtime.agent_bin_corrections c
      JOIN movements o ON o.workspace_id=c.workspace_id AND o.id=c.out_movement_id AND o.operation='transfer' AND o.leg='out'
      JOIN movements i ON i.workspace_id=c.workspace_id AND i.id=c.in_movement_id AND i.operation='transfer' AND i.leg='in' AND i.group_id=o.group_id AND i.sku_id=o.sku_id
      JOIN accounting_inventory_cost_movements co ON co.workspace_id=c.workspace_id AND co.inventory_movement_id=o.id
      JOIN accounting_inventory_cost_movements ci ON ci.workspace_id=c.workspace_id AND ci.inventory_movement_id=i.id
      WHERE c.workspace_id=$1 AND c.status='COMPLETED' AND NOT c.manual_recovery AND c.scan_proof IS NOT NULL
       AND o.quantity_delta=-(c.source->>'quantity')::numeric AND i.quantity_delta=(c.source->>'quantity')::numeric
       AND co.quantity_delta=o.quantity_delta AND ci.quantity_delta=i.quantity_delta AND co.cost_delta_minor=-ci.cost_delta_minor UNION ALL
    SELECT 'supplier-details',s.processed_at FROM stockchief_runtime.agent_supplier_term_sources s
      WHERE s.workspace_id=$1 AND s.processed_at IS NOT NULL AND s.changed_count>0 AND s.instruction_hash IS NOT NULL UNION ALL
    SELECT 'po-delivery-date',s.processed_at FROM stockchief_runtime.agent_po_date_sources s
      WHERE s.workspace_id=$1 AND s.processed_at IS NOT NULL AND s.changed AND s.instruction_hash IS NOT NULL
        AND s.source_snapshot->>'kind' IS DISTINCT FROM 'amendment' UNION ALL
    SELECT 'po-supplier-amendment',s.processed_at FROM stockchief_runtime.agent_po_date_sources s
      WHERE s.workspace_id=$1 AND s.processed_at IS NOT NULL AND s.changed AND s.instruction_hash IS NOT NULL
        AND s.source_snapshot->>'kind'='amendment'
        AND EXISTS(SELECT 1 FROM purchase_order_events e WHERE e.workspace_id=s.workspace_id
          AND e.purchase_order_id=s.purchase_order_id AND e.event='supplier_purchase_amended'
          AND e.detail::jsonb->>'sourceId'=s.source_id) UNION ALL
    SELECT 'receiving-document',r.received_at::timestamptz FROM purchase_order_receipts r
      JOIN stockchief_runtime.business_operations o ON o.workspace_id=r.workspace_id AND o.kind='purchase_order.receive'
        AND o.idempotency_key=r.idempotency_key AND o.status='COMPLETED' AND o.result->>'receiptId'=r.id
        AND o.result->>'purchaseOrderId'=r.purchase_order_id AND o.result=r.result::jsonb
      WHERE r.workspace_id=$1 AND r.idempotency_key LIKE 'receiving-document:%'
        AND r.created_at>=to_char((CURRENT_TIMESTAMP-($2::int * interval '24 hours')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND jsonb_array_length(o.result->'lines')>0 AND EXISTS(
          SELECT 1 FROM import_plans p WHERE p.workspace_id=r.workspace_id AND 'receiving-document:'||p.source_hash=r.idempotency_key
            AND p.transformations::jsonb->>'agentJob'='43' AND p.transformations::jsonb->>'receivingOrderId'=r.purchase_order_id)
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o.result->'lines') receipt_line WHERE NOT EXISTS(
          SELECT 1 FROM movements m JOIN accounting_inventory_cost_movements c
            ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id AND c.cost_source_record_id=r.id
            AND c.cost_source_type='purchase_order_receipt' AND c.quantity_delta=m.quantity_delta
          WHERE m.workspace_id=r.workspace_id AND m.id=receipt_line->>'movementId' AND m.operation='receive'
            AND m.quantity_delta=(receipt_line->>'quantity')::numeric AND c.cost_delta_minor=(receipt_line->>'totalCostMinor')::bigint
            AND c.journal_entry_id IS NOT DISTINCT FROM (receipt_line->>'journalEntryId')
            AND (c.cost_delta_minor=0 AND c.journal_entry_id IS NULL OR EXISTS(
              SELECT 1 FROM accounting_journal_entries j WHERE j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
                AND j.status='POSTED' AND j.source_type='purchase_receipt' AND j.source_record_id=r.id AND NOT EXISTS(
                  SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=j.workspace_id
                    AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED'))))) UNION ALL
    SELECT 'container-plan',r.completed_at FROM stockchief_runtime.agent_container_runs r
      WHERE r.workspace_id=$1 AND r.completed_at IS NOT NULL AND (r.result->>'cartons')::int>0 UNION ALL
    SELECT 'shutdown-purchase',p.purchase_created_at FROM stockchief_runtime.agent_supplier_shutdown_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id WHERE p.workspace_id=$1 AND p.purchase_created_at IS NOT NULL AND o.status<>'CANCELLED' UNION ALL
    SELECT 'customer-reservation',a.executed_at FROM stockchief_runtime.assistant_action_proposals a
      JOIN stockchief_runtime.business_operations o ON o.workspace_id=a.workspace_id AND o.idempotency_key=a.idempotency_key AND o.kind='sales_order.confirm' AND o.status='COMPLETED'
      WHERE a.workspace_id=$1 AND a.action_type='sales_order.reserve_all' AND a.status='EXECUTED' AND a.result->>'replayed' IS DISTINCT FROM 'true'
       AND jsonb_array_length(coalesce(a.result->'allocations','[]'::jsonb))>0 AND o.result->>'salesOrderId'=a.payload->>'recordId' AND o.result->'allocations'=a.result->'allocations' UNION ALL
    SELECT 'customer-priority',a.executed_at FROM stockchief_runtime.assistant_action_proposals a WHERE a.workspace_id=$1 AND a.action_type='sales_order.allocation_priority' AND a.status='EXECUTED'
      AND a.payload->>'reservationFingerprint' IS NOT NULL AND (a.result->>'version')::int=(a.payload->>'expectedVersion')::int+1
      AND ((a.payload->>'beforePriority')::int<>(a.payload->>'priority')::int OR coalesce(a.payload->>'beforeNeededBy','')<>coalesce(a.payload->>'neededBy','')) UNION ALL
    SELECT 'supplier-claim',m.sent_at::timestamptz FROM stockchief_runtime.agent_supplier_claims c JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id WHERE c.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED') UNION ALL
    SELECT 'supplier-rfq',m.sent_at::timestamptz FROM stockchief_runtime.agent_rfq_deliveries d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id WHERE d.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=d.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED') UNION ALL
    SELECT 'channel-buffer',e.completed_at FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=$1 AND e.kind='commerce.position.publish' AND e.status='SUCCEEDED' AND e.payload->'channelBuffer'->>'id' IS NOT NULL AND e.result->>'verified'='true' UNION ALL
    SELECT 'return-label',min(m.sent_at::timestamptz) FROM customer_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      WHERE m.workspace_id=$1 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='return_label' GROUP BY m.id UNION ALL
    SELECT 'partial-shipment',${require('../warehouse/partial-shipment-evidence').completedAtSql('p')} FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.action_type='warehouse.release_partial_order' AND ${require('../warehouse/partial-shipment-evidence').completionSql('p')} UNION ALL
    SELECT 'export-papers',min(p.reviewed_at) FROM stockchief_runtime.agent_export_paper_packets p WHERE p.workspace_id=$1 AND p.status='REVIEWED' AND p.reviewed_pdf IS NOT NULL GROUP BY p.shipment_id UNION ALL
    SELECT 'return-disposition',p.applied_at FROM stockchief_runtime.agent_return_assessments p JOIN customer_returns r ON r.workspace_id=p.workspace_id AND r.id=p.return_id WHERE p.workspace_id=$1 AND p.status='APPLIED' AND p.proposal->>'byRules'='true' AND p.applied_at IS NOT NULL AND r.inspected_at IS NOT NULL UNION ALL
    SELECT 'customer-page-order',r.processed_at FROM stockchief_runtime.agent_customer_page_requests r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id WHERE r.workspace_id=$1 AND r.status='DRAFTED' AND o.status<>'CANCELLED' AND r.processed_at IS NOT NULL UNION ALL
    SELECT 'annual-stocktake',p.signed_off_at FROM stockchief_runtime.agent_annual_stocktakes p WHERE p.workspace_id=$1 AND p.status='SIGNED_OFF' AND p.signed_off_at IS NOT NULL AND (p.signoff->>'positions')::int>0 AND p.signoff->>'positions'=p.signoff->>'applied' UNION ALL
    SELECT 'delivery-qc',h.created_at FROM stockchief_runtime.agent_quality_holds h WHERE h.workspace_id=$1 AND h.automatic UNION ALL
    SELECT 'promotion-purchase',p.purchase_created_at FROM stockchief_runtime.agent_promotion_stock_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id WHERE p.workspace_id=$1 AND p.purchase_created_at IS NOT NULL AND o.status<>'CANCELLED' UNION ALL
    SELECT 'product-retirement',n.applied_at FROM stockchief_runtime.agent_product_retirement_notices n WHERE n.workspace_id=$1 AND n.applied_at IS NOT NULL AND (n.result->>'changedCount')::int>0 UNION ALL
    SELECT 'blanket-release',r.prepared_at FROM stockchief_runtime.agent_blanket_releases r JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id WHERE r.workspace_id=$1 AND r.automatic AND r.status='DRAFTED' AND r.prepared_at IS NOT NULL AND o.status<>'CANCELLED' UNION ALL
    SELECT 'product-facts',min(f.saved_at) FROM stockchief_runtime.agent_sourced_product_facts f JOIN stockchief_runtime.agent_product_source_readings r ON r.workspace_id=f.workspace_id AND r.id=f.reading_id WHERE f.workspace_id=$1 GROUP BY r.item_id,r.source_hash UNION ALL
    SELECT 'channel-copy',v.exported_at FROM stockchief_runtime.agent_channel_copy_versions v WHERE v.workspace_id=$1 AND v.exported_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_channel_copy_versions older WHERE older.workspace_id=v.workspace_id AND older.document_hash=v.document_hash AND older.exported_at IS NOT NULL AND (older.exported_at,older.id)<(v.exported_at,v.id)) UNION ALL
    SELECT 'team-procedure',v.created_at FROM stockchief_runtime.agent_team_procedure_versions v
      WHERE v.workspace_id=$1 AND v.created_at>=CURRENT_TIMESTAMP-($2::int * interval '24 hours') AND NOT EXISTS(
       SELECT 1 FROM stockchief_runtime.agent_team_procedure_versions older WHERE older.workspace_id=v.workspace_id AND older.procedure_id=v.procedure_id
        AND older.document_hash=v.document_hash AND (older.created_at,older.id)<(v.created_at,v.id)) UNION ALL
    SELECT 'return-email',r.created_at::timestamptz FROM stockchief_runtime.agent_return_email_sources s
      JOIN customer_returns r ON r.workspace_id=s.workspace_id AND r.id=s.customer_return_id
      WHERE s.workspace_id=$1 AND r.status<>'CANCELLED' AND s.source_fingerprint IS NOT NULL UNION ALL
    SELECT 'supplier-forecast',min(m.sent_at::timestamptz) FROM supplier_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      JOIN stockchief_runtime.agent_supplier_forecast_reports r ON r.workspace_id=m.workspace_id AND r.communication_id=m.id
      WHERE m.workspace_id=$1 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND e.payload->'standingAuthority'->>'kind'='supplier_forecast'
        AND e.payload->'standingAuthority'->>'recordId'=r.id AND e.payload->'standingAuthority'->>'sourceFingerprint'=r.source_fingerprint GROUP BY m.id UNION ALL
    SELECT 'invoice-dispute',min(m.sent_at::timestamptz) FROM supplier_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      WHERE m.workspace_id=$1 AND m.invoice_dispute_bill_id IS NOT NULL AND m.status='SENT' AND m.external_message_id IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='invoice_dispute' GROUP BY m.id UNION ALL
    SELECT 'customer-statement',min(m.sent_at::timestamptz) FROM customer_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      JOIN stockchief_runtime.assistant_action_proposals a ON a.workspace_id=m.workspace_id AND a.result->>'communicationId'=m.id AND a.action_type='customer.statement' AND a.status='EXECUTED'
      WHERE m.workspace_id=$1 AND m.customer_id=a.payload->>'recordId' AND m.status='SENT' AND m.external_message_id IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='customer_statement' AND e.payload->'standingAuthority'->>'sourceFingerprint'=a.payload->>'sourceFingerprint' GROUP BY m.id UNION ALL
    SELECT 'quote-followup',min(m.sent_at::timestamptz) FROM customer_communications m
      JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
      JOIN sales_quotations q ON q.workspace_id=m.workspace_id AND q.id=e.payload->'standingAuthority'->>'recordId'
      WHERE m.workspace_id=$1 AND m.customer_id=q.customer_id AND m.status='SENT' AND m.external_message_id IS NOT NULL
        AND e.payload->'standingAuthority'->>'kind'='quote_followup' AND e.payload->'standingAuthority'->>'quoteHash'=q.pricing_hash
      GROUP BY m.id UNION ALL
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
  const amounts=(await db.query(`WITH source_differences AS (
    SELECT b.currency,l.quantity,l.secondary_quantity,l.price_quantity,d FROM accounting_supplier_bills b JOIN purchase_orders p ON p.workspace_id=b.workspace_id AND p.id=b.purchase_order_id AND p.currency=b.currency CROSS JOIN LATERAL jsonb_array_elements(b.exception_detail::jsonb->'differences') d JOIN accounting_supplier_bill_lines l ON l.workspace_id=b.workspace_id AND l.bill_id=b.id AND l.line_number=(d->>'line')::int WHERE b.workspace_id=$1 AND b.status='DISPUTED' AND b.created_at::timestamptz BETWEEN now()-make_interval(days=>$2) AND now()
    UNION ALL SELECT q.prepared_input->>'currency',(l->>'quantity')::numeric,(l->>'secondaryQuantity')::numeric,coalesce((l->>'priceQuantity')::numeric,1),d FROM stockchief_runtime.agent_supplier_invoice_intakes q CROSS JOIN LATERAL jsonb_array_elements(q.comparison->'differences') d JOIN LATERAL(SELECT value l FROM jsonb_array_elements(q.prepared_input->'lines') WITH ORDINALITY x(value,n) WHERE x.n=(d->>'line')::int) x ON true WHERE q.workspace_id=$1 AND q.status='EXCEPTION' AND q.duplicate_bill_id IS NULL AND q.created_at BETWEEN now()-make_interval(days=>$2) AND now()
  ), open_differences AS (
    SELECT currency,sum(round(coalesce(secondary_quantity,quantity)*((d->>'billedUnitCostMinor')::numeric/coalesce((d->>'priceQuantity')::numeric,price_quantity,1)-(d->>'approvedUnitCostMinor')::numeric))) AS amount FROM source_differences WHERE d->>'kind'='price_outside_approved_cost' AND (d->>'billedUnitCostMinor')::numeric/coalesce((d->>'priceQuantity')::numeric,price_quantity,1)>(d->>'approvedUnitCostMinor')::numeric GROUP BY currency
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

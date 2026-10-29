'use strict';

function number(value){return Number(value || 0);}
function object(value){if(value && typeof value==='object')return value;try{return JSON.parse(value || '{}');}catch{return {};}}
async function membership(database,workspaceId,actorId){return actorId?(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[workspaceId,actorId])).rows[0]:null;}
function visible(item,actor){const p=require('../actions/permissions'),required={accounting:p.VIEW_ACCOUNTING,order:p.VIEW_SALES,shipping:p.VIEW_SALES,purchase:p.VIEW_PURCHASING,repair:p.ADMIN,provider:p.ADMIN};return (item.requiredPermissions||[required[item.kind]||p.VIEW]).every(key=>p.can(actor,key));}

async function needsCount(database,workspaceId,actorId=null){
  // The badge and the decision list are one projection with the same permission
  // filtering and related-record de-duplication. A second SQL count drifted.
  return (await needs(database,workspaceId,actorId)).length;
}

async function runtimeFailures(database,workspaceId){
  const rows=(await database.query(`SELECT kind,last_error->>'code' AS error_code,
    last_error->>'message' AS error_message,COUNT(*)::integer AS attempts
    FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND status='DEAD'
    GROUP BY kind,last_error->>'code',last_error->>'message'
    ORDER BY attempts DESC,kind`,[workspaceId])).rows;
  return {attempts:rows.reduce((sum,row)=>sum+number(row.attempts),0),causes:rows};
}

async function needs(database,workspaceId,actorId=null){
  const actor=await membership(database,workspaceId,actorId);if(actorId&&!actor)return [];
  const [attention,connections,work,imports,bills,supplierReturns,shippingExceptions,mail,orders,purchases,
    repairs,ambiguousEffects,nativeApprovals,bulkReviews,rentalBilling]=await Promise.all([
    database.query(`SELECT id,title,concise_summary,explanation,recommendation,severity,priority_score,item_id,first_detected_at
      FROM attention_items WHERE workspace_id=$1 AND status='OPEN' ORDER BY priority_score DESC,first_detected_at`,[workspaceId]),
    database.query(`SELECT i.id,i.title,i.detail,i.resolution_hint,i.created_at,i.updated_at,i.connector_id,
      i.issue_type,i.external_event_id,c.provider_type,
      message.id AS reply_message_id,related_effect.id AS provider_effect_id
      FROM connection_issues i JOIN workspace_connectors c ON c.id=i.connector_id
      LEFT JOIN connection_email_messages message ON message.workspace_id=i.workspace_id AND message.id=i.external_event_id
      LEFT JOIN LATERAL (SELECT effect.id FROM stockchief_runtime.provider_effects effect
        WHERE effect.workspace_id=i.workspace_id AND effect.aggregate_id=i.external_event_id
        AND effect.aggregate_type IN ('email_message','supplier_communication','customer_communication')
        AND effect.status='AMBIGUOUS' ORDER BY effect.created_at DESC LIMIT 1) related_effect ON true
      WHERE i.workspace_id=$1 AND i.status='OPEN' ORDER BY i.updated_at DESC`,[workspaceId]),
    database.query(`SELECT id,category,source,recommended_action,policy_evaluation,outcome,urgency,confidence,priority,created_at,error_message
      FROM work_items WHERE workspace_id=$1 AND approval_requirement<>'NONE'
      AND execution_status NOT IN ('COMPLETED','CANCELLED','FAILED') ORDER BY priority DESC,created_at`,[workspaceId]),
    database.query(`SELECT e.id,e.import_id,e.error_message,e.finished_at,p.source_name FROM import_executions e
      JOIN import_plans p ON p.id=e.import_id WHERE e.workspace_id=$1 AND e.status='FAILED'
      ORDER BY e.finished_at DESC`,[workspaceId]),
    database.query(`SELECT b.id,b.bill_number,b.supplier_invoice_number,b.balance_minor,b.currency,b.exception_detail,b.created_at,b.updated_at,b.due_date,s.name AS supplier_name
      FROM accounting_supplier_bills b JOIN suppliers s ON s.id=b.supplier_id
      WHERE b.workspace_id=$1 AND b.status='DISPUTED' ORDER BY b.updated_at DESC`,[workspaceId]),
    database.query(`SELECT r.id,r.return_number,r.expected_credit_minor,r.actual_credit_minor,r.created_at,
      s.name AS supplier_name,COALESCE(b.currency,'USD') AS currency
      FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id
      LEFT JOIN accounting_supplier_bills b ON b.id=r.supplier_bill_id
      WHERE r.workspace_id=$1 AND r.status='CREDIT_MISMATCH' ORDER BY r.created_at DESC`,[workspaceId]),
    database.query(`SELECT sh.id,sh.shipment_number,sh.tracking_status,sh.tracking_status_detail,
      sh.exception_reason,sh.created_at,sh.tracked_at,so.order_number,c.name AS customer_name
      FROM sales_shipments sh JOIN sales_orders so ON so.id=sh.sales_order_id
      JOIN customers c ON c.id=so.customer_id WHERE sh.workspace_id=$1
      AND sh.tracking_status IN ('FAILURE','RETURNED') ORDER BY sh.tracked_at DESC`,[workspaceId]),
    database.query(`SELECT message.id,message.subject,message.sender,message.reply_reason,message.received_at
      FROM connection_email_messages message WHERE message.workspace_id=$1 AND message.reply_state='NEEDS_REPLY'
      AND NOT EXISTS (SELECT 1 FROM stockchief_runtime.email_reply_outbox outbox
        WHERE outbox.workspace_id=message.workspace_id AND outbox.message_id=message.id
        AND outbox.status IN ('PENDING','SENDING','AMBIGUOUS')) ORDER BY message.received_at ASC`,[workspaceId]),
    database.query(`SELECT so.id,so.order_number,so.needed_by,so.created_at,c.name AS customer_name,
      SUM(sol.quantity_ordered-sol.quantity_fulfilled) AS remaining,
      COALESCE(SUM(a.allocated),0) AS allocated
      FROM sales_orders so JOIN customers c ON c.id=so.customer_id
      JOIN sales_order_lines sol ON sol.sales_order_id=so.id
      LEFT JOIN (SELECT sales_order_line_id,SUM(quantity) AS allocated FROM sales_order_allocations
        WHERE workspace_id=$1 GROUP BY sales_order_line_id) a ON a.sales_order_line_id=sol.id
      WHERE so.workspace_id=$1 AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
      GROUP BY so.id,so.order_number,so.needed_by,so.created_at,c.name
      HAVING SUM(sol.quantity_ordered-sol.quantity_fulfilled)>COALESCE(SUM(a.allocated),0)
      ORDER BY so.needed_by NULLS LAST,so.created_at`,[workspaceId]),
    database.query(`SELECT po.id,po.po_number,po.expected_date,po.created_at,s.name AS supplier_name
      FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
      WHERE po.workspace_id=$1 AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
      AND po.expected_date IS NOT NULL AND po.expected_date<CURRENT_DATE::text
      ORDER BY po.expected_date`,[workspaceId]),
    database.query(`SELECT id,symptom,failed_invariant,status,materiality,confidence,error_message,created_at,updated_at
      FROM repair_cases WHERE workspace_id=$1
      AND status IN ('NEEDS_AUTHORITY','AUTHORIZED','FAILED','INCONCLUSIVE')
      ORDER BY CASE materiality WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,updated_at DESC`,[workspaceId]),
    database.query(`SELECT effect.id,effect.kind,effect.provider,effect.aggregate_type,effect.aggregate_id,
      effect.error_message,effect.created_at,effect.completed_at,request.sales_order_id AS payment_order_id
      FROM stockchief_runtime.provider_effects effect
      LEFT JOIN payment_requests request ON effect.aggregate_type='payment_request' AND request.id=effect.aggregate_id
      WHERE effect.workspace_id=$1 AND effect.status='AMBIGUOUS'
      AND NOT (effect.kind IN ('shipping.label.purchase','shipping.label.void') AND effect.provider_reference->>'externalId' IS NOT NULL
        AND EXISTS (SELECT 1 FROM stockchief_runtime.jobs verification WHERE verification.workspace_id=effect.workspace_id
            AND verification.kind=CASE WHEN effect.kind='shipping.label.void' THEN 'shipping.void.verify' ELSE 'shipping.label.verify' END AND verification.payload->>'effectId'=effect.id
          AND verification.status IN ('PENDING','RUNNING','RETRY')))
      AND NOT (effect.aggregate_type IN ('email_message','supplier_communication','customer_communication')
        AND EXISTS (SELECT 1 FROM connection_issues issue
        WHERE issue.workspace_id=effect.workspace_id AND issue.issue_type='EMAIL_SEND_AMBIGUOUS'
        AND issue.external_event_id=effect.aggregate_id AND issue.status='OPEN'))
      ORDER BY effect.completed_at DESC,effect.id`,[workspaceId]),
    require('../assistant/postgres-approval-projection').pending(database,workspaceId,actorId),
    database.query("SELECT id,kind,payload,created_at FROM catalog_bulk_reviews WHERE workspace_id=$1 AND status='PENDING' ORDER BY created_at,id",[workspaceId]),
    database.query("SELECT p.id,p.agreement_id,p.last_error,p.created_at,p.updated_at,a.agreement_number FROM custody_billing_policies p JOIN custody_agreements a ON a.workspace_id=p.workspace_id AND a.id=p.agreement_id WHERE p.workspace_id=$1 AND p.status='NEEDS_REVIEW' ORDER BY p.updated_at",[workspaceId]),
  ]);
  const ownedRecords=new Set(work.rows.filter(r=>object(r.outcome).decision).map(r=>object(r.outcome).recordId));
  const preparedLinks=new Set(nativeApprovals.map(r=>r.href));
  const items=[...nativeApprovals];
  for(const row of rentalBilling.rows)items.push({kind:'accounting',importance:'Important',priority:89,title:'Review rental billing for '+row.agreement_number,happened:'An earned rental invoice is paused before posting.',why:row.last_error,recommendation:'Review the unchanged billing authority, tax settings and accounting period before authorizing another attempt.',href:'/custody/'+row.agreement_id+'#rental-billing',actionLabel:'Review rental billing',sourceId:row.id,createdAt:row.created_at,updatedAt:row.updated_at,timeLabel:'Billing paused',at:row.updated_at});
  for(const row of bulkReviews.rows)items.push({kind:'approval',requiredPermissions:[require('../actions/permissions').ADMIN],importance:'Important',priority:70,title:row.kind==='price'?'Review selected selling prices':row.kind==='restore'?'Restore selected products':'Archive selected products',happened:(row.payload.items||[]).length+' selected products are prepared; nothing has changed.',why:'Your approval is required before these product changes are applied.',recommendation:'Review the exact products and changes, then approve or cancel.',href:'/inventory/bulk/reviews/'+row.id,actionLabel:'Review changes',sourceId:row.id,createdAt:row.created_at,timeLabel:'Prepared',at:row.created_at});
  for(const row of attention.rows)items.push({kind:'inventory',importance:row.severity==='critical'?'Urgent':row.severity==='important'?'Important':'Watch',
    priority:number(row.priority_score),title:row.title,happened:row.concise_summary,why:row.explanation,
    recommendation:row.recommendation,href:row.item_id?`/inventory/${row.item_id}`:'/inventory',actionLabel:'Review inventory',sourceId:row.id,createdAt:row.first_detected_at,timeLabel:'First detected',at:row.first_detected_at});
  for(const row of connections.rows)items.push({kind:'connection',importance:'Important',priority:85,title:row.title,
    happened:row.detail,why:row.issue_type==='EMAIL_SEND_AMBIGUOUS'
      ?'The provider may have accepted the email before StockChief could verify delivery. Sending it again could create a duplicate.'
      :`${row.provider_type} cannot currently provide complete business data.`,recommendation:row.resolution_hint,
    href:row.issue_type==='EMAIL_SEND_AMBIGUOUS' && row.reply_message_id
      ?`/mail/${row.reply_message_id}`:row.issue_type==='EMAIL_SEND_AMBIGUOUS' && row.provider_effect_id
        ?`/settings/operations/provider-effects/${row.provider_effect_id}`:`/settings/connections/${row.connector_id}`,
    actionLabel:row.issue_type==='EMAIL_SEND_AMBIGUOUS'?'Verify email':'Fix connection',sourceId:row.id,createdAt:row.created_at,timeLabel:'Issue opened',updatedAt:row.updated_at,at:row.updated_at});
  for(const row of work.rows){const action=object(row.recommended_action),outcome=object(row.outcome);const authority=object(row.policy_evaluation);
    if(outcome.decision&&preparedLinks.has(outcome.reviewHref))continue;
    if(outcome.decision){const d=outcome.decision,permission=action.type==='customer_order'?require('../actions/permissions').VIEW_SALES:action.type==='supplier_invoice'?require('../actions/permissions').VIEW_ACCOUNTING:require('../actions/permissions').VIEW_PURCHASING;
      items.push({kind:'approval',requiredPermissions:[permission],importance:'Important',priority:90,title:(outcome.reference||action.displayName||'Business work')+': '+outcome.nextAction,happened:d.happened,why:d.impact,recommendation:d.recommendation+' '+d.required,checked:d.checked,alternatives:d.alternatives,href:outcome.reviewHref||outcome.href||action.href||'/autopilot/work/'+row.id,actionLabel:'Review next step',sourceId:row.id,createdAt:row.created_at,at:outcome.deadline||row.created_at});continue;}
    items.push({kind:'approval',requiredPermissions:[action.type==='transfer'?require('../actions/permissions').VIEW_TRANSFERS:require('../actions/permissions').VIEW_PURCHASING],
    importance:row.urgency==='immediate'?'Urgent':'Important',priority:70+number(row.priority),
    title:action.title || `${action.type==='transfer'?'Transfer':'Replenish'} ${action.displayName || String(row.category).replaceAll('_',' ')}`,
    happened:action.summary || (action.type==='transfer'
      ? `Move ${number(action.quantity)} units from ${action.sourceLocationName} to ${action.destinationLocationName}.`
      : `Prepare ${number(action.quantity)} units from ${action.supplierName || 'the selected supplier'}.`),
    why:row.error_message || authority.reason || 'Your authority policy requires approval.',
    recommendation:action.reason || 'Review the prepared work and its evidence.',href:`/autopilot/work/${row.id}`,
    actionLabel:'Review decision',sourceId:row.id,createdAt:row.created_at,timeLabel:'Proposed',at:row.created_at});}
  for(const row of imports.rows)items.push({kind:'import',importance:'Important',priority:80,title:`Import failed: ${row.source_name}`,
    happened:'The database transaction was rolled back; no partial inventory truth was left behind.',why:row.error_message || 'The import could not be verified.',
    recommendation:'Correct the source or setup, then run the same approved preview again.',href:`/imports/${row.import_id}`,
    actionLabel:'Open import',sourceId:row.id,createdAt:row.finished_at,timeLabel:'Failed',at:row.finished_at});
  for(const row of bills.rows.filter(r=>!ownedRecords.has(r.id)))items.push({kind:'accounting',importance:'Important',priority:88,title:`Review invoice ${row.supplier_invoice_number||row.bill_number} from ${row.supplier_name}`,
    happened:`${row.supplier_name} has ${row.currency} ${(number(row.balance_minor)/100).toFixed(2)} unresolved.`,
    why:'The supplier document and expected purchase do not agree.',recommendation:'Review the discrepancy before paying or posting a correction.',
    href:`/accounting/payables/${row.id}/review`,actionLabel:'Review invoice',sourceId:row.id,createdAt:row.created_at,timeLabel:'Invoice recorded',updatedAt:row.updated_at,dueDate:row.due_date,at:row.updated_at});
  for(const row of supplierReturns.rows)items.push({kind:'accounting',importance:'Important',priority:89,
    title:`Resolve supplier credit mismatch on ${row.return_number}`,
    happened:`${row.supplier_name} credited ${row.currency} ${(number(row.actual_credit_minor)/100).toFixed(2)}; expected ${row.currency} ${(number(row.expected_credit_minor)/100).toFixed(2)}.`,
    why:'The physical return is complete, but the supplier credited a different amount.',
    recommendation:'Review the supplier credit memo and decide whether to dispute or accept the variance.',
    href:`/supplier-returns/${row.id}`,actionLabel:'Review supplier return',sourceId:row.id,createdAt:row.created_at,at:row.created_at});
  for(const row of shippingExceptions.rows)items.push({kind:'shipping',importance:'Urgent',priority:94,
    title:`Carrier exception on ${row.shipment_number}`,happened:`${row.order_number} for ${row.customer_name} is ${String(row.tracking_status).toLowerCase().replaceAll('_',' ')}.`,
    why:row.exception_reason||row.tracking_status_detail||'The carrier reported a delivery exception.',
    recommendation:'Review the parcel and contact the customer if the promise is at risk.',
    href:`/fulfilment/${row.id}`,actionLabel:'Review shipment',sourceId:row.id,createdAt:row.created_at,updatedAt:row.tracked_at,timeLabel:'Shipment created',at:row.tracked_at});
  for(const row of mail.rows)items.push({kind:'mail',importance:'Important',priority:82,title:row.subject || `Reply to ${row.sender}`,
    happened:`${row.sender} is waiting for a response.`,why:row.reply_reason || 'A known customer or supplier sent a business message.',
    recommendation:'Read the message first. Review or write a reply only if one is needed.',href:`/mail/${row.id}`,
    actionLabel:'Read email',sourceId:row.id,createdAt:row.received_at,timeLabel:'Received',at:row.received_at});
  for(const row of orders.rows.filter(r=>!ownedRecords.has(r.id)))items.push({kind:'order',importance:row.needed_by && row.needed_by<new Date().toISOString().slice(0,10)?'Urgent':'Important',
    priority:92,title:`${row.order_number} does not have enough allocated stock`,happened:`${row.customer_name} needs ${number(row.remaining)} units; ${number(row.allocated)} are allocated.`,
    why:'The order cannot be fulfilled completely from its current allocations.',recommendation:'Review transfer or replenishment options before the promised date.',
    href:`/orders/${row.id}`,actionLabel:'Review order',sourceId:row.id,createdAt:row.created_at,timeLabel:'Order created',dueDate:row.needed_by,at:row.needed_by});
  for(const row of purchases.rows.filter(r=>!ownedRecords.has(r.id)))items.push({kind:'purchase',importance:'Important',priority:75,title:`${row.po_number} is late`,
    happened:`${row.supplier_name} was expected on ${row.expected_date}.`,why:'StockChief has no complete receipt for this purchase order.',
    recommendation:'Check the supplier update and affected customer commitments.',href:`/purchasing/orders/${row.id}`,actionLabel:'Review purchase',sourceId:row.id,createdAt:row.created_at,timeLabel:'Purchase order created',dueDate:row.expected_date,at:row.expected_date});
  for(const row of repairs.rows)items.push({kind:'repair',importance:row.materiality==='high'?'Urgent':'Important',
    priority:row.materiality==='high'?97:86,title:row.symptom,happened:row.failed_invariant,
    why:row.error_message||`The governed repair is ${String(row.status).toLowerCase().replaceAll('_',' ')} with ${row.confidence} confidence.`,
    recommendation:row.status==='AUTHORIZED'||row.status==='FAILED'?'Run and verify the approved correction.':
      row.status==='INCONCLUSIVE'?'Provide exact source evidence before changing records.':'Review the simulation and approve only if it matches the intended correction.',
    href:`/repairs/${row.id}`,actionLabel:'Review repair',sourceId:row.id,createdAt:row.created_at,updatedAt:row.updated_at,at:row.updated_at});
  for(const row of ambiguousEffects.rows)items.push({kind:'provider',importance:'Urgent',priority:98,
    title:`Verify ${String(row.kind).replaceAll('.',' ')} with ${row.provider}`,
    happened:row.error_message||'The outside provider may have accepted the request before StockChief could save confirmation.',
    why:'Repeating a consequential provider call could create a duplicate charge or external record.',
    recommendation:'Check the provider account and reconcile the existing request. StockChief has stopped automatic retries.',
    href:row.aggregate_type==='shipment'?`/fulfilment/${row.aggregate_id}`:
      row.aggregate_type==='email_message'?`/mail/${row.aggregate_id}`:
        row.payment_order_id?`/orders/${row.payment_order_id}`:
          `/settings/operations/provider-effects/${row.id}`,
    actionLabel:'Verify provider outcome',sourceId:row.id,createdAt:row.created_at,updatedAt:row.completed_at,at:row.completed_at});
  return items.filter(item=>!actorId||visible(item,actor)).sort((a,b)=>b.priority-a.priority || String(a.at||'').localeCompare(String(b.at||'')));
}

async function brief(database,workspaceId,actorId=null){
  const [stats,locations,activity,openOrders,openPurchases,needItems,totalAvailable]=await Promise.all([
    database.query(`SELECT
      (SELECT COUNT(*) FROM items WHERE workspace_id=$1 AND is_active=1) AS item_count,
      (SELECT COUNT(*) FROM skus WHERE workspace_id=$1 AND is_active=1) AS sku_count,
      (SELECT COUNT(*) FROM locations WHERE workspace_id=$1 AND is_active=1) AS location_count,
      (SELECT COALESCE(SUM(on_hand),0) FROM balances WHERE workspace_id=$1) AS units_on_hand,
      (SELECT COUNT(*) FROM skus s WHERE s.workspace_id=$1 AND s.is_active=1 AND
        COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.sku_id=s.id),0)<=0) AS zero_count,
      (SELECT COALESCE(SUM(a.quantity),0) FROM sales_order_allocations a WHERE a.workspace_id=$1) AS committed,
      (SELECT COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id=pol.purchase_order_id WHERE pol.workspace_id=$1
        AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')) AS incoming`,[workspaceId]),
    database.query(`SELECT l.id,l.name,COALESCE(SUM(b.on_hand),0) AS on_hand FROM locations l
      LEFT JOIN balances b ON b.location_id=l.id AND b.workspace_id=l.workspace_id
      WHERE l.workspace_id=$1 AND l.is_active=1 GROUP BY l.id,l.name ORDER BY l.name`,[workspaceId]),
    database.query(`SELECT m.id,m.operation,m.quantity_delta,m.reference,m.notes,m.occurred_at,
      i.name AS item_name,s.code,l.name AS location_name,u.name AS actor_name
      FROM movements m JOIN items i ON i.id=m.item_id JOIN skus s ON s.id=m.sku_id
      JOIN locations l ON l.id=m.location_id LEFT JOIN users u ON u.id=m.actor_user_id
      WHERE m.workspace_id=$1 ORDER BY m.occurred_at DESC,m.seq DESC LIMIT 12`,[workspaceId]),
    database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1
      AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`,[workspaceId]),
    database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1
      AND status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED')`,[workspaceId]),
    needs(database,workspaceId,actorId),
    require('../domain/postgres-stock-availability').total(database,workspaceId),
  ]);
  const row=stats.rows[0];
  return {stats:{itemCount:number(row.item_count),skuCount:number(row.sku_count),locationCount:number(row.location_count),
    unitsOnHand:number(row.units_on_hand),zeroCount:number(row.zero_count),committed:number(row.committed),incoming:number(row.incoming),
    available:totalAvailable,openOrders:number(openOrders.rows[0].count),
    openPurchases:number(openPurchases.rows[0].count)},locations:locations.rows.map((entry)=>({...entry,onHand:number(entry.on_hand)})),
    activity:activity.rows.map((entry)=>({...entry,quantityDelta:number(entry.quantity_delta)})),needs:needItems};
}

module.exports={brief,needs,needsCount,runtimeFailures};

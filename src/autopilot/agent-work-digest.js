'use strict';
const policy=require('../commercial/agent-plan'),time=require('../lib/business-time');
const {ValidationError,NotFoundError}=require('../domain/errors');
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const kinds=new Map([['sales_order.create','sale'],['sales_order.repeat','sale'],['sales_quote.create','quote'],['manufacturing.create_work_order','production'],['catalog.supplier_price_list','prices']]);
function reference(p){return p.result?.salesOrderId||p.result?.quoteId||p.result?.id;}
async function states(db,ctx,proposals,{lock=false}={}){
 const result=new Map(),suffix=lock?' FOR UPDATE':'';
 for(const [kind,table]of [['sale','sales_orders'],['quote','sales_quotations'],['production','manufacturing_work_orders']]){
  const ids=proposals.filter(p=>kinds.get(p.action_type)===kind).map(reference).filter(Boolean);if(!ids.length)continue;
  const rows=(await db.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=ANY($2::text[])'+suffix,[ctx.workspaceId,ids])).rows;
  for(const row of rows)result.set(kind+':'+row.id,row);
 }
 const workIds=proposals.filter(p=>kinds.get(p.action_type)==='production').map(reference).filter(Boolean);
 if(workIds.length){const used=(await db.query(`SELECT DISTINCT work_order_id FROM manufacturing_events WHERE workspace_id=$1 AND work_order_id=ANY($2::text[])
  UNION SELECT work_order_id FROM manufacturing_capacity_bookings WHERE workspace_id=$1 AND work_order_id=ANY($2::text[]) AND status='HELD'`,[ctx.workspaceId,workIds])).rows;
  for(const r of used){const row=result.get('production:'+r.work_order_id);if(row)row.laterWork=true;}}
 const quoteIds=proposals.filter(p=>kinds.get(p.action_type)==='quote').map(reference).filter(Boolean);
 if(quoteIds.length){const newer=(await db.query('SELECT supersedes_id FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=ANY($2::text[])',[ctx.workspaceId,quoteIds])).rows;
  for(const r of newer){const row=result.get('quote:'+r.supersedes_id);if(row)row.laterWork=true;}}
 const skuIds=[...new Set(proposals.filter(p=>kinds.get(p.action_type)==='prices').flatMap(p=>(p.payload.changes||[]).map(c=>c.skuId)))];
 if(skuIds.length){const costs=(await db.query(`SELECT p.* FROM skus s JOIN LATERAL(SELECT * FROM sku_purchase_costs p WHERE p.workspace_id=s.workspace_id AND p.sku_id=s.id ORDER BY p.created_at DESC,p.id DESC LIMIT 1)p ON true
   WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id`+(lock?' FOR UPDATE OF s':''),[ctx.workspaceId,skuIds])).rows;
  for(const r of costs)result.set('cost:'+r.sku_id,r);}
 return result;
}
function undoable(p,state){
 if(p.undone)return {allowed:false,reason:'Already undone'};
 const kind=kinds.get(p.action_type),row=state.get(kind+':'+reference(p));
 if(kind==='sale')return row?.status==='DRAFT'&&Number(row.version)===1?{allowed:true,reason:'Cancel the unchanged draft order'}:{allowed:false,reason:'Order changed; review its current state'};
 if(kind==='quote')return row?.status==='OPEN'&&!row.laterWork?{allowed:true,reason:'Withdraw the open quotation'}:{allowed:false,reason:'Quotation decided or revised; review its current state'};
 if(kind==='production')return row?.status==='DRAFT'&&!row.laterWork&&Number(row.wip_cost_minor)===0?{allowed:true,reason:'Cancel the unused production draft'}:{allowed:false,reason:'Production has later work; review its current state'};
 if(kind==='prices'){
  const changes=p.payload.changes||[],ids=p.result?.ids||[];
  const safe=changes.length&&changes.every(c=>c.before&&ids.includes(state.get('cost:'+c.skuId)?.id)&&
   Number(state.get('cost:'+c.skuId).amount_minor)===c.amountMinor&&state.get('cost:'+c.skuId).currency===c.currency);
  return {allowed:Boolean(safe),reason:safe?'Restore the preceding purchase costs':'Purchase costs changed or had no previous value; review their current state'};
 }
 return {allowed:false,reason:'Open the recorded work to review a correction'};
}
async function report(db,ctx,{filter='',page=1}={}){
 await require('./job-reviews').ownerState(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,204,'suggest');
 page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid work-history page.');
 const {calendarDate,timeZone}=await time.forWorkspace(db,ctx.workspaceId),day=filter||calendarDate;
 const from=time.dayBoundary(day,timeZone),to=time.dayBoundary(day,timeZone,{nextDay:true}),history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const proposals=(await db.query(`WITH actions AS (
  SELECT 'action' AS origin,p.id,p.action_type,p.summary,p.result,p.executed_at,
   CASE WHEN p.action_type=ANY($6::text[]) THEN p.payload ELSE '{}'::jsonb END AS payload,
   EXISTS(SELECT 1 FROM security_event_history e WHERE e.workspace_id=p.workspace_id AND e.reference=p.id AND e.action='Agent action undone') AS undone
  FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.status='EXECUTED' AND NOT(p.action_type='document.save_product_facts' AND coalesce(p.payload->>'queueReading','false')='true') AND p.action_type NOT IN('warehouse.release_partial_order','customer_return.send_label','shipping.prepare_export_papers','customer_invoice.prepare_document') AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_intakes q WHERE q.workspace_id=p.workspace_id AND q.bill_id=p.result->>'billId' AND q.status='POSTED') AND p.executed_at>=($2::text)::timestamptz AND p.executed_at<($3::text)::timestamptz
   AND ($5::text IS NULL OR p.executed_at>=$5::timestamptz) ORDER BY p.executed_at,p.id LIMIT $7
 ), routines AS (
  SELECT 'routine' AS origin,w.id,'routine' AS action_type,'Completed business routine: '||coalesce(w.recommended_action::jsonb->>'displayName',w.recommended_action::jsonb->>'poNumber','View recorded work') AS summary,
   '{}'::jsonb AS result,w.completed_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM work_items w WHERE w.workspace_id=$1 AND w.execution_status='COMPLETED' AND w.verification_status='VERIFIED'
   AND w.completed_at>=$2::text AND w.completed_at<$3::text AND ($5::text IS NULL OR w.completed_at>=$5::text)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=w.workspace_id AND p.id=w.proposal_id AND p.status='EXECUTED')
  ORDER BY w.completed_at,w.id LIMIT $7
 ), supplier_details AS (
  SELECT 'supplier-details' AS origin,s.message_id AS id,'supplier.email_terms' AS action_type,
   'Updated '||s.changed_count||' supplier fields from '||coalesce(p.name,'a known supplier') AS summary,
   '{}'::jsonb AS result,s.processed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_term_sources s JOIN suppliers p ON p.workspace_id=s.workspace_id AND p.id=s.supplier_id
  WHERE s.workspace_id=$1 AND s.processed_at>=$2::timestamptz AND s.processed_at<$3::timestamptz AND s.changed_count>0
   AND ($5::text IS NULL OR s.processed_at>=$5::timestamptz) ORDER BY s.processed_at,s.message_id LIMIT $7
 ), po_dates AS (
  SELECT 'po-delivery-date' AS origin,s.source_id AS id,'purchase_order.update_delivery_date' AS action_type,
   'Updated delivery promise for '||coalesce(s.source_snapshot->>'orderNumber','a purchase order')||' to '||(s.source_snapshot->>'proposedDate') AS summary,
   '{}'::jsonb AS result,s.processed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_po_date_sources s
  WHERE s.workspace_id=$1 AND s.changed AND s.instruction_hash IS NOT NULL AND s.processed_at>=$2::timestamptz AND s.processed_at<$3::timestamptz
   AND ($5::text IS NULL OR s.processed_at>=$5::timestamptz) ORDER BY s.processed_at,s.source_id LIMIT $7
 ), container_plans AS (
  SELECT 'container-plan' AS origin,p.id,'purchasing.plan_container' AS action_type,
   'Calculated container load: '||p.title||' · '||(r.result->>'loaded')||' cartons fitted, '||(r.result->>'remaining')||' left outside' AS summary,
   '{}'::jsonb AS result,r.completed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_container_runs r JOIN stockchief_runtime.agent_container_projects p ON p.workspace_id=r.workspace_id AND p.id=r.project_id
  WHERE r.workspace_id=$1 AND r.completed_at>=$2::timestamptz AND r.completed_at<$3::timestamptz AND (r.result->>'cartons')::int>0
   AND ($5::text IS NULL OR r.completed_at>=$5::timestamptz) ORDER BY r.completed_at,r.id LIMIT $7
 ), blanket_releases AS (
  SELECT 'blanket-release' AS origin,r.id,'purchasing.prepare_blanket_release' AS action_type,
   'Unapproved supplier release prepared: '||p.reference||' / '||o.po_number AS summary,
   jsonb_build_object('purchaseOrderId',o.id) AS result,r.prepared_at AS executed_at,jsonb_build_object('contractId',p.id) AS payload,false AS undone
  FROM stockchief_runtime.agent_blanket_releases r JOIN stockchief_runtime.agent_blanket_contracts p ON p.workspace_id=r.workspace_id AND p.id=r.contract_id
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  WHERE r.workspace_id=$1 AND r.automatic AND r.status='DRAFTED' AND r.prepared_at>=$2::timestamptz AND r.prepared_at<$3::timestamptz AND o.status<>'CANCELLED'
   AND ($5::text IS NULL OR r.prepared_at>=$5::timestamptz) ORDER BY r.prepared_at,r.id LIMIT $7
 ), product_facts AS (
  SELECT 'product-facts' AS origin,r.id,'document.save_product_facts' AS action_type,
   'Source-backed product facts saved: '||i.name AS summary,'{}'::jsonb AS result,s.saved_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_product_source_readings r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id
  JOIN LATERAL(SELECT min(f.saved_at) AS saved_at FROM stockchief_runtime.agent_sourced_product_facts f WHERE f.workspace_id=r.workspace_id AND f.reading_id=r.id HAVING count(*)>0)s ON true
  WHERE r.workspace_id=$1 AND s.saved_at>=$2::timestamptz AND s.saved_at<$3::timestamptz AND ($5::text IS NULL OR s.saved_at>=$5::timestamptz)
  ORDER BY s.saved_at,r.id LIMIT $7
 ), channel_copy AS (
  SELECT 'channel-copy' AS origin,v.copy_id AS id,'catalog.write_channel_copy' AS action_type,
   'Private channel copy exported: '||p.channel_name AS summary,'{}'::jsonb AS result,v.exported_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_channel_copy_versions v JOIN stockchief_runtime.agent_channel_copy_sets p ON p.workspace_id=v.workspace_id AND p.id=v.copy_id
  WHERE v.workspace_id=$1 AND v.exported_at>=$2::timestamptz AND v.exported_at<$3::timestamptz
   AND ($5::text IS NULL OR v.exported_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_channel_copy_versions older WHERE older.workspace_id=v.workspace_id AND older.document_hash=v.document_hash AND older.exported_at IS NOT NULL AND (older.exported_at,older.id)<(v.exported_at,v.id))
  ORDER BY v.exported_at,v.id LIMIT $7
 ), team_procedures AS (
  SELECT 'team-procedure' AS origin,v.procedure_id AS id,'team.write_procedure' AS action_type,
   'Private app procedure written: '||(v.document->>'title') AS summary,
   '{}'::jsonb AS result,v.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_team_procedure_versions v
  WHERE v.workspace_id=$1 AND v.created_at>=$2::timestamptz AND v.created_at<$3::timestamptz
   AND ($5::text IS NULL OR v.created_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_team_procedure_versions older WHERE older.workspace_id=v.workspace_id AND older.procedure_id=v.procedure_id
    AND older.document_hash=v.document_hash AND (older.created_at,older.id)<(v.created_at,v.id))
  ORDER BY v.created_at,v.id LIMIT $7
 ), product_retirements AS (
  SELECT 'product-retirement' AS origin,n.id,'catalog.retire_discontinued' AS action_type,
   'Retired '||(n.result->>'changedCount')||' discontinued products with replacement guidance: '||n.reference AS summary,
   '{}'::jsonb AS result,n.applied_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_product_retirement_notices n
  WHERE n.workspace_id=$1 AND n.applied_at>=$2::timestamptz AND n.applied_at<$3::timestamptz AND (n.result->>'changedCount')::int>0
   AND ($5::text IS NULL OR n.applied_at>=$5::timestamptz) ORDER BY n.applied_at,n.id LIMIT $7
 ), shutdown_purchases AS (
  SELECT 'shutdown-purchase' AS origin,p.id,'purchasing.plan_supplier_shutdown' AS action_type,
   'Prepared shutdown purchase draft: '||o.po_number||' from '||s.reference AS summary,
   jsonb_build_object('purchaseOrderId',o.id) AS result,p.purchase_created_at AS executed_at,jsonb_build_object('shutdownId',p.shutdown_id) AS payload,o.status='CANCELLED' AS undone
  FROM stockchief_runtime.agent_supplier_shutdown_plans p JOIN stockchief_runtime.agent_supplier_shutdowns s ON s.workspace_id=p.workspace_id AND s.id=p.shutdown_id
  JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.purchase_created_at>=$2::timestamptz AND p.purchase_created_at<$3::timestamptz
   AND ($5::text IS NULL OR p.purchase_created_at>=$5::timestamptz) ORDER BY p.purchase_created_at,p.id LIMIT $7
 ), supplier_claims AS (
  SELECT 'supplier-claim' AS origin,c.id,'supplier.open_damage_claim' AS action_type,'Sent supplier damage claim: '||c.reference AS summary,
   jsonb_build_object('communicationId',m.id) AS result,m.sent_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_claims c JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id
  WHERE c.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
   AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz) AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED')
  ORDER BY m.sent_at,c.id LIMIT $7
 ), supplier_rfqs AS (
  SELECT 'supplier-rfq' AS origin,d.id,'supplier.request_quotes' AS action_type,'Sent supplier RFQ: '||(r.snapshot->>'reference')||' to '||s.name AS summary,
   jsonb_build_object('communicationId',m.id) AS result,m.sent_at::timestamptz AS executed_at,jsonb_build_object('requestId',d.request_id) AS payload,false AS undone
  FROM stockchief_runtime.agent_rfq_deliveries d JOIN stockchief_runtime.agent_rfq_requests r ON r.workspace_id=d.workspace_id AND r.id=d.request_id
  JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id JOIN suppliers s ON s.workspace_id=d.workspace_id AND s.id=d.supplier_id
  WHERE d.workspace_id=$1 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
   AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz) AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=d.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED')
  ORDER BY m.sent_at,d.id LIMIT $7
 ), return_labels AS (
  SELECT 'return-label' AS origin,m.id,'customer_return.send_label' AS action_type,'Sent purchased return label and instructions: '||m.subject AS summary,
    '{}'::jsonb AS result,m.sent_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM customer_communications m WHERE m.workspace_id=$1 AND m.status='SENT' AND m.external_message_id IS NOT NULL
    AND m.sent_at::timestamptz>=$2::timestamptz AND m.sent_at::timestamptz<$3::timestamptz
    AND ($5::text IS NULL OR m.sent_at::timestamptz>=$5::timestamptz)
    AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=m.workspace_id AND e.aggregate_id=m.id
      AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED' AND e.payload->'standingAuthority'->>'kind'='return_label')
  ORDER BY executed_at,m.id LIMIT $7
 ), partial_shipments AS (
  SELECT 'partial-shipment' AS origin,p.id,p.action_type,'Completed partial shipment for '||(p.payload#>>'{partialSummary,order}') AS summary,
    p.result,${require('../warehouse/partial-shipment-evidence').completedAtSql('p')} AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.action_type='warehouse.release_partial_order'
    AND ${require('../warehouse/partial-shipment-evidence').completionSql('p')}
    AND ${require('../warehouse/partial-shipment-evidence').completedAtSql('p')}>=$2::timestamptz
    AND ${require('../warehouse/partial-shipment-evidence').completedAtSql('p')}<$3::timestamptz
    AND ($5::text IS NULL OR ${require('../warehouse/partial-shipment-evidence').completedAtSql('p')}>=$5::timestamptz)
  ORDER BY executed_at,p.id LIMIT $7
 ), customer_page_orders AS (
  SELECT 'customer-page-order' AS origin,r.id,'customer_order.from_page' AS action_type,'Drafted original customer page request: '||r.reference AS summary,
   jsonb_build_object('salesOrderId',r.sales_order_id) AS result,r.processed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_customer_page_requests r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
  WHERE r.workspace_id=$1 AND r.status='DRAFTED' AND o.status<>'CANCELLED' AND r.processed_at>=$2::timestamptz AND r.processed_at<$3::timestamptz
   AND ($5::text IS NULL OR r.processed_at>=$5::timestamptz) ORDER BY r.processed_at,r.id LIMIT $7
 ), return_dispositions AS (
  SELECT 'return-disposition' AS origin,p.id,'customer_return.plan_disposition' AS action_type,'Approved rule-based return disposition: '||r.return_number AS summary,
   '{}'::jsonb AS result,p.applied_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_return_assessments p JOIN customer_returns r ON r.workspace_id=p.workspace_id AND r.id=p.return_id
  WHERE p.workspace_id=$1 AND p.status='APPLIED' AND p.proposal->>'byRules'='true' AND r.inspected_at IS NOT NULL
   AND p.applied_at>=$2::timestamptz AND p.applied_at<$3::timestamptz AND ($5::text IS NULL OR p.applied_at>=$5::timestamptz)
  ORDER BY p.applied_at,p.id LIMIT $7
 ), supplier_invoices AS (
  SELECT 'supplier-invoice-source' AS origin,q.id,'purchase_order.record_supplier_invoice' AS action_type,'Read, matched and recorded supplier invoice: '||q.invoice_number AS summary,jsonb_build_object('billId',q.bill_id) AS result,b.opened_at::timestamptz AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN accounting_supplier_bills b ON b.workspace_id=q.workspace_id AND b.id=q.bill_id WHERE q.workspace_id=$1 AND q.status='POSTED' AND b.opened_at::timestamptz>=$2::timestamptz AND b.opened_at::timestamptz<$3::timestamptz AND ($5::text IS NULL OR b.opened_at::timestamptz>=$5::timestamptz) ORDER BY b.opened_at,q.id LIMIT $7
 ), customer_invoices AS (
  SELECT 'customer-invoice' AS origin,p.id,'customer_invoice.prepare_document' AS action_type,'Prepared customer invoice: '||(p.source_snapshot->'document'->'row'->>'invoice_number') AS summary,jsonb_build_object('documentId',p.id,'invoiceId',p.invoice_id) AS result,p.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_customer_invoice_documents p WHERE p.workspace_id=$1 AND p.created_at>=$2::timestamptz AND p.created_at<$3::timestamptz AND ($5::text IS NULL OR p.created_at>=$5::timestamptz) ORDER BY p.created_at,p.id LIMIT $7
 ), export_packets AS (
  SELECT 'export-papers' AS origin,p.id,'shipping.prepare_export_papers' AS action_type,'Prepared and owner-reviewed export packet: '||(p.source_snapshot->>'shipmentNumber') AS summary,
   '{}'::jsonb AS result,p.reviewed_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_export_paper_packets p WHERE p.workspace_id=$1 AND p.status='REVIEWED' AND p.reviewed_pdf IS NOT NULL
   AND p.reviewed_at>=$2::timestamptz AND p.reviewed_at<$3::timestamptz AND ($5::text IS NULL OR p.reviewed_at>=$5::timestamptz)
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_export_paper_packets prior WHERE prior.workspace_id=p.workspace_id AND prior.shipment_id=p.shipment_id AND prior.status='REVIEWED' AND (prior.reviewed_at,prior.id)<(p.reviewed_at,p.id))
  ORDER BY p.reviewed_at,p.id LIMIT $7
 ), annual_stocktakes AS (
  SELECT 'annual-stocktake' AS origin,p.id,'inventory.plan_annual_stocktake' AS action_type,'Signed off annual stocktake: '||p.title AS summary,
   p.signoff AS result,p.signed_off_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_annual_stocktakes p WHERE p.workspace_id=$1 AND p.status='SIGNED_OFF' AND p.signed_off_at>=$2::timestamptz AND p.signed_off_at<$3::timestamptz
   AND ($5::text IS NULL OR p.signed_off_at>=$5::timestamptz) ORDER BY p.signed_off_at,p.id LIMIT $7
 ), channel_buffers AS (
  SELECT 'channel-buffer' AS origin,e.id,'channel.set_stock_buffer' AS action_type,
   'Published buffered channel stock: '||s.code||' at '||l.name||' = '||(e.payload->>'value')||' units' AS summary,
   e.result,e.completed_at AS executed_at,jsonb_build_object('positionId',p.id) AS payload,false AS undone
  FROM stockchief_runtime.provider_effects e JOIN connection_commerce_positions p ON p.workspace_id=e.workspace_id AND p.id=e.aggregate_id
  JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
  WHERE e.workspace_id=$1 AND e.kind='commerce.position.publish' AND e.status='SUCCEEDED' AND e.payload->'channelBuffer'->>'id' IS NOT NULL AND e.result->>'verified'='true'
   AND e.completed_at>=$2::timestamptz AND e.completed_at<$3::timestamptz AND ($5::text IS NULL OR e.completed_at>=$5::timestamptz) ORDER BY e.completed_at,e.id LIMIT $7
 ), delivery_quality AS (
  SELECT 'delivery-qc' AS origin,h.id,'inventory.inspect_delivery' AS action_type,
   'Applied delivery QC hold: '||h.quantity||' units of '||s.code AS summary,
   jsonb_build_object('holdId',h.id) AS result,h.created_at AS executed_at,'{}'::jsonb AS payload,false AS undone
  FROM stockchief_runtime.agent_quality_holds h JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id
  WHERE h.workspace_id=$1 AND h.automatic AND h.created_at>=$2::timestamptz AND h.created_at<$3::timestamptz
   AND ($5::text IS NULL OR h.created_at>=$5::timestamptz) ORDER BY h.created_at,h.id LIMIT $7
 ), promotion_purchases AS (
  SELECT 'promotion-purchase' AS origin,p.id,'purchasing.plan_promotion_stock' AS action_type,
   'Prepared promotion purchase draft: '||o.po_number||' from '||s.reference AS summary,
   jsonb_build_object('purchaseOrderId',o.id) AS result,p.purchase_created_at AS executed_at,jsonb_build_object('promotionId',p.promotion_id) AS payload,o.status='CANCELLED' AS undone
  FROM stockchief_runtime.agent_promotion_stock_plans p JOIN stockchief_runtime.agent_promotion_stock s ON s.workspace_id=p.workspace_id AND s.id=p.promotion_id
  JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  WHERE p.workspace_id=$1 AND p.purchase_created_at>=$2::timestamptz AND p.purchase_created_at<$3::timestamptz
   AND ($5::text IS NULL OR p.purchase_created_at>=$5::timestamptz) ORDER BY p.purchase_created_at,p.id LIMIT $7
 ) SELECT * FROM (SELECT * FROM actions UNION ALL SELECT * FROM routines UNION ALL SELECT * FROM supplier_details UNION ALL SELECT * FROM po_dates UNION ALL SELECT * FROM container_plans UNION ALL SELECT * FROM blanket_releases UNION ALL SELECT * FROM channel_copy UNION ALL SELECT * FROM product_facts UNION ALL SELECT * FROM team_procedures UNION ALL SELECT * FROM product_retirements UNION ALL SELECT * FROM shutdown_purchases UNION ALL SELECT * FROM promotion_purchases UNION ALL SELECT * FROM delivery_quality UNION ALL SELECT * FROM supplier_rfqs UNION ALL SELECT * FROM supplier_claims UNION ALL SELECT * FROM channel_buffers UNION ALL SELECT * FROM annual_stocktakes UNION ALL SELECT * FROM partial_shipments UNION ALL SELECT * FROM return_labels UNION ALL SELECT * FROM supplier_invoices UNION ALL SELECT * FROM customer_invoices UNION ALL SELECT * FROM export_packets UNION ALL SELECT * FROM return_dispositions UNION ALL SELECT * FROM customer_page_orders) all_work ORDER BY executed_at,origin,id LIMIT 101 OFFSET $4`,
  [ctx.workspaceId,from,to,(page-1)*100,history.activityAfter,[...kinds.keys()],page*100+1])).rows;
 const more=proposals.length>100;if(more)proposals.pop();const current=await states(db,ctx,proposals),entries=[];
 const rows=proposals.map(p=>{const undo=undoable(p,current);if(undo.allowed)entries.push({id:p.id,summary:p.summary,what:undo.reason});
  return {Action:p.summary,When:new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(p.executed_at)),Status:p.undone?'Undone':'Completed','Undo or correction':undo.reason,link:p.origin==='product-facts'?'/autopilot/product-facts/'+p.id:p.origin==='supplier-invoice-source'?'/autopilot/supplier-invoices/'+p.id:p.origin==='customer-invoice'?'/autopilot/customer-invoices/'+p.id:p.origin==='blanket-release'?'/autopilot/blanket-releases/'+p.payload.contractId:p.origin==='channel-copy'?'/autopilot/channel-copy/'+p.id:p.origin==='customer-page-order'?'/autopilot/customer-order-pages?requestId='+p.id:p.origin==='return-disposition'?'/autopilot/return-disposition?id='+p.id:p.origin==='export-papers'?'/autopilot/export-papers/'+p.id:p.origin==='return-label'?'/messages/customer/'+p.id:p.origin==='annual-stocktake'?'/autopilot/annual-stocktakes/'+p.id:p.origin==='channel-buffer'?'/autopilot/channel-buffers?position='+encodeURIComponent(p.payload.positionId):p.origin==='supplier-claim'?'/autopilot/supplier-claims/'+p.id:p.origin==='supplier-rfq'?'/autopilot/supplier-rfqs/'+p.payload.requestId:p.origin==='delivery-qc'?'/autopilot/delivery-quality/'+p.id:p.origin==='promotion-purchase'?'/autopilot/promotion-stock/'+p.payload.promotionId:p.origin==='shutdown-purchase'?'/autopilot/supplier-shutdowns/'+p.payload.shutdownId:p.origin==='product-retirement'?'/autopilot/discontinued-products/'+p.id:p.origin==='team-procedure'?'/autopilot/team-procedures/'+p.id:p.origin==='container-plan'?'/autopilot/container-plans/'+p.id:p.origin==='po-delivery-date'?'/autopilot/po-delivery-dates/'+p.id:p.origin==='supplier-details'?'/mail/'+p.id+'/supplier-details':(p.origin==='routine'?'/autopilot/work/':'/actions/')+p.id};});
 return {rows,more,undoForm:{day,entries},summary:'Recorded agent work for '+day+' in '+timeZone+'. Undo is available for an unchanged draft or the most recent purchase-cost update. Stock movements, sent messages and posted money need their own reviewed correction.'};
}
async function undo(db,ctx,id){return db.transaction(async c=>{
 await require('./job-reviews').ownerState(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,204,'draft');
 const history=await require('../commercial/agent-history').access(c,ctx.workspaceId);
 const p=(await c.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 AND status='EXECUTED'
  AND ($3::timestamptz IS NULL OR executed_at>=$3::timestamptz) FOR UPDATE`,[ctx.workspaceId,id,history.activityAfter])).rows[0];
 if(!p)throw new NotFoundError('Choose completed agent work from this inventory.');
 if((await c.query("SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND reference=$2 AND action='Agent action undone'",[ctx.workspaceId,id])).rowCount)return {replayed:true};
 const current=await states(c,ctx,[p],{lock:true}),decision=undoable(p,current);if(!decision.allowed)throw new ValidationError(decision.reason+'. Open that record before correcting it.');
 const kind=kinds.get(p.action_type),recordId=reference(p),key='agent-undo:'+id;let result;
 if(kind==='sale')result=await require('../operations/postgres-business-workflows').cancelSalesOrderInTransaction(c,ctx,recordId,{idempotencyKey:key,reason:'Owner undid the agent-created draft'});
 if(kind==='quote')result=await require('../sales/postgres-quotes').decide(scoped(c),ctx,recordId,{accept:false,expectedHash:current.get('quote:'+recordId).pricing_hash});
 if(kind==='production')result=await require('../manufacturing/postgres-service').cancel(scoped(c),ctx,recordId,{confirmed:'yes',reason:'Owner undid the unused agent-created draft',idempotencyKey:key});
 if(kind==='prices'){
  result={ids:[]};for(const change of p.payload.changes){const before=change.before,saved=await require('../pricing/postgres-service').setPurchaseCostInTransaction(c,ctx,
   {skuId:change.skuId,amountMinor:before.amountMinor,currency:before.currency,expectedCurrentId:current.get('cost:'+change.skuId).id,source:'owner_undo_agent',sourceDetail:{proposalId:id}});result.ids.push(saved.id);}
 }
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Agent action undone',reference:id,before:{action:p.action_type,result:p.result},after:result});
 return {replayed:false,result};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={report,undo,definition:{id:204,key:'daily-work',label:'Daily record of StockChief work',filterLabel:'Business date (YYYY-MM-DD)',readPage:report}};

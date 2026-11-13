'use strict';

const {hasVerifiedMigration}=require('../db/migrate-postgres');
const lotCertificateActivity=`CASE WHEN users.role='owner' THEN (
  EXISTS(SELECT 1 FROM stockchief_runtime.lot_certificate_requirements r WHERE r.workspace_id=$1)
  OR EXISTS(SELECT 1 FROM stockchief_runtime.lot_certificate_links d WHERE d.workspace_id=$1 AND d.state='DRAFT')
  OR EXISTS(SELECT 1 FROM stockchief_runtime.lot_certificate_sources d
    WHERE d.workspace_id=$1 AND d.review_reason IS NOT NULL AND d.dismissed_at IS NULL)
) ELSE false END`;

function number(value){return Number(value || 0);}
// Urgent: something is already wrong or overdue. Important: time or money is really at stake.
// Everything else simply waits for a decision and is not dressed up as an alarm.
const olderThanDays=(value,days)=>{const at=Date.parse(value||'');return Number.isFinite(at)&&Date.now()-at>days*86400000;};
// What is actually wrong with a product, from the facts the decision was made on.
function stockSentence(row,action){let facts=[];try{facts=typeof row.source_evidence==='string'?JSON.parse(row.source_evidence||'[]'):row.source_evidence||[];}catch{facts=[];}
 const fact=name=>facts.find(entry=>entry.fact===name)?.value,available=fact('available'),incoming=fact('incoming')??action.incoming,point=fact('reorder_point')??action.reorderPoint;
 if(available===undefined||point===undefined)return 'Prepare '+number(action.quantity)+' units from '+(action.supplierName||'the selected supplier')+'.';
 return (Number(available)<=0?'Nothing is available':available+' available')+(Number(incoming)>0?' and '+incoming+' on the way':Number(incoming)===0?', and nothing is on the way':'')+'. Your reorder point is '+point+'.';}
function orderImportance(neededBy){if(!neededBy)return 'Needs You';const today=new Date().toISOString().slice(0,10);if(neededBy<today)return 'Urgent';
 return new Date(Date.parse(today+'T00:00:00Z')+3*86400000).toISOString().slice(0,10)>=neededBy?'Important':'Needs You';}
function object(value){if(value && typeof value==='object')return value;try{return JSON.parse(value || '{}');}catch{return {};}}
async function membership(database,workspaceId,actorId){
 const hasSupplierCredits=hasVerifiedMigration(database,'359-agent-supplier-credit-notes.sql');
 return actorId?(await database.query(`SELECT role,permissions,
 coalesce((SELECT (to_jsonb(w)->>'has_supplier_direct_orders')::boolean FROM workspaces w
   WHERE w.id=users.workspace_id AND w.owner_account_id=users.account_id),false) AS has_supplier_direct_orders,
 ${hasVerifiedMigration(database,'357-agent-lot-certificate-evidence.sql')?lotCertificateActivity:'false'} AS has_lot_certificate_activity,
 CASE WHEN users.role='owner' THEN (${hasVerifiedMigration(database,'416-agent-annual-stocktake-runs.sql')?require('../operations/agent-annual-stocktakes').summarySql('p'):`SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.frozen_at))
 FROM stockchief_runtime.agent_annual_stocktakes p WHERE p.workspace_id=$1 AND p.status='FROZEN'`}
 AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS annual_stocktake_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.created_at))
 FROM stockchief_runtime.agent_export_paper_packets p WHERE p.workspace_id=$1 AND p.status='DRAFT'
 AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS export_paper_summary,
 ${hasSupplierCredits?`CASE WHEN role='owner' THEN (SELECT jsonb_build_object('n',count(*) FILTER(WHERE checked),'awaiting',count(*) FILTER(WHERE NOT checked),'created_at',min(p.at))
 FROM (SELECT x.checked_at at,true checked FROM stockchief_runtime.agent_supplier_credit_work x
 JOIN stockchief_runtime.agent_supplier_invoice_intakes q ON q.workspace_id=x.workspace_id AND q.id=x.intake_id
 WHERE x.workspace_id=$1 AND q.status='CREDIT_REVIEW' AND x.result->>'status' IN('READY','WAITING','CONFLICT')
 UNION ALL SELECT r.shipped_at::timestamptz,false FROM supplier_returns r
 WHERE r.workspace_id=$1 AND r.status='AWAITING_CREDIT' AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_work x
 WHERE x.workspace_id=r.workspace_id AND x.result->>'returnId'=r.id)
 AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications a
   WHERE a.workspace_id=r.workspace_id AND a.supplier_return_id=r.id AND a.intake_id IS NOT NULL)) p
 WHERE EXISTS(SELECT 1 FROM workspaces w JOIN account_subscriptions sub ON sub.account_id=w.owner_account_id
 JOIN stockchief_runtime.agent_job_modes mode ON mode.workspace_id=w.id AND mode.job_id=105 AND mode.mode='routine'
 WHERE w.id=$1 AND w.owner_account_id=users.account_id AND mode.updated_by=users.id AND sub.plan_id IN('pro','enterprise')
 AND sub.status IN('ACTIVE','TRIALING'))) END`:'NULL::jsonb'} AS supplier_credit_summary,
 CASE WHEN role='owner' THEN (SELECT jsonb_build_object('n',count(*),'created_at',min(p.created_at)) FROM (SELECT workspace_id,created_at FROM stockchief_runtime.agent_supplier_invoice_intakes WHERE workspace_id=$1 AND status IN('READY','HELD','EXCEPTION','CREDIT_REVIEW') ${hasSupplierCredits?`AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_work x WHERE x.workspace_id=$1 AND x.intake_id=agent_supplier_invoice_intakes.id AND x.result->>'status' IN('READY','WAITING','CONFLICT','APPLIED','DUPLICATE'))`:''} UNION ALL SELECT workspace_id,created_at FROM stockchief_runtime.agent_supplier_invoice_uploads WHERE workspace_id=$1 AND status='HELD') p WHERE EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS supplier_invoice_summary,
 CASE WHEN role='owner' THEN (SELECT jsonb_build_object('n',count(*),'created_at',min(p.changed_at)) FROM stockchief_runtime.agent_customer_invoice_work p WHERE p.workspace_id=$1 AND p.revision>p.completed_revision AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS customer_invoice_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.created_at))
 FROM stockchief_runtime.agent_order_cost_previews p WHERE p.workspace_id=$1 AND p.status='DRAFT'
 AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS order_cost_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.created_at))
 FROM (SELECT workspace_id,created_at FROM stockchief_runtime.agent_return_assessments WHERE workspace_id=$1 AND status IN('OBSERVED','READY')
 UNION ALL SELECT workspace_id,created_at FROM stockchief_runtime.agent_return_repair_holds WHERE workspace_id=$1 AND status='HELD') p
 WHERE EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS return_assessment_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.created_at))
 FROM stockchief_runtime.agent_customer_page_requests p WHERE p.workspace_id=$1 AND p.status='RECEIVED'
 AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS customer_page_request_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.created_at))
 FROM stockchief_runtime.agent_channel_copy_sets p LEFT JOIN LATERAL(
  SELECT v.document_hash,v.exported_at,v.automatic FROM stockchief_runtime.agent_channel_copy_versions v
  WHERE v.workspace_id=p.workspace_id AND v.copy_id=p.id ORDER BY v.created_at DESC,v.id DESC LIMIT 1
 ) latest ON true WHERE p.workspace_id=$1
 AND (EXISTS(SELECT 1 FROM stockchief_runtime.agent_channel_copy_runs pending WHERE pending.workspace_id=p.workspace_id AND pending.copy_id=p.id AND pending.status='READY') OR p.last_issue IS NOT NULL OR p.enabled AND latest.automatic AND latest.exported_at IS NULL AND NOT EXISTS(
  SELECT 1 FROM stockchief_runtime.agent_channel_copy_versions done WHERE done.workspace_id=p.workspace_id AND done.document_hash=latest.document_hash AND done.exported_at IS NOT NULL))
 AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS channel_copy_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.updated_at)) FROM stockchief_runtime.agent_product_source_readings p WHERE p.workspace_id=$1 AND p.acknowledged_at IS NULL AND (p.status IN('READY','FAILED') OR p.status='SAVED' AND p.held_count>0) AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS product_source_summary,
 ${hasVerifiedMigration(database,'361-agent-shipping-document-reading.sql')?`CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.updated_at)) FROM stockchief_runtime.agent_shipping_document_readings p WHERE p.workspace_id=$1 AND p.dismissed_at IS NULL AND p.status IN('READY','FAILED') AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END`:'NULL::jsonb'} AS shipping_document_summary,
 ${hasVerifiedMigration(database,'366-agent-document-discovery.sql')?`CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'created_at',min(p.updated_at)) FROM stockchief_runtime.agent_document_discoveries p WHERE p.workspace_id=$1 AND p.dismissed_at IS NULL AND p.status IN('REVIEW','FAILED') AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END`:'NULL::jsonb'} AS document_discovery_summary,
 CASE WHEN users.role='owner' THEN (SELECT jsonb_build_object('n',count(*)::int,'reference',min(p.reference),'created_at',min(p.created_at))
 FROM stockchief_runtime.agent_blanket_contracts p WHERE p.workspace_id=$1
 AND (p.enabled AND p.last_issue IS NOT NULL OR EXISTS(SELECT 1 FROM stockchief_runtime.agent_blanket_releases r
  JOIN purchase_orders o ON o.workspace_id=r.workspace_id AND o.id=r.purchase_order_id
  WHERE r.workspace_id=p.workspace_id AND r.contract_id=p.id AND r.automatic AND o.status IN ('DRAFT','AWAITING_APPROVAL')))
 AND EXISTS(SELECT 1 FROM workspaces w WHERE w.id=p.workspace_id AND w.owner_account_id=users.account_id)) END AS blanket_contract_summary
 FROM users WHERE workspace_id=$1 AND id=$2`,[workspaceId,actorId])).rows[0]:null;}
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

// Needs you is counted on every page. A source whose table or column comes from
// a migration this database has not run yet (an upgrade in progress, or an
// upgrade test) contributes nothing instead of failing every page. Any other
// error still fails loudly.
function schemaTolerant(source){
  return Promise.resolve(source).catch(error=>{
    if(error?.code!=='42P01'&&error?.code!=='42703')throw error;
    console.error('[needs] skipped a source that needs a newer database:',error.message);
    return [];
  });
}
function needs(database,workspaceId,actorId=null){
  return require('../lib/request-read-cache').read(JSON.stringify(['needs',workspaceId,actorId]),async()=>{
    const actor=await membership(database,workspaceId,actorId);
    if(actorId&&!actor)return [];
    const [items,notices,purchaseReviews,countTasks,deputyTasks,supplierUpdates,supplierBenefits,supplierDates,staleIncoming,purchaseFx,containerPlans,teamProcedures,productRetirements,supplierShutdowns,promotionStock,annualStocktakes,deliveryQuality,supplierRfqs,negotiationDrafts,supplierClaims,exportPapers,orderCosts,returnAssessments,customerPageRequests,channelCopies,blanketContracts,productSources,directShipments,lotCertificates,shippingDocuments,documentDiscoveries,supplierCostUpdates,clearancePlans,slowStockSteps,expiryWarnings,lotBlocks,complianceReports,landedCostBills,orderChecks,creditHolds,invoiceDisputes,customerOrders,netMargins,channelPrices,pickReleases,pickWaves,orderSplits,preorderFills,addressChecks,labelRuns,catalogFixes,dataHealth,demandForecasts,reportFlags,shipmentNotices,parcelFlags,carrierClaims,statementRequests,reminderDisputes,creditRefunds,supplierCatalogs,oldSystemMoves,runOuts,productCategories,escalations,returnEmails,returnLabels,returnRestocks,shadowReport,staffTasks,channelSyncFixes,channelBufferPlans,approvalDesk,customerQuestions,quoteRequests,quoteFollowups,supplierReviewPacks,yearEndPacks,reportEmails,supplierForecasts,stockReadyStaff]=await Promise.all([
      require('../lib/versioned-read-model').read(database,workspaceId,['needs',actorId],()=>needsUncached(database,workspaceId,actorId,actor)),
      actorId?require('../autopilot/operational-notices').inbox(database,workspaceId,actorId):[],
      actorId?require('../purchasing/approval-routing').inbox(database,workspaceId,actorId):[],
      actorId?require('../operations/agent-count-tasks').inbox(database,workspaceId,actorId):[],
      actorId?require('../autopilot/vacation-deputy').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-email-terms').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-benefits').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-po-delivery-dates').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-stale-incoming').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../purchasing/agent-purchase-fx').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../purchasing/agent-container-plans').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../autopilot/team-procedures').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../catalog/agent-product-retirements').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-shutdowns').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-promotion-stock').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../operations/agent-annual-stocktakes').notices(actor.annual_stocktake_summary):[],
      actor?.role==='owner'?require('../operations/agent-quality-holds').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-rfqs').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/negotiation-drafts').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-claims').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../shipping/agent-export-papers').notices(actor.export_paper_summary).concat(require('../accounting/agent-customer-invoices').notices(actor.customer_invoice_summary),require('../purchasing/agent-supplier-invoice-intake').notices(actor.supplier_invoice_summary),require('../purchasing/agent-supplier-credit-notes').notices(actor.supplier_credit_summary)):[],
      actor?.role==='owner'?require('../reports/agent-net-contribution').notices(actor.order_cost_summary):[],
      actor?.role==='owner'?require('../operations/agent-return-disposition').notices(actor.return_assessment_summary):[],
      actor?.role==='owner'?require('../sales/agent-customer-order-pages').notices(actor.customer_page_request_summary):[],
      actor?.role==='owner'?require('../catalog/agent-channel-copy').notices(actor.channel_copy_summary):[],
      actor?.role==='owner'?require('../purchasing/agent-blanket-releases').notices(actor.blanket_contract_summary):[],
      actor?.role==='owner'?require('../documents/agent-product-source').notices(actor.product_source_summary):[],
      actor?.role==='owner'&&actor.has_supplier_direct_orders?
        require('../purchasing/agent-direct-shipments').inbox(database,workspaceId,{installed:true}):[],
      actor?.role==='owner'?require('../documents/agent-shipping-document-reader').notices(actor.shipping_document_summary):[],
      actor?.role==='owner'?require('../documents/agent-document-discovery').notices(actor.document_discovery_summary):[],
      actor?.role==='owner'&&actor.has_lot_certificate_activity?require('../autopilot/lot-certificate-coverage').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../pricing/agent-supplier-price-updates').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../pricing/agent-clearance-plans').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../forecasting/agent-slow-stock-steps').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../operations/agent-expiry-warnings').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../operations/agent-lot-blocks').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../reports/agent-compliance-reports').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../accounting/agent-landed-cost-bills').inbox(database,workspaceId):[],
      actor&&require('../actions/permissions').can(actor,require('../actions/permissions').VIEW_SALES)?require('../sales/agent-order-screening').inbox(database,workspaceId):[],
      actor&&require('../actions/permissions').can(actor,require('../actions/permissions').VIEW_SALES)?require('../sales/agent-credit-holds').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../purchasing/invoice-dispute-follow-through').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../sales/agent-customer-orders').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../reports/agent-net-margin').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../pricing/agent-channel-price-checks').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../warehouse/agent-pick-release').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../warehouse/agent-pick-waves').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../sales/agent-order-splits').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../sales/agent-preorder-fills').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../shipping/agent-address-checks').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../shipping/agent-labels').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../catalog/agent-catalog-fixes').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../autopilot/data-health').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../forecasting/agent-demand-forecast').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../reports/agent-report-runs').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../shipping/agent-shipping-notices').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../shipping/agent-parcel-watch').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../shipping/agent-carrier-claims').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../accounting/agent-statement-requests').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../accounting/agent-invoice-reminders').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../accounting/agent-customer-credits').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../catalog/agent-supplier-catalog').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../onboarding/agent-old-system-migration').inbox(database,workspaceId):[],
      actor&&require('../actions/permissions').can(actor,require('../actions/permissions').MANAGE_REPLENISHMENT)?require('../forecasting/agent-runout').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../catalog/agent-product-classification').inbox(database,workspaceId):[],
      actorId?require('../autopilot/escalations').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../sales/agent-customer-return-emails').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../shipping/agent-return-labels').inbox(database,workspaceId):[],
      actor?require('../operations/agent-return-disposition').restockInbox(database,workspaceId,actor):[],
      actor?.role==='owner'?require('../autopilot/shadow-mode').inbox(database,workspaceId):[],
      actorId?require('../operations/agent-staff-tasks').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../connections/agent-channel-sync-fixes').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../connections/agent-channel-buffer-plans').inbox(database,workspaceId):[],
      actorId?require('../autopilot/approval-desk').inbox(database,workspaceId,actorId):[],
      actor?.role==='owner'?require('../sales/agent-customer-questions').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../sales/agent-quote-requests').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../sales/agent-quote-followups').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-review-packs').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../accounting/agent-year-end-pack').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../reports/agent-report-email').inbox(database,workspaceId):[],
      actor?.role==='owner'?require('../purchasing/agent-supplier-forecasts').inbox(database,workspaceId):[],
      actorId?require('../sales/agent-stock-ready-staff').inbox(database,workspaceId,actorId):[],
    ].map(schemaTolerant));
    // A parcel StockChief is watching (job 62) shows once, with its own words.
    const watchedParcels=new Set(parcelFlags.map(r=>r.shipmentId));
    const delegated=new Set(deputyTasks.map(r=>r.href));
    const supplierMail=new Set(supplierUpdates.filter(r=>!r.grouped).map(r=>r.href.replace(/\/supplier-details$/,'')));
    // An approval routed here (job 176) shows once: a native approval, a deputy's
    // copy or another source naming the same record wins.
    const all=items.concat(notices,purchaseReviews,countTasks).filter(r=>!delegated.has(r.href)&&!supplierMail.has(r.href)&&!(r.kind==='shipping'&&watchedParcels.has(r.sourceId))).concat(deputyTasks,supplierUpdates,supplierBenefits,supplierDates,staleIncoming,purchaseFx,containerPlans,teamProcedures,productRetirements,supplierShutdowns,promotionStock,annualStocktakes,deliveryQuality,supplierRfqs,supplierClaims,exportPapers,orderCosts,returnAssessments,customerPageRequests,channelCopies,blanketContracts,productSources,directShipments,lotCertificates,shippingDocuments,documentDiscoveries,supplierCostUpdates,clearancePlans,slowStockSteps,expiryWarnings,lotBlocks,complianceReports,landedCostBills,negotiationDrafts,orderChecks,creditHolds,invoiceDisputes,customerOrders,netMargins,channelPrices,pickReleases,pickWaves,orderSplits,preorderFills,addressChecks,labelRuns,catalogFixes,dataHealth,demandForecasts,reportFlags,shipmentNotices,parcelFlags,carrierClaims,statementRequests,reminderDisputes,creditRefunds,supplierCatalogs,oldSystemMoves,runOuts,productCategories,escalations,returnEmails,returnLabels,returnRestocks,shadowReport,staffTasks,channelSyncFixes,channelBufferPlans,approvalDesk,customerQuestions,quoteRequests,quoteFollowups,supplierReviewPacks,yearEndPacks,reportEmails,supplierForecasts,stockReadyStaff),shown=new Set(all.filter(r=>!r.approvalRequest).map(r=>r.href));
    return all.filter(r=>!r.approvalRequest||!shown.has(r.href)).sort((a,b)=>b.priority-a.priority || Number(Boolean(b.grouped))-Number(Boolean(a.grouped)) || (a.moneyCurrency&&a.moneyCurrency===b.moneyCurrency?(b.moneyValue??-1)-(a.moneyValue??-1):0) || String(a.at||'').localeCompare(String(b.at||'')));
  });
}
// Share only permission-independent source facts. Membership, private agent
// approvals, de-duplication and final permissions remain per actor.
function needsInputs(connection,workspaceId){return require('../lib/versioned-read-model').read(connection,workspaceId,['needs-inputs'],async()=>{
  // pg.Result carries parser functions; cache only detached source rows.
  const database={query:async(sql,values)=>({rows:(await connection.query(sql,values)).rows})};
  return Promise.all([
    require('./postgres-attention-inbox').summary(database,workspaceId),
    database.query(`SELECT i.id,i.title,i.detail,i.resolution_hint,i.created_at,i.updated_at,i.connector_id,
      i.issue_type,i.external_event_id,c.provider_type,
      message.id AS reply_message_id,related_effect.id AS provider_effect_id,buffer.position_id AS buffer_position_id
      FROM connection_issues i JOIN workspace_connectors c ON c.id=i.connector_id
      LEFT JOIN connection_email_messages message ON message.workspace_id=i.workspace_id AND message.id=i.external_event_id
      LEFT JOIN stockchief_runtime.agent_channel_buffers buffer ON buffer.workspace_id=i.workspace_id AND i.fingerprint='commerce-position:'||buffer.position_id AND buffer.enabled
      LEFT JOIN LATERAL (SELECT effect.id FROM stockchief_runtime.provider_effects effect
        WHERE effect.workspace_id=i.workspace_id AND effect.aggregate_id=i.external_event_id
        AND effect.aggregate_type IN ('email_message','supplier_communication','customer_communication')
        AND effect.status='AMBIGUOUS' ORDER BY effect.created_at DESC LIMIT 1) related_effect ON true
      WHERE i.workspace_id=$1 AND i.status='OPEN' ORDER BY i.updated_at DESC`,[workspaceId]),
    require('./postgres-work-inbox').summary(database,workspaceId),
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
      SUM(sol.quantity_ordered-sol.quantity_fulfilled-coalesce((to_jsonb(sol)->>'direct_committed_quantity')::numeric,0)) AS remaining,
      COALESCE(SUM(a.allocated),0) AS allocated
      FROM sales_orders so JOIN customers c ON c.id=so.customer_id
      JOIN sales_order_lines sol ON sol.sales_order_id=so.id
      LEFT JOIN (SELECT sales_order_line_id,SUM(quantity) AS allocated FROM sales_order_allocations
        WHERE workspace_id=$1 GROUP BY sales_order_line_id) a ON a.sales_order_line_id=sol.id
      WHERE so.workspace_id=$1 AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
      GROUP BY so.id,so.order_number,so.needed_by,so.created_at,c.name
      HAVING SUM(sol.quantity_ordered-sol.quantity_fulfilled-coalesce((to_jsonb(sol)->>'direct_committed_quantity')::numeric,0))>COALESCE(SUM(a.allocated),0)
      ORDER BY so.needed_by NULLS LAST,so.created_at`,[workspaceId]),
    database.query(`SELECT po.id,po.po_number,po.expected_date,po.created_at,s.name AS supplier_name,
      EXISTS(SELECT 1 FROM purchase_order_lines line WHERE line.workspace_id=po.workspace_id AND line.purchase_order_id=po.id
        AND line.quantity_units>line.quantity_received_units AND to_jsonb(line)->>'supplier_supply_hold_id' IS NOT NULL) AS unavailable
      FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
      WHERE po.workspace_id=$1 AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
      AND (po.expected_date IS NOT NULL AND po.expected_date<CURRENT_DATE::text OR
        EXISTS(SELECT 1 FROM purchase_order_lines line WHERE line.workspace_id=po.workspace_id AND line.purchase_order_id=po.id
          AND line.quantity_units>line.quantity_received_units AND to_jsonb(line)->>'supplier_supply_hold_id' IS NOT NULL))
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
    database.query("SELECT id,kind,payload,created_at FROM catalog_bulk_reviews WHERE workspace_id=$1 AND status='PENDING' ORDER BY created_at,id",[workspaceId]),
    database.query("SELECT p.id,p.agreement_id,p.last_error,p.created_at,p.updated_at,a.agreement_number FROM custody_billing_policies p JOIN custody_agreements a ON a.workspace_id=p.workspace_id AND a.id=p.agreement_id WHERE p.workspace_id=$1 AND p.status='NEEDS_REVIEW' ORDER BY p.updated_at",[workspaceId]),
    require('../domain/postgres-batch-expiry').summary(database,workspaceId),
    require('../sales/postgres-deposit-refunds').due(database,workspaceId),
    require('../lib/business-time').forWorkspace(database,workspaceId),
    require('../operations/postgres-reconciliation').failures(database,workspaceId),
    database.query(`SELECT r.id,r.job_id,r.location_id,r.reason,r.created_at,(r.plan->>'units')::int AS units,l.name AS location_name
      FROM stockchief_runtime.agent_backorder_runs r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
      WHERE r.workspace_id=$1 AND r.status='DRAFT' ORDER BY r.created_at,r.id LIMIT 20`,[workspaceId]),
    database.query(`SELECT r.id,r.status,r.sales_order_id,r.reason,r.created_at,r.plan->>'summary' AS summary,o.order_number
      FROM stockchief_runtime.agent_warehouse_routings r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
      WHERE r.workspace_id=$1 AND r.status IN ('DRAFT','ASK') ORDER BY r.created_at,r.id LIMIT 20`,[workspaceId]),
  ]);});}
async function needsUncached(database,workspaceId,actorId,actor){
  const [inputs,nativeApprovals]=await Promise.all([
    needsInputs(database,workspaceId),
    require('../assistant/postgres-approval-projection').pending(database,workspaceId,actorId),
  ]);
  const [attention,connections,work,imports,bills,supplierReturns,shippingExceptions,mail,orders,purchases,
    repairs,ambiguousEffects,bulkReviews,rentalBilling,batchExpiry,depositRefunds,calendar,booksMismatches=[],backorderPlans={rows:[]},warehouseChoices={rows:[]}]=inputs;
  const ownedRecords=new Set(work.rows.filter(r=>object(r.outcome).decision).map(r=>object(r.outcome).recordId));
  const preparedLinks=new Set(nativeApprovals.map(r=>r.href));
  const items=[...nativeApprovals];
  if(batchExpiry.expired||batchExpiry.soon)items.push({kind:'inventory',grouped:true,importance:batchExpiry.expired?'Urgent':'Important',priority:batchExpiry.expired?94:70,title:batchExpiry.expired?batchExpiry.expired+' batches have expired':batchExpiry.soon+' batches expire within 30 days',happened:batchExpiry.expired+' expired batches; '+batchExpiry.soon+' more expire within 30 days.',why:'Expired stock is blocked from sale. Review batch stock before picking or disposing of it.',recommendation:'Review the batches and their locations. Use unexpired stock with the earliest expiry first.',href:'/warehouse/batches',actionLabel:'Review batch expiry',sourceId:'batch-expiry'});
  for(const row of backorderPlans.rows)items.push({kind:'approval',requiredPermissions:[require('../actions/permissions').ADMIN],importance:'Needs You',priority:87,
    title:(row.job_id===65?'Approve how scarce stock is shared at ':'Approve stock for waiting orders at ')+row.location_name,
    happened:number(row.units)+' '+(number(row.units)===1?'unit is':'units are')+' ready to set aside. Nothing has moved yet.',
    why:row.reason&&row.reason!=='Prepared on request.'?row.reason:'Your plan asks you to approve who gets stock that arrived or freed up.',
    recommendation:'Check who gets the stock, then approve or dismiss the plan.',
    href:(row.job_id===65?'/autopilot/stock-sharing':'/autopilot/backorders')+'?location='+encodeURIComponent(row.location_id),actionLabel:'Review plan',
    sourceId:row.id,createdAt:row.created_at,timeLabel:'Prepared',at:row.created_at});
  // Job 121: a warehouse choice to approve, or a fact StockChief needs before it can choose.
  for(const row of warehouseChoices.rows)items.push({kind:'approval',requiredPermissions:[require('../actions/permissions').OPERATE],importance:'Needs You',priority:row.status==='ASK'?84:86,
    title:(row.status==='ASK'?'Help StockChief choose the warehouse for ':'Approve the warehouse for ')+row.order_number,
    happened:row.status==='ASK'?'StockChief stopped before choosing a warehouse. Nothing has changed.':(row.summary||'A warehouse choice is ready.')+' Nothing has changed yet.',
    why:row.reason||'Your plan asks you to approve each warehouse choice.',
    recommendation:row.status==='ASK'?'Fix what is missing on the order, or choose the warehouse yourself.':'Check the warehouse, then approve or dismiss it.',
    href:'/orders/'+encodeURIComponent(row.sales_order_id)+'/ship-from',actionLabel:row.status==='ASK'?'Review order':'Review choice',
    sourceId:row.id,createdAt:row.created_at,timeLabel:'Prepared',at:row.created_at});
  for(const row of rentalBilling.rows)items.push({kind:'accounting',importance:'Needs You',priority:89,title:'Review rental billing for '+row.agreement_number,happened:'An earned rental invoice is paused before posting.',why:row.last_error,recommendation:'Review the unchanged billing authority, tax settings and accounting period before authorizing another attempt.',href:'/custody/'+row.agreement_id+'#rental-billing',actionLabel:'Review rental billing',sourceId:row.id,createdAt:row.created_at,updatedAt:row.updated_at,timeLabel:'Billing paused',at:row.updated_at});
  for(const row of bulkReviews.rows)items.push({kind:'approval',requiredPermissions:[require('../actions/permissions').ADMIN],importance:'Needs You',priority:70,title:row.kind==='price'?'Review selected selling prices':row.kind==='cost'?'Review selected purchase costs':row.kind==='reorder'?'Review selected reorder levels':row.kind==='restore'?'Restore selected products':'Archive selected products',happened:(row.payload.items||[]).length+' selected products are prepared; nothing has changed.',why:'Your approval is required before these product changes are applied.',recommendation:'Review the exact products and changes, then approve or cancel.',href:'/inventory/bulk/reviews/'+row.id,actionLabel:'Review changes',sourceId:row.id,createdAt:row.created_at,timeLabel:'Prepared',at:row.created_at});
  for(const row of attention.rows)items.push({kind:'inventory',importance:row.severity==='critical'?'Urgent':row.severity==='important'?'Important':'Watch',
    priority:number(row.priority_score),title:row.title,happened:row.concise_summary,why:row.explanation,
    recommendation:row.recommendation,grouped:Boolean(row.summary),href:row.href||(row.item_id?`/inventory/${row.item_id}?finding=${encodeURIComponent(row.id)}`:'/needs-you/findings'),actionLabel:row.summary?'Review group':'See what to do',sourceId:row.id,createdAt:row.first_detected_at,timeLabel:'First detected',at:row.first_detected_at});
  // The 15-minute check found the books and the records disagree. Automatic
  // work is paused until they agree, so this outranks everything it could do.
  for(const row of booksMismatches)items.push({kind:'accounting',importance:'Urgent',priority:97,title:row.title,happened:row.happened,
    why:'StockChief checks your books against your records every 15 minutes. Automatic work is paused until they agree, so nothing builds on a wrong figure.',
    recommendation:'Find what changed and correct it on the record itself. Automatic work starts again once the next check passes.',
    href:row.href,actionLabel:'Look into it',sourceId:'books-check:'+row.key,createdAt:row.checkedAt,timeLabel:'Checked',updatedAt:row.checkedAt,at:row.checkedAt});
  for(const row of depositRefunds){const amount=require('../pricing/postgres-service').formatMinor(row.toRefundMinor,row.currency);
    items.push({kind:'accounting',importance:olderThanDays(row.changedAt,3)?'Important':'Needs You',priority:88,title:(row.cancelled?'Deposit to refund: ':'Overpayment to refund: ')+amount+' to '+row.customerName,happened:row.orderNumber+(row.cancelled?' was cancelled after the customer paid.':' is complete and the customer paid more than it came to.'),
      why:'That money is still theirs. It stays on your books as a customer deposit until it is returned.',recommendation:'Send the money back, then record the refund on the order.',
      href:'/orders/'+row.orderId+'#deposit-refund',actionLabel:row.cancelled?'Refund deposit':'Refund overpayment',sourceId:'deposit-refund:'+row.orderId,createdAt:row.changedAt,timeLabel:row.cancelled?'Cancelled':'Completed',updatedAt:row.changedAt,at:row.changedAt});}
  for(const row of connections.rows)items.push({kind:'connection',importance:'Important',priority:85,title:row.title,
    happened:row.detail,why:row.issue_type==='EMAIL_SEND_AMBIGUOUS'
      ?'The provider may have accepted the email before StockChief could verify delivery. Sending it again could create a duplicate.'
      :row.buffer_position_id?'The channel stock update is held until its current stock, plan and approval requirements are met.':`${require('../web/presentation/connections').name(row)} cannot currently provide complete business data.`,recommendation:row.resolution_hint,
    href:row.buffer_position_id?`/autopilot/channel-buffers?position=${encodeURIComponent(row.buffer_position_id)}`:row.issue_type==='EMAIL_SEND_AMBIGUOUS' && row.reply_message_id
      ?`/mail/${row.reply_message_id}`:row.issue_type==='EMAIL_SEND_AMBIGUOUS' && row.provider_effect_id
        ?`/settings/operations/provider-effects/${row.provider_effect_id}`:`/settings/connections/${row.connector_id}`,
    actionLabel:row.buffer_position_id?'Review stock buffer':row.issue_type==='EMAIL_SEND_AMBIGUOUS'?'Verify email':'Fix connection',sourceId:row.id,createdAt:row.created_at,timeLabel:'Issue opened',updatedAt:row.updated_at,at:row.updated_at});
  for(const row of work.rows){if(row.summary){const shown=row.names||[],others=row.count-shown.length;items.push({kind:'approval',grouped:true,requiredPermissions:[row.kind==='transfer'?require('../actions/permissions').VIEW_TRANSFERS:require('../actions/permissions').VIEW_PURCHASING],importance:row.urgentCount?'Urgent':'Important',priority:70+number(row.priority),title:row.title,happened:(row.urgentCount?row.urgentCount.toLocaleString()+' urgent. ':'')+(shown.length?'Includes '+shown.join(', ')+(others>0?' and '+others.toLocaleString()+' more.':'.'):row.count.toLocaleString()+' '+row.groupLabel+' await review.'),why:row.kind==='transfer'?'These locations are at or below their reorder points while another location has stock to spare.':'These products are at or below their reorder points, so they could run out.',recommendation:row.kind==='transfer'?'Move the stock rather than buying more. Approve them together, or review each one.':'Order them from their suppliers. Approve them together, or review each one.',href:row.href,actionLabel:'Review and approve',sourceId:row.id,createdAt:row.created_at,at:row.created_at});continue;}const action=object(row.recommended_action),outcome=object(row.outcome);const authority=object(row.policy_evaluation);
    if(outcome.decision&&preparedLinks.has(outcome.reviewHref))continue;
    if(outcome.decision){const d=outcome.decision,permission=action.type==='customer_order'?require('../actions/permissions').VIEW_SALES:action.type==='supplier_invoice'?require('../actions/permissions').VIEW_ACCOUNTING:require('../actions/permissions').VIEW_PURCHASING;
      items.push({kind:'approval',requiredPermissions:[permission],importance:'Needs You',priority:90,title:(outcome.reference||action.displayName||'Business work')+': '+outcome.nextAction,happened:d.happened,why:d.impact,recommendation:d.recommendation+' '+d.required,checked:d.checked,alternatives:d.alternatives,href:outcome.reviewHref||outcome.href||action.href||'/autopilot/work/'+row.id,actionLabel:'Review next step',sourceId:row.id,createdAt:row.created_at,at:outcome.deadline||row.created_at});continue;}
    items.push({kind:'approval',requiredPermissions:[action.type==='transfer'?require('../actions/permissions').VIEW_TRANSFERS:require('../actions/permissions').VIEW_PURCHASING],
    importance:row.urgency==='immediate'?'Urgent':'Needs You',priority:70+number(row.priority),
    title:action.title || `${action.type==='transfer'?'Transfer':'Replenish'} ${action.displayName || String(row.category).replaceAll('_',' ')}`,
    happened:action.summary || (action.type==='transfer'
      ? `Move ${number(action.quantity)} units from ${action.sourceLocationName} to ${action.destinationLocationName}.`
      : stockSentence(row,action)),
    why:row.error_message || authority.reason || 'Your authority policy requires approval.',
    recommendation:action.type==='transfer'?(action.reason||'Review the prepared work and its evidence.'):'Order '+number(action.quantity)+' '+(number(action.quantity)===1?'unit':'units')+' from '+(action.supplierName||'the selected supplier')+'.',href:`/autopilot/work/${row.id}`,
    confidence:require('../autopilot/confidence').forAction(action),
    actionLabel:'Review decision',sourceId:row.id,createdAt:row.created_at,timeLabel:'Proposed',at:row.created_at});}
  for(const row of imports.rows)items.push({kind:'import',importance:'Important',priority:80,title:`Import failed: ${row.source_name}`,
    happened:'Completed import batches are saved. Open the import to see the stopping reason and resume from its checkpoint.',why:row.error_message || 'The import could not be verified.',
    recommendation:'Correct the source or setup, then run the same approved preview again.',href:`/imports/${row.import_id}`,
    actionLabel:'Open import',sourceId:row.id,createdAt:row.finished_at,timeLabel:'Failed',at:row.finished_at});
  for(const row of bills.rows.filter(r=>!ownedRecords.has(r.id)))items.push({kind:'accounting',importance:'Needs You',priority:88,title:`Review invoice ${row.supplier_invoice_number||row.bill_number} from ${row.supplier_name}`,
    happened:`${row.supplier_name} has ${row.currency} ${(number(row.balance_minor)/100).toFixed(2)} unresolved.`,
    why:'The supplier document and expected purchase do not agree.',recommendation:'Review the discrepancy before paying or posting a correction.',
    href:`/accounting/payables/${row.id}/review`,actionLabel:'Review invoice',sourceId:row.id,createdAt:row.created_at,timeLabel:'Invoice recorded',updatedAt:row.updated_at,dueDate:row.due_date,at:row.updated_at});
  for(const row of supplierReturns.rows)items.push({kind:'accounting',importance:'Needs You',priority:89,
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
  for(const row of mail.rows)items.push({kind:'mail',importance:olderThanDays(row.received_at,2)?'Important':'Needs You',priority:82,title:row.subject || `Reply to ${row.sender}`,
    happened:`${row.sender} is waiting for a response.`,why:row.reply_reason || 'A known customer or supplier sent a business message.',
    recommendation:'Read the message first. Review or write a reply only if one is needed.',href:`/mail/${row.id}`,
    actionLabel:'Read email',sourceId:row.id,createdAt:row.received_at,timeLabel:'Received',at:row.received_at});
  for(const row of orders.rows.filter(r=>!ownedRecords.has(r.id)))items.push({kind:'order',importance:orderImportance(row.needed_by),
    priority:92,title:`${row.order_number} can’t be filled yet`,happened:`${row.customer_name} needs ${number(row.remaining)} ${number(row.remaining)===1?'unit':'units'}; only ${number(row.allocated)} ${number(row.allocated)===1?'is':'are'} set aside for this order.`,
    why:'Until more stock is available, this order can only go out in part.',recommendation:'Move stock from another location or buy more.',
    href:`/orders/${row.id}`,actionLabel:'Review order',sourceId:row.id,createdAt:row.created_at,timeLabel:'Order created',dueDate:row.needed_by,at:row.needed_by});
  for(const row of purchases.rows.filter(r=>!ownedRecords.has(r.id)))items.push({kind:'purchase',importance:'Important',priority:75,title:row.unavailable?`Confirm supplier availability for ${row.po_number}`:`${row.po_number} is late`,
    happened:row.unavailable?`${row.supplier_name} reported unavailable goods on this order.`:`${row.supplier_name} was expected on ${new Date(row.expected_date+'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}.`,why:row.unavailable?'Those remaining units are excluded from dependable incoming until supplier availability is confirmed.':'StockChief has no complete receipt for this purchase order.',
    recommendation:'Check the supplier update and affected customer commitments.',href:`/purchasing/orders/${row.id}`,actionLabel:'Review purchase',sourceId:row.id,createdAt:row.created_at,timeLabel:'Purchase order created',dueDate:row.expected_date,at:row.expected_date});
  for(const row of repairs.rows)items.push({kind:'repair',importance:row.materiality==='high'?'Urgent':'Needs You',
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
  const zone=calendar.timeZone,{readableTimes}=require('../web/presentation/time-zones');
  for(const item of items)for(const field of ['title','happened','why','recommendation'])if(item[field])item[field]=readableTimes(item[field],zone);
  // Any entry can be dismissed. Its key follows what it says and where it
  // leads, so a changed situation (new count, new record) comes back.
  const dismissed=new Set((await database.query('SELECT entry_id FROM needs_you_dismissals WHERE workspace_id=$1',[workspaceId])).rows.map(row=>row.entry_id));
  for(const item of items){item.entryKey=require('node:crypto').createHash('sha256').update(JSON.stringify([item.kind,item.href||item.link||'',item.title||''])).digest('hex').slice(0,32);
    if(!item.dismiss)item.dismiss={action:'/needs-you/dismiss/'+item.entryKey,label:'Dismiss'};}
  return items.filter(item=>!dismissed.has(item.entryKey)).filter(item=>!actorId||visible(item,actor)).sort((a,b)=>b.priority-a.priority || Number(Boolean(b.grouped))-Number(Boolean(a.grouped)) || (a.moneyCurrency&&a.moneyCurrency===b.moneyCurrency?(b.moneyValue??-1)-(a.moneyValue??-1):0) || String(a.at||'').localeCompare(String(b.at||'')));
}

async function brief(database,workspaceId,actorId=null,{includeLocationStock=true,includeAvailability=true}={}){
  if(typeof includeLocationStock!=='boolean'||typeof includeAvailability!=='boolean')throw new TypeError('Choose fixed location-stock and availability projections.');
  const [data,needItems]=await Promise.all([require('../lib/versioned-read-model').read(database,workspaceId,['business-brief',includeLocationStock,includeAvailability],()=>briefData(database,workspaceId,{includeLocationStock,includeAvailability}),{domain:'business'}),needs(database,workspaceId,actorId)]);
  return {...data,needs:needItems};
}
async function briefData(database,workspaceId,{includeLocationStock,includeAvailability}){
  const [stats,locations,activity,openOrders,openPurchases,totalAvailable,stock]=await Promise.all([
    database.query(`WITH stock_by_sku AS MATERIALIZED(${require('./postgres-sku-stock').source()}),
     sku_stats AS (
      SELECT count(*) FILTER(WHERE s.is_active=1) AS sku_count,
        count(*) FILTER(WHERE s.is_active=1 AND coalesce(b.quantity,0)<=0) AS zero_count
      FROM skus s
      LEFT JOIN stock_by_sku b ON b.sku_id=s.id WHERE s.workspace_id=$1
    ) SELECT
      (SELECT COUNT(*) FROM items WHERE workspace_id=$1 AND is_active=1) AS item_count,
      sku_stats.sku_count,
      (SELECT COUNT(*) FROM locations WHERE workspace_id=$1 AND is_active=1) AS location_count,
      sku_stats.zero_count,
      (SELECT COALESCE(SUM(a.quantity),0) FROM sales_order_allocations a WHERE a.workspace_id=$1) AS committed,
      (SELECT COALESCE(SUM(pol.quantity_units-pol.quantity_received_units),0) FROM purchase_order_lines pol
        JOIN purchase_orders po ON po.id=pol.purchase_order_id WHERE pol.workspace_id=$1
        AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
        AND coalesce(to_jsonb(po)->>'delivery_kind','WAREHOUSE')='WAREHOUSE'
        AND to_jsonb(pol)->>'supplier_supply_hold_id' IS NULL) AS incoming FROM sku_stats`,[workspaceId]),
    includeLocationStock?database.query(`SELECT l.id,l.name,${require('../domain/stock-totals').totalsSql('l.workspace_id','l.id')} AS stock FROM locations l
      WHERE l.workspace_id=$1 AND l.is_active=1 ORDER BY l.name`,[workspaceId]):{rows:[]},
    database.query(`WITH recent_movements AS MATERIALIZED(
      SELECT id,seq,operation,quantity_delta,reference,notes,occurred_at,item_id,sku_id,location_id,actor_user_id
      FROM movements WHERE workspace_id=$1 ORDER BY occurred_at DESC,seq DESC LIMIT 12)
      SELECT m.id,m.operation,m.quantity_delta,m.reference,m.notes,m.occurred_at,
      i.name AS item_name,s.code,l.name AS location_name,u.name AS actor_name
      FROM recent_movements m
      JOIN LATERAL(SELECT name FROM items WHERE id=m.item_id OFFSET 0)i ON true
      JOIN LATERAL(SELECT code FROM skus WHERE id=m.sku_id OFFSET 0)s ON true
      JOIN LATERAL(SELECT name FROM locations WHERE id=m.location_id OFFSET 0)l ON true
      LEFT JOIN LATERAL(SELECT name FROM users WHERE id=m.actor_user_id OFFSET 0)u ON true
      ORDER BY m.occurred_at DESC,m.seq DESC`,[workspaceId]),
    database.query(`SELECT COUNT(*) AS count FROM sales_orders WHERE workspace_id=$1
      AND status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')`,[workspaceId]),
    database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1
      AND status IN ('DRAFT','AWAITING_APPROVAL','APPROVED','ORDERED','PARTIALLY_RECEIVED')`,[workspaceId]),
    includeAvailability?require('../domain/postgres-stock-availability').total(database,workspaceId):null,
    require('../domain/stock-totals').forBusiness(database,workspaceId),
  ]);
  const row=stats.rows[0];
  return {stats:{itemCount:number(row.item_count),skuCount:number(row.sku_count),locationCount:number(row.location_count),
    unitsOnHand:stock.units,hasMeasuredStock:stock.measured.length>0,measuredStock:stock.measured,zeroCount:number(row.zero_count),committed:number(row.committed),incoming:number(row.incoming),
    available:totalAvailable,openOrders:number(openOrders.rows[0].count),
    openPurchases:number(openPurchases.rows[0].count)},locations:locations.rows.map((entry)=>{const stock=require('../domain/stock-totals').read(entry.stock);return {id:entry.id,name:entry.name,on_hand:stock.units,onHand:stock.units,measured:stock.measured};}),
    activity:activity.rows.map((entry)=>({...entry,quantityDelta:number(entry.quantity_delta)}))};
}

module.exports={brief,needs,needsCount,runtimeFailures,orderImportance};

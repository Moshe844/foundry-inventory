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
  FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.status='EXECUTED' AND p.executed_at>=($2::text)::timestamptz AND p.executed_at<($3::text)::timestamptz
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
 ) SELECT * FROM (SELECT * FROM actions UNION ALL SELECT * FROM routines UNION ALL SELECT * FROM supplier_details UNION ALL SELECT * FROM po_dates UNION ALL SELECT * FROM container_plans UNION ALL SELECT * FROM team_procedures UNION ALL SELECT * FROM product_retirements UNION ALL SELECT * FROM shutdown_purchases UNION ALL SELECT * FROM promotion_purchases UNION ALL SELECT * FROM delivery_quality UNION ALL SELECT * FROM supplier_rfqs UNION ALL SELECT * FROM supplier_claims) all_work ORDER BY executed_at,origin,id LIMIT 101 OFFSET $4`,
  [ctx.workspaceId,from,to,(page-1)*100,history.activityAfter,[...kinds.keys()],page*100+1])).rows;
 const more=proposals.length>100;if(more)proposals.pop();const current=await states(db,ctx,proposals),entries=[];
 const rows=proposals.map(p=>{const undo=undoable(p,current);if(undo.allowed)entries.push({id:p.id,summary:p.summary,what:undo.reason});
  return {Action:p.summary,When:new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(p.executed_at)),Status:p.undone?'Undone':'Completed','Undo or correction':undo.reason,link:p.origin==='supplier-claim'?'/autopilot/supplier-claims/'+p.id:p.origin==='supplier-rfq'?'/autopilot/supplier-rfqs/'+p.payload.requestId:p.origin==='delivery-qc'?'/autopilot/delivery-quality/'+p.id:p.origin==='promotion-purchase'?'/autopilot/promotion-stock/'+p.payload.promotionId:p.origin==='shutdown-purchase'?'/autopilot/supplier-shutdowns/'+p.payload.shutdownId:p.origin==='product-retirement'?'/autopilot/discontinued-products/'+p.id:p.origin==='team-procedure'?'/autopilot/team-procedures/'+p.id:p.origin==='container-plan'?'/autopilot/container-plans/'+p.id:p.origin==='po-delivery-date'?'/autopilot/po-delivery-dates/'+p.id:p.origin==='supplier-details'?'/mail/'+p.id+'/supplier-details':(p.origin==='routine'?'/autopilot/work/':'/actions/')+p.id};});
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

'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions'),policy=require('../commercial/agent-plan');
const kinds={receiving:'Receive supplier deliveries',dispatch:'Record customer dispatch',counting:'Review and post a physical stock count'};
function input(value){
 const kind=String(value.kind||''),locationId=String(value.locationId||''),text=String(value.lookbackDays??'');
 if(!Object.hasOwn(kinds,kind)||!locationId||!/^\d{1,4}$/.test(text)||Number(text)<1||Number(text)>3650)throw new ValidationError('Choose a recorded workflow, an exact warehouse and a lookback from one to 3,650 days.');
 return {kind,locationId,lookbackDays:Number(text)};
}
async function owner(db,ctx){
 const user=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];if(!user)throw new AuthorizationError('Only the inventory owner can prepare and authorize team procedures.');
 return user;
}
async function facts(db,ctx,raw,{exampleIds=null,recordedFrom=null,recordedThrough=null}={}){
 const scope=input(raw);await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,178,'draft');await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[scope.locationId]);
 if(exampleIds!==null&&(!Array.isArray(exampleIds)||!exampleIds.length||exampleIds.length>100||new Set(exampleIds).size!==exampleIds.length))throw new ValidationError('Choose the exact recorded procedure examples.');
 const location=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,scope.locationId])).rows[0];if(!location)throw new ValidationError('Choose an active owned warehouse or stock location.');
 const covered=await require('../operations/postgres-warehouse-access').locations(db,ctx.workspaceId,[scope.locationId]),history=await require('../commercial/agent-history').access(db,ctx.workspaceId),window=(await db.query("SELECT greatest(coalesce($3::timestamptz,now()-make_interval(days=>$1)),coalesce($2::timestamptz,'-infinity'::timestamptz)) AS starts,least(coalesce($4::timestamptz,now()),now()) AS ends",[scope.lookbackDays,history.activityAfter,recordedFrom,recordedThrough])).rows[0],from=window.starts.toISOString(),to=window.ends.toISOString(),args=[ctx.workspaceId,covered.map(l=>l.id),from,to,exampleIds];let examples;
 if(scope.kind==='receiving')examples=(await db.query(`WITH recent AS MATERIALIZED(
  SELECT r.* FROM purchase_order_receipts r WHERE r.workspace_id=$1 AND ($5::text[] IS NULL OR r.id=ANY($5)) AND r.created_at>=$3 AND r.created_at<=$4
   AND EXISTS(SELECT 1 FROM purchase_order_receipt_lines l WHERE l.workspace_id=r.workspace_id AND l.receipt_id=r.id AND l.location_id=ANY($2::text[]))
  ORDER BY r.created_at DESC,r.id DESC LIMIT 1000)
  SELECT r.id,p.po_number AS reference,r.created_at AS recorded_at,r.received_by_user_id AS actor_id,
  r.reference IS NOT NULL AND trim(r.reference)<>'' AS has_reference,r.over_receipt_approved=1 AS over_receipt,
  count(*)::int AS lines,array_agg(DISTINCT i.tracking_mode ORDER BY i.tracking_mode) AS tracking_modes
  FROM recent r JOIN purchase_orders p ON p.workspace_id=r.workspace_id AND p.id=r.purchase_order_id
  JOIN purchase_order_receipt_lines l ON l.workspace_id=r.workspace_id AND l.receipt_id=r.id AND l.location_id=ANY($2::text[])
  JOIN movements m ON m.workspace_id=l.workspace_id AND m.id=(l.movement_ids::jsonb->>0) AND m.sku_id=l.sku_id AND m.location_id=l.location_id AND m.operation='receive' AND m.quantity_delta=l.quantity_units
  JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id AND c.quantity_delta=m.quantity_delta AND c.cost_source_record_id=r.id AND c.cost_source_type='purchase_order_receipt'
  JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
  WHERE r.workspace_id=$1 AND ($5::text[] IS NULL OR r.id=ANY($5)) AND r.created_at>=$3 AND r.created_at<=$4 AND r.created_at::timestamptz>=$3::timestamptz AND r.created_at::timestamptz<=$4::timestamptz
   AND p.approved_at IS NOT NULL AND p.ordered_at IS NOT NULL AND p.ordered_at::timestamptz<=r.created_at::timestamptz
   AND c.cost_delta_minor>=0 AND ((c.cost_delta_minor=0 AND c.journal_entry_id IS NULL) OR (j.status='POSTED' AND j.source_record_id=r.id AND j.metadata::jsonb->>'movementId'=m.id))
   AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries reversal WHERE reversal.workspace_id=j.workspace_id AND reversal.reversal_of_entry_id=j.id AND reversal.status='POSTED')
  GROUP BY r.workspace_id,r.id,r.created_at,r.received_by_user_id,r.reference,r.over_receipt_approved,p.po_number
  HAVING count(*)=(SELECT count(*) FROM purchase_order_receipt_lines all_lines WHERE all_lines.workspace_id=r.workspace_id AND all_lines.receipt_id=r.id AND all_lines.location_id=ANY($2::text[]))
  ORDER BY r.created_at DESC,r.id DESC LIMIT 101`,args)).rows;
 else if(scope.kind==='dispatch')examples=(await db.query(`WITH recent AS MATERIALIZED(
  SELECT sh.* FROM sales_shipments sh WHERE sh.workspace_id=$1 AND ($5::text[] IS NULL OR sh.id=ANY($5)) AND sh.ship_from_location_id=ANY($2::text[]) AND sh.status IN ('SHIPPED','DELIVERED') AND sh.created_at>=$3 AND sh.created_at<=$4
  ORDER BY sh.created_at DESC,sh.id DESC LIMIT 1000)
  SELECT sh.id,sh.shipment_number AS reference,sh.created_at AS recorded_at,sh.created_by_user_id AS actor_id,
  sh.handover,coalesce(sh.tracking_number,'')<>'' AS has_tracking,sh.sales_order_id
  FROM recent sh JOIN sales_orders o ON o.workspace_id=sh.workspace_id AND o.id=sh.sales_order_id
  WHERE sh.workspace_id=$1 AND ($5::text[] IS NULL OR sh.id=ANY($5)) AND sh.ship_from_location_id=ANY($2::text[]) AND sh.status IN ('SHIPPED','DELIVERED') AND sh.created_at>=$3 AND sh.created_at<=$4
   AND sh.created_at::timestamptz>=$3::timestamptz AND sh.created_at::timestamptz<=$4::timestamptz
   AND EXISTS(SELECT 1 FROM stockchief_runtime.business_operations op WHERE op.workspace_id=sh.workspace_id AND op.kind='sales_order.fulfill' AND op.status='COMPLETED'
    AND op.result->>'salesOrderId'=o.id AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(op.result->'shipments','[]'::jsonb)) sent WHERE sent->>'shipmentId'=sh.id)
    AND jsonb_array_length(coalesce(op.result->'lines','[]'::jsonb))>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.result->'lines') line
     WHERE line ? 'kitComponents' OR NOT EXISTS(SELECT 1 FROM movements m JOIN accounting_inventory_cost_movements c ON c.workspace_id=m.workspace_id AND c.inventory_movement_id=m.id
      JOIN accounting_journal_entries j ON j.workspace_id=m.workspace_id AND j.id=line->>'journalEntryId' AND j.status='POSTED'
      WHERE m.workspace_id=op.workspace_id AND m.id=line->>'movementId' AND m.sku_id=line->>'skuId' AND m.quantity_delta=-(line->>'quantity')::numeric
       AND c.quantity_delta=m.quantity_delta AND c.journal_entry_id=j.id AND j.metadata::jsonb->>'movementId'=m.id
       AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries rev WHERE rev.workspace_id=j.workspace_id AND rev.reversal_of_entry_id=j.id AND rev.status='POSTED'))))
  ORDER BY sh.created_at DESC,sh.id DESC LIMIT 101`,args)).rows;
 else examples=(await db.query(`SELECT c.id,c.title AS reference,c.completed_at AS recorded_at,c.approved_by_user_id AS actor_id
  FROM warehouse_count_campaigns c
  WHERE c.workspace_id=$1 AND ($5::text[] IS NULL OR c.id=ANY($5)) AND c.status='COMPLETED' AND c.approved_at IS NOT NULL AND c.completed_at>=$3::timestamptz AND c.completed_at<=$4::timestamptz
   AND EXISTS(SELECT 1 FROM warehouse_count_campaign_lines l WHERE l.workspace_id=c.workspace_id AND l.campaign_id=c.id AND l.location_id=ANY($2::text[]))
   AND NOT EXISTS(SELECT 1 FROM warehouse_count_campaign_lines missing WHERE missing.workspace_id=c.workspace_id AND missing.campaign_id=c.id AND missing.applied_at IS NULL)
  ORDER BY c.completed_at DESC,c.id DESC LIMIT 101`,args)).rows;
 if(!examples.length)throw new ValidationError('No complete verified examples of this workflow were found among the recent recorded work at this location in the permitted history. Record the real workflow first; StockChief will not invent a team procedure.');
 const more=examples.length>100;examples=examples.slice(0,100).map(row=>({...row,recorded_at:new Date(row.recorded_at).toISOString()}));
 const body=write(scope,location,examples),core={version:'recorded-team-procedure-v1',scope,location,examples,document:body},snapshot={...core,historyCutoff:history.activityAfter,recordedFrom:from,recordedThrough:to};
 return {scope,location,examples,more,from,to,...body,document:body,sourceSnapshot:snapshot,sourceFingerprint:hash(core)};
}
function write(scope,location,examples){
 let steps,outcome,notes=[];
 if(scope.kind==='receiving'){
  steps=['Open the placed purchase order in Book in delivery.','Choose the product lines and the actual receiving location within '+location.name+'.','Enter the quantities physically received against those lines.'];
  const modes=new Set(examples.flatMap(e=>e.tracking_modes||[]));if(modes.has('lot'))steps.push('For lot-tracked lines, record the received lot and any known expiry details.');if(modes.has('serial'))steps.push('For serial-tracked lines, record the individual serial numbers received.');
  if(examples.every(e=>e.has_reference))steps.push('Enter the delivery reference used for this receipt.');
  if(examples.some(e=>e.over_receipt))notes.push('An over-receipt approval was recorded in some examples. Extra quantities still require the current receipt approval; this procedure grants no new authority.');
  steps.push('Confirm the physical receipt after checking its actual quantities.');outcome='The verified examples recorded the stock receipt and its inventory cost together. This procedure does not book in goods by itself.';
 }else if(scope.kind==='dispatch'){
  const handovers={CARRIER:'carrier handoff',COLLECTED:'collection',DELIVERED_BY_US:'delivery by your team'},observed=[...new Set(examples.map(e=>handovers[e.handover]).filter(Boolean))];if(!observed.length)throw new ValidationError('The recorded shipment handover is unclear. Review the original dispatch before writing its procedure.');
  steps=['Open the customer order and its current fulfillment details.','Confirm the exact product quantities physically leaving '+location.name+'.','Record the observed handover type: '+observed.join(' or ')+'.'];
  if(examples.some(e=>e.has_tracking))steps.push('For a carrier handoff with supplied tracking, enter the carrier and tracking details.');
  steps.push('Confirm only the goods actually handed over.');outcome='The verified app dispatch recorded stock issue, inventory cost and customer invoice effects together. This procedure creates no shipment, charge or payment.';
  notes.push('These examples cover ordinary native StockChief dispatch, not kit fulfillment or a provider-only shipment notice.');
 }else{
  steps=['Open the physical count worksheet for '+location.name+'.','Record the quantities physically counted. Leave uncounted positions blank.','Have the inventory owner review the complete counts and differences before approving.','Apply the approved worksheet through StockChief and confirm that every batch finishes.'];outcome='The verified worksheets reached Completed only after all positions were counted and applied. Stock or cost changes during a count require a fresh review.';
  notes.push('These examples cover quantity-stock worksheets. Lot, serial and weighed stock need their own specific count workflow.');
 }
 return {title:kinds[scope.kind]+' at '+location.name,steps,outcome,notes};
}
module.exports={facts,input,kinds,write,owner};

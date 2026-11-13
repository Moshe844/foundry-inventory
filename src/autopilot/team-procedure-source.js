'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions'),policy=require('../commercial/agent-plan');
// Job 178: each procedure is written from complete recorded examples of one
// workflow at one warehouse. The steps staff really take come from the
// records around each example (scans, inspections, put-aways, phone counts,
// return dispositions): a step done in at least half the examples becomes a
// step, a rarer one becomes a "sometimes" note, and timed steps follow the
// order staff did them in (the median minutes after the example started).
// The summary is deterministic; no AI model writes it.
const kinds={receiving:'Receive supplier deliveries',picking:'Pick customer orders',dispatch:'Record customer dispatch',counting:'Review and post a physical stock count',returns:'Receive and inspect customer returns'};
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
  SELECT r.id,r.workspace_id,r.purchase_order_id,r.created_at,r.received_by_user_id,r.reference,r.over_receipt_approved
  FROM purchase_order_receipts r WHERE r.workspace_id=$1 AND ($5::text[] IS NULL OR r.id=ANY($5)) AND r.created_at>=$3 AND r.created_at<=$4
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
  SELECT sh.id,sh.workspace_id,sh.sales_order_id,sh.shipment_number,sh.created_at,sh.created_by_user_id,
    sh.handover,sh.tracking_number,sh.ship_from_location_id,sh.status
  FROM sales_shipments sh WHERE sh.workspace_id=$1 AND ($5::text[] IS NULL OR sh.id=ANY($5)) AND sh.ship_from_location_id=ANY($2::text[]) AND sh.status IN ('SHIPPED','DELIVERED') AND sh.created_at>=$3 AND sh.created_at<=$4
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
 else if(scope.kind==='counting')examples=(await db.query(`SELECT c.id,c.title AS reference,c.completed_at AS recorded_at,c.approved_by_user_id AS actor_id
  FROM warehouse_count_campaigns c
  WHERE c.workspace_id=$1 AND ($5::text[] IS NULL OR c.id=ANY($5)) AND c.status='COMPLETED' AND c.approved_at IS NOT NULL AND c.completed_at>=$3::timestamptz AND c.completed_at<=$4::timestamptz
   AND EXISTS(SELECT 1 FROM warehouse_count_campaign_lines l WHERE l.workspace_id=c.workspace_id AND l.campaign_id=c.id AND l.location_id=ANY($2::text[]))
   AND NOT EXISTS(SELECT 1 FROM warehouse_count_campaign_lines missing WHERE missing.workspace_id=c.workspace_id AND missing.campaign_id=c.id AND missing.applied_at IS NULL)
  ORDER BY c.completed_at DESC,c.id DESC LIMIT 101`,args)).rows;
 // Waves at this warehouse whose every line was scanned or reported short.
 else if(scope.kind==='picking')examples=(await db.query(`SELECT w.id,'Wave '||w.wave_number AS reference,w.created_at::timestamptz AS recorded_at,w.created_by_user_id AS actor_id
  FROM fulfillment_waves w WHERE w.workspace_id=$1 AND ($5::text[] IS NULL OR w.id=ANY($5)) AND w.status IN ('PICKING','PACKED','COMPLETED','BLOCKED')
   AND w.created_at::timestamptz>=$3::timestamptz AND w.created_at::timestamptz<=$4::timestamptz
   AND EXISTS(SELECT 1 FROM fulfillment_wave_lines l WHERE l.workspace_id=w.workspace_id AND l.wave_id=w.id AND l.location_id=ANY($2::text[]))
   AND NOT EXISTS(SELECT 1 FROM fulfillment_wave_lines l WHERE l.workspace_id=w.workspace_id AND l.wave_id=w.id AND l.status='OPEN')
   AND EXISTS(SELECT 1 FROM fulfillment_wave_scans x WHERE x.workspace_id=w.workspace_id AND x.wave_id=w.id AND x.status='ACCEPTED')
  ORDER BY w.created_at DESC,w.id DESC LIMIT 101`,args)).rows;
 // Customer returns received into this warehouse and inspected.
 else examples=(await db.query(`SELECT r.id,r.return_number AS reference,r.received_at::timestamptz AS recorded_at,coalesce(r.inspected_by_user_id,r.created_by_user_id) AS actor_id
  FROM customer_returns r WHERE r.workspace_id=$1 AND ($5::text[] IS NULL OR r.id=ANY($5)) AND r.quarantine_location_id=ANY($2::text[])
   AND r.received_at IS NOT NULL AND r.inspected_at IS NOT NULL AND r.status IN ('INSPECTED','AWAITING_REFUND','COMPLETED')
   AND r.received_at::timestamptz>=$3::timestamptz AND r.received_at::timestamptz<=$4::timestamptz
  ORDER BY r.received_at DESC,r.id DESC LIMIT 101`,args)).rows;
 if(!examples.length)throw new ValidationError('No complete verified examples of this workflow were found among the recent recorded work at this location in the permitted history. Record the real workflow first; StockChief will not invent a team procedure.');
 const more=examples.length>100;examples=examples.slice(0,100).map(row=>({...row,recorded_at:new Date(row.recorded_at).toISOString()}));
 const seen=await observe(db,ctx.workspaceId,scope.kind,examples.map(e=>e.id));examples=examples.map(e=>({...e,observed:seen.get(e.id)||{}}));
 const body=write(scope,location,examples),core={version:'recorded-team-procedure-v2',scope,location,examples,document:body},snapshot={...core,historyCutoff:history.activityAfter,recordedFrom:from,recordedThrough:to};
 return {scope,location,examples,more,from,to,...body,document:body,sourceSnapshot:snapshot,sourceFingerprint:hash(core)};
}
const minutes=(later,earlier)=>`round(extract(epoch FROM (${later})-(${earlier}))/60)`;
// What staff recorded around each example, from scans, inspections, put-away
// confirmations, phone counts and return lines: one row per step done, with
// the minutes after the example started when the record carries a time.
const observations={
 receiving:`SELECT r.id AS example,o.step,o.at FROM purchase_order_receipts r CROSS JOIN LATERAL (
   SELECT 'qc' AS step,${minutes('min(h.inspected_at)','r.created_at::timestamptz')} AS at FROM stockchief_runtime.agent_quality_holds h
    JOIN purchase_order_receipt_lines l ON l.workspace_id=h.workspace_id AND l.id=h.receipt_line_id WHERE l.workspace_id=r.workspace_id AND l.receipt_id=r.id AND h.inspected_at IS NOT NULL HAVING count(*)>0
   UNION ALL SELECT 'putaway',${minutes('min(c.created_at)','r.created_at::timestamptz')} FROM stockchief_runtime.agent_putaway_confirmations c
    JOIN stockchief_runtime.agent_putaway_instructions p ON p.workspace_id=c.workspace_id AND p.id=c.instruction_id JOIN purchase_order_receipt_lines l ON l.workspace_id=p.workspace_id AND l.id=p.receipt_line_id
    WHERE l.workspace_id=r.workspace_id AND l.receipt_id=r.id HAVING count(*)>0) o WHERE r.workspace_id=$1 AND r.id=ANY($2::text[])`,
 dispatch:`SELECT sh.id AS example,'wave' AS step,${minutes('min(x.scanned_at::timestamptz)','sh.created_at::timestamptz')} AS at FROM sales_shipments sh
   JOIN fulfillment_wave_lines l ON l.workspace_id=sh.workspace_id AND l.shipment_id=sh.id JOIN fulfillment_wave_scans x ON x.workspace_id=l.workspace_id AND x.line_id=l.id AND x.status='ACCEPTED'
   WHERE sh.workspace_id=$1 AND sh.id=ANY($2::text[]) GROUP BY sh.id`,
 counting:`SELECT c.id AS example,'phone' AS step,${minutes('t.observed_at','c.created_at')} AS at FROM warehouse_count_campaigns c
   JOIN stockchief_runtime.agent_count_tasks t ON t.workspace_id=c.workspace_id AND t.campaign_id=c.id WHERE c.workspace_id=$1 AND c.id=ANY($2::text[]) AND t.observed_at IS NOT NULL`,
 picking:`SELECT w.id AS example,o.step,o.at FROM fulfillment_waves w CROSS JOIN LATERAL (
   SELECT 'bin' AS step,${minutes('min(x.scanned_at::timestamptz)','w.created_at::timestamptz')} AS at FROM fulfillment_wave_scans x WHERE x.workspace_id=w.workspace_id AND x.wave_id=w.id AND x.status='ACCEPTED' AND x.location_barcode IS NOT NULL HAVING count(*)>0
   UNION ALL SELECT 'product',${minutes('min(x.scanned_at::timestamptz)','w.created_at::timestamptz')} FROM fulfillment_wave_scans x WHERE x.workspace_id=w.workspace_id AND x.wave_id=w.id AND x.status='ACCEPTED' AND x.item_barcode IS NOT NULL HAVING count(*)>0
   UNION ALL SELECT 'lot',NULL FROM fulfillment_wave_scans x WHERE x.workspace_id=w.workspace_id AND x.wave_id=w.id AND x.status='ACCEPTED' AND x.lot_id IS NOT NULL HAVING count(*)>0
   UNION ALL SELECT 'serial',NULL FROM fulfillment_wave_scans x WHERE x.workspace_id=w.workspace_id AND x.wave_id=w.id AND x.status='ACCEPTED' AND x.serial_unit_id IS NOT NULL HAVING count(*)>0
   UNION ALL SELECT 'short',NULL WHERE EXISTS(SELECT 1 FROM fulfillment_wave_lines l WHERE l.workspace_id=w.workspace_id AND l.wave_id=w.id AND l.status='SHORT')
   UNION ALL SELECT 'pack',NULL WHERE EXISTS(SELECT 1 FROM fulfillment_wave_shipments s WHERE s.workspace_id=w.workspace_id AND s.wave_id=w.id AND s.status IN ('PACKED','SHIPPED'))
   UNION ALL SELECT 'handoff',NULL WHERE EXISTS(SELECT 1 FROM fulfillment_wave_shipments s WHERE s.workspace_id=w.workspace_id AND s.wave_id=w.id AND s.status='SHIPPED')
  ) o WHERE w.workspace_id=$1 AND w.id=ANY($2::text[])`,
 returns:`SELECT r.id AS example,o.step,o.at FROM customer_returns r CROSS JOIN LATERAL (
   SELECT 'authorize' AS step,${minutes('r.authorized_at::timestamptz','r.created_at::timestamptz')} AS at WHERE r.authorized_at IS NOT NULL
   UNION ALL SELECT 'receive',${minutes('r.received_at::timestamptz','r.created_at::timestamptz')}
   UNION ALL SELECT 'tracked',NULL WHERE EXISTS(SELECT 1 FROM customer_return_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE l.workspace_id=r.workspace_id AND l.customer_return_id=r.id AND i.tracking_mode IN ('lot','serial'))
   UNION ALL SELECT 'condition',NULL WHERE EXISTS(SELECT 1 FROM customer_return_lines l WHERE l.workspace_id=r.workspace_id AND l.customer_return_id=r.id AND nullif(trim(l.condition_note),'') IS NOT NULL)
   UNION ALL SELECT 'inspect',${minutes('r.inspected_at::timestamptz','r.created_at::timestamptz')}
   UNION ALL SELECT 'restock',NULL WHERE EXISTS(SELECT 1 FROM customer_return_lines l WHERE l.workspace_id=r.workspace_id AND l.customer_return_id=r.id AND l.quantity_restocked>0)
   UNION ALL SELECT 'scrap',NULL WHERE EXISTS(SELECT 1 FROM customer_return_lines l WHERE l.workspace_id=r.workspace_id AND l.customer_return_id=r.id AND l.quantity_scrapped>0)
   UNION ALL SELECT 'repair',NULL WHERE EXISTS(SELECT 1 FROM customer_return_lines l WHERE l.workspace_id=r.workspace_id AND l.customer_return_id=r.id AND l.quantity_repair>0)
   UNION ALL SELECT 'money',NULL WHERE r.refund_id IS NOT NULL OR r.exchange_order_id IS NOT NULL
  ) o WHERE r.workspace_id=$1 AND r.id=ANY($2::text[])`
};
async function observe(db,workspaceId,kind,ids){
 const out=new Map();
 for(const row of (await db.query(observations[kind],[workspaceId,ids])).rows){
  if(!out.has(row.example))out.set(row.example,{});
  out.get(row.example)[row.step]=row.at==null?null:Math.max(0,Number(row.at));
 }
 return out;
}
// Each workflow's possible steps in their natural order. "always" steps are
// part of the workflow itself, or apply to products the examples carried;
// the rest are counted across the examples.
function catalogue(kind,location,examples){
 const has=key=>examples.some(e=>e.observed&&Object.hasOwn(e.observed,key));
 if(kind==='receiving'){const modes=new Set(examples.flatMap(e=>e.tracking_modes||[]));return [
  {key:'open',always:true,text:'Open the placed purchase order in Book in delivery.'},
  {key:'lines',always:true,text:'Choose the product lines and the actual receiving location within '+location.name+'.'},
  {key:'quantities',always:true,text:'Enter the quantities physically received against those lines.'},
  ...(modes.has('lot')?[{key:'lot',always:true,text:'For lot-tracked lines, record the received lot and any known expiry details.'}]:[]),
  ...(modes.has('serial')?[{key:'serial',always:true,text:'For serial-tracked lines, record the individual serial numbers received.'}]:[]),
  {key:'reference',text:'Enter the delivery reference used for this receipt.',seen:e=>e.has_reference},
  {key:'confirm',always:true,text:'Confirm the physical receipt after checking its actual quantities.'},
  {key:'qc',text:'Inspect goods held for QC against the checklist and record the result.'},
  {key:'putaway',text:'Put the goods away in the bin on the put-away sheet and confirm each one.'}];}
 if(kind==='dispatch'){
  const handovers={CARRIER:'carrier handoff',COLLECTED:'collection',DELIVERED_BY_US:'delivery by your team'},observed=[...new Set(examples.map(e=>handovers[e.handover]).filter(Boolean))];
  if(!observed.length)throw new ValidationError('The recorded shipment handover is unclear. Review the original dispatch before writing its procedure.');
  return [{key:'open',always:true,text:'Open the customer order and its current fulfillment details.'},
   {key:'wave',text:'Pick the order on its pick wave, scanning each bin and product.'},
   {key:'quantities',always:true,text:'Confirm the exact product quantities physically leaving '+location.name+'.'},
   {key:'handover',always:true,text:'Record the observed handover type: '+observed.join(' or ')+'.'},
   ...(examples.some(e=>e.has_tracking)?[{key:'tracking',always:true,text:'For a carrier handoff with supplied tracking, enter the carrier and tracking details.'}]:[]),
   {key:'confirm',always:true,text:'Confirm only the goods actually handed over.'}];
 }
 if(kind==='counting')return [{key:'open',always:true,text:'Open the physical count worksheet for '+location.name+'.'},
  {key:'phone',text:'Give the count list to the counter, who records each shelf on their phone without seeing the recorded quantities.'},
  {key:'record',always:true,text:'Record the quantities physically counted. Leave uncounted positions blank.'},
  {key:'review',always:true,text:'Have the inventory owner review the complete counts and differences before approving.'},
  {key:'apply',always:true,text:'Apply the approved worksheet through StockChief and confirm that every batch finishes.'}];
 if(kind==='picking')return [{key:'start',always:true,text:'Open the pick wave for '+location.name+' and start it.'},
  {key:'walk',always:true,text:'Follow the pick list in walking order, one zone at a time.'},
  {key:'bin',text:'Scan the bin label before taking anything from it.'},
  {key:'product',text:'Scan the product label for each item you pick.'},
  ...(has('lot')?[{key:'lot',always:true,text:'For batch goods, scan the batch shown on the pick list.'}]:[]),
  ...(has('serial')?[{key:'serial',always:true,text:'For serial goods, scan each serial number.'}]:[]),
  {key:'short',text:'If a bin is short, report the shortage with the quantity you found.'},
  {key:'pack',text:'Pack each order into its own carton.'},
  {key:'handoff',text:'Hand the cartons over and record the dispatch.'}];
 return [{key:'authorize',text:'Check the return against the original order and authorize it.'},
  {key:'receive',always:true,text:'Receive the returned items into '+location.name+' and enter the quantity that arrived.'},
  ...(has('tracked')?[{key:'tracked',always:true,text:'For batch or serial goods, record the batch or serial number of each returned item.'}]:[]),
  {key:'condition',text:'Note the condition of each item.'},
  {key:'inspect',always:true,text:'Inspect each item and record what happens to it.'},
  {key:'restock',text:'Put items that can be sold again back into stock.'},
  {key:'scrap',text:'Scrap items that cannot be sold.'},
  {key:'repair',text:'Send items that need repair for repair.'}];
}
// Steps done in at least half the examples are kept, saying how often when
// not every time; rarer ones become notes. Steps with recorded times follow
// the order staff did them in (median minutes); the rest keep their place.
function summarize(entries,examples){
 const total=examples.length,kept=[],sometimes=[];
 for(const entry of entries){
  const done=examples.filter(e=>entry.always||(entry.seen?entry.seen(e):Object.hasOwn(e.observed||{},entry.key)));
  const times=done.map(e=>e.observed?.[entry.key]).filter(t=>typeof t==='number').sort((a,b)=>a-b);
  const row={...entry,count:done.length,median:times.length?times[Math.floor((times.length-1)/2)]:null};
  if(!row.count)continue;
  if(entry.always||row.count*2>=total)kept.push(row);else sometimes.push(row);
 }
 const slots=kept.map((r,i)=>r.median!=null?i:-1).filter(i=>i>=0);
 const ordered=slots.map(i=>kept[i]).sort((a,b)=>a.median-b.median||kept.indexOf(a)-kept.indexOf(b));
 slots.forEach((slot,i)=>{kept[slot]=ordered[i];});
 const often=r=>r.always||r.count===total?'':' (In '+r.count+' of '+total+' recorded examples.)';
 return {steps:kept.map(r=>r.text+often(r)),notes:sometimes.map(r=>'Sometimes ('+r.count+' of '+total+' recorded examples): '+r.text)};
}
function write(scope,location,examples){
 const {steps,notes}=summarize(catalogue(scope.kind,location,examples),examples);let outcome;
 if(scope.kind==='receiving'){
  if(examples.some(e=>e.over_receipt))notes.push('An over-receipt approval was recorded in some examples. Extra quantities still require the current receipt approval; this procedure grants no new authority.');
  outcome='The verified examples recorded the stock receipt and its inventory cost together. This procedure does not book in goods by itself.';
 }else if(scope.kind==='dispatch'){
  outcome='The verified app dispatch recorded stock issue, inventory cost and customer invoice effects together. This procedure creates no shipment, charge or payment.';
  notes.push('These examples cover ordinary native StockChief dispatch, not kit fulfillment or a provider-only shipment notice.');
 }else if(scope.kind==='counting'){
  outcome='The verified worksheets reached Completed only after all positions were counted and applied. Stock or cost changes during a count require a fresh review.';
  notes.push('These examples cover quantity-stock worksheets. Lot, serial and weighed stock need their own specific count workflow.');
 }else if(scope.kind==='picking'){
  outcome='The verified waves recorded every accepted scan against its pick line. This procedure does not reserve, pick or ship anything by itself.';
 }else{
  outcome='The verified returns recorded what arrived and what happened to each item. This procedure moves no stock or money by itself.';
  if(examples.some(e=>Object.hasOwn(e.observed||{},'money')))notes.push('A person issues any refund or exchange after the inspection. This procedure grants no authority to move money.');
 }
 return {title:kinds[scope.kind]+' at '+location.name,steps,outcome,notes};
}
module.exports={facts,input,kinds,write,summarize,owner};

'use strict';
// Job 208 adapters for stock, warehouse and catalogue jobs. Each one reads its
// job's own approvals and teaches through that job's own rule or example path.
const {T,day,num,largest,maximum,minimum,whole,amount,token,row,hash,money,locationNames,bookCurrency}=require('./common');
const window_=`now()-make_interval(days=>$3)`;

// Job 5: count sheets read into stock differences. Each sheet the owner
// approved for the same locations and the same sheet layout is the same
// routine; the rule names the sheet type, places and the most rows.
const countSheets={kind:'job:5',jobs:[5],label:'Count sheets into stock differences',
 tables:[T('agent_count_sources'),T('agent_count_source_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT s.id,s.format,s.location_ids,s.layout_hash,s.status,coalesce(s.posted_at,s.approved_at,s.created_at) at,
     (SELECT count(*)::int FROM ${T('agent_count_source_rows')} r WHERE r.workspace_id=s.workspace_id AND r.source_id=s.id) row_count
   FROM ${T('agent_count_sources')} s WHERE s.workspace_id=$1 AND s.actor_id=$2 AND s.rule_id IS NULL AND s.status IN ('APPROVED','POSTED')
     AND s.layout_hash IS NOT NULL AND coalesce(s.approved_at,s.created_at)>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   // A photo or PDF reading never posts on its own, so only spreadsheets learn.
   .map(r=>row(r.id,r.format+'|'+[...r.location_ids].sort().join(',')+'|'+r.layout_hash,r.at,{needsPerson:r.format!=='sheet',value:r.row_count,data:r}));
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data,ids=[...d.location_ids].sort();
  if((await db.query(`SELECT 1 FROM ${T('agent_count_source_rules')} WHERE workspace_id=$1 AND enabled AND format=$2 AND location_ids=$3::text[] AND layout_hash=$4`,
    [ctx.workspaceId,d.format,ids,d.layout_hash])).rowCount)return null;
  const example=run.rows.find(r=>r.data.status==='POSTED'),rows=maximum(run.rows,r=>r.value);
  if(!example||!whole(rows))return null;
  const label=('Count sheets for '+(await locationNames(db,ctx.workspaceId,ids))).slice(0,120);
  const input={format:d.format,locationIds:ids,maximumRows:rows,label,exampleId:example.id,confirmed:'yes'};
  return {label,limit:'up to '+rows+' rows a sheet, same layout and places',runMaximum:rows+' rows',href:'/imports/count-sources/'+example.id,token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../imports/physical-count-sources').configure(s,ctx,offer.teach);}
};

// Job 9: slow stock steps. A rule is per kind of step: a move, a return or
// a clearance discount.
const STEP_LABELS={MOVE:'Slow stock: move it to where it sells',RETURN:'Slow stock: send it back to the supplier',DISCOUNT:'Slow stock: clearance discounts'};
const slowStock={kind:'job:9',jobs:[9],label:'Slow stock steps',tables:[T('agent_slow_stock_steps'),T('agent_slow_stock_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT s.id,s.kind,s.status,s.quantity::text quantity,s.details,coalesce(s.decided_at,s.checked_at,s.created_at) at,
     cp.step_days,cp.steps->0->>'points' points,coalesce(t.status,r.status,cp.status) result
   FROM ${T('agent_slow_stock_steps')} s
   LEFT JOIN inventory_transfers t ON t.workspace_id=s.workspace_id AND t.id=s.transfer_id
   LEFT JOIN supplier_returns r ON r.workspace_id=s.workspace_id AND r.id=s.supplier_return_id
   LEFT JOIN ${T('agent_clearance_plans')} cp ON cp.workspace_id=s.workspace_id AND cp.id=s.clearance_plan_id
   WHERE s.workspace_id=$1 AND ((s.status='DONE' AND NOT s.automatic AND s.decided_by=$2) OR (s.status='DISMISSED' AND s.decided_by=$2) OR s.status='UNDONE')
     AND coalesce(s.decided_at,s.checked_at,s.created_at)>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.kind,r.at,{declined:r.status!=='DONE'||r.result==='CANCELLED',
     needsPerson:r.kind==='RETURN'&&num(r.details?.valueMinor)===null,variant:r.kind==='DISCOUNT'?r.points+'|'+r.step_days:null,data:r}));
 },
 async offer(db,ctx,{run}){
  const kind=run.scope;
  if((await db.query(`SELECT 1 FROM ${T('agent_slow_stock_rules')} WHERE workspace_id=$1 AND kind=$2`,[ctx.workspaceId,kind])).rowCount)return null;
  const days=minimum(run.rows,r=>r.data.details?.since);
  if(!whole(days)||days>3650)return null;
  const input={revision:'0',confirmed:'yes',minimumDays:String(days)};let limit='after '+days+' days without a sale';
  if(kind==='MOVE'){
   const units=maximum(run.rows,r=>r.data.quantity);if(!(units>0))return null;
   input.maximumQuantity=String(units);limit+=', up to '+units+' units a move';
  }else if(kind==='RETURN'){
   const book=await bookCurrency(db,ctx.workspaceId);
   if(!book||run.rows.some(r=>r.data.details?.currency!==book))return null;
   const value=maximum(run.rows,r=>r.data.details?.valueMinor);if(!(value>0))return null;
   input.maximum=money.fromMinor(value,book);limit+=', up to '+amount(value,book)+' recorded cost a return';
  }else{
   const d=run.latest.data;if(!d.points||!d.step_days)return null;
   input.markdown=require('../../domain/exact-quantity').fromAtoms(Number(d.points),2);input.stepDays=String(d.step_days);
   limit+=', '+input.markdown+'% off every '+d.step_days+' days (you still approve the prices)';
  }
  return {label:STEP_LABELS[kind],limit,href:'/autopilot/slow-stock',token:token({kind,input}),teach:{kind,input}};
 },
 async teach(s,ctx,offer){await require('../../forecasting/agent-slow-stock-steps').configure(s,ctx,offer.teach.kind,offer.teach.input);}
};

// Job 11: bin corrections. The same product moved between the same two bins.
const binCorrections={kind:'job:11',jobs:[11],label:'Bin corrections',tables:[T('agent_bin_corrections'),T('agent_bin_correction_rules'),T('agent_bin_correction_settings')],
 async history(db,ctx,{days}){
  const bins=require('../../warehouse/agent-bin-corrections');
  return (await db.query(`SELECT id,source,status,coalesce(completed_at,undone_at,created_at) at FROM ${T('agent_bin_corrections')}
   WHERE workspace_id=$1 AND ((status='COMPLETED' AND NOT automatic AND NOT manual_recovery AND approved_by=$2) OR status IN ('CANCELLED','UNDONE'))
     AND created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   // Batch and serial stock always waits for a person in this job.
   .map(r=>row(r.id,hash(bins.scope(r.source)),r.at,{declined:r.status!=='COMPLETED',needsPerson:Boolean(r.source.lot||r.source.serials?.length),value:r.source.quantity,data:r}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_bin_correction_rules')} WHERE workspace_id=$1 AND scope_hash=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  const setting=(await db.query(`SELECT * FROM ${T('agent_bin_correction_settings')} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
  // Without the owner's routine limit a taught scope changes nothing.
  if(!setting?.enabled)return null;
  const most=maximum(run.rows,r=>r.value);if(!whole(most))return null;
  const units=Math.min(most,Number(setting.maximum_units)),p=run.latest.data.source;
  const input={confirmed:'yes',revision:0,maximumUnits:String(units)};
  return {label:'Move '+p.sku+' from '+p.from.name+' to '+p.to.name,limit:'up to '+units+' units a correction',runMaximum:most+' units',
   capped:units<most?'your routine bin correction limit':null,href:'/warehouse/bin-corrections/'+run.latest.id,token:token({id:run.latest.id,input}),teach:{id:run.latest.id,input}};
 },
 async teach(s,ctx,offer){await require('../../warehouse/agent-bin-corrections').teach(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 47: put-away bins. The same product from the same receiving place into
// the same bin; the owner changing the bin, or staff putting it elsewhere, is a "no".
const putaway={kind:'job:47',jobs:[47],label:'Put-away bins',tables:[T('agent_putaway_instructions'),T('agent_putaway_rules'),T('agent_putaway_confirmations')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT i.id,i.source,i.status,i.revision,i.created_at at,
     EXISTS(SELECT 1 FROM ${T('agent_putaway_confirmations')} c WHERE c.workspace_id=i.workspace_id AND c.instruction_id=i.id AND c.location_id<>c.planned_location_id) wrong
   FROM ${T('agent_putaway_instructions')} i WHERE i.workspace_id=$1 AND NOT i.automatic AND i.actor_id=$2 AND i.chosen_by='owner' AND i.status='PUT_AWAY'
     AND i.created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.source.skuId+'|'+r.source.from.id,r.at,{declined:r.revision>1||r.wrong,variant:r.source.to.id,value:r.source.quantity,data:r}));
 },
 async offer(db,ctx,{run}){
  const p=run.latest.data.source;
  if((await db.query(`SELECT 1 FROM ${T('agent_putaway_rules')} WHERE workspace_id=$1 AND sku_id=$2 AND from_location_id=$3`,[ctx.workspaceId,p.skuId,p.from.id])).rowCount)return null;
  const example=largest(run.rows,r=>r.value),units=num(example?.value);
  if(!whole(units))return null;
  const input={revision:0,maximum:String(units)};
  return {label:'Put '+p.sku+' from '+p.from.name+' away in '+p.to.name,limit:'up to '+units+' units a receipt',href:'/warehouse/putaway/'+example.id,
   token:token({id:example.id,input}),teach:{id:example.id,input}};
 },
 async teach(s,ctx,offer){await require('../../warehouse/agent-putaway').teach(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 51: QC holds the owner approved under the same rule and checklist.
const qualityHolds={kind:'job:51',jobs:[51],label:'Delivery QC holds',tables:[T('agent_quality_holds'),T('agent_quality_policies')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT id,policy_id,checklist,status,quantity::text quantity,decided_at at FROM ${T('agent_quality_holds')}
   WHERE workspace_id=$1 AND NOT automatic AND decided_by=$2 AND decided_at IS NOT NULL AND policy_id IS NOT NULL
     AND status IN ('HELD','FAILED','PASSED','NOT_HELD') AND decided_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.policy_id,r.at,{declined:r.status==='NOT_HELD',variant:JSON.stringify(r.checklist),value:r.quantity,data:r}));
 },
 async offer(db,ctx,{run}){
  const p=(await db.query(`SELECT p.*,v.name supplier_name,s.code,l.name location_name FROM ${T('agent_quality_policies')} p
    LEFT JOIN suppliers v ON v.workspace_id=p.workspace_id AND v.id=p.supplier_id LEFT JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id
    LEFT JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.workspaceId,run.scope])).rows[0];
  if(!p?.enabled||p.automatic_enabled||JSON.stringify(p.checklist)!==run.latest.variant)return null;
  const example=run.rows.find(r=>r.data.status==='PASSED'),input={revision:p.revision,confirmed:'yes',...(example?{exampleId:example.id}:{})};
  return {label:'Hold deliveries for QC: '+[p.supplier_name||'Any supplier',p.code||'any product',p.location_name||'any owned location'].join(' · '),
   limit:'up to '+p.max_units+' units a delivery, your saved limit',href:'/operations/quality-holds',token:token({id:p.id,input}),teach:{id:p.id,input}};
 },
 async teach(s,ctx,offer){await require('../../operations/agent-quality-holds').configure(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 57: pick waves a person started at the same warehouse.
const pickWaves={kind:'job:57',jobs:[57],label:'Pick waves',tables:[T('agent_pick_waves'),T('agent_pick_wave_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT w.id,w.location_id,w.status,coalesce(w.undone_at,w.started_at,w.created_at) at,w.plan->>'location' place,
     jsonb_array_length(coalesce(w.plan->'orders','[]'::jsonb)) orders
   FROM ${T('agent_pick_waves')} w WHERE w.workspace_id=$1 AND ((w.status='STARTED' AND w.started_kind='INDIVIDUAL' AND w.started_by=$2) OR w.status='UNDONE')
     AND w.created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.location_id,r.at,{declined:r.status==='UNDONE',value:r.orders,data:r}));
 },
 async offer(db,ctx,{run}){
  const waves=require('../../warehouse/agent-pick-waves'),rule=await waves.read(db,ctx.workspaceId,run.scope);
  if(rule?.enabled&&rule.automatic)return null;
  const size=rule?.enabled?Number(rule.wave_orders):Math.min(Math.max(Number(run.latest.value)||1,1),200);
  return {label:'Start pick waves at '+run.latest.data.place,limit:size+' orders a wave',runMaximum:maximum(run.rows,r=>r.value)+' orders',
   href:'/warehouse/waves/'+run.latest.id,token:token({id:run.latest.id,size}),teach:{id:run.latest.id}};
 },
 async teach(s,ctx,offer){await require('../../warehouse/agent-pick-waves').teach(s,ctx,offer.teach.id);}
};

// Job 118: balancing transfer requests on the same product and route.
const transfers={kind:'job:118',jobs:[118],label:'Balancing transfers',tables:[T('agent_transfer_balance_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT p.id,p.status,p.payload,p.created_at at,t.status transfer_status,
     t.decision_detail::jsonb->>'sourceFingerprint' AS transfer_fingerprint
   FROM ${T('assistant_action_proposals')} p LEFT JOIN inventory_transfers t ON t.workspace_id=p.workspace_id AND t.id=p.result->>'transferId'
   WHERE p.workspace_id=$1 AND p.action_type='transfer.prepare_balance' AND p.actor_user_id=$2 AND p.payload->>'scope' IS NOT NULL
     AND ((p.status='EXECUTED' AND p.result->>'automatic'='false') OR p.status='CANCELLED') AND p.created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.payload.scope,r.at,{declined:r.status==='CANCELLED'||r.transfer_status==='CANCELLED',value:r.payload.quantity,
     needsPerson:r.status==='EXECUTED'&&r.transfer_fingerprint!==r.payload.sourceFingerprint,data:r}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_transfer_balance_rules')} WHERE workspace_id=$1 AND scope_key=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  // The rule may not go past the example it is taught from, so the example
  // is the largest request in the run.
  const example=largest(run.rows,r=>r.value);if(!example)return null;
  const p=example.data.payload;
  const input={sku:p.skuId,fromLocation:p.sourceId,toLocation:p.destinationId,maximumBalanceQuantity:String(p.quantity),exampleId:example.id,revision:0,confirmed:'yes'};
  return {label:'Balance '+(p.balanceSummary?.title||'stock between locations'),limit:'up to '+p.quantity+' stocking units a request',href:'/actions/'+example.id,token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../transfers/agent-transfer-balancing').configure(s,ctx,offer.teach);}
};

// Job 120: reorder points per location the owner approved one by one.
const locationReorder={kind:'job:120',jobs:[120],label:'Reorder points per location',tables:[T('location_reorder_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT p.id,p.sku_id,p.evidence::jsonb ev,p.headline,p.decided_at::timestamptz at FROM planning_recommendations p
   WHERE p.workspace_id=$1 AND p.status='APPLIED' AND p.decided_by_user_id=$2 AND p.resulting_detail::jsonb->>'kind'='location_reorder_manual'
     AND p.decided_at::timestamptz>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .filter(r=>r.ev?.locationId).map(r=>row(r.id,r.sku_id+'|'+r.ev.locationId,r.at,{variant:r.ev.profileKey,value:r.ev.maximum,data:r}));
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data;
  if((await db.query(`SELECT 1 FROM ${T('location_reorder_rules')} WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3`,[ctx.workspaceId,d.sku_id,d.ev.locationId])).rowCount)return null;
  const example=largest(run.rows,r=>r.value);if(!example)return null;
  const input={skuId:d.sku_id,locationId:d.ev.locationId,revision:0,ceiling:String(example.data.ev.maximum),exampleId:example.id,confirmed:'yes'};
  return {label:'Reorder points for '+(d.headline||d.ev.code),limit:'targets up to '+example.data.ev.maximum,href:'/planning/location-reorder?skuId='+encodeURIComponent(d.sku_id)+'&locationId='+encodeURIComponent(d.ev.locationId),
   token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../forecasting/location-reorder-rules').configure(s,ctx,offer.teach);}
};

// Job 126: catalogue fixes of one kind. The daily limit is the most fixes of
// that kind the owner approved in one day of the run.
const FIX_LABELS={MERGE:'Duplicate products',SKU:'SKUs',COST:'Purchase costs',WEIGHT:'Weights'};
const catalogFixes={kind:'job:126',jobs:[126],label:'Catalogue fixes',tables:[T('agent_catalog_fixes'),T('agent_catalog_fix_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT id,kind,status,details->'after' IS NULL AS typed,decided_at at FROM ${T('agent_catalog_fixes')}
   WHERE workspace_id=$1 AND decided_by=$2 AND decided_at IS NOT NULL AND ((status='DONE' AND NOT automatic) OR status IN ('DISMISSED','UNDONE'))
     AND decided_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   // A value the owner typed themselves is never made on its own.
   .map(r=>row(r.id,r.kind,r.at,{declined:r.status!=='DONE',needsPerson:r.kind!=='MERGE'&&r.typed,data:r}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_catalog_fix_rules')} WHERE workspace_id=$1 AND kind=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  const perDay={};for(const r of run.rows)perDay[day(r.at)]=(perDay[day(r.at)]||0)+1;
  const limit=Math.min(1000,Math.max(...Object.values(perDay)));
  const input={revision:'0',confirmed:'yes',dailyLimit:String(limit)};
  return {label:'Catalogue fixes: '+FIX_LABELS[run.scope],limit:'up to '+limit+' a day',href:'/catalog/fixes',token:token({kind:run.scope,input}),teach:{kind:run.scope,input}};
 },
 async teach(s,ctx,offer){await require('../../catalog/agent-catalog-fixes').configure(s,ctx,offer.teach.kind,offer.teach.input);}
};

// Job 132, from checked supplier notices: the same supplier's notices.
const retirementNotices={kind:'job:132:supplier',jobs:[132],label:'Discontinued products from supplier notices',
 tables:[T('agent_product_retirement_notices'),T('agent_product_retirement_settings'),T('agent_product_retirements')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT n.id,n.supplier_id,n.applied_at at,jsonb_array_length(coalesce(n.source_snapshot->'pairs','[]'::jsonb)) pairs,
     EXISTS(SELECT 1 FROM ${T('agent_product_retirements')} r WHERE r.workspace_id=n.workspace_id AND r.notice_id=n.id AND r.status='UNDONE') undone
   FROM ${T('agent_product_retirement_notices')} n WHERE n.workspace_id=$1 AND n.applied_at IS NOT NULL AND NOT n.automatic AND n.applied_by=$2
     AND coalesce((n.result->>'changedCount')::int,0)>0 AND n.applied_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,r.supplier_id,r.at,{declined:r.undone,value:r.pairs,data:r}));
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_product_retirement_settings')} WHERE workspace_id=$1 AND supplier_id=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  const supplier=(await db.query("SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,run.scope])).rows[0];
  const most=maximum(run.rows,r=>r.value);
  if(!supplier||!whole(most)||most>100)return null;
  const input={revision:0,confirmed:'yes',maximumProducts:String(most),supplierFingerprint:hash(supplier),exampleId:run.latest.id};
  return {label:'Retire products '+supplier.name+' discontinues',limit:'up to '+most+' products a checked notice',href:'/catalog/discontinued',token:token({id:supplier.id,input}),teach:{id:supplier.id,input}};
 },
 async teach(s,ctx,offer){await require('../../catalog/agent-product-retirements').configure(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 132, dead stock: retirements the owner approved under the saved rule.
// Drafts exist only once the rule is saved, so teaching re-saves it unchanged
// with an approved retirement as its example.
const deadStock={kind:'job:132:dead-stock',jobs:[132],label:'Retire dead stock',tables:[T('agent_product_retirements'),T('agent_product_retirement_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT id,status,coalesce(decided_at,created_at) at FROM ${T('agent_product_retirements')}
   WHERE workspace_id=$1 AND source='DEAD_STOCK' AND ((status IN ('SELLING_DOWN','RETIRED') AND NOT automatic AND decided_by=$2) OR (status='DISMISSED' AND decided_by=$2) OR status='UNDONE')
     AND coalesce(decided_at,created_at)>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,'dead-stock',r.at,{declined:!['SELLING_DOWN','RETIRED'].includes(r.status),data:r}));
 },
 async offer(db,ctx,{run}){
  const work=require('../../catalog/agent-retirement-work'),rule=await work.loadRule(db,ctx.workspaceId);
  if(!rule?.enabled)return null;
  if(rule.example_id&&(await db.query(`SELECT 1 FROM ${T('agent_product_retirements')} WHERE workspace_id=$1 AND id=$2 AND NOT automatic AND decided_by=$3 AND status IN ('SELLING_DOWN','RETIRED')`,
    [ctx.workspaceId,rule.example_id,rule.authorized_by])).rowCount)return null;
  const input={revision:String(rule.revision),confirmed:'yes',deadDays:String(rule.dead_days),dailyLimit:String(rule.daily_limit),
   markdown:rule.markdown_points?require('../../domain/exact-quantity').fromAtoms(Number(rule.markdown_points),2):'',stepDays:rule.step_days?String(rule.step_days):'',exampleId:run.latest.id};
  return {label:'Retire dead stock on its own',limit:'up to '+rule.daily_limit+' products a day after '+rule.dead_days+' days without a sale, your saved rule',
   href:'/catalog/discontinued',token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../catalog/agent-retirement-work').configure(s,ctx,offer.teach);}
};

module.exports=[countSheets,slowStock,binCorrections,putaway,qualityHolds,pickWaves,transfers,locationReorder,catalogFixes,retirementNotices,deadStock];

'use strict';
// Job 208 adapters for purchasing and supplier jobs. Each one reads its job's
// own approvals and teaches through that job's own rule or example path.
const {T,day,num,largest,maximum,whole,amount,token,row,hash,money}=require('./common');
const window_=`now()-make_interval(days=>$3)`;
const PLACED=['APPROVED','ORDERED','PLACED','PARTIALLY_RECEIVED','RECEIVED'];
const daysBetween=(a,b)=>Math.round((Date.parse(String(a).slice(0,10)+'T00:00:00Z')-Date.parse(String(b).slice(0,10)+'T00:00:00Z'))/86400000);

// Job 29: supplier ship dates the owner recorded from confirmations asked
// through the same mailbox. A request the owner declined to send is a "no".
const shipPromises={kind:'job:29',jobs:[29],label:'Supplier ship-date confirmations',
 tables:[T('agent_supplier_ship_promises'),T('agent_supplier_confirmation_rules')],
 async history(db,ctx,{days}){
  const kept=(await db.query(`SELECT p.source_id id,p.supplier_id,p.training_connector_id connector,p.training_mailbox_account mailbox,p.ship_date::text ship_date,
     p.reported_at,p.accepted_at at,s.name supplier,s.follow_up_days
   FROM ${T('agent_supplier_ship_promises')} p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
   WHERE p.workspace_id=$1 AND NOT p.automatic AND p.actor_id=$2 AND p.training_connector_id IS NOT NULL AND p.accepted_at>=${window_}`,
  [ctx.workspaceId,ctx.actorId,days])).rows.map(r=>row(r.id,r.supplier_id+'|'+r.connector,r.at,{variant:r.mailbox,value:Math.max(0,daysBetween(r.ship_date,day(r.reported_at))),data:r}));
  const declined=(await db.query(`SELECT id,payload->>'recipientId' supplier_id,payload->>'connectorId' connector,coalesce(cancelled_at,created_at) at
   FROM ${T('assistant_action_proposals')} WHERE workspace_id=$1 AND action_type='communication.send_email' AND status='CANCELLED'
     AND payload->>'recipientKind'='supplier' AND payload->>'followUpPhase'='supplier_confirmation_due'
     AND created_at>=now()-make_interval(days=>$2)`,[ctx.workspaceId,days])).rows.map(r=>row(r.id,r.supplier_id+'|'+r.connector,r.at,{declined:true}));
  return kept.concat(declined);
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data;
  if((await db.query(`SELECT 1 FROM ${T('agent_supplier_confirmation_rules')} WHERE workspace_id=$1 AND supplier_id=$2`,[ctx.workspaceId,d.supplier_id])).rowCount)return null;
  const delivery=await require('../../purchasing/agent-supplier-delivery-chases').contact(db,ctx.workspaceId,d.supplier_id,d.connector);
  if(!delivery?.ready)return null;
  const shipDays=maximum(run.rows,r=>r.value),interval=Math.min(720,Math.max(24,Number(d.follow_up_days||2)*24));
  if(shipDays===null||shipDays>365)return null;
  // One request per order, sent after the supplier's own follow-up days, as
  // the owner did each time by hand.
  const input={supplierId:d.supplier_id,confirmed:'yes',maximumMessages:'1',intervalHours:String(interval),maximumShipDays:String(shipDays),
   connectorId:d.connector,expectedRecipient:delivery.supplier.email,exampleId:run.latest.id};
  return {label:'Ask '+d.supplier+' to confirm each order and save the ship date',limit:'one request an order, ship dates up to '+shipDays+' days after the reply',
   href:'/purchasing/supplier-confirmations',token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-supplier-ship-promises').configure(s,ctx,offer.teach);}
};

// Job 31: supplier date changes the owner approved for the same supplier,
// warehouse and products. Price or quantity amendments and past dates always
// need a person, so they never count.
function dateCaps(p,processed){
  if(!p.proposedDate)return {shift:0,total:0,future:0,first:false};
  const original=p.originalDate||p.currentDate;
  return {shift:p.currentDate?Math.abs(daysBetween(p.proposedDate,p.currentDate)):0,total:original?Math.abs(daysBetween(p.proposedDate,original)):0,
   future:Math.max(0,daysBetween(p.proposedDate,processed)),first:!p.currentDate};
}
const deliveryDates={kind:'job:31',jobs:[31],label:'Supplier delivery date changes',tables:[T('agent_po_date_sources'),T('agent_po_date_rules'),T('agent_po_date_settings')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT source_id id,source_snapshot snap,processed_at at FROM ${T('agent_po_date_sources')}
   WHERE workspace_id=$1 AND processed_at IS NOT NULL AND NOT automatic AND processed_by=$2 AND processed_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .filter(r=>r.snap?.scope).map(r=>{const p=r.snap,processed=day(r.at);
    return row(r.id,hash(p.scope),r.at,{needsPerson:Boolean(p.amendments?.length)||Boolean(p.proposedDate&&p.proposedDate<processed),value:dateCaps(p,processed),data:r});});
 },
 async offer(db,ctx,{run}){
  const p=run.latest.data.snap;
  if((await db.query(`SELECT 1 FROM ${T('agent_po_date_rules')} WHERE workspace_id=$1 AND scope_hash=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  const settings=(await db.query(`SELECT * FROM ${T('agent_po_date_settings')} WHERE workspace_id=$1 AND supplier_id=$2`,[ctx.workspaceId,p.supplierId])).rows;
  const own=settings.find(x=>x.scope_hash===run.scope);
  // Another saved scope for the same supplier, warehouse and products would overlap.
  if(settings.some(x=>x.enabled&&x.scope_hash!==run.scope&&x.scope.destinationLocationId===p.scope.destinationLocationId&&x.scope.currency===p.scope.currency&&
    x.scope.products.some(a=>p.scope.products.some(b=>a.skuId===b.skuId))))return null;
  if(own&&!own.enabled)return null;
  let shift=maximum(run.rows,r=>r.value.shift),total=maximum(run.rows,r=>r.value.total),future=maximum(run.rows,r=>r.value.future),first=run.rows.some(r=>r.value.first);
  let capped=null;
  if(own){const l=own.limits;const before=[shift,total,future];shift=Math.min(shift,l.maximumShiftDays);total=Math.min(total,l.maximumTotalShiftDays);
   future=Math.min(future,l.maximumFutureDays);first=first&&Boolean(l.allowFirstDate);if(before.join()!==[shift,total,future].join())capped='your saved date limits';}
  if([shift,total,future].some(n=>n>365))return null;
  const caps={maximumShiftDays:String(shift),maximumTotalShiftDays:String(total),maximumFutureDays:String(future),...(first?{allowFirstDate:'yes'}:{})};
  const input={id:run.latest.id,configure:!own,caps};
  return {label:'Delivery dates from '+(p.supplierName||'this supplier')+' to '+(p.destinationName||'your warehouse'),
   limit:'dates that move up to '+shift+' days, at most '+total+' days from the first promise and up to '+future+' days ahead'+(first?', including a first date':''),
   capped,href:'/purchasing/po-delivery-dates/'+run.latest.id,token:token(input),teach:input};
 },
 async teach(s,ctx,offer){
  const dates=require('../../purchasing/agent-po-delivery-dates'),{id,caps}=offer.teach;
  if(offer.teach.configure)await dates.configure(s,ctx,id,{...caps,confirmed:'yes',revision:'0'});
  await dates.teach(s,ctx,id,{...caps,confirmed:'yes',revision:'0'});
 }
};

// Job 38: container orders the owner approved under the same saved rule.
const containerOrders={kind:'job:38',jobs:[38],label:'Container orders',tables:[T('agent_container_orders'),T('agent_container_order_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT o.id,o.rule_id,o.status,o.plan,o.created_at at,p.status po_status,p.approved_by_user_id
   FROM ${T('agent_container_orders')} o LEFT JOIN purchase_orders p ON p.workspace_id=o.workspace_id AND p.id=o.purchase_order_id
   WHERE o.workspace_id=$1 AND o.created_at>=${window_} AND (o.status='UNDONE' OR p.status='CANCELLED'
     OR (o.status='DRAFTED' AND p.status=ANY($4::text[]) AND p.approved_by_user_id=$2))`,[ctx.workspaceId,ctx.actorId,days,PLACED.filter(s=>s!=='PLACED')])).rows
   .map(r=>row(r.id,r.rule_id,r.at,{declined:r.status==='UNDONE'||r.po_status==='CANCELLED',variant:r.plan?.termsHash||null,value:r.plan?.valueMinor,data:r}));
 },
 async offer(db,ctx,{run}){
  const orders=require('../../purchasing/agent-container-orders');
  const r=(await db.query(`SELECT r.*,s.name supplier,l.name place FROM ${T('agent_container_order_rules')} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.destination_id WHERE r.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,run.scope])).rows[0];
  if(!r?.enabled||run.latest.variant!==hash(orders.terms(r)))return null;
  if(r.taught_order_id&&r.training_signature===hash(orders.terms(r)))return null;
  return {label:r.container+' ft containers from '+r.supplier+' to '+r.place,limit:'up to '+amount(r.maximum_minor,r.currency)+' an order, your saved limit',
   runMaximum:amount(maximum(run.rows,x=>x.value)||0,r.currency),href:'/purchasing/container-orders',token:token({id:run.latest.id,rule:r.id}),teach:{id:run.latest.id}};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-container-orders').teach(s,ctx,offer.teach.id,{confirmed:'yes'});}
};

// Job 42: contract releases whose purchase orders the owner approved.
const blanketReleases={kind:'job:42',jobs:[42],label:'Supplier contract releases',tables:[T('agent_blanket_releases'),T('agent_blanket_contracts')],
 async history(db,ctx,{days}){
  const approved=(await db.query(`SELECT r.id,r.contract_id,r.lines,coalesce(r.prepared_at,r.created_at) at,p.status po_status
   FROM ${T('agent_blanket_releases')} r JOIN purchase_orders p ON p.workspace_id=r.workspace_id AND p.id=r.purchase_order_id
   WHERE r.workspace_id=$1 AND coalesce(r.prepared_at,r.created_at)>=${window_} AND ((r.status='DRAFTED' AND r.sent_at IS NULL AND p.status=ANY($4::text[])
     AND p.approved_by_user_id=$2) OR p.status='CANCELLED')`,[ctx.workspaceId,ctx.actorId,days,PLACED])).rows
   .map(r=>row(r.id+(r.po_status==='CANCELLED'?':cancelled':''),r.contract_id,r.at,{declined:r.po_status==='CANCELLED',
     value:(r.lines||[]).reduce((n,l)=>n+Number(l.quantityUnits||0),0),data:{...r,releaseId:r.id}}));
  // Undoing or skipping a release is the owner's "no", kept in the audit trail.
  const declined=(await db.query(`SELECT e.id,e.created_at at,coalesce(e.after_state->>'contractId',r.contract_id) contract_id FROM security_event_history e
    LEFT JOIN ${T('agent_blanket_releases')} r ON r.workspace_id=e.workspace_id AND r.id=e.reference
   WHERE e.workspace_id=$1 AND e.actor_id=$2 AND e.action IN ('Supplier contract release undone before sending','Unprepared contract release skipped by owner')
     AND e.created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows.filter(r=>r.contract_id).map(r=>row(r.id,r.contract_id,r.at,{declined:true}));
  return approved.concat(declined);
 },
 async offer(db,ctx,{run}){
  const p=(await db.query(`SELECT c.*,s.name supplier FROM ${T('agent_blanket_contracts')} c JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id
    WHERE c.workspace_id=$1 AND c.id=$2`,[ctx.workspaceId,run.scope])).rows[0];
  if(!p?.enabled||p.stopped||p.trained_release_id)return null;
  // The example covers future releases up to its own quantities, so it is the largest one.
  const example=largest(run.rows,r=>r.value);
  return {label:'Contract '+p.reference+' with '+p.supplier,limit:'releases up to the quantities of your largest approved release, at the contract prices',
   href:'/purchasing/supplier-contracts/'+p.id,token:token({id:example.data.releaseId,contract:p.id}),teach:{id:example.data.releaseId}};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-blanket-releases').teach(s,ctx,offer.teach.id,{confirmed:'yes'});}
};

// Job 45: supplier damage and shortage claims the owner reviewed and sent.
const supplierClaims={kind:'job:45',jobs:[45],label:'Supplier claims',tables:[T('agent_supplier_claims'),T('agent_supplier_claim_rules')],
 async history(db,ctx,{days}){
  const source=require('../../purchasing/supplier-claim-source');
  return (await db.query(`SELECT c.id,c.snapshot,c.reviewed_at at FROM ${T('agent_supplier_claims')} c
   JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL
   WHERE c.workspace_id=$1 AND NOT c.automatic AND c.reviewed_by=$2 AND c.reviewed_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .map(r=>row(r.id,hash(source.profile(r.snapshot)),r.at,{value:r.snapshot.totalMinor,data:r}));
 },
 async offer(db,ctx,{run}){
  const source=require('../../purchasing/supplier-claim-source'),p=run.latest.data.snapshot;
  if(!p.remedy||(await db.query(`SELECT 1 FROM ${T('agent_supplier_claim_rules')} WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3 AND location_id=$4 AND enabled`,
    [ctx.workspaceId,p.supplierId,p.skuId,p.locationId])).rowCount)return null;
  // The rule may not go past its example, so the example is the largest claim.
  const example=largest(run.rows,r=>r.value),e=example.data.snapshot,age=maximum(run.rows,r=>r.data.snapshot.ageDays);
  if(!(age>=1&&age<=365))return null;
  const value=money.fromMinor(Number(e.totalMinor),e.currency);
  const input={confirmed:'yes',exampleId:example.id,maxUnits:String(source.units(e)),...(e.missingWeight!=null?{maxWeight:String(e.missingWeight)}:{}),
   maxValue:value,maxWeekly:value,maxAgeDays:String(Math.ceil(age)),...(e.photos?.length?{includePhotos:'yes'}:{})};
  return {label:'Claims to '+p.supplierName+' for '+p.sku+' at '+p.location,
   limit:'up to '+source.units(e)+' units and '+amount(e.totalMinor,e.currency)+' a claim and a week, deliveries up to '+Math.ceil(age)+' days old',
   href:'/purchasing/supplier-claims/'+example.id,token:token(input),teach:input};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-supplier-claims').configure(s,ctx,offer.teach.exampleId,offer.teach);}
};

// Job 93: quote requests a saved quote rule prepared and the owner sent to
// every supplier. Closing one unsent is a "no".
const quoteRequests={kind:'job:93',jobs:[93],label:'Supplier quote requests',tables:[T('agent_rfq_requests'),T('agent_rfq_deliveries'),T('agent_rfq_competition_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT r.id,r.competition_rule_id,coalesce(r.reviewed_at,r.closed_at,r.created_at) at,r.reviewed_at IS NULL declined,
     jsonb_array_length(coalesce(r.snapshot->'suppliers','[]'::jsonb)) suppliers,
     (SELECT count(*)::int FROM ${T('agent_rfq_deliveries')} d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id
       WHERE d.workspace_id=r.workspace_id AND d.request_id=r.id AND NOT d.automatic AND d.approved_by=$2 AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL) sent
   FROM ${T('agent_rfq_requests')} r WHERE r.workspace_id=$1 AND r.competition_rule_id IS NOT NULL AND r.created_at>=${window_}
     AND ((r.reviewed_by=$2 AND r.reviewed_at IS NOT NULL) OR (r.reviewed_at IS NULL AND r.closed_at IS NOT NULL))`,[ctx.workspaceId,ctx.actorId,days])).rows
   // A request still waiting for its mailbox confirmations is not counted yet.
   .filter(r=>r.declined||r.sent===r.suppliers).map(r=>row(r.id,r.competition_rule_id,r.at,{declined:r.declined,data:r}));
 },
 async offer(db,ctx,{run}){
  const rule=(await db.query(`SELECT * FROM ${T('agent_rfq_competition_rules')} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,run.scope])).rows[0];
  if(!rule?.enabled||rule.example_request_id||rule.authorized_by!==ctx.actorId)return null;
  const input={revision:rule.revision,confirmed:'yes',requestId:run.latest.id};
  return {label:'Quote requests: '+rule.name,limit:'up to '+rule.max_requests_per_week+' requests a week, your saved rule',href:'/purchasing/quote-rules',token:token({rule:rule.id,input}),teach:{rule:rule.id,input}};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-rfq-competition').teach(s,ctx,offer.teach.rule,offer.teach.input);}
};

// Job 95: switches to the backup supplier the owner made under the same rule.
const backupSuppliers={kind:'job:95',jobs:[95],label:'Backup supplier switches',tables:[T('agent_backup_supplier_runs'),T('agent_backup_supplier_rules')],
 async history(db,ctx,{days}){
  return (await db.query(`SELECT id,rule_id,facts,completed_at at FROM ${T('agent_backup_supplier_runs')}
   WHERE workspace_id=$1 AND mode='human' AND actor_id=$2 AND completed_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows
   .filter(r=>r.rule_id&&r.facts?.terms).map(r=>row(r.id,r.rule_id+'|'+(r.facts.trigger?.kind||''),r.at,{variant:r.facts.terms.offerHash,value:r.facts.terms.amount,data:r}));
 },
 async offer(db,ctx,{run}){
  const rule=(await db.query(`SELECT * FROM ${T('agent_backup_supplier_rules')} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,run.latest.data.rule_id])).rows[0];
  if(!rule?.enabled||rule.taught_run_id)return null;
  const fits=r=>{const t=r.data.facts.terms;return t.offerHash===rule.backup_offer_hash&&t.confirmationDays===rule.confirmation_days&&t.primarySupplierId===rule.primary_supplier_id&&
   t.backupSupplierId===rule.backup_supplier_id&&t.skuId===rule.sku_id&&t.locationId===rule.location_id;};
  // Later switches must stay at or under the example's amount, so it is the largest.
  const example=largest(run.rows.filter(fits),r=>r.value);if(!example)return null;
  const t=example.data.facts.terms,input={confirmed:'yes',revision:rule.revision,runId:example.id};
  return {label:'Switch '+(t.sku||'this product')+' to '+(t.backupName||'the backup supplier'),
   limit:'orders up to '+(t.currency?amount(t.amount,t.currency):t.amount)+', inside your saved maximum',href:'/purchasing/backup-suppliers',token:token({rule:rule.id,input}),teach:{rule:rule.id,input}};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-backup-suppliers').teach(s,ctx,offer.teach.rule,offer.teach.input);}
};

// Job 96: supplier detail updates from emails the owner approved, for the
// same supplier, mailbox, products and fields. Undoing one is a "no"; an
// order address change, prices, terms or anything unclear always need a person.
const LEAD=['lead_time_days','default_lead_time_days'];
const supplierTerms={kind:'job:96',jobs:[96],label:'Supplier details from emails',tables:[T('agent_supplier_term_sources'),T('agent_supplier_term_rules')],
 async history(db,ctx,{days}){
  const terms=require('../../purchasing/agent-supplier-email-terms'),source=require('../../purchasing/supplier-email-terms-source');
  return (await db.query(`SELECT message_id id,source_snapshot snap,undone_at,coalesce(undone_at,processed_at) at FROM ${T('agent_supplier_term_sources')}
   WHERE workspace_id=$1 AND processed_at IS NOT NULL AND NOT automatic AND processed_by=$2 AND source_snapshot IS NOT NULL AND processed_at>=${window_}`,
  [ctx.workspaceId,ctx.actorId,days])).rows.map(r=>{
   const changes=(r.snap.changes||[]).filter(c=>!source.personOnly.has(c.field));
   const address=(r.snap.changes||[]).some(c=>source.personOnly.has(c.field)&&c.before!==c.value);
   return row(r.id,changes.length?hash(terms.scope({...r.snap,changes})):'none:'+r.id,r.at,{declined:Boolean(r.undone_at),
    needsPerson:!changes.length||address||Boolean(r.snap.other?.length)||Boolean(r.snap.unclear?.length),data:{...r,changes}});
  });
 },
 async offer(db,ctx,{run}){
  if((await db.query(`SELECT 1 FROM ${T('agent_supplier_term_rules')} WHERE workspace_id=$1 AND scope_hash=$2`,[ctx.workspaceId,run.scope])).rowCount)return null;
  const changes=run.rows.flatMap(r=>r.data.changes),of=fields=>changes.filter(c=>fields.includes(c.field));
  const delta=c=>c.before===null||c.before===undefined?0:Math.abs(Number(c.value)-Number(c.before));
  const top=(list,f)=>list.reduce((m,c)=>Math.max(m,f(c)),0);
  const lead=of(LEAD),moq=of(['minimum_order_quantity']),pack=of(['units_per_purchase_unit']);
  const input={revision:0,confirmed:'yes',maximumLeadDays:String(top(lead,c=>Number(c.value))),maximumLeadChangeDays:String(top(lead,delta)),
   maximumMoq:String(top(moq,c=>Number(c.value))),maximumMoqChange:String(top(moq,delta)),...(pack.length?{maximumPackChange:String(top(pack,delta))}:{}),
   ...(changes.some(c=>require('../../purchasing/supplier-email-terms-source').numeric.has(c.field)&&(c.before===null||c.before===undefined))?{allowUnset:'yes'}:{})};
  if(Object.values(input).some(v=>typeof v==='string'&&v!=='yes'&&!Number.isFinite(Number(v))))return null;
  const snap=run.latest.data.snap;
  return {label:'Supplier details from '+(snap.supplierName||'this supplier')+' emails',
   limit:'lead times up to '+input.maximumLeadDays+' days (changes up to '+input.maximumLeadChangeDays+'), minimum orders up to '+input.maximumMoq+' (changes up to '+input.maximumMoqChange+')'+
    (input.maximumPackChange?', pack size changes up to '+input.maximumPackChange:''),href:'/purchasing/supplier-emails/'+run.latest.id,token:token({id:run.latest.id,input}),teach:{id:run.latest.id,input}};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-supplier-email-terms').teach(s,ctx,offer.teach.id,offer.teach.input);}
};

// Job 115: faulty-goods returns the owner prepared for the same supplier,
// location and currency. Cancelling one is a "no". It learns only once one of
// them has its full supplier credit posted, as the job's own rule requires.
const supplierReturns={kind:'job:115',jobs:[115],label:'Faulty goods back to the supplier',tables:[T('agent_supplier_return_cases'),T('agent_supplier_return_rules')],
 async history(db,ctx,{days}){
  const rows=(await db.query(`SELECT id,supplier_id,evidence,cancelled_at,coalesce(cancelled_at,created_at) at FROM ${T('agent_supplier_return_cases')}
   WHERE workspace_id=$1 AND ((authorization_kind='INDIVIDUAL' AND prepared_by=$2) OR cancelled_at IS NOT NULL) AND created_at>=${window_}`,[ctx.workspaceId,ctx.actorId,days])).rows;
  const out=[];
  for(const r of rows)for(const place of [...new Set((r.evidence?.lines||[]).map(l=>l.locationId))])
   out.push(row(r.id+'@'+place,r.supplier_id+'|'+place+'|'+r.evidence.currency,r.at,{declined:Boolean(r.cancelled_at),value:r.evidence.expected,data:{...r,caseId:r.id,place}}));
  return out;
 },
 async offer(db,ctx,{run}){
  const d=run.latest.data;
  if((await db.query(`SELECT 1 FROM ${T('agent_supplier_return_rules')} WHERE workspace_id=$1 AND supplier_id=$2 AND location_id=$3 AND currency=$4`,
    [ctx.workspaceId,d.supplier_id,d.place,d.evidence.currency])).rowCount)return null;
  const returns=require('../../purchasing/agent-supplier-returns'),evidence=require('../../purchasing/supplier-return-evidence');
  let example=null;
  for(const r of run.rows){
   const c=await returns.get(db,ctx,r.data.caseId).catch(()=>null);if(!c||!evidence.dispatchProof(c))continue;
   const follow=await returns.credited(db,ctx,c);if(!follow.problem&&follow.remaining===0&&follow.status==='RECONCILED'){example=r;break;}
  }
  if(!example)return null;
  const most=maximum(run.rows,r=>r.value),input={revision:0,locationId:d.place,maximum:money.fromMinor(most,d.evidence.currency),confirmed:'yes'};
  const place=d.evidence.lines.find(l=>l.locationId===d.place)?.location;
  return {label:'Return faulty goods to '+(d.evidence.supplier||'the supplier')+(place?' from '+place:''),limit:'up to '+amount(most,d.evidence.currency)+' expected credit a return',
   href:'/purchasing/supplier-returns/'+example.data.caseId,token:token({id:example.data.caseId,input}),teach:{id:example.data.caseId,input}};
 },
 async teach(s,ctx,offer){await require('../../purchasing/agent-supplier-returns').configure(s,ctx,offer.teach.id,offer.teach.input);}
};

module.exports=[shipPromises,deliveryDates,containerOrders,blanketReleases,supplierClaims,quoteRequests,backupSuppliers,supplierTerms,supplierReturns];

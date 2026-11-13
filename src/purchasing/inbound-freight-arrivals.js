'use strict';

// Job 39: what an arrival update changes, beyond the shipment record itself.
//
//  - Purchase-order dates. When the port or airport arrival moves, each linked
//    open purchase order's warehouse date moves by the same number of days, so
//    the recorded gap between the port and the warehouse is kept (never earlier
//    than the arrival itself). Planning and run-out read those dates, so they
//    follow on their own. A change made on its own can be undone while the
//    order still shows the date StockChief set.
//  - Run-out alerts. Before a later date is used, the job 151 run-out
//    calculation is repeated with the delivery at its new date. A product that
//    runs out before the goods now reach the warehouse goes to Needs you.
//  - Carrier tracking. A scheduled worker job reads each followed shipment from
//    the tracking service (freight-tracking.js), records what it says and
//    applies it within the owner's day limit, exactly like a forwarder update.
//  - Deposits and balances. The deposit and the remaining balance on each
//    purchase order are compared with posted supplier payments, and come due
//    in Needs you. StockChief records and reminds; a person pays.
//
// Pause, observe, Watch only and the first 14 days only record: updates are
// saved with the dates they would set, and alerts still show. Ask me first
// sends every update, with its purchase-order dates, for approval.
const {createHash}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const installed=require('../db/schema-installed');
const tracking=require('./freight-tracking');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const {ValidationError,NotFoundError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const {addDays}=require('../accounting/customer-money');

const JOB=39,KIND='agent.inbound-freight-tracking.v1',path='/autopilot/inbound-freight';
const table='stockchief_runtime.agent_inbound_freight',updates='stockchief_runtime.agent_inbound_freight_updates';
const dates='stockchief_runtime.agent_inbound_freight_po_dates',deposits='stockchief_runtime.agent_inbound_freight_deposits';
const DAY=86400000,BATCH=25,REMIND_DAYS=7;
const between=(from,to)=>Math.round((Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/DAY);
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const day=value=>{const text=String(value||'').slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(text)?text:null;};
const audit=(c,ctx,action,reference,before={},after={})=>require('../operations/postgres-security-audit').record(c,ctx,{action,reference,before,after});
const freightModule=()=>require('./agent-inbound-freight');

// ---- Purchase-order dates ----
async function proposals(c,workspaceId,freight,fromEta,toEta){
  if(!fromEta||!toEta||fromEta===toEta)return [];
  const shift=between(fromEta,toEta);
  const rows=(await c.query(`SELECT id,po_number,expected_date FROM purchase_orders WHERE workspace_id=$1 AND id=ANY($2::text[])
    AND status IN ('ORDERED','PARTIALLY_RECEIVED') ORDER BY po_number,id FOR UPDATE`,[workspaceId,freight.order_ids])).rows;
  return rows.filter(r=>day(r.expected_date)).map(r=>{
    const moved=addDays(day(r.expected_date),shift);
    return {orderId:r.id,poNumber:r.po_number,previous:day(r.expected_date),proposed:moved<toEta?toEta:moved};
  }).filter(x=>x.proposed!==x.previous);
}

// Products on these orders that would run out before the goods now arrive.
async function shortages(c,workspaceId,changes){
  const slips=changes.filter(x=>x.proposed>x.previous),result=new Map();
  if(!slips.length)return result;
  const lines=(await c.query(`SELECT DISTINCT purchase_order_id,sku_id FROM purchase_order_lines WHERE workspace_id=$1
    AND purchase_order_id=ANY($2::text[]) AND quantity_units>quantity_received_units`,[workspaceId,slips.map(x=>x.orderId)])).rows;
  if(!lines.length)return result;
  const runout=require('../forecasting/agent-runout'),today=await require('../lib/business-time').today(c,workspaceId);
  const data=await runout.load(scoped(c),workspaceId,[...new Set(lines.map(l=>l.sku_id))],today);
  if(!data)return result;
  const moved=new Map(slips.map(x=>[x.poNumber,x.proposed]));
  data.incoming=data.incoming.map(l=>moved.has(l.po_number)?{...l,expected:moved.get(l.po_number)}:l);
  const estimates=new Map(runout.compute(data).map(e=>[e.skuId,e]));
  for(const x of slips){
    const short=lines.filter(l=>l.purchase_order_id===x.orderId).map(l=>estimates.get(l.sku_id))
      .filter(e=>e?.runout&&e.runout<x.proposed).map(e=>({skuId:e.skuId,code:e.code,runsOut:e.runout}));
    if(short.length)result.set(x.orderId,short.slice(0,20));
  }
  return result;
}

// What one arrival update does to the linked purchase orders.
//   APPLIED  on its own, inside the owner's limits
//   APPROVED by the owner reviewing the update
//   HELD     waits with the update for approval
//   WATCH    recorded only (pause, observe, Watch only, first 14 days)
async function settle(c,ctx,freight,updateId,fromEta,toEta,disposition){
  if(!await installed.has(c,dates))return [];
  await c.query(`UPDATE ${dates} SET status='SUPERSEDED' WHERE workspace_id=$1 AND freight_id=$2 AND update_id<>$3 AND status IN ('HELD','WATCH')`,
    [ctx.workspaceId,freight.id,updateId]);
  if(disposition==='APPLIED'&&await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,JOB,true))disposition='HELD';
  const changes=await proposals(c,ctx.workspaceId,freight,fromEta,toEta);
  if(!changes.length)return [];
  // The run-out check only advises. A failure there never blocks the update.
  let short=new Map();
  await c.query('SAVEPOINT inbound_freight_runout');
  try{short=await shortages(c,ctx.workspaceId,changes);await c.query('RELEASE SAVEPOINT inbound_freight_runout');}
  catch(error){await c.query('ROLLBACK TO SAVEPOINT inbound_freight_runout');if(['40001','40P01'].includes(error.code))throw error;}
  const apply=['APPLIED','APPROVED'].includes(disposition),at=nowIso();
  for(const x of changes){
    x.shortage=short.get(x.orderId)||[];x.status=disposition;
    await c.query(`INSERT INTO ${dates}(workspace_id,id,freight_id,update_id,purchase_order_id,previous_date,proposed_date,status,automatic,shortage,decided_by,decided_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) ON CONFLICT(workspace_id,update_id,purchase_order_id) DO UPDATE SET
      previous_date=EXCLUDED.previous_date,proposed_date=EXCLUDED.proposed_date,status=EXCLUDED.status,automatic=EXCLUDED.automatic,
      shortage=EXCLUDED.shortage,decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at,alert_seen_at=NULL`,
    [ctx.workspaceId,newId('freight-date'),freight.id,updateId,x.orderId,x.previous,x.proposed,disposition,disposition==='APPLIED',
      JSON.stringify(x.shortage),apply?ctx.actorId:null,apply?at:null]);
    if(!apply)continue;
    await c.query('UPDATE purchase_orders SET expected_date=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,x.orderId,x.proposed,at]);
    await c.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at)
      VALUES($1,$2,$3,'inbound_freight_date_updated',$4,$5,$6)`,[newId('poevt'),ctx.workspaceId,x.orderId,
      JSON.stringify({freightId:freight.id,updateId,previousDate:x.previous,expectedDate:x.proposed,automatic:disposition==='APPLIED'}),ctx.actorId,at]);
    await audit(c,ctx,disposition==='APPLIED'?'Purchase order date moved with its shipment':'Purchase order date approved with its shipment',
      x.orderId,{expectedDate:x.previous},{expectedDate:x.proposed,freightId:freight.id,updateId});
  }
  return changes;
}

// Puts back the date an earlier change replaced, while the order still shows
// the date StockChief set. A date someone has since changed is left alone.
async function undo(db,ctx,id,input){
  return db.transaction(async c=>{
    const freight=freightModule();
    await freight.authorize(scoped(c),ctx,true);
    await freight.get(c,ctx.workspaceId,id,true);
    const row=(await c.query(`SELECT id,purchase_order_id,previous_date::text,proposed_date::text,status FROM ${dates}
      WHERE workspace_id=$1 AND freight_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,id,input.dateId])).rows[0];
    if(row?.status==='UNDONE')return {replayed:true};
    if(!row||!['APPLIED','APPROVED'].includes(row.status)||input.confirmed!=='yes')
      throw new ValidationError('Choose a purchase-order date change StockChief made and confirm putting the earlier date back.');
    const po=(await c.query('SELECT expected_date,status FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,row.purchase_order_id])).rows[0];
    if(!po||day(po.expected_date)!==row.proposed_date||!['ORDERED','PARTIALLY_RECEIVED'].includes(po.status))
      throw new ValidationError('This purchase order’s date or status changed since. Review it on the order instead.');
    const at=nowIso();
    await c.query('UPDATE purchase_orders SET expected_date=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.purchase_order_id,row.previous_date,at]);
    await c.query(`UPDATE ${dates} SET status='UNDONE',decided_by=$3,decided_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,ctx.actorId]);
    await c.query(`INSERT INTO purchase_order_events(id,workspace_id,purchase_order_id,event,detail,actor_user_id,created_at)
      VALUES($1,$2,$3,'inbound_freight_date_undone',$4,$5,$6)`,[newId('poevt'),ctx.workspaceId,row.purchase_order_id,
      JSON.stringify({freightId:id,changeId:row.id,expectedDate:row.previous_date,replacedDate:row.proposed_date}),ctx.actorId,at]);
    await audit(c,ctx,'Purchase order date change undone',row.purchase_order_id,{expectedDate:row.proposed_date},{expectedDate:row.previous_date,freightId:id});
    return {undone:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function seen(db,ctx,id,input){
  return db.transaction(async c=>{
    await freightModule().authorize(scoped(c),ctx,true);
    const done=await c.query(`UPDATE ${dates} SET alert_seen_at=now() WHERE workspace_id=$1 AND freight_id=$2 AND id=$3 AND alert_seen_at IS NULL
      AND jsonb_array_length(shortage)>0`,[ctx.workspaceId,id,input.dateId]);
    if(done.rowCount)await audit(c,ctx,'Shipment run-out alert noted',id,{},{changeId:input.dateId});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// ---- Carrier tracking ----
async function configureTracking(db,ctx,id,input){
  return db.transaction(async c=>{
    const freight=freightModule();
    await freight.authorize(scoped(c),ctx,true);
    const row=await freight.get(c,ctx.workspaceId,id,true);
    if(input.confirmed!=='yes'||Number(input.revision)!==row.revision)throw new ValidationError('Reload the current freight settings and confirm the change.');
    const enable=input.tracking==='yes',code=String(input.carrierCode||'').trim().toUpperCase()||null;
    if(code&&!/^[A-Z0-9]{2,4}$/.test(code))throw new ValidationError('Enter the shipping line or airline code of 2 to 4 letters or digits, for example MAEU.');
    if(enable&&!tracking.configured())throw new ValidationError('Carrier tracking is not set up on this server. Arrival updates still come from the forwarder link.');
    if(enable&&row.mode==='ocean'&&!code)throw new ValidationError('Enter the shipping line’s code (SCAC) to follow its tracking.');
    await c.query(`UPDATE ${table} SET tracking=$3,carrier_code=$4,tracking_issue=NULL,tracking_retry_after=NULL,
      tracking_reference=CASE WHEN $3 AND carrier_code IS NOT DISTINCT FROM $4 THEN tracking_reference ELSE NULL END
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,enable,code]);
    await audit(c,ctx,enable?'Carrier tracking turned on for a shipment':'Carrier tracking turned off for a shipment',id,{tracking:row.tracking},{tracking:enable,carrierCode:code});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Saves one reading from the tracking service and applies it as far as the
// owner's authority allows. A repeated reading of the same state is skipped.
async function record(db,workspaceId,id,answer){
  return db.transaction(async c=>{
    const freight=freightModule(),row=await freight.get(c,workspaceId,id,true);
    if(!row.tracking)return {skipped:'tracking off'};
    const ctx={workspaceId,actorId:row.authorized_by},account=await freight.authorize(scoped(c),ctx,true);
    if(answer.pending){
      await c.query(`UPDATE ${table} SET tracking_reference=$3,tracking_checked_at=now(),tracking_issue=NULL,tracking_retry_after=NULL WHERE workspace_id=$1 AND id=$2`,
        [workspaceId,id,answer.providerReference]);
      return {pending:true};
    }
    const touch=()=>c.query(`UPDATE ${table} SET tracking_reference=coalesce($3,tracking_reference),tracking_checked_at=now(),tracking_issue=NULL,
      tracking_retry_after=NULL WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,answer.providerReference]);
    if(answer.status===row.status&&(!answer.eta||answer.eta===row.eta)){await touch();return {unchanged:true};}
    const key=hash(['carrier',row.revision,answer.status,answer.eta]);
    if((await c.query(`SELECT 1 FROM ${updates} WHERE workspace_id=$1 AND freight_id=$2 AND provider_key=$3`,[workspaceId,id,key])).rowCount){await touch();return {unchanged:true};}
    const decision=await freight.decide(c,ctx,account,row,{status:answer.status,eta:answer.eta}),updateId=newId('freight-update');
    const last=answer.events.at(-1),note=last?[last.detail,last.location].filter(Boolean).join(' · ').slice(0,1000)||null:null;
    await require('../commercial/storage-capacity').reserve(scoped(c),workspaceId,'inbound-freight-update:'+updateId,4096,{finished:true});
    await c.query(`INSERT INTO ${updates}(workspace_id,freight_id,id,revision,status,eta,note,disposition,applied_by,source,provider_key,held_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'carrier',$10,$11)`,[workspaceId,id,updateId,row.revision+1,answer.status,answer.eta,note,
      decision.disposition,decision.disposition==='APPLIED'?ctx.actorId:null,key,decision.reason||null]);
    const applied=decision.disposition==='APPLIED';
    await c.query(`UPDATE ${table} SET revision=revision+1,status=CASE WHEN $3 THEN $4 ELSE status END,eta=CASE WHEN $3 THEN coalesce($5::date,eta) ELSE eta END,
      tracking_reference=coalesce($6,tracking_reference),tracking_checked_at=now(),tracking_issue=NULL,tracking_retry_after=NULL WHERE workspace_id=$1 AND id=$2`,
    [workspaceId,id,applied,answer.status,answer.eta,answer.providerReference]);
    await settle(c,ctx,row,updateId,row.eta,answer.eta,{APPLIED:'APPLIED',REVIEW:'HELD',WATCH:'WATCH'}[decision.disposition]);
    await audit(c,ctx,{APPLIED:'Carrier tracking update applied',REVIEW:'Carrier tracking update needs review',WATCH:'Carrier tracking update recorded while watching'}[decision.disposition],
      id,{status:row.status,eta:row.eta},{updateId,status:answer.status,eta:answer.eta,reason:decision.reason||null});
    return {disposition:decision.disposition};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

const DUE=`SELECT id,mode,reference_type,reference,carrier_code,tracking_reference FROM ${table}
  WHERE workspace_id=$1 AND tracking AND status<>'released' AND (tracking_retry_after IS NULL OR tracking_retry_after<=now())
    AND (tracking_checked_at IS NULL OR tracking_checked_at<=now()-interval '6 hours')`;

async function schedule(c,workspaceId,cycleId){
  if(!tracking.configured()||!await installed.has(c,table,'tracking'))return {queued:false};
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {queued:false};
  if(!(await c.query(DUE+' LIMIT 1',[workspaceId])).rowCount)return {queued:false};
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'inbound-freight-tracking:'+cycleId,
    payload:{cycleId},priority:52,maxAttempts:3});
  return {queued:true};
}

// The worker job. The tracking service is called outside any database
// transaction; each answer is then saved on its own.
async function run(db,job,{provider=null}={}){
  const workspaceId=job.workspaceId,account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return {skipped:'plan'};
  if(!await installed.has(db,table,'tracking'))return {skipped:'schema'};
  const name=provider?null:tracking.configured();
  if(!provider&&!name)return {skipped:'no tracking service'};
  const service=provider||tracking.get(name),result={checked:0,applied:0,review:0,watched:0,pending:0,unchanged:0,problems:0};
  for(const row of (await db.query(DUE+' ORDER BY tracking_checked_at NULLS FIRST,id LIMIT '+BATCH,[workspaceId])).rows){
    result.checked++;
    try{
      const answer=tracking.read(await service.track({mode:row.mode,referenceType:row.reference_type,reference:row.reference,
        carrierCode:row.carrier_code,providerReference:row.tracking_reference}));
      const saved=await record(db,workspaceId,row.id,answer);
      if(saved.pending)result.pending++;else if(saved.unchanged||saved.skipped)result.unchanged++;
      else result[{APPLIED:'applied',REVIEW:'review',WATCH:'watched'}[saved.disposition]]++;
    }catch(error){
      if(!error.retryable&&![400,402,403,404,409,422].includes(error.status))throw error;
      await db.query(`UPDATE ${table} SET tracking_issue=$3,tracking_checked_at=now(),tracking_retry_after=now()+interval '1 hour'
        WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.id,String(error.message||'The tracking service did not answer.').slice(0,500)]);
      result.problems++;
    }
  }
  return result;
}

// ---- Deposits and the remaining balance ----
// Goods value of each order and the posted supplier payments on its posted bills.
async function orderMoney(db,workspaceId,orderIds){
  const result=new Map(orderIds.map(id=>[id,{valueMinor:null,paidMinor:0}]));
  if(!orderIds.length)return result;
  const lines=(await db.query(`SELECT l.purchase_order_id,l.unit_cost::text cost,l.quantity_units::text quantity,l.secondary_quantity_ordered::text secondary,
    i.secondary_unit_label,p.currency FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=ANY($2::text[])`,[workspaceId,orderIds])).rows;
  for(const id of orderIds){
    const own=lines.filter(l=>l.purchase_order_id===id);
    if(!own.length||own.some(l=>l.cost==null||(l.secondary_unit_label&&l.secondary==null)))continue;
    try{result.get(id).valueMinor=money.sum(own.map(l=>exact.costMinor(l.secondary_unit_label?l.secondary:l.quantity,money.userToMinor(l.cost,l.currency))));}
    catch{/* A cost that cannot be read exactly leaves the value unknown. */}
  }
  const paid=(await db.query(`SELECT b.purchase_order_id,coalesce(sum(a.amount_minor),0)::text paid FROM accounting_supplier_bills b
    JOIN accounting_journal_entries bj ON bj.workspace_id=b.workspace_id AND bj.id=b.journal_entry_id AND bj.status='POSTED'
    JOIN purchase_orders o ON o.workspace_id=b.workspace_id AND o.id=b.purchase_order_id AND o.currency=b.currency
    JOIN accounting_payment_allocations a ON a.workspace_id=b.workspace_id AND a.supplier_bill_id=b.id
    JOIN accounting_payments p ON p.workspace_id=a.workspace_id AND p.id=a.payment_id AND p.status='POSTED' AND p.direction='SUPPLIER_PAYMENT' AND p.currency=b.currency
    JOIN accounting_journal_entries pj ON pj.workspace_id=p.workspace_id AND pj.id=p.journal_entry_id AND pj.status='POSTED'
    WHERE b.workspace_id=$1 AND b.purchase_order_id=ANY($2::text[]) AND b.status IN('OPEN','PARTIALLY_PAID','PAID') GROUP BY b.purchase_order_id`,[workspaceId,orderIds])).rows;
  for(const row of paid)result.get(row.purchase_order_id).paidMinor=Number(row.paid);
  return result;
}

// Each recorded deposit with what has been paid on its matched posted bill.
async function depositRows(db,workspaceId,{freightId=null,dueBy=null}={}){
  const balance=await installed.has(db,deposits,'balance_due_date');
  return (await db.query(`SELECT d.freight_id,f.reference,d.purchase_order_id,po.po_number,po.status order_status,d.revision,d.amount_minor,d.currency,
      d.due_date::text,${balance?'d.balance_due_date::text':'NULL::text'} balance_due_date,b.bill_number,coalesce(sum(paid.amount_minor),0)::text paid
    FROM ${deposits} d JOIN ${table} f ON f.workspace_id=d.workspace_id AND f.id=d.freight_id
    JOIN purchase_orders po ON po.workspace_id=d.workspace_id AND po.id=d.purchase_order_id
    LEFT JOIN accounting_supplier_bills b ON b.workspace_id=d.workspace_id AND b.id=d.bill_id
      AND b.purchase_order_id=d.purchase_order_id AND b.status IN('OPEN','PARTIALLY_PAID','PAID')
      AND b.currency=d.currency AND b.total_minor=d.amount_minor AND EXISTS(SELECT 1 FROM accounting_journal_entries j
        WHERE j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED')
    LEFT JOIN LATERAL(SELECT a.amount_minor FROM accounting_payment_allocations a JOIN accounting_payments p
      ON p.workspace_id=a.workspace_id AND p.id=a.payment_id AND p.status='POSTED' AND p.direction='SUPPLIER_PAYMENT'
      AND p.currency=b.currency AND p.supplier_id=b.supplier_id JOIN accounting_journal_entries j ON j.workspace_id=p.workspace_id
      AND j.id=p.journal_entry_id AND j.status='POSTED' WHERE a.workspace_id=b.workspace_id AND a.supplier_bill_id=b.id) paid ON true
    WHERE d.workspace_id=$1 AND ($2::text IS NULL OR d.freight_id=$2)
      AND ($3::date IS NULL OR d.due_date<=$3::date${balance?' OR d.balance_due_date<=$3::date':''})
    GROUP BY d.freight_id,f.reference,d.purchase_order_id,po.po_number,po.status,d.revision,d.amount_minor,d.currency,d.due_date,${balance?'d.balance_due_date,':''}b.bill_number
    ORDER BY d.due_date,po.po_number LIMIT 200`,[workspaceId,freightId,dueBy])).rows;
}

// ---- The purchase order page ----
async function forOrder(db,workspaceId,orderId){
  if(!await installed.has(db,table))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'suggest'))return [];
  const shipments=(await db.query(`SELECT id,mode,reference,forwarder,destination,status,eta::text FROM ${table}
    WHERE workspace_id=$1 AND order_ids ? $2 ORDER BY created_at DESC,id DESC LIMIT 5`,[workspaceId,orderId])).rows;
  if(!shipments.length)return [];
  const owed=(await depositRows(db,workspaceId)).filter(d=>d.purchase_order_id===orderId),value=(await orderMoney(db,workspaceId,[orderId])).get(orderId);
  return shipments.map(s=>({...s,href:path+'/'+s.id,deposit:owed.find(d=>d.freight_id===s.id)||null,order:value}));
}

// ---- Needs you ----
async function inbox(db,workspaceId){
  if(!await installed.has(db,table))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const today=await require('../lib/business-time').today(db,workspaceId),items=[],labels=freightModule().statusLabels;
  const v2=await installed.has(db,dates);
  const reviews=(await db.query(`SELECT f.id,f.reference,u.status,u.eta::text,u.created_at,${v2?'u.held_reason,u.source':"NULL held_reason,'forwarder' source"}
    FROM ${updates} u JOIN ${table} f ON f.workspace_id=u.workspace_id AND f.id=u.freight_id AND f.revision=u.revision
    WHERE u.workspace_id=$1 AND u.disposition='REVIEW' ORDER BY u.created_at LIMIT 25`,[workspaceId])).rows;
  for(const r of reviews)items.push({kind:'purchase',importance:'Needs You',priority:78,title:'Review the arrival update for '+r.reference,
    happened:(r.source==='carrier'?'The carrier’s tracking':'The forwarder')+' reports '+labels[r.status].toLowerCase()+(r.eta?', arriving '+r.eta:'')+'.',
    why:r.held_reason||'It is outside the limits you set for this shipment.',recommendation:'Check the update and the purchase-order dates it moves, then apply it or leave it.',
    href:path+'/'+r.id+'#updates',actionLabel:'Review the update',sourceId:'inbound-freight-review:'+r.id,at:r.created_at,createdAt:r.created_at});
  if(v2){
    const alerts=(await db.query(`SELECT * FROM (SELECT DISTINCT ON (d.freight_id,d.purchase_order_id) d.id,d.freight_id,d.status,d.proposed_date::text,
        d.shortage,d.alert_seen_at,d.created_at,f.reference,po.po_number,po.status order_status
      FROM ${dates} d JOIN ${table} f ON f.workspace_id=d.workspace_id AND f.id=d.freight_id
      JOIN purchase_orders po ON po.workspace_id=d.workspace_id AND po.id=d.purchase_order_id
      WHERE d.workspace_id=$1 AND d.status<>'SUPERSEDED' ORDER BY d.freight_id,d.purchase_order_id,d.created_at DESC,d.id DESC) latest
      WHERE status IN ('APPLIED','APPROVED','HELD','WATCH') AND jsonb_array_length(shortage)>0 AND alert_seen_at IS NULL
        AND order_status IN ('ORDERED','PARTIALLY_RECEIVED') ORDER BY created_at LIMIT 25`,[workspaceId])).rows;
    for(const r of alerts){
      const first=r.shortage[0],more=r.shortage.length>1?' and '+(r.shortage.length-1)+' more':'';
      items.push({kind:'purchase',importance:'Urgent',priority:88,title:first.code+more+' will run out before '+r.po_number+' arrives',
        happened:'Shipment '+r.reference+(r.status==='APPLIED'||r.status==='APPROVED'?' now reaches the warehouse on ':' would reach the warehouse on ')+r.proposed_date+
          '. '+first.code+' runs out on '+first.runsOut+'.',
        why:'The arrival moved later than the date your stock plan needs.',recommendation:'Speed up this shipment, move stock from another location or order a smaller quick delivery.',
        href:path+'/'+r.freight_id+'#orders',actionLabel:'Open the shipment',sourceId:'inbound-freight-runout:'+r.id,at:r.created_at,createdAt:r.created_at});
    }
  }
  const soon=addDays(today,REMIND_DAYS),orders=new Set();
  const owed=(await depositRows(db,workspaceId,{dueBy:soon})).filter(d=>['ORDERED','PARTIALLY_RECEIVED','RECEIVED','APPROVED'].includes(d.order_status));
  const values=await orderMoney(db,workspaceId,[...new Set(owed.map(d=>d.purchase_order_id))]);
  for(const d of owed){
    const left=Number(d.amount_minor)-Number(d.paid);
    if(left>0&&d.due_date<=soon)items.push({kind:'purchase',importance:d.due_date<today?'Urgent':'Needs You',priority:d.due_date<today?84:76,
      title:'Deposit for '+d.po_number+(d.due_date<today?' was due ':' is due ')+d.due_date,happened:money.format(left,d.currency)+' of the '+money.format(Number(d.amount_minor),d.currency)+' deposit is not recorded as paid.',
      why:'You recorded this deposit for shipment '+d.reference+'.',recommendation:'Pay it from your bank, then record the payment on its bill. StockChief reminds; it never sends money.',
      href:path+'/'+d.freight_id+'#orders',actionLabel:'Open the shipment',sourceId:'inbound-freight-deposit:'+d.freight_id+':'+d.purchase_order_id+':'+d.due_date,at:d.due_date,createdAt:d.due_date});
    const value=values.get(d.purchase_order_id);
    if(d.balance_due_date&&d.balance_due_date<=soon&&value?.valueMinor!=null&&!orders.has(d.purchase_order_id)&&value.valueMinor-value.paidMinor>0){
      orders.add(d.purchase_order_id);
      items.push({kind:'purchase',importance:d.balance_due_date<today?'Urgent':'Needs You',priority:d.balance_due_date<today?83:75,
        title:'Balance for '+d.po_number+(d.balance_due_date<today?' was due ':' is due ')+d.balance_due_date,
        happened:money.format(value.valueMinor-value.paidMinor,d.currency)+' of the goods on this order is not recorded as paid.',why:'You recorded this balance date for shipment '+d.reference+'.',
        recommendation:'Pay it from your bank, then record the payment on the supplier bill. StockChief reminds; it never sends money.',
        href:path+'/'+d.freight_id+'#orders',actionLabel:'Open the shipment',sourceId:'inbound-freight-balance:'+d.purchase_order_id+':'+d.balance_due_date,at:d.balance_due_date,createdAt:d.balance_due_date});
    }
  }
  if(await installed.has(db,table,'tracking')){
    const issues=(await db.query(`SELECT id,reference,tracking_issue,tracking_checked_at FROM ${table} WHERE workspace_id=$1 AND tracking AND tracking_issue IS NOT NULL
      AND status<>'released' ORDER BY tracking_checked_at LIMIT 10`,[workspaceId])).rows;
    for(const r of issues)items.push({kind:'purchase',importance:'Needs You',priority:60,title:'Carrier tracking for '+r.reference+' needs attention',happened:r.tracking_issue,
      why:'StockChief could not read the carrier’s tracking. The saved arrival date is unchanged.',recommendation:'Check the carrier code and reference, or use the forwarder link.',
      href:path+'/'+r.id,actionLabel:'Open the shipment',sourceId:'inbound-freight-tracking:'+r.id,at:r.tracking_checked_at,createdAt:r.tracking_checked_at});
  }
  return items;
}

module.exports={JOB,KIND,settle,undo,seen,configureTracking,record,schedule,run,orderMoney,depositRows,forOrder,inbox};

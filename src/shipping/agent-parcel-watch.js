'use strict';
// Job 62: StockChief watches every parcel that has left with a carrier. On a
// schedule it asks the carrier about parcels it has not heard from (webhooks
// are the usual way; this is the polling fallback through the connected
// account's own adapter), then flags any parcel that is late against the date
// promised on the order, has stopped moving, or that the carrier reports as
// lost, damaged, returned to sender or held up. Each flag is raised once, on
// the order and in Needs you, and is audited. If the owner turns it on, the
// customer is told about a delay: written for review, or sent on its own.
// Growth, Pro and Custom watch alone; Starter does not include it.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const jobs=require('../operations/postgres-job-queue');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso,requireText}=require('../lib/util');

const JOB=62,KIND='agent.parcel-watch.v1',ACTION='shipping.parcel_watch';
const STUCK_DAYS=3,QUIET_MS=6*3600_000,POLLS=25,DAY=86400_000;
const DELAYS=['late','stuck'];
const WORDS={late:'late',stuck:'stalled',lost:'lost',damaged:'damaged',returned:'returned',exception:'held up'};
const scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
const flagKey=(id,problem)=>'parcel-watch:'+id+':'+problem;
const handledKey=(id,problem)=>'parcel-watch-handled:'+id+':'+problem;

// Parcels that have left with a carrier and are not yet delivered.
const PARCELS=`SELECT s.id,s.shipment_number,s.sales_order_id,s.status,s.tracking_number,s.tracking_url,s.carrier,s.provider,s.label_status,
    s.tracking_status,s.tracking_status_detail,s.exception_reason,s.expected_delivery_date,s.shipped_at,s.tracked_at,
    o.order_number,o.needed_by,o.customer_id,o.contact_email,c.name customer_name,
    (SELECT e.occurred_at FROM shipment_tracking_events e WHERE e.workspace_id=s.workspace_id AND e.shipment_id=s.id ORDER BY e.occurred_at DESC LIMIT 1) last_scan_at,
    (SELECT e.location FROM shipment_tracking_events e WHERE e.workspace_id=s.workspace_id AND e.shipment_id=s.id ORDER BY e.occurred_at DESC LIMIT 1) last_scan_location,
    (SELECT k.last_checked_at FROM shipping_tracking_checks k WHERE k.workspace_id=s.workspace_id AND k.shipment_id=s.id) last_asked_at
  FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
  LEFT JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  WHERE s.workspace_id=$1 AND s.status='SHIPPED' AND s.handover='CARRIER' AND s.customer_return_id IS NULL AND s.return_outbound_shipment_id IS NULL
    AND coalesce(s.tracking_status,'UNKNOWN') NOT IN ('DELIVERED','CANCELLED')`;
async function parcels(db,workspaceId,{orderId=null,shipmentId=null}={}){
  return (await db.query(PARCELS+` AND ($2::text IS NULL OR s.sales_order_id=$2) AND ($3::text IS NULL OR s.id=$3) ORDER BY s.shipped_at,s.id LIMIT 200`,
    [workspaceId,orderId,shipmentId])).rows;
}

// What is wrong with one parcel, from the carrier's own words and the order's dates.
function classify(s,today,now=Date.now()){
  const status=s.tracking_status||'UNKNOWN',said=[s.tracking_status_detail,s.exception_reason].filter(Boolean)
    .filter((x,i,a)=>a.indexOf(x)===i).join(' — ');
  if(['DELIVERED','CANCELLED'].includes(status)||s.status!=='SHIPPED')return null;
  if(status==='RETURNED')return {problem:'returned',detail:said||'The carrier is sending it back to you.'};
  if(/\blost\b|\bmissing\b|cannot be located|unable to locate/i.test(said))return {problem:'lost',detail:said};
  if(/damag/i.test(said))return {problem:'damaged',detail:said};
  if(status==='FAILURE')return {problem:'exception',detail:said||'The carrier reported a delivery problem.'};
  const promised=s.needed_by?String(s.needed_by).slice(0,10):null,carrierDate=s.expected_delivery_date?String(s.expected_delivery_date).slice(0,10):null,due=promised||carrierDate;
  if(due&&due<today)return {problem:'late',due,detail:'It was due '+due+' and has not been delivered.'};
  if(promised&&carrierDate&&carrierDate>promised)return {problem:'late',due:promised,detail:'The carrier now expects it '+carrierDate+', after the date promised, '+promised+'.'};
  const last=[s.last_scan_at,s.shipped_at].filter(Boolean).map(x=>Date.parse(x)).filter(Number.isFinite).sort((a,b)=>b-a)[0];
  if(last&&now-last>STUCK_DAYS*DAY)return {problem:'stuck',detail:'The carrier has not scanned it since '+new Date(last).toISOString().slice(0,10)+'.'};
  return null;
}

async function ownerUser(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.created_at,u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// How far StockChief may go now. Watching and flagging are alerts, so they
// continue under Watch only, Ask me first, observe and the first 14 days;
// pause stops the watch. Only telling the customer on its own needs more.
async function authority(db,workspaceId){
  const account=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null;
  if(!plan||!policy.permits(plan,JOB,'automatic'))return {plan:null,account};
  const cfg=(await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(Number(cfg?.paused)||Number(cfg?.suspended))return {plan,account,paused:'Automatic work is paused. Review the inventory’s automation settings.'};
  const watch=await policy.stopped(db,workspaceId,account,ACTION,false);
  let hold=watch||await policy.stopped(db,workspaceId,account,ACTION,true);
  if(!hold&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    hold='Routine work is off. Choose Handle routine work in StockChief AI to let it email customers on its own.';
  return {plan,account,watch,hold};
}

// Raise a flag once per parcel and problem: on the order and in the audit log.
async function flag(database,workspaceId,s,found,auth){
  return database.transaction(async c=>{
    const detail={shipmentId:s.id,shipmentNumber:s.shipment_number,problem:found.problem,detail:found.detail,due:found.due||null,watching:Boolean(auth.watch)};
    const inserted=(await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
      VALUES($1,$2,$3,'parcel_flagged',$4,NULL,$5,$6) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
    [newId('soevt'),workspaceId,s.sales_order_id,JSON.stringify(detail),flagKey(s.id,found.problem),nowIso()])).rows[0];
    if(!inserted)return false;
    await audit.record(c,{workspaceId},{action:'Flagged a '+WORDS[found.problem]+' parcel',reference:s.shipment_number,
      after:{orderNumber:s.order_number,problem:found.problem,detail:found.detail,due:found.due||null,trackingNumber:s.tracking_number}});
    return true;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// ---- Telling the customer about a delay (only if the owner turned it on) ----
async function noticePolicy(db,workspaceId){
  return (await db.query(`SELECT p.exception_notice,p.connector_id,p.shipping_authorized_by,p.shipping_mailbox_account,p.signature,p.business_name,p.updated_at revision,
    EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=p.workspace_id AND u.id=p.shipping_authorized_by AND u.role='owner') owner_authority
    FROM customer_communication_policy p WHERE p.workspace_id=$1`,[workspaceId])).rows[0]||null;
}
function compose(s,found,p){
  const carriers=require('../sales/carriers'),carrier=s.carrier?carriers.displayName(s.carrier):'The carrier',link=s.tracking_url||carriers.trackingUrlFor(s.carrier,s.tracking_number);
  const where=s.last_scan_at?' Its last scan was'+(s.last_scan_location?' in '+s.last_scan_location:'')+' on '+String(s.last_scan_at).slice(0,10)+'.':'';
  const middle=found.problem==='late'
    ?(found.due?'It was due '+found.due+'. ':'')+carrier+' has not delivered it yet.'+where
    :carrier+' has not scanned it for a few days.'+where;
  return {subject:'Your order '+s.order_number+' is running late',
    body:['Hello'+(s.customer_name?' '+s.customer_name:'')+',','','Your order '+s.order_number+' is on its way, but it is running late. '+middle,
      carrier+' has not given a new date. We will tell you as soon as it moves or arrives.','',
      ...(s.tracking_number?['Tracking: '+s.tracking_number,...(link?[link]:[]),'']:[]),p?.signature||p?.business_name||null].filter(x=>x!=null).join('\n')};
}
async function mailbox(db,workspaceId,id){return require('./agent-shipping-notices').mailbox(db,workspaceId,id);}

async function noticeAuthority(db,workspaceId,rule){
  const account=await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');
  const stop=await policy.stopped(db,workspaceId,account,ACTION,rule.automatic);
  if(stop)throw new ValidationError(stop);
  const p=await noticePolicy(db,workspaceId);
  if(!p||p.exception_notice==='off')throw new ValidationError('Delay emails are turned off. Turn them on in Fulfilment settings first.');
  if(rule.automatic){
    if(!policy.permits(account.plan,JOB,'automatic')||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
      throw Object.assign(new ValidationError('Approve this delay email. Sending on its own needs Growth or higher and routine work on.'),{code:'delay_needs_approval'});
    if(p.exception_notice!=='send'||!p.owner_authority||p.shipping_authorized_by!==rule.actorId||p.connector_id!==rule.connector
      ||p.revision!==rule.revision||p.shipping_mailbox_account!==rule.mailboxAccount)
      throw new ValidationError('The delay email needs individual approval under the current settings.');
  }
  const s=(await parcels(db,workspaceId,{shipmentId:rule.shipmentId}))[0];
  const found=s&&classify(s,await require('../lib/business-time').today(db,workspaceId));
  if(!s||found?.problem!==rule.problem)throw new ValidationError('The parcel is no longer '+(WORDS[rule.problem]||'late')+'. The delay email was not sent.');
  if(!s.contact_email||s.contact_email.toLowerCase()!==String(rule.recipient||'').toLowerCase())throw new ValidationError('The customer’s email changed. Review the delay email before sending.');
  const sender=await mailbox(db,workspaceId,rule.connector);
  if(!sender||sender.provider_account_id!==rule.mailboxAccount)throw new ValidationError('Review the sending mailbox and its email permission before sending.');
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[workspaceId,rule.actorId])).rows[0],access=require('../actions/permissions');
  if(!actor||!access.can(actor,access.OPERATE))throw new ValidationError('The person who approved this delay email no longer has access.');
}

async function queueNotice(c,ctx,note,s,found,connector,automatic,p){
  const rule={kind:'parcel_delay_notice',shipmentId:s.id,problem:found.problem,recipient:note.recipient,connector:connector.id,
    mailboxAccount:connector.provider_account_id,revision:p?.revision||null,actorId:ctx.actorId,automatic};
  try{await noticeAuthority(c,ctx.workspaceId,rule);}
  catch(error){if(automatic&&error instanceof ValidationError)return null;throw error;}
  const at=nowIso();
  await c.query(`UPDATE customer_communications SET status='QUEUED',connector_id=$3,transport=$4,approved_by_user_id=$5,approved_at=$6,queued_at=$6,updated_at=$6
    WHERE workspace_id=$1 AND id=$2 AND status='PREPARED'`,[ctx.workspaceId,note.id,connector.id,connector.provider_type,ctx.actorId,at]);
  const queued=await require('../operations/postgres-provider-effects').enqueueInTransaction(c,{workspaceId:ctx.workspaceId,kind:'mail.outbound.send',
    provider:connector.provider_type,aggregateType:'customer_communication',aggregateId:note.id,
    idempotencyKey:automatic?note.idempotency_key:note.idempotency_key+':approved:'+note.updated_at,requestedByUserId:ctx.actorId,
    payload:{communicationId:note.id,communicationKind:'customer',connectorId:connector.id,agentJob:JOB,standingAuthority:rule}});
  await audit.record(c,automatic?{workspaceId:ctx.workspaceId}:ctx,{action:automatic?'Told a customer their parcel is late':'Approved a delay email',reference:s.shipment_number,
    before:{status:'PREPARED'},after:{status:'QUEUED',orderNumber:s.order_number,recipient:note.recipient,problem:found.problem}});
  return queued;
}

// Write the delay email once per parcel and problem; send it on its own only
// when the owner chose "Send automatically" and StockChief may act alone.
async function tell(database,workspaceId,s,found,auth,owner){
  if(!DELAYS.includes(found.problem))return null;
  const p=await noticePolicy(database,workspaceId);
  if(!p||!['prepare','send'].includes(p.exception_notice))return null;
  return database.transaction(async c=>{
    const words=compose(s,found,p),at=nowIso();
    const note=(await c.query(`INSERT INTO customer_communications(id,workspace_id,customer_id,sales_order_id,shipment_id,recipient,subject,body,
      message_kind,status,connector_id,idempotency_key,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'shipping_delay','PREPARED',$9,$10,$11,$11)
      ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,[newId('delaymail'),workspaceId,s.customer_id,s.sales_order_id,s.id,s.contact_email||null,
      words.subject,words.body,p.connector_id,'parcel-delay:'+s.id+':'+found.problem,at])).rows[0];
    if(!note)return null;
    await audit.record(c,{workspaceId},{action:'Wrote a delay email',reference:s.shipment_number,after:{orderNumber:s.order_number,recipient:s.contact_email||null,problem:found.problem}});
    if(p.exception_notice!=='send'||auth.hold||!note.recipient||!p.owner_authority||!p.connector_id)return {prepared:note.id};
    const connector=await mailbox(c,workspaceId,p.connector_id);
    if(!connector)return {prepared:note.id};
    const queued=await queueNotice(c,{workspaceId,actorId:p.shipping_authorized_by},note,s,found,connector,true,p);
    return queued?{queued:note.id}:{prepared:note.id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// A person reads, edits, sends or drops the delay email with one tap.
async function editNotice(db,ctx,shipmentId,input){
  return db.transaction(async c=>{
    const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(user,require('../actions/permissions').OPERATE,'review delay emails');
    await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const note=(await c.query("SELECT * FROM customer_communications WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3 AND message_kind='shipping_delay' FOR UPDATE",[ctx.workspaceId,shipmentId,input.messageId])).rows[0];
    if(!note||note.status!=='PREPARED'||note.updated_at!==input.version)throw new ValidationError('This delay email changed. Open the current one before sending.');
    if(!['save','cancel','send'].includes(input.action))throw new ValidationError('Choose how to handle this delay email.');
    const s=(await parcels(c,ctx.workspaceId,{shipmentId}))[0];
    const words=input.action==='cancel'?note:{subject:requireText(input.subject,'Subject',{max:250}),body:requireText(input.body,'Message',{max:20000})};
    const updated=(await c.query(`UPDATE customer_communications SET subject=$3,body=$4,status=$5,recipient=$6,updated_at=$7 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [ctx.workspaceId,note.id,words.subject,words.body,input.action==='cancel'?'CANCELLED':'PREPARED',s?.contact_email||note.recipient,nowIso()])).rows[0];
    if(input.action==='cancel')await audit.record(c,ctx,{action:'Decided not to send a delay email',reference:note.shipment_id,before:{status:'PREPARED'},after:{status:'CANCELLED'}});
    if(input.action==='send'){
      const problem=String(note.idempotency_key).split(':').at(-1);
      if(!s)throw new ValidationError('The parcel was delivered or closed. The delay email was not sent.');
      if(!updated.recipient)throw new ValidationError('Add the customer’s email to the order before sending.');
      const connector=await mailbox(c,ctx.workspaceId,input.connectorId);
      if(!connector)throw new ValidationError('Choose a connected mailbox before sending.');
      await queueNotice(c,ctx,updated,s,{problem},connector,false,await noticePolicy(c,ctx.workspaceId));
    }
    return updated.id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// ---- The scheduled watch ----
async function run(database,job,options={}){
  const workspaceId=job.workspaceId,auth=await authority(database,workspaceId);
  if(!auth.plan)return {skipped:'plan'};
  if(auth.paused)return {skipped:'paused'};
  const owner=await ownerUser(database,workspaceId);if(!owner)return {skipped:'owner'};
  const ctx={workspaceId,actorId:owner},result={checked:0,polled:0,flagged:0,emailed:0,written:0};
  // Polling fallback: ask the carrier about parcels it has gone quiet on.
  const heard=s=>Math.max(...[s.tracked_at,s.last_asked_at].map(x=>Date.parse(x||'')).filter(Number.isFinite),0);
  const quiet=(await parcels(database,workspaceId)).filter(s=>s.tracking_number&&Date.now()-heard(s)>QUIET_MS).slice(0,POLLS);
  for(const s of quiet){
    await database.query(`INSERT INTO shipping_tracking_checks(workspace_id,shipment_id,next_check_at,last_checked_at) VALUES($1,$2,$3,$3)
      ON CONFLICT(workspace_id,shipment_id) DO UPDATE SET last_checked_at=EXCLUDED.last_checked_at`,[workspaceId,s.id,nowIso()]);
    try{await require('./postgres-service').refreshTracking(database,ctx,s.id,{provider:options.providerResolver?options.providerResolver(s.provider):undefined,
      essential:true,idempotencyKey:'parcel-watch:'+(job.id||newId('watch'))+':'+s.id});result.polled++;}
    catch{/* A carrier that does not answer keeps what it last said; the next parcel is still checked. */}
  }
  const today=await require('../lib/business-time').today(database,workspaceId);
  for(const s of await parcels(database,workspaceId)){
    result.checked++;
    const found=classify(s,today);if(!found)continue;
    if(await flag(database,workspaceId,s,found,auth))result.flagged++;
    // Job 63: a parcel the carrier itself reports lost gets its claim prepared.
    if(found.problem==='lost'&&!auth.watch){
      try{if(await require('./agent-carrier-claims').fromWatch(database,workspaceId,s,found))result.claimed=(result.claimed||0)+1;}
      catch{/* A claim that cannot be prepared now is tried again on the next watch; the flag stands. */}
    }
    // Watch only, observe and the first 14 days flag but write nothing to customers.
    const told=auth.watch?null:await tell(database,workspaceId,s,found,auth,owner);
    if(told?.queued)result.emailed++;else if(told?.prepared)result.written++;
  }
  return result;
}
async function schedule(c,workspaceId,cycleId){
  const account=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {queued:false};
  if(!(await c.query(PARCELS+' LIMIT 1',[workspaceId])).rowCount)return {queued:false};
  await jobs.enqueue(scoped(c),{workspaceId,kind:KIND,idempotencyKey:'parcel-watch:cycle:'+cycleId,payload:{cycleId},priority:50,maxAttempts:3});
  return {queued:true};
}

// ---- What people see: the order, Needs you, and a person marking it handled ----
async function flagged(db,workspaceId,{orderId=null}={}){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return [];
  const today=await require('../lib/business-time').today(db,workspaceId);
  const found=(await parcels(db,workspaceId,{orderId})).map(s=>({s,f:classify(s,today)})).filter(x=>x.f);
  if(!found.length)return [];
  const keys=found.flatMap(x=>[flagKey(x.s.id,x.f.problem),handledKey(x.s.id,x.f.problem)]);
  const events=new Map((await db.query('SELECT idempotency_key,created_at FROM sales_order_events WHERE workspace_id=$1 AND idempotency_key=ANY($2::text[])',[workspaceId,keys])).rows.map(r=>[r.idempotency_key,r.created_at]));
  const notes=new Map((await db.query(`SELECT shipment_id,id,status FROM customer_communications WHERE workspace_id=$1 AND message_kind='shipping_delay' AND shipment_id=ANY($2::text[])
    ORDER BY created_at DESC`,[workspaceId,found.map(x=>x.s.id)])).rows.reverse().map(r=>[r.shipment_id,r]));
  return found.filter(x=>events.has(flagKey(x.s.id,x.f.problem))).map(({s,f})=>({shipmentId:s.id,shipmentNumber:s.shipment_number,orderId:s.sales_order_id,
    orderNumber:s.order_number,customerName:s.customer_name,trackingNumber:s.tracking_number,problem:f.problem,detail:f.detail,due:f.due||null,
    flaggedAt:events.get(flagKey(s.id,f.problem)),handled:events.has(handledKey(s.id,f.problem)),delayEmail:notes.get(s.id)||null}));
}
const TITLE={late:n=>'The parcel for order '+n+' is late',stuck:n=>'The parcel for order '+n+' has stopped moving',lost:n=>'The carrier lost the parcel for order '+n,
  damaged:n=>'The parcel for order '+n+' was damaged',returned:n=>'The parcel for order '+n+' is coming back',exception:n=>'The carrier is having trouble delivering order '+n};
const NEXT={late:'Check the tracking and tell the customer if it matters to them.',stuck:'Check with the carrier and tell the customer if it matters to them.',
  lost:'Tell the customer and send a replacement or refund. A carrier claim can win the money back.',damaged:'Tell the customer and agree a replacement or refund. A carrier claim can win the money back.',
  returned:'Ask the customer where to send it, or whether they still want it.',exception:'Read what the carrier said and fix it with them, or tell the customer.'};
function title(row){return TITLE[row.problem](row.orderNumber);}
async function inbox(db,workspaceId){
  return (await flagged(db,workspaceId)).filter(r=>!r.handled).slice(0,25).map(r=>({kind:'shipping',importance:['lost','damaged','returned'].includes(r.problem)?'Urgent':'Needs You',
    priority:['lost','damaged'].includes(r.problem)?93:r.problem==='returned'?91:r.problem==='exception'?90:70,
    title:title(r),happened:r.detail,why:'StockChief watches every parcel until it is delivered.',
    recommendation:r.delayEmail?.status==='PREPARED'?'A delay email is written. Read it and send it with one tap.':NEXT[r.problem],
    href:'/orders/'+r.orderId+'#parcel-watch',actionLabel:'Open the order',sourceId:'parcel-watch:'+r.shipmentId+':'+r.problem,
    shipmentId:r.shipmentId,at:r.flaggedAt,createdAt:r.flaggedAt}));
}
async function forOrder(db,workspaceId,orderId){
  return (await flagged(db,workspaceId,{orderId})).map(r=>({...r,title:title(r),next:NEXT[r.problem]}));
}
async function markHandled(db,ctx,orderId,input){
  return db.transaction(async c=>{
    const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(user,require('../actions/permissions').OPERATE,'handle parcel problems');
    const row=(await flagged(c,ctx.workspaceId,{orderId})).find(r=>r.shipmentId===input.shipmentId&&r.problem===input.problem);
    if(!row)throw new ValidationError('This parcel problem changed. Open the order again to see the current one.');
    const done=(await c.query(`INSERT INTO sales_order_events(id,workspace_id,sales_order_id,event_type,detail,actor_user_id,idempotency_key,created_at)
      VALUES($1,$2,$3,'parcel_flag_handled',$4,$5,$6,$7) ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING id`,
    [newId('soevt'),ctx.workspaceId,orderId,JSON.stringify({shipmentId:row.shipmentId,problem:row.problem}),ctx.actorId,handledKey(row.shipmentId,row.problem),nowIso()])).rows[0];
    if(done)await audit.record(c,ctx,{action:'Marked a parcel problem handled',reference:row.shipmentNumber,before:{problem:row.problem},after:{handled:true}});
    return {replayed:!done};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={JOB,KIND,ACTION,classify,authority,run,schedule,inbox,forOrder,flagged,markHandled,editNotice,noticeAuthority,compose,STUCK_DAYS};

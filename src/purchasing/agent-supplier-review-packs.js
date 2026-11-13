'use strict';
// Job 164 (Pro and Custom): the quarterly supplier review pack, sent to each supplier.
//
// After each calendar quarter the worker prepares the review (agent-supplier-pack)
// for every active supplier with orders placed in that quarter, keeps the PDF it
// made, and sends it to the supplier's email on file from the owner's connected
// mailbox, through the ordinary outbound mail path. One pack per supplier and
// quarter: a replay finds the same pack and never sends twice.
//
// Pause holds the worker. The first 14 days, Watch only and a job set to Watch
// only prepare and keep the packs and send nothing. Ask me first (the job's
// mode, or the inventory not handling routine work) keeps them ready and the
// owner presses send. A missing supplier email, no connected mailbox, or two
// mailboxes with no choice made stop that pack and ask in Needs you.
const {ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const time=require('../lib/business-time');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const reports=require('../reports/agent-report-runs');
const source=require('./agent-supplier-pack');
const {hash}=require('../pricing/postgres-promotions');
const {newId}=require('../lib/util');

const JOB=164,ACTION='report.supplier_review_pack',KIND='reports.supplier-review-packs.v1',MAIL='supplier_review_pack';
const href='/autopilot/reviews/quarterly-supplier-pack';
const PACKS='stockchief_runtime.agent_supplier_review_packs',SETTINGS='stockchief_runtime.agent_supplier_review_settings';
const BATCH=25,EMAIL_LIMIT=2097152,EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDERED="p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')";
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const outbound=()=>require('../connections/postgres-outbound-mail');
function quarterOf(period){const end=reports.monthEnd(period);return {...source.quarter(require('../accounting/customer-money').addDays(end,1)),closing:period};}

// ---- Who may do what, right now -------------------------------------------

// 'automatic' sends on its own; 'ask' keeps the pack for the owner to send;
// 'watch' keeps it and sends nothing.
async function authority(db,workspaceId,state){
  const manual=await policy.stopped(db,workspaceId,state,ACTION,false);
  if(manual)return {mode:'watch',reason:manual};
  const automatic=await policy.stopped(db,workspaceId,state,ACTION,true);
  if(automatic)return {mode:'ask',reason:automatic};
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    return {mode:'ask',reason:'StockChief asks before it does routine work in this inventory. Press send for each pack.'};
  return {mode:'automatic',reason:null};
}
// The mailbox the pack is sent from: the owner's choice, else the only one connected.
async function mailbox(db,workspaceId){
  const saved=(await db.query(`SELECT connector_id FROM ${SETTINGS} WHERE workspace_id=$1`,[workspaceId])).rows[0];
  return require('../connections/agent-sending-mailbox').resolve(db,workspaceId,saved?.connector_id,'supplier packs');
}
// Facts the send needs, or the first one that is missing.
function missing(pack,supplier,sender){
  if(!supplier?.email||!EMAIL.test(supplier.email))return {problem:'recipient',reason:'Add an email address for '+pack.supplier_name+' so StockChief can send their pack.'};
  if(pack.file.length>EMAIL_LIMIT)return {problem:'size',reason:'This pack is too large to email. Download it and send it yourself.'};
  if(!sender.box)return {problem:sender.problem,reason:sender.reason};
  return null;
}

// ---- Preparing and keeping a pack ------------------------------------------

async function supplierRow(db,workspaceId,supplierId){
  return (await db.query("SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2",[workspaceId,supplierId])).rows[0]||null;
}
function words(pack){
  const s=pack.summary,label=s.span.label;
  return {subject:'Quarterly review · '+label+' · '+s.business,
    body:'Hello '+s.supplier+',\n\nAttached is our review of the orders we placed with you in '+label+' ('+s.span.start+' to '+s.span.end+').\n\n'+
      s.totals.map(t=>'· '+source.sentence(t)).join('\n')+
      '\n\nThe PDF lists every order line, what arrived by the end of the quarter and whether it arrived in full by the promised date. If your records differ, please reply to this email.\n\nThank you,\n'+s.business};
}
async function load(db,workspaceId,id,{lock=false}={}){
  return (await db.query(`SELECT * FROM ${PACKS} WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,String(id||'')])).rows[0]||null;
}
// Make (or bring up to date) one supplier's pack for a quarter, then send it if
// StockChief may. Returns what happened. Never sends a queued pack again.
async function prepare(c,ctx,supplierId,span,{automatic,state}){
  const existing=(await c.query(`SELECT * FROM ${PACKS} WHERE workspace_id=$1 AND supplier_id=$2 AND period=$3 FOR UPDATE`,[ctx.workspaceId,supplierId,span.closing])).rows[0];
  if(existing?.status==='QUEUED')return {pack:existing,replayed:true};
  const supplier=await supplierRow(c,ctx.workspaceId,supplierId);
  if(!supplier)throw new NotFoundError('That supplier is not in this inventory.');
  const facts=JSON.parse(JSON.stringify(await source.facts(c,ctx.workspaceId,supplier,span)));
  if(!facts.rows.length)return {pack:existing,skipped:'no_orders'};
  const {rows:_rows,...summary}=facts,fingerprint=hash(facts);
  let file=existing?.file,filename=existing?.filename;
  if(!existing||existing.fingerprint!==fingerprint){
    file=await source.pdf({...facts,rows:facts.rows});
    filename=('supplier-review-'+span.closing+'-'+supplier.id).replace(/[^-a-zA-Z0-9_.]/g,'-').slice(0,110)+'.pdf';
    await storage.reserve(reports.scoped(c),ctx.workspaceId,'supplier-review-pack:'+fingerprint.slice(0,48),file.length+4096,{finished:true});
  }
  const who=await authority(c,ctx.workspaceId,state);
  const sender=await mailbox(c,ctx.workspaceId);
  const draft={supplier_name:supplier.name,file};
  const lack=supplier.status==='active'?missing(draft,supplier,sender):{problem:'recipient',reason:supplier.name+' is no longer an active supplier.'};
  let status,reason=null,problem=null;
  if(who.mode==='watch'){status='WATCHED';reason=who.reason;}
  else if(lack){status='STOPPED';reason=lack.reason;problem=lack.problem;}
  else if(who.mode==='ask'||!automatic){status='WAITING';reason=who.mode==='ask'?who.reason:null;}
  else status='WAITING';
  const id=existing?.id||newId('supplierpack');
  await c.query(`INSERT INTO ${PACKS}(workspace_id,id,supplier_id,period,quarter_start,quarter_end,supplier_name,fingerprint,summary,file,filename,status,reason,problem)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT(workspace_id,id) DO UPDATE SET supplier_name=EXCLUDED.supplier_name,fingerprint=EXCLUDED.fingerprint,summary=EXCLUDED.summary,file=EXCLUDED.file,
      filename=EXCLUDED.filename,status=EXCLUDED.status,reason=EXCLUDED.reason,problem=EXCLUDED.problem,updated_at=clock_timestamp()`,
  [ctx.workspaceId,id,supplier.id,span.closing,span.start,span.end,supplier.name,fingerprint,JSON.stringify(summary),file,filename,status,reason,problem]);
  const changed=!existing||existing.fingerprint!==fingerprint||existing.status!==status||existing.problem!==problem;
  if(changed)await audit.record(c,ctx,{action:automatic?'StockChief prepared a supplier review pack':'Prepared a supplier review pack',reference:supplier.name+' · '+span.label,
    before:existing?{status:existing.status,fingerprint:existing.fingerprint}:{},after:{packId:id,status,reason,fingerprint}});
  const pack=await load(c,ctx.workspaceId,id);
  if(status==='WAITING'&&automatic&&who.mode==='automatic')return {pack:await queue(c,ctx,pack,{automatic:true,box:sender.box,recipient:supplier.email}),sent:true};
  return {pack,changed};
}

// ---- Sending ---------------------------------------------------------------

async function queue(c,ctx,pack,{automatic,box,recipient}){
  const attempt=pack.attempt||0,key='supplier-review-pack:'+pack.supplier_id+':'+pack.period+(attempt?':'+attempt:'');
  const grant={kind:MAIL,packId:pack.id,fingerprint:pack.fingerprint,attempt,automatic,actorId:ctx.actorId};
  const r=await outbound().queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:pack.supplier_id,recipientEmail:recipient,connectorId:box.id,...words(pack),standingAuthority:grant},key,{agentRequested:true,agentJob:JOB});
  await c.query(`UPDATE ${PACKS} SET status='QUEUED',reason=NULL,problem=NULL,communication_id=$3,recipient=$4,connector_id=$5,authorization_kind=$6,sent_by=$7,queued_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,pack.id,r.communicationId,recipient,box.id,automatic?'AUTOMATIC':'INDIVIDUAL',automatic?null:ctx.actorId]);
  await audit.record(c,ctx,{action:automatic?'StockChief sent a supplier review pack':'Sent a supplier review pack',reference:pack.supplier_name+' · '+pack.summary.span.label,
    after:{packId:pack.id,recipient,mailbox:box.display_name||box.provider_account_name||box.id,communicationId:r.communicationId,attempt}});
  return load(c,ctx.workspaceId,pack.id);
}
// The message behind a queued pack: QUEUED, SENDING, SENT or FAILED.
async function delivery(db,workspaceId,pack){
  if(!pack?.communication_id)return null;
  return (await db.query(`SELECT m.status,m.error_message,m.sent_at,e.status AS effect_status FROM supplier_communications m
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    WHERE m.workspace_id=$1 AND m.id=$2 ORDER BY e.created_at DESC LIMIT 1`,[workspaceId,pack.communication_id])).rows[0]||null;
}
async function access(db,ctx,operation='suggest'){await reports.owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,operation);}

// The owner presses send for one pack.
async function send(database,ctx,id,input={}){
  return tx(database,async c=>{
    const state=await access(c,ctx,'draft');
    if(await reports.paused(c,ctx.workspaceId))throw new ValidationError('StockChief is paused. Resume it to send supplier packs.');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
    let pack=await load(c,ctx.workspaceId,id,{lock:true});
    if(!pack)throw new NotFoundError('That supplier pack is not in this inventory.');
    if(pack.status==='QUEUED'){
      const sent=await delivery(c,ctx.workspaceId,pack);
      if(sent?.status!=='FAILED')return {pack,replayed:true};
      if(sent.effect_status!=='FAILED')throw new ValidationError('StockChief cannot tell whether the last email reached the supplier. Check the mailbox’s Sent folder before sending again.');
      await c.query(`UPDATE ${PACKS} SET attempt=attempt+1,status='WAITING',communication_id=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,pack.id]);
    }
    if(String(input.fingerprint||'')!==pack.fingerprint)throw new ValidationError('This pack changed after you opened it. Review it again before sending.');
    // Bring the figures up to date; a change means the owner reviews the new pack first.
    const refreshed=await prepare(c,ctx,pack.supplier_id,quarterOf(pack.period),{automatic:false,state});
    pack=refreshed.pack||await load(c,ctx.workspaceId,pack.id);
    if(pack.fingerprint!==String(input.fingerprint))return {pack,changed:true};
    if(pack.status==='WATCHED')throw new ValidationError(pack.reason);
    if(pack.status==='STOPPED')throw new ValidationError(pack.reason);
    const supplier=await supplierRow(c,ctx.workspaceId,pack.supplier_id),sender=await mailbox(c,ctx.workspaceId);
    return {pack:await queue(c,ctx,pack,{automatic:false,box:sender.box,recipient:supplier.email}),sent:true};
  });
}
// Send every pack of a quarter that is ready and waiting for the owner.
async function sendAll(database,ctx,input={}){
  const period=String(input.period||'');
  if(!reports.MONTH.test(period))throw new ValidationError('Choose the quarter to send.');
  await access(database,ctx,'draft');
  const waiting=(await database.query(`SELECT id,fingerprint FROM ${PACKS} WHERE workspace_id=$1 AND period=$2 AND status='WAITING' ORDER BY supplier_name,id LIMIT 200`,[ctx.workspaceId,period])).rows;
  let sent=0,changed=0;
  for(const p of waiting){const r=await send(database,ctx,p.id,{fingerprint:p.fingerprint});if(r.sent)sent++;if(r.changed)changed++;}
  return {sent,changed};
}
// The owner chooses the mailbox packs are sent from.
async function chooseMailbox(database,ctx,input={}){
  return tx(database,async c=>{
    await access(c,ctx,'draft');
    const box=(await outbound().mailboxes(c,ctx.workspaceId)).find(b=>b.id===String(input.connectorId||''));
    if(!box)throw new ValidationError('Choose one of your connected mailboxes.');
    const prior=(await c.query(`SELECT connector_id,revision FROM ${SETTINGS} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the page before changing the mailbox.');
    if(prior?.connector_id===box.id)return {unchanged:true};
    await c.query(`INSERT INTO ${SETTINGS}(workspace_id,connector_id,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET connector_id=EXCLUDED.connector_id,updated_by=EXCLUDED.updated_by,revision=agent_supplier_review_settings.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,box.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Chose the mailbox for supplier review packs',before:prior?{connectorId:prior.connector_id}:{},after:{connectorId:box.id,mailbox:box.display_name}});
    return {saved:true};
  });
}

// ---- The outbound mail boundary -------------------------------------------

// Checked again when the mailbox sends: the plan, pause, the first 14 days,
// the job's mode, the pack and the supplier's email must still hold.
async function deliveryAuthority(db,workspaceId,grant){
  if(grant?.kind!==MAIL)throw new ValidationError('This supplier pack email is not authorized.');
  const pack=await load(db,workspaceId,grant.packId);
  if(!pack||pack.status!=='QUEUED'||pack.fingerprint!==grant.fingerprint||Number(pack.attempt)!==Number(grant.attempt))
    throw new ValidationError('This supplier pack changed after it was queued. Review it before sending.');
  const state=await policy.requireWorkspaceJob(db,workspaceId,JOB,'draft');
  if(await reports.paused(db,workspaceId))throw new ValidationError('StockChief is paused. Resume it to send supplier packs.');
  const stop=await policy.stopped(db,workspaceId,state,ACTION,grant.automatic===true);if(stop)throw new ValidationError(stop);
  if(grant.automatic===true&&!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    throw new ValidationError('StockChief asks before it does routine work in this inventory. Press send for this pack.');
  const supplier=await supplierRow(db,workspaceId,pack.supplier_id);
  if(supplier?.status!=='active'||String(supplier.email||'').toLowerCase()!==String(pack.recipient).toLowerCase())
    throw new ValidationError('The supplier’s email changed after this pack was queued. Review it before sending.');
  return pack;
}
async function attachments(db,workspaceId,grant){
  const pack=await deliveryAuthority(db,workspaceId,grant);
  if(pack.file.length>EMAIL_LIMIT)throw new ValidationError('This pack is too large to email. Download it and send it yourself.');
  return [{filename:pack.filename,contentType:'application/pdf',content:Buffer.from(pack.file)}];
}

// ---- The worker -------------------------------------------------------------

// Suppliers with orders placed in the quarter whose pack is not yet sent.
async function pending(db,workspaceId,span,{after='',limit=BATCH}={}){
  const zone=(await time.forWorkspace(db,workspaceId)).timeZone;
  return (await db.query(`SELECT s.id FROM suppliers s WHERE s.workspace_id=$1 AND s.status='active' AND s.id>$5
    AND EXISTS(SELECT 1 FROM purchase_orders p WHERE p.workspace_id=s.workspace_id AND p.supplier_id=s.id AND ${ORDERED}
      AND p.ordered_at::timestamptz>=$2::timestamptz AND p.ordered_at::timestamptz<$3::timestamptz)
    AND NOT EXISTS(SELECT 1 FROM ${PACKS} k WHERE k.workspace_id=s.workspace_id AND k.supplier_id=s.id AND k.period=$4 AND k.status='QUEUED')
    ORDER BY s.id LIMIT $6`,[workspaceId,time.dayBoundary(span.start,zone),time.dayBoundary(span.finish,zone),span.closing,after,limit])).rows.map(r=>r.id);
}
async function run(database,workspaceId,payload={}){
  const actorId=await reports.currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},state=await policy.accountState(database,workspaceId);
  if(!reports.alone(state,JOB))return {skipped:'plan'};
  if(await reports.paused(database,workspaceId))return {held:'paused'};
  const span=source.quarter(await time.today(database,workspaceId));
  if(payload.period&&payload.period!==span.closing)return {skipped:'stale'};
  const ids=await pending(database,workspaceId,span,{after:String(payload.after||''),limit:BATCH+1});
  const out={prepared:0,sent:0,waiting:0,stopped:0,watched:0};
  for(const supplierId of ids.slice(0,BATCH)){
    const r=await tx(database,c=>prepare(c,ctx,supplierId,span,{automatic:true,state}));
    if(r.skipped)continue;
    out.prepared++;if(r.sent)out.sent++;else if(r.pack?.status==='WAITING')out.waiting++;else if(r.pack?.status==='STOPPED')out.stopped++;else if(r.pack?.status==='WATCHED')out.watched++;
  }
  if(ids.length>BATCH){
    const next=ids[BATCH-1];
    await require('../operations/postgres-job-queue').enqueue(database,{workspaceId,kind:KIND,priority:70,maxAttempts:3,
      idempotencyKey:'supplier-review-packs:'+span.closing+':after:'+next+':'+(await time.today(database,workspaceId)),payload:{period:span.closing,after:next}});
    out.continued=true;
  }
  return out;
}
async function schedule(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);if(!reports.alone(state,JOB))return {queued:0};
  if(!(await require('../db/schema-installed').has(db,PACKS)))return {queued:0};
  const today=await time.today(db,workspaceId),span=source.quarter(today);
  if(!(await pending(db,workspaceId,span,{limit:1})).length)return {queued:0};
  // Daily after the quarter ends until every supplier's pack is sent; the same facts replay to the same pack.
  const job=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:KIND,priority:70,maxAttempts:3,
    idempotencyKey:'supplier-review-packs:'+span.closing+':'+today,payload:{period:span.closing}});
  return {queued:job.created?1:0};
}
// On demand: prepare and keep the last quarter's packs now (the owner sends them).
async function prepareNow(database,ctx){
  const state=await access(database,ctx,'draft');
  if(await reports.paused(database,ctx.workspaceId))throw new ValidationError('StockChief is paused. Resume it to prepare supplier packs.');
  const span=source.quarter(await time.today(database,ctx.workspaceId));
  const zone=(await time.forWorkspace(database,ctx.workspaceId)).timeZone;
  const ids=(await database.query(`SELECT DISTINCT s.id FROM suppliers s JOIN purchase_orders p ON p.workspace_id=s.workspace_id AND p.supplier_id=s.id
    WHERE s.workspace_id=$1 AND s.status='active' AND ${ORDERED} AND p.ordered_at::timestamptz>=$2::timestamptz AND p.ordered_at::timestamptz<$3::timestamptz ORDER BY s.id LIMIT 51`,
  [ctx.workspaceId,time.dayBoundary(span.start,zone),time.dayBoundary(span.finish,zone)])).rows.map(r=>r.id);
  let prepared=0;
  for(const supplierId of ids.slice(0,50)){const r=await tx(database,c=>prepare(c,ctx,supplierId,span,{automatic:false,state}));if(!r.skipped&&!r.replayed)prepared++;}
  return {prepared,more:ids.length>50,period:span.closing};
}

// ---- Page, kept copies, Needs you ------------------------------------------

function display(pack,sent){
  if(pack.status==='QUEUED'){
    if(sent?.status==='SENT')return {label:'Sent',tone:'ok',detail:'Sent to '+pack.recipient};
    if(sent?.status==='FAILED')return {label:'Not sent',tone:'danger',detail:sent.error_message||'The mailbox did not send it.',retry:sent.effect_status==='FAILED'};
    return {label:'Sending',tone:'info',detail:'Queued for '+pack.recipient};
  }
  if(pack.status==='WAITING')return {label:'Ready to send',tone:'warn',detail:pack.reason||'Ready to send.',send:true};
  if(pack.status==='STOPPED')return {label:'Needs you',tone:'danger',detail:pack.reason};
  return {label:'Kept, not sent',tone:'info',detail:null};
}
async function page(db,ctx,query={}){
  const state=await access(db,ctx);
  const today=await time.today(db,ctx.workspaceId),current=source.quarter(today);
  const periods=[...new Set([current.closing,...(await db.query(`SELECT DISTINCT period FROM ${PACKS} WHERE workspace_id=$1 ORDER BY period DESC LIMIT 8`,[ctx.workspaceId])).rows.map(r=>r.period)])].sort().reverse();
  const period=periods.includes(String(query.period||''))?String(query.period):current.closing,span=quarterOf(period);
  const packs=(await db.query(`SELECT k.id,k.supplier_id,k.supplier_name,k.period,k.fingerprint,k.summary,k.status,k.reason,k.problem,k.recipient,k.communication_id,k.attempt,
      k.authorization_kind,k.queued_at,k.updated_at,k.filename,m.status AS sent_status,m.error_message,e.status AS effect_status
    FROM ${PACKS} k LEFT JOIN supplier_communications m ON m.workspace_id=k.workspace_id AND m.id=k.communication_id
    LEFT JOIN LATERAL (SELECT x.status FROM stockchief_runtime.provider_effects x WHERE x.workspace_id=m.workspace_id AND x.aggregate_id=m.id AND x.kind='mail.outbound.send'
      ORDER BY x.created_at DESC LIMIT 1) e ON true
    WHERE k.workspace_id=$1 AND k.period=$2 ORDER BY k.supplier_name,k.id LIMIT 500`,[ctx.workspaceId,period])).rows;
  for(const p of packs)p.view=display(p,p.communication_id?{status:p.sent_status,error_message:p.error_message,effect_status:p.effect_status}:null);
  const sender=await mailbox(db,ctx.workspaceId);
  const setting=(await db.query(`SELECT connector_id,revision FROM ${SETTINGS} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0]||null;
  const paused=await reports.paused(db,ctx.workspaceId);
  const who=policy.permits(state.plan,JOB,'draft')?await authority(db,ctx.workspaceId,state):{mode:'watch',reason:null};
  const lookupSpan=source.quarter(today,query.quarter),quarter=lookupSpan.end.slice(0,4)+'-Q'+Math.ceil(Number(lookupSpan.end.slice(5,7))/3);
  return {span,period,periods,current,packs,sender,setting,paused,who,shadow:Boolean(state.shadow),
    waiting:packs.filter(p=>p.status==='WAITING').length,
    lookupSpan,quarter,filter:String(query.filter||'').slice(0,150),
    lookup:'/autopilot/reviews/quarterly-supplier-pack/download?'+new URLSearchParams({quarter})};
}
async function kept(db,ctx,id){
  await access(db,ctx);
  const pack=await load(db,ctx.workspaceId,id);
  if(!pack)throw new NotFoundError('That supplier pack is not in this inventory.');
  return {filename:pack.filename,body:Buffer.from(pack.file)};
}
async function inbox(db,workspaceId){
  if(!(await require('../db/schema-installed').has(db,PACKS)))return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return [];
  const latest=(await db.query(`SELECT max(period) AS period FROM ${PACKS} WHERE workspace_id=$1`,[workspaceId])).rows[0]?.period;if(!latest)return [];
  const rows=(await db.query(`SELECT k.id,k.supplier_name,k.status,k.problem,k.reason,k.updated_at,m.status AS sent_status
    FROM ${PACKS} k LEFT JOIN supplier_communications m ON m.workspace_id=k.workspace_id AND m.id=k.communication_id
    WHERE k.workspace_id=$1 AND k.period=$2 AND (k.status IN ('WAITING','STOPPED') OR m.status='FAILED') ORDER BY k.supplier_name,k.id LIMIT 200`,[workspaceId,latest])).rows;
  const label=quarterOf(latest).label,link=href+'?'+new URLSearchParams({period:latest}),at=rows.map(r=>r.updated_at).sort().at(-1),out=[];
  const names=list=>list.slice(0,3).map(r=>r.supplier_name).join(', ')+(list.length>3?' and '+(list.length-3)+' more':'');
  const waiting=rows.filter(r=>r.status==='WAITING'),stopped=rows.filter(r=>r.status==='STOPPED'),failed=rows.filter(r=>r.sent_status==='FAILED');
  if(waiting.length)out.push({kind:'purchasing',importance:'Needs You',priority:45,title:waiting.length+' supplier review pack'+(waiting.length===1?' is':'s are')+' ready to send for '+label,
    happened:'Ready for '+names(waiting)+'.',why:'StockChief asks you before it sends these packs.',recommendation:'Check them and press send.',
    href:link,actionLabel:'Review and send',sourceId:'supplier-review-packs:waiting:'+latest,createdAt:at,at});
  for(const problem of ['recipient','mailbox','mailbox_choice','size']){
    const group=stopped.filter(r=>r.problem===problem);if(!group.length)continue;
    out.push({kind:'purchasing',importance:'Needs You',priority:50,
      title:problem==='recipient'?'Add an email for '+names(group)+' to send the '+label+' review pack':problem==='size'?'A supplier review pack is too large to email':
        problem==='mailbox_choice'?'Choose the mailbox for supplier review packs':'Connect a mailbox to send supplier review packs',
      happened:group[0].reason,why:'StockChief does not guess where to send a pack or which mailbox to send it from.',
      recommendation:problem==='recipient'?'Add the supplier’s email, then StockChief sends the pack.':'Fix this on the supplier packs page.',
      href:link,actionLabel:'Open supplier packs',sourceId:'supplier-review-packs:'+problem+':'+latest,createdAt:at,at});
  }
  if(failed.length)out.push({kind:'purchasing',importance:'Needs You',priority:50,title:failed.length+' supplier review pack'+(failed.length===1?' was':'s were')+' not sent',
    happened:'Not sent to '+names(failed)+'.',why:'The mailbox did not send '+(failed.length===1?'it':'them')+'.',recommendation:'Check the mailbox, then send again.',
    href:link,actionLabel:'Open supplier packs',sourceId:'supplier-review-packs:failed:'+latest,createdAt:at,at});
  return out;
}

module.exports={JOB,ACTION,KIND,MAIL,href,authority,mailbox,prepare,send,sendAll,chooseMailbox,deliveryAuthority,attachments,run,schedule,prepareNow,page,kept,inbox,words};

'use strict';
// Job 36 (Starter excluded, Growth draft, Pro and Custom alone): every week
// each key supplier gets our stock and a 12-week forecast of their own products.
//
// The owner chooses the key suppliers (one rule per supplier, counted as a
// taught rule) and, with several mailboxes, the one forecasts go out from.
// Every autopilot check (run) prepares this week's forecast for each key
// supplier that does not have one yet: that supplier's active products only,
// owned stock on hand and twelve weekly quantities from StockChief's demand
// forecast (supplier-forecast-source.js). Then, by what StockChief may do now:
//  - pause holds everything: nothing is prepared or sent, not even by the owner;
//  - the first 14 days and Watch only (the inventory's or this job's) keep the
//    forecast and send nothing;
//  - Growth, Ask me first, routine work off and the first forecast to a
//    supplier's email address keep it ready; the owner presses send;
//  - Pro and Custom otherwise send it on their own.
// A supplier with no email or no products, no mailbox, or two mailboxes with no
// choice made stop that forecast and ask in Needs you; StockChief never picks.
// One forecast per supplier and week: replays find the same one and the mail
// key is per supplier and week, so a supplier never gets two in a week. The
// mailbox checks the authority again just before sending. Every forecast
// prepared or sent, every key supplier and the mailbox choice are audited.
const source=require('./supplier-forecast-source'),policy=require('../commercial/agent-plan'),audit=require('../operations/postgres-security-audit');
const time=require('../lib/business-time'),installed=require('../db/schema-installed'),{newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions');
const {ValidationError,NotFoundError}=require('../domain/errors');

const JOB=36,ACTION='supplier.share_forecast',MAIL='supplier_forecast',href='/autopilot/supplier-forecasts';
const REPORTS='stockchief_runtime.agent_supplier_forecast_reports',RULES='stockchief_runtime.agent_supplier_forecast_rules',SETTINGS='stockchief_runtime.agent_supplier_forecast_settings';
const BATCH=25,FRESH_MS=86400000,EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,KEY='supplier-forecast-week:';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const outbound=()=>require('../connections/postgres-outbound-mail');
const ready=db=>installed.has(db,REPORTS,'status');
const monday=source.monday;

// ---- Who may do what, right now --------------------------------------------

async function paused(db,workspaceId){
  const pilot=(await db.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  return Boolean(Number(pilot?.paused)||Number(pilot?.suspended));
}
// 'automatic' sends on its own; 'ask' keeps the forecast for the owner; 'watch'
// keeps it and sends nothing.
async function authority(db,workspaceId,state){
  const manual=await policy.stopped(db,workspaceId,state,ACTION,false);
  if(manual)return {mode:'watch',reason:manual};
  if(!policy.permits(state.plan,JOB,'automatic'))return {mode:'ask',reason:'Your plan asks you to check each forecast before it is sent.'};
  const automatic=await policy.stopped(db,workspaceId,state,ACTION,true);
  if(automatic)return {mode:'ask',reason:automatic};
  if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
    return {mode:'ask',reason:'StockChief asks before it does routine work in this inventory. Press send for each forecast.'};
  return {mode:'automatic',reason:null};
}
// The mailbox forecasts are sent from: the owner's choice, else the only one connected.
async function mailbox(db,workspaceId){
  const saved=(await db.query(`SELECT connector_id FROM ${SETTINGS} WHERE workspace_id=$1`,[workspaceId])).rows[0];
  return require('../connections/agent-sending-mailbox').resolve(db,workspaceId,saved?.connector_id,'supplier forecasts');
}
// A person checks the first forecast to each supplier email address (page 13).
async function firstTime(db,workspaceId,supplierId,recipient){
  return !(await db.query(`SELECT 1 FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    WHERE m.workspace_id=$1 AND m.supplier_id=$2 AND lower(m.recipient)=lower($3) AND m.status='SENT' AND e.payload->'standingAuthority'->>'kind'='supplier_forecast' LIMIT 1`,
  [workspaceId,supplierId,recipient])).rowCount;
}
async function access(db,ctx,operation='draft'){return source.access(db,ctx,operation);}
async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.workspace_id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}

// ---- The email -------------------------------------------------------------

function words(p){
  const number=v=>String(v);
  const rows=p.rows.map(row=>row.sku+' · '+row.name+'\nStock on hand: '+row.onHand+' '+row.unit+(row.needsReview?' (includes a negative stock record)':'')+'\n'+
    (row.total===null?'Next 12 weeks: not enough sales history to forecast yet.':'Next 12 weeks: '+number(row.total)+' '+row.unit+'\n'+
      row.weeks.map((w,i)=>'Week '+(i+1)+' ('+w.from+' to '+w.to+'): '+number(w.quantity)+' '+row.unit).join('\n')));
  const body='Hello '+p.supplierName+',\n\nHere is our stock and our 12-week demand forecast for the products we buy from you.\nPrepared '+p.today+' ('+p.timeZone+').\n\n'+
    rows.join('\n\n')+'\n\nStock on hand is what we hold at our own sites as of today. It does not subtract orders we have already promised to customers.\n'+
    'The forecast comes from our recorded sales from '+p.historyFrom+' to '+p.historyThrough+', with weekly and yearly patterns where the history shows them.\n\n'+
    'This is for planning only. It is not a purchase order or a promise to buy. No prices, costs or customer details are included.\n\nThank you.';
  if(body.length>100000)throw new ValidationError('This forecast is too long for one email. Remove some of this supplier’s products, then prepare it again.');
  return {subject:'Our stock and 12-week forecast · '+p.today,body};
}

// ---- Preparing one supplier's forecast for this week -----------------------

async function load(db,workspaceId,id,{lock=false}={}){
  return (await db.query(`SELECT *,week_start::text AS week_start FROM ${REPORTS} WHERE workspace_id=$1 AND id=$2 AND status IS NOT NULL${lock?' FOR UPDATE':''}`,[workspaceId,String(id||'')])).rows[0]||null;
}
async function supplierRow(db,workspaceId,supplierId){
  return (await db.query('SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id=$2',[workspaceId,supplierId])).rows[0]||null;
}
// The first fact the send needs that is missing, or null.
function missing(supplier,list,sender){
  if(!supplier||supplier.status!=='active')return {problem:'recipient',reason:(supplier?.name||'This supplier')+' is no longer an active supplier.'};
  if(!EMAIL.test(supplier.email||''))return {problem:'recipient',reason:'Add an email address for '+supplier.name+' so StockChief can send their forecast.'};
  if(!list.length)return {problem:'products',reason:'No products are linked to '+supplier.name+'. Add the products you buy from them, then StockChief prepares their forecast.'};
  if(list.length>source.MAX_PRODUCTS)return {problem:'products',reason:supplier.name+' has more than '+source.MAX_PRODUCTS+' products, too many for one email. Mark the ones you no longer buy from them as inactive.'};
  if(!sender.box)return {problem:sender.problem,reason:sender.reason};
  return null;
}
// Make (or bring up to date) this week's forecast for one key supplier, then
// send it if StockChief may (`mayQueue`). A forecast handed to the mailbox is
// never prepared or sent again; a snapshot under a day old is kept as it is.
async function prepare(c,ctx,rule,{mayQueue,state,refresh=false}){
  const clock=await time.forWorkspace(c,ctx.workspaceId),week=monday(clock.calendarDate);
  const existing=(await c.query(`SELECT *,week_start::text AS week_start FROM ${REPORTS} WHERE workspace_id=$1 AND supplier_id=$2 AND week_start=$3 AND status IS NOT NULL FOR UPDATE`,
    [ctx.workspaceId,rule.supplier_id,week])).rows[0];
  if(existing?.status==='QUEUED')return {report:existing,replayed:true};
  if((await c.query('SELECT 1 FROM supplier_communications WHERE workspace_id=$1 AND idempotency_key=$2',[ctx.workspaceId,'supplier-forecast:'+rule.supplier_id+':'+week])).rowCount)
    return {skipped:'sent_this_week'};
  const supplier=await supplierRow(c,ctx.workspaceId,rule.supplier_id);
  if(!supplier)throw new NotFoundError('That supplier is not in this inventory.');
  const list=await source.products(c,ctx.workspaceId,supplier.id),shown=list.slice(0,source.MAX_PRODUCTS);
  const old=existing?.snapshot,fresh=old&&!refresh&&Date.parse(clock.instant)-Date.parse(old.preparedAt)<FRESH_MS&&old.today<=clock.calendarDate&&
    old.recipient===(supplier.email||null)&&old.supplierName===supplier.name&&hash(old.rows.map(r=>[r.skuId,r.sku,r.name,r.unit]))===hash(shown.map(p=>[p.id,p.code,p.name,p.unit_label]));
  const facts=fresh?old:await source.snapshot(c,ctx,supplier,shown);
  const who=await authority(c,ctx.workspaceId,state),sender=await mailbox(c,ctx.workspaceId),lack=missing(supplier,list,sender);
  const first=!lack&&await firstTime(c,ctx.workspaceId,supplier.id,supplier.email);
  let status,reason=null,problem=null;
  if(who.mode==='watch'){status='WATCHED';reason=who.reason;}
  else if(lack){status='STOPPED';reason=lack.reason;problem=lack.problem;}
  else{status='WAITING';reason=first?'This is the first forecast to '+supplier.email+'. A person checks the first email to each supplier.':who.mode==='ask'?who.reason:null;}
  if(!lack)words(facts);
  const id=existing?.id||newId('forecast'),connector=sender.box?.id||null;
  await c.query(`INSERT INTO ${REPORTS}(id,workspace_id,supplier_id,connector_id,prepared_by,request_key,input_hash,snapshot,source_fingerprint,week_start,rule_id,status,reason,problem,recipient,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp())
    ON CONFLICT(workspace_id,request_key) DO UPDATE SET connector_id=EXCLUDED.connector_id,prepared_by=EXCLUDED.prepared_by,snapshot=EXCLUDED.snapshot,source_fingerprint=EXCLUDED.source_fingerprint,
      rule_id=EXCLUDED.rule_id,status=EXCLUDED.status,reason=EXCLUDED.reason,problem=EXCLUDED.problem,recipient=EXCLUDED.recipient,updated_at=clock_timestamp()`,
  [id,ctx.workspaceId,supplier.id,connector,ctx.actorId,'week:'+supplier.id+':'+week,hash({supplierId:supplier.id,week}),JSON.stringify(facts),facts.sourceFingerprint,week,rule.id,status,reason,problem,supplier.email||null]);
  const changed=!existing||existing.source_fingerprint!==facts.sourceFingerprint||existing.status!==status||existing.problem!==problem;
  if(changed)await audit.record(c,ctx,{action:mayQueue?'StockChief prepared a supplier forecast':'Prepared a supplier forecast',reference:supplier.name+' · week of '+week,
    before:existing?{status:existing.status,fingerprint:existing.source_fingerprint}:{},after:{reportId:id,status,reason,products:facts.skuIds.length,fingerprint:facts.sourceFingerprint}});
  const report=await load(c,ctx.workspaceId,id);
  if(status==='WAITING'&&mayQueue&&who.mode==='automatic'&&!first)
    return {report:await queue(c,ctx,report,{automatic:true,box:sender.box,rule}),sent:true};
  return {report,changed};
}

// ---- Sending ---------------------------------------------------------------

async function queue(c,ctx,report,{automatic,box,rule=null}){
  const attempt=report.attempt||0,key=KEY+report.supplier_id+':'+report.week_start+(attempt?':'+attempt:'');
  const grant={kind:MAIL,version:2,reportId:report.id,fingerprint:report.source_fingerprint,attempt,automatic,actorId:ctx.actorId,
    ...(automatic?{ruleId:rule.id,ruleRevision:rule.revision}:{})};
  const r=await outbound().queueInTransaction(c,ctx,{recipientKind:'supplier',recipientId:report.supplier_id,recipientEmail:report.recipient,connectorId:box.id,
    ...words(report.snapshot),standingAuthority:grant},key,{agentRequested:true,agentJob:JOB});
  await c.query(`UPDATE ${REPORTS} SET status='QUEUED',reason=NULL,problem=NULL,communication_id=$3,connector_id=$4,authorization_kind=$5,sent_by=$6,queued_at=clock_timestamp(),updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,report.id,r.communicationId,box.id,automatic?'AUTOMATIC':'INDIVIDUAL',automatic?null:ctx.actorId]);
  await audit.record(c,ctx,{action:automatic?'StockChief sent a supplier forecast':'Sent a supplier forecast',reference:report.snapshot.supplierName+' · week of '+report.week_start,
    after:{reportId:report.id,recipient:report.recipient,mailbox:box.display_name||box.provider_account_name||box.id,communicationId:r.communicationId,products:report.snapshot.skuIds.length,attempt}});
  return load(c,ctx.workspaceId,report.id);
}
// The message behind a queued forecast: QUEUED, SENDING, SENT or FAILED.
async function delivery(db,workspaceId,report){
  if(!report?.communication_id)return null;
  return (await db.query(`SELECT m.status,m.error_message,m.sent_at,e.status AS effect_status FROM supplier_communications m
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    WHERE m.workspace_id=$1 AND m.id=$2 ORDER BY e.created_at DESC LIMIT 1`,[workspaceId,report.communication_id])).rows[0]||null;
}
async function ruleFor(db,workspaceId,supplierId,{lock=false}={}){
  return (await db.query(`SELECT *,next_due_on::text AS next_due_on FROM ${RULES} WHERE workspace_id=$1 AND supplier_id=$2${lock?' FOR UPDATE':''}`,[workspaceId,supplierId])).rows[0]||null;
}

// The owner presses send for one forecast.
async function send(database,ctx,id,input={}){
  return tx(database,async c=>{
    const state=await access(c,ctx,'draft');
    if(await paused(c,ctx.workspaceId))throw new ValidationError('StockChief is paused. Resume it to send supplier forecasts.');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
    let report=await load(c,ctx.workspaceId,id,{lock:true});
    if(!report)throw new NotFoundError('That supplier forecast is not in this inventory.');
    if(report.week_start!==monday(await time.today(c,ctx.workspaceId)))throw new ValidationError('This forecast is for an earlier week. StockChief prepares a new one each week.');
    if(report.status==='QUEUED'){
      const sent=await delivery(c,ctx.workspaceId,report);
      if(sent?.status!=='FAILED')return {report,replayed:true};
      if(sent.effect_status!=='FAILED')throw new ValidationError('StockChief cannot tell whether the last email reached the supplier. Check the mailbox’s Sent folder before sending again.');
      await c.query(`UPDATE ${REPORTS} SET attempt=attempt+1,status='WAITING',communication_id=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,report.id]);
    }
    if(String(input.fingerprint||'')!==report.source_fingerprint)throw new ValidationError('This forecast changed after you opened it. Check it again before sending.');
    const rule=await ruleFor(c,ctx.workspaceId,report.supplier_id);
    if(!rule?.enabled)throw new ValidationError('This supplier is no longer a key supplier. Add them again to send their forecast.');
    // Bring it up to date; changed figures mean the owner checks the new forecast first.
    const refreshed=await prepare(c,ctx,rule,{mayQueue:false,state});
    report=refreshed.report||await load(c,ctx.workspaceId,report.id);
    if(report.source_fingerprint!==String(input.fingerprint))return {report,changed:true};
    if(report.status==='WATCHED'||report.status==='STOPPED')throw new ValidationError(report.reason);
    const sender=await mailbox(c,ctx.workspaceId);
    return {report:await queue(c,ctx,report,{automatic:false,box:sender.box}),sent:true};
  });
}
// Send every forecast of this week that waits for the owner.
async function sendAll(database,ctx){
  await access(database,ctx,'draft');
  const week=monday(await time.today(database,ctx.workspaceId));
  const waiting=(await database.query(`SELECT id,source_fingerprint FROM ${REPORTS} WHERE workspace_id=$1 AND week_start=$2 AND status='WAITING' ORDER BY id LIMIT 200`,[ctx.workspaceId,week])).rows;
  let sent=0,changed=0;
  for(const r of waiting){const out=await send(database,ctx,r.id,{fingerprint:r.source_fingerprint});if(out.sent)sent++;if(out.changed)changed++;}
  return {sent,changed};
}
// The owner chooses the mailbox forecasts are sent from.
async function chooseMailbox(database,ctx,input={}){
  return tx(database,async c=>{
    await access(c,ctx,'draft');
    const box=(await outbound().mailboxes(c,ctx.workspaceId)).find(b=>b.id===String(input.connectorId||''));
    if(!box)throw new ValidationError('Choose one of your connected mailboxes.');
    const prior=(await c.query(`SELECT connector_id,revision FROM ${SETTINGS} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision||0)!==(prior?.revision||0))throw new ValidationError('Reload the page before changing the mailbox.');
    if(prior?.connector_id===box.id)return {unchanged:true};
    await c.query(`INSERT INTO ${SETTINGS}(workspace_id,connector_id,updated_by) VALUES($1,$2,$3)
      ON CONFLICT(workspace_id) DO UPDATE SET connector_id=EXCLUDED.connector_id,updated_by=EXCLUDED.updated_by,revision=agent_supplier_forecast_settings.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,box.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Chose the mailbox for supplier forecasts',before:prior?{connectorId:prior.connector_id}:{},after:{connectorId:box.id,mailbox:box.display_name}});
    return {saved:true};
  });
}

// ---- Key suppliers ----------------------------------------------------------

async function addKey(database,ctx,input={}){
  return tx(database,async c=>{
    await access(c,ctx,'draft');
    const supplier=await supplierRow(c,ctx.workspaceId,String(input.supplierId||''));
    if(!supplier||supplier.status!=='active')throw new ValidationError('Choose an active supplier.');
    const prior=await ruleFor(c,ctx.workspaceId,supplier.id,{lock:true});
    if(prior?.enabled)return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],1);
    const today=await time.today(c,ctx.workspaceId),scope={supplierId:supplier.id,products:'supplier'};
    await c.query(`INSERT INTO ${RULES}(id,workspace_id,supplier_id,connector_id,authorized_by,scope,scope_hash,next_due_on) VALUES($1,$2,$3,NULL,$4,$5,$6,$7)
      ON CONFLICT(workspace_id,supplier_id) DO UPDATE SET connector_id=NULL,authorized_by=EXCLUDED.authorized_by,scope=EXCLUDED.scope,scope_hash=EXCLUDED.scope_hash,
        next_due_on=EXCLUDED.next_due_on,enabled=true,revision=agent_supplier_forecast_rules.revision+1,retry_after=NULL,problem=NULL,updated_at=now()`,
    [prior?.id||newId('forecastrule'),ctx.workspaceId,supplier.id,ctx.actorId,JSON.stringify(scope),hash(scope),today]);
    await audit.record(c,ctx,{action:'Made a key supplier for weekly forecasts',reference:supplier.name,after:{supplierId:supplier.id,from:today}});
    return {saved:true};
  });
}
async function removeKey(database,ctx,input={}){
  return tx(database,async c=>{
    await source.owner(c,ctx);
    const rule=(await c.query(`SELECT r.*,s.name FROM ${RULES} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id WHERE r.workspace_id=$1 AND r.id=$2 FOR UPDATE OF r`,
      [ctx.workspaceId,String(input.ruleId||'')])).rows[0];
    if(!rule||rule.revision!==Number(input.revision))throw new ValidationError('Reload the page before changing your key suppliers.');
    if(!rule.enabled)return {unchanged:true};
    await c.query(`UPDATE ${RULES} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,rule.id]);
    await audit.record(c,ctx,{action:'Stopped weekly forecasts to a supplier',reference:rule.name,after:{supplierId:rule.supplier_id}});
    return {saved:true};
  });
}

// ---- The outbound mail boundary --------------------------------------------

// Checked when the forecast is queued and again just before the mailbox sends:
// the plan, pause, the first 14 days, the job's mode, the forecast, the key
// supplier, its email and the chosen mailbox must still hold.
async function deliveryAuthority(db,workspaceId,grant){
  if(grant?.kind!==MAIL||grant.version!==2||!grant.reportId)
    throw new ValidationError('This forecast was prepared before weekly forecasts changed. StockChief prepares a new one this week.');
  const report=await load(db,workspaceId,grant.reportId);
  if(!report||report.source_fingerprint!==grant.fingerprint||Number(report.attempt)!==Number(grant.attempt)||report.status!=='QUEUED')
    throw new ValidationError('This supplier forecast changed after it was queued. Check it before sending.');
  const state=await policy.requireWorkspaceJob(db,workspaceId,JOB,grant.automatic===true?'automatic':'draft');
  if(await paused(db,workspaceId))throw new ValidationError('StockChief is paused. Resume it to send supplier forecasts.');
  const stop=await policy.stopped(db,workspaceId,state,ACTION,grant.automatic===true);if(stop)throw new ValidationError(stop);
  const rule=await ruleFor(db,workspaceId,report.supplier_id);
  if(!rule?.enabled)throw new ValidationError('This supplier is no longer a key supplier, so the forecast was not sent.');
  if(grant.automatic===true){
    if(!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)
      throw new ValidationError('StockChief asks before it does routine work in this inventory. Press send for this forecast.');
    if(rule.id!==grant.ruleId||rule.revision!==grant.ruleRevision)throw new ValidationError('This key supplier changed after the forecast was queued. Check it before sending.');
  }
  const supplier=await supplierRow(db,workspaceId,report.supplier_id);
  if(supplier?.status!=='active'||String(supplier.email||'').toLowerCase()!==String(report.recipient||'').toLowerCase())
    throw new ValidationError('The supplier’s email changed after this forecast was queued. Check it before sending.');
  const sender=await mailbox(db,workspaceId);
  if(!sender.box||(report.connector_id&&sender.box.id!==report.connector_id))throw new ValidationError('The mailbox for supplier forecasts changed. Check the forecast before sending.');
  return report;
}

// ---- The worker -------------------------------------------------------------

// Key suppliers due this week whose forecast is not handed to the mailbox yet.
async function pending(db,workspaceId,today,limit){
  const week=monday(today);
  return (await db.query(`SELECT r.*,r.next_due_on::text AS next_due_on FROM ${RULES} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    WHERE r.workspace_id=$1 AND r.enabled AND r.next_due_on<=$2::date
      AND NOT EXISTS(SELECT 1 FROM ${REPORTS} k WHERE k.workspace_id=r.workspace_id AND k.supplier_id=r.supplier_id AND k.week_start=$3::date AND k.status='QUEUED')
      AND NOT EXISTS(SELECT 1 FROM supplier_communications m WHERE m.workspace_id=r.workspace_id AND m.idempotency_key='supplier-forecast:'||r.supplier_id||':'||$3)
    ORDER BY r.next_due_on,r.id LIMIT $4`,[workspaceId,today,week,limit])).rows;
}
async function run(database,workspaceId){
  if(!await ready(database))return {skipped:'upgrade'};
  const state=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return {skipped:'plan'};
  if(await paused(database,workspaceId))return {held:'paused'};
  const actorId=await currentOwner(database,workspaceId);if(!actorId)return {skipped:'owner_unavailable'};
  const ctx={workspaceId,actorId},rules=await pending(database,workspaceId,await time.today(database,workspaceId),BATCH);
  const out={prepared:0,queued:0,waiting:0,stopped:0,watched:0};
  for(const rule of rules){
    const r=await tx(database,c=>prepare(c,ctx,rule,{mayQueue:true,state}));
    if(r.skipped||r.replayed)continue;
    if(r.changed||r.sent)out.prepared++;
    if(r.sent)out.queued++;else out[r.report.status.toLowerCase()]++;
  }
  return out;
}
// The owner prepares this week's forecasts now. StockChief still sends only
// what it may send on its own.
async function prepareNow(database,ctx){
  const state=await access(database,ctx,'draft');
  if(await paused(database,ctx.workspaceId))throw new ValidationError('StockChief is paused. Resume it to prepare supplier forecasts.');
  const rules=(await database.query(`SELECT *,next_due_on::text AS next_due_on FROM ${RULES} WHERE workspace_id=$1 AND enabled ORDER BY id LIMIT 51`,[ctx.workspaceId])).rows;
  if(!rules.length)throw new ValidationError('Choose a key supplier first.');
  let prepared=0;
  for(const rule of rules.slice(0,50)){const r=await tx(database,c=>prepare(c,ctx,rule,{mayQueue:true,state,refresh:true}));if(!r.skipped&&!r.replayed)prepared++;}
  return {prepared,more:rules.length>50};
}

// ---- Page and Needs you ----------------------------------------------------

function display(report,sent){
  if(report.status==='QUEUED'){
    if(sent?.status==='SENT')return {label:'Sent',tone:'ok',detail:'Sent to '+report.recipient};
    if(sent?.status==='FAILED')return {label:'Not sent',tone:'danger',detail:sent.error_message||'The mailbox did not send it.',retry:sent.effect_status==='FAILED'};
    return {label:'Sending',tone:'info',detail:'Queued for '+report.recipient};
  }
  if(report.status==='WAITING')return {label:'Ready to send',tone:'warn',detail:report.reason||'Ready to send.',send:true};
  if(report.status==='STOPPED')return {label:'Needs you',tone:'danger',detail:report.reason};
  return {label:'Kept, not sent',tone:'info',detail:report.reason};
}
async function page(db,ctx,query={}){
  const state=await access(db,ctx,'draft');
  if(!await ready(db))return {upgrading:true,week:null,today:null,q:'',rules:[],reports:[],suppliers:[],moreSuppliers:false,sender:{boxes:[]},setting:null,paused:false,
    shadow:Boolean(state.shadow),who:{mode:'watch',reason:null},alone:false,chosen:null,chosenWords:null,waiting:0};
  const today=await time.today(db,ctx.workspaceId),week=monday(today),q=String(query.q||'').trim().slice(0,120);
  const rules=(await db.query(`SELECT r.id,r.supplier_id,r.revision,r.enabled,r.next_due_on::text AS next_due_on,s.name,s.email FROM ${RULES} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    WHERE r.workspace_id=$1 AND r.enabled ORDER BY s.name,r.id LIMIT 200`,[ctx.workspaceId])).rows;
  const reports=(await db.query(`SELECT k.*,k.week_start::text AS week_start,m.status AS sent_status,m.error_message,e.status AS effect_status
    FROM ${REPORTS} k LEFT JOIN supplier_communications m ON m.workspace_id=k.workspace_id AND m.id=k.communication_id
    LEFT JOIN LATERAL (SELECT x.status FROM stockchief_runtime.provider_effects x WHERE x.workspace_id=m.workspace_id AND x.aggregate_id=m.id AND x.kind='mail.outbound.send' ORDER BY x.created_at DESC LIMIT 1) e ON true
    WHERE k.workspace_id=$1 AND k.week_start=$2 AND k.status IS NOT NULL ORDER BY k.snapshot->>'supplierName',k.id LIMIT 200`,[ctx.workspaceId,week])).rows;
  for(const r of reports)r.view=display(r,r.communication_id?{status:r.sent_status,error_message:r.error_message,effect_status:r.effect_status}:null);
  const keyIds=new Set(rules.map(r=>r.supplier_id));
  const suppliers=(await db.query(`SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND status='active' AND ($2='' OR name ILIKE '%'||$2||'%') ORDER BY name,id LIMIT 251`,[ctx.workspaceId,q])).rows.filter(s=>!keyIds.has(s.id));
  const chosen=query.id?reports.find(r=>r.id===String(query.id))||await load(db,ctx.workspaceId,query.id):null;
  if(query.id&&!chosen)throw new NotFoundError('That supplier forecast is not in this inventory.');
  const setting=(await db.query(`SELECT connector_id,revision FROM ${SETTINGS} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0]||null;
  return {week,today,q,rules,reports,suppliers:suppliers.slice(0,50),moreSuppliers:suppliers.length>50,sender:await mailbox(db,ctx.workspaceId),setting,
    paused:await paused(db,ctx.workspaceId),shadow:Boolean(state.shadow),who:await authority(db,ctx.workspaceId,state),alone:policy.permits(state.plan,JOB,'automatic'),
    chosen,chosenWords:chosen&&!chosen.problem?words(chosen.snapshot):null,waiting:reports.filter(r=>r.status==='WAITING').length};
}
async function inbox(db,workspaceId){
  if(!await ready(db))return [];
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return [];
  const week=monday(await time.today(db,workspaceId));
  const rows=(await db.query(`SELECT k.id,k.snapshot->>'supplierName' AS supplier_name,k.status,k.problem,k.reason,k.updated_at,m.status AS sent_status
    FROM ${REPORTS} k LEFT JOIN supplier_communications m ON m.workspace_id=k.workspace_id AND m.id=k.communication_id
    WHERE k.workspace_id=$1 AND k.week_start=$2 AND (k.status IN ('WAITING','STOPPED') OR m.status='FAILED') ORDER BY 2,k.id LIMIT 200`,[workspaceId,week])).rows;
  if(!rows.length)return [];
  const at=rows.map(r=>r.updated_at).sort().at(-1),out=[];
  const names=list=>list.slice(0,3).map(r=>r.supplier_name).join(', ')+(list.length>3?' and '+(list.length-3)+' more':'');
  const waiting=rows.filter(r=>r.status==='WAITING'),stopped=rows.filter(r=>r.status==='STOPPED'),failed=rows.filter(r=>r.sent_status==='FAILED');
  if(waiting.length)out.push({kind:'purchasing',importance:'Needs You',priority:45,title:waiting.length+' supplier forecast'+(waiting.length===1?' is':'s are')+' ready to send',
    happened:'This week’s stock and 12-week forecast for '+names(waiting)+'.',why:waiting[0].reason||'StockChief asks you before it sends these forecasts.',
    recommendation:'Check them and press send.',href,actionLabel:'Review and send',sourceId:'supplier-forecasts:waiting:'+week,createdAt:at,at});
  for(const problem of ['recipient','products','mailbox','mailbox_choice']){
    const group=stopped.filter(r=>r.problem===problem);if(!group.length)continue;
    out.push({kind:'purchasing',importance:'Needs You',priority:50,
      title:problem==='recipient'?'Add an email for '+names(group)+' to send their forecast':problem==='products'?'Link products to '+names(group)+' to send their forecast':
        problem==='mailbox_choice'?'Choose the mailbox for supplier forecasts':'Connect a mailbox to send supplier forecasts',
      happened:group[0].reason,why:'StockChief does not guess where to send a forecast, what is in it or which mailbox to send it from.',
      recommendation:'Fix this, then StockChief sends the forecast.',href,actionLabel:'Open supplier forecasts',sourceId:'supplier-forecasts:'+problem+':'+week,createdAt:at,at});
  }
  if(failed.length)out.push({kind:'purchasing',importance:'Needs You',priority:50,title:failed.length+' supplier forecast'+(failed.length===1?' was':'s were')+' not sent',
    happened:'Not sent to '+names(failed)+'.',why:'The mailbox did not send '+(failed.length===1?'it':'them')+'.',recommendation:'Check the mailbox, then send again.',
    href,actionLabel:'Open supplier forecasts',sourceId:'supplier-forecasts:failed:'+week,createdAt:at,at});
  return out;
}

module.exports={JOB,ACTION,MAIL,href,authority:deliveryAuthority,who:authority,mailbox,prepare,send,sendAll,chooseMailbox,addKey,removeKey,run,prepareNow,page,inbox,words,monday,load,
  definition:{id:JOB,key:'supplier-forecasts',label:'Share stock and a 12-week forecast with key suppliers every week',
    readPage:async()=>({summary:'Choose your key suppliers. Each week StockChief prepares their own products’ stock and 12-week forecast and sends it from your mailbox. Growth asks you to send each one; Pro and Custom send on their own.',
      rows:[{Action:'Key suppliers and this week’s forecasts',link:href}],more:false})}};

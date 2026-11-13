'use strict';

// Job 156: the daily briefing is delivered on its own, alone on every plan.
//
// At the owner's chosen time (7:00 every day until they choose), the worker
// delivers the briefing of the previous business day: what happened (stock
// receipts, issues, transfers and adjustments, work StockChief finished,
// verified work) and what needs the owner now (approvals waiting, late orders,
// shipments and invoices, stock-outs and low stock). It shows in Needs you on
// every mode, because it changes nothing, and is emailed from the connected
// mailbox the owner chose to the people they chose (the owner until they
// choose), each with their own Needs you list. With "Monday to Friday" the
// Monday briefing covers the weekend too. The email waits during the first 14
// days, pause, Watch only and Ask me first (where the owner presses send), and
// when no mailbox was chosen or a chosen person left; each delivery is
// audited and a replay delivers nothing twice. The plan, mode, mailbox and
// person are checked again just before the mailbox sends.

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const time=require('../lib/business-time');
const config=require('../config');
const {addDays}=require('../accounting/customer-money');
const {ValidationError}=require('../domain/errors');

const JOB=156,ACTION='report.briefing',key='daily-briefing',path='/autopilot/reviews/'+key;
const table='stockchief_runtime.agent_briefing_deliveries',settingsTable='stockchief_runtime.agent_report_email_settings';
const DEFAULT={send_hour:7,send_minute:0,send_days:'daily'};
const mail=()=>require('../reports/agent-report-email');
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);

async function ready(db){return await installed.has(db,table)&&await installed.has(db,settingsTable);}
const weekend=day=>[0,6].includes(new Date(day+'T12:00:00Z').getUTCDay());
// The first chosen time after `after`, in the business's time zone.
function slotAfter(s,zone,after){
  const today=time.context(zone,after).calendarDate;
  for(let n=0;n<10;n++){
    const day=addDays(today,n);
    if(s.send_days==='weekdays'&&weekend(day))continue;
    const at=time.wall(day,Number(s.send_hour),Number(s.send_minute),zone);
    if(at&&at>after)return at;
  }
  return null;
}
// Called when the routine check writes a briefing: a business gets the
// default time once, until the owner chooses another.
async function ensureSchedule(db,workspaceId,zone,now=new Date()){
  if(!await ready(db))return;
  await db.query(`INSERT INTO ${settingsTable}(workspace_id,job_id,next_send_at) VALUES($1,${JOB},$2) ON CONFLICT DO NOTHING`,
    [workspaceId,slotAfter(DEFAULT,zone,now)?.toISOString()||null]);
}
// After the owner changes the time: today's briefing still goes today if its
// new time has passed and it was not delivered yet.
async function nextAfterChange(db,workspaceId,s,now=new Date()){
  const {calendarDate,timeZone}=await time.forWorkspace(db,workspaceId,now),today=time.wall(calendarDate,Number(s.send_hour),Number(s.send_minute),timeZone);
  const delivered=(await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,addDays(calendarDate,-1)])).rowCount;
  if(!delivered&&today&&today<=now&&!(s.send_days==='weekdays'&&weekend(calendarDate)))return now;
  return slotAfter(s,timeZone,now);
}

// The worker's sweep: queue each business whose time has come, once per time.
async function enqueueDue(client,at){
  if(!await ready(client))return {queued:0};
  const when=new Date(at),jobs=require('../operations/postgres-job-queue'),scoped=require('../reports/postgres-delivery-controls').scoped;
  const due=(await client.query(`SELECT s.* FROM ${settingsTable} s JOIN workspaces w ON w.id=s.workspace_id AND w.deletion_requested_at IS NULL
    WHERE s.job_id=${JOB} AND s.next_send_at<=$1 ORDER BY s.next_send_at,s.workspace_id LIMIT 200 FOR UPDATE OF s SKIP LOCKED`,[when.toISOString()])).rows;
  let queued=0;
  for(const s of due){
    const slot=new Date(s.next_send_at).toISOString(),zone=(await time.forWorkspace(client,s.workspace_id,when)).timeZone;
    const made=await jobs.enqueue(scoped(client),{workspaceId:s.workspace_id,kind:'agent.briefing-delivery',idempotencyKey:'briefing:'+s.workspace_id+':'+slot,
      payload:{slotAt:slot},priority:60,maxAttempts:3});
    if(made.created)queued++;
    await client.query(`UPDATE ${settingsTable} SET next_send_at=$2 WHERE workspace_id=$1 AND job_id=${JOB}`,[s.workspace_id,slotAfter(s,zone,when)?.toISOString()||null]);
  }
  return {queued};
}

// What stops the email, if anything, and who gets it.
async function plan(db,workspaceId,account,{manual}){
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {problem:'The briefing email needs an active StockChief plan.'};
  const stop=await policy.stopped(db,workspaceId,account,ACTION,!manual);
  if(stop)return {problem:stop};
  const box=await mail().mailbox(db,workspaceId,JOB);
  if(box.problem)return box;
  const team=await mail().people(db,workspaceId),sender=team.find(p=>p.is_owner);
  if(!sender)return {problem:'The business owner has no email address, so the briefing was not emailed.'};
  const ids=(await mail().setting(db,workspaceId,JOB))?.recipient_user_ids||[],people=[];
  for(const id of ids.length?ids:[sender.id]){
    const person=team.find(p=>p.id===id);
    if(!person)return {problem:'Someone chosen to get the briefing is no longer in the business or has no email address. Update who gets it.'};
    people.push(person);
  }
  return {box:box.box,people,sender};
}

const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const span=(from,to)=>from===to?to:from+' to '+to;
function happened(s){
  const verbs=require('./daily-briefs').verbs,out=Object.entries(s.totals||{}).filter(([,n])=>n).map(([k,n])=>verbs[k]+': '+n);
  if(s.actions)out.push('Work StockChief finished: '+s.actions);
  if(s.verified)out.push('Work checked as done: '+s.verified);
  return out.length?out:['No stock activity or finished work was recorded.'];
}
function needsNow(s){
  return [['Approvals waiting for you',s.approvals],['Late orders, shipments and invoices',s.overdue],['Out of stock',s.stockOuts],['Running low',s.runningLow]]
    .filter(([,n])=>Number(n)>0).map(([label,n])=>label+': '+n);
}
// One person's email: the briefing, and their own Needs you list now.
async function letter(database,workspaceId,summary,person){
  let items=[];
  try{items=require('../web/presentation/importance').mostImportantFirst((await require('../projections/postgres-service').needs(database,workspaceId,person.id))
    .filter(i=>!String(i.sourceId||'').startsWith('daily-briefing:')));}catch(error){if(!mail().expected(error))throw error;}
  const origin=String(config.connections.publicOrigin||'').replace(/\/$/,''),links=origin.startsWith('https://');
  const now=needsNow(summary);
  const lines=['What happened on '+span(summary.from,summary.to)+':',...happened(summary).map(l=>'- '+l),'','What needs you now:',
    ...(now.length?now.map(l=>'- '+l):['- Nothing is late or waiting for approval.']),
    ...(items.length?['','Your Needs you list ('+plural(items.length,'item','items')+'):',...items.slice(0,8).map(i=>'- '+String(i.title||'').replace(/[\r\n]+/g,' ')),
      ...(items.length>8?['- and '+plural(items.length-8,'more item','more items')]:[])]:[]),
    ...(links?['','Read the briefing: '+origin+path+'?filter='+summary.to,'Open Needs you: '+origin+'/needs-you']:[])];
  return {subject:'Your StockChief briefing for '+span(summary.from,summary.to),body:lines.join('\n')};
}
async function queueLetters(c,workspaceId,p,letters,{day,manual}){
  const ids=[];
  await c.query('SAVEPOINT briefing_email');
  try{
    for(const [i,person] of p.people.entries()){
      const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,{workspaceId,actorId:p.sender.id},{
        recipientKind:'address',recipientEmail:person.email,connectorId:p.box.id,subject:letters[i].subject,body:letters[i].body,
        standingAuthority:{kind:'agent_briefing',job:JOB,day,userId:person.id,connectorId:p.box.id,manual}},'briefing-email:'+day+':'+person.id);
      ids.push(queued.communicationId);
    }
    await c.query('RELEASE SAVEPOINT briefing_email');
    return {ids};
  }catch(error){
    if(!mail().expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT briefing_email');await c.query('RELEASE SAVEPOINT briefing_email');
    return {problem:error.message};
  }
}

// The worker: deliver the briefing due at `slotAt`, once.
async function run(database,workspaceId,{slotAt}={}){
  if(!await ready(database))return {skipped:'not_installed'};
  const slot=new Date(slotAt);
  if(!Number.isFinite(slot.getTime()))throw Object.assign(new Error('A briefing delivery needs its scheduled time.'),{code:'briefing_slot_invalid',retryable:false});
  const account=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {skipped:'plan'};
  const {calendarDate,timeZone}=await time.forWorkspace(database,workspaceId,slot),day=addDays(calendarDate,-1);
  const done=()=>database.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,day]).then(r=>r.rowCount>0);
  if(await done())return {replayed:true,day};
  // The routine check writes the day; pause stops that check, so write it here too.
  await tx(database,c=>require('./daily-briefs').deliver(c,workspaceId,account,{now:slot}));
  const last=(await database.query(`SELECT max(report_date)::text AS d FROM ${table} WHERE workspace_id=$1 AND report_date<$2`,[workspaceId,day])).rows[0].d;
  const from=last&&last>=addDays(day,-6)?addDays(last,1):day;
  const summary={from,to:day,...await require('./daily-briefs').collect(database,workspaceId,from,day,timeZone)};
  const p=await plan(database,workspaceId,account,{manual:false});
  const letters=p.problem?[]:await Promise.all(p.people.map(person=>letter(database,workspaceId,summary,person)));
  return tx(database,async c=>{
    const owner=p.sender||(await mail().people(c,workspaceId)).find(x=>x.is_owner),ctx={workspaceId,actorId:owner?.id||null};
    const inserted=await c.query(`INSERT INTO ${table}(workspace_id,report_date,from_date,slot_at,status,hold_reason,summary,mailbox,recipients)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING report_date`,
      [workspaceId,day,from,slot.toISOString(),p.problem?'HELD':'QUEUED',p.problem?String(p.problem).slice(0,500):null,summary,p.box?.name||null,(p.people||[]).map(x=>x.email)]);
    if(!inserted.rowCount)return {replayed:true,day};
    await c.query(`UPDATE ${table} SET status='CANCELLED',updated_at=clock_timestamp() WHERE workspace_id=$1 AND status='HELD' AND report_date<$2`,[workspaceId,day]);
    let problem=p.problem,ids=[];
    if(!problem){const queued=await queueLetters(c,workspaceId,p,letters,{day,manual:false});problem=queued.problem;ids=queued.ids||[];}
    if(problem)await c.query(`UPDATE ${table} SET status='HELD',hold_reason=$3,communication_ids='{}' WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,day,String(problem).slice(0,500)]);
    else await c.query(`UPDATE ${table} SET communication_ids=$3 WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,day,ids]);
    await audit.record(c,ctx,{action:'Daily briefing delivered',reference:day,after:{from,to:day,inApp:true,
      ...(problem?{emailHeld:String(problem).slice(0,500)}:{emailedTo:p.people.map(x=>x.email),mailbox:p.box.name})}});
    return {day,from,...(problem?{held:problem}:{emailed:ids.length})};
  });
}

// The owner emails a waiting briefing (Ask me first, or after fixing what stopped it).
async function sendNow(database,ctx){
  await mail().requireOwner(database,ctx);
  const account=await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'suggest');
  if(!await ready(database))throw new ValidationError('The briefing email is being upgraded. Try again shortly.');
  const row=(await database.query(`SELECT report_date::text AS day,status,summary FROM ${table} WHERE workspace_id=$1 ORDER BY report_date DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
  if(!row||row.status!=='HELD')throw new ValidationError('No briefing is waiting to be emailed.');
  const p=await plan(database,ctx.workspaceId,account,{manual:true});
  if(p.problem)throw new ValidationError(p.problem);
  const day=row.day,summary=row.summary;
  const letters=await Promise.all(p.people.map(person=>letter(database,ctx.workspaceId,summary,person)));
  return tx(database,async c=>{
    const current=(await c.query(`SELECT status FROM ${table} WHERE workspace_id=$1 AND report_date=$2 FOR UPDATE`,[ctx.workspaceId,day])).rows[0];
    if(current?.status!=='HELD')throw new ValidationError('This briefing was already emailed.');
    const queued=await queueLetters(c,ctx.workspaceId,p,letters,{day,manual:true});
    if(queued.problem)throw new ValidationError(queued.problem);
    await c.query(`UPDATE ${table} SET status='QUEUED',hold_reason=NULL,communication_ids=$3,recipients=$4,mailbox=$5,sent_by_owner=true,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND report_date=$2`,[ctx.workspaceId,day,queued.ids,p.people.map(x=>x.email),p.box.name]);
    await audit.record(c,ctx,{action:'Daily briefing emailed',reference:day,after:{emailedTo:p.people.map(x=>x.email),mailbox:p.box.name,sentByOwner:true}});
    return {emailed:queued.ids.length};
  });
}

// Checked again just before the mailbox sends.
async function emailAuthority(db,workspaceId,grant){
  if(Number(grant?.job)!==JOB)throw new ValidationError('This briefing email is not recognised, so it was not sent.');
  const account=await policy.accountState(db,workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,JOB,'automatic');
  const stop=await policy.stopped(db,workspaceId,account,ACTION,grant.manual!==true);
  if(stop)throw new ValidationError(stop+' The briefing email is held.');
  const saved=await mail().setting(db,workspaceId,JOB);
  if(saved?.email_connector_id!==grant.connectorId)throw new ValidationError('The mailbox for the briefing changed, so this email was not sent.');
  const row=(await db.query(`SELECT status FROM ${table} WHERE workspace_id=$1 AND report_date=$2`,[workspaceId,String(grant.day||'')])).rows[0];
  if(row?.status!=='QUEUED')throw new ValidationError('This briefing was replaced, so the email was not sent.');
  const team=await mail().people(db,workspaceId),ids=saved.recipient_user_ids?.length?saved.recipient_user_ids:[team.find(p=>p.is_owner)?.id];
  if(!ids.includes(grant.userId)||!team.some(p=>p.id===grant.userId))throw new ValidationError('Who gets the briefing changed, so this email was not sent.');
}

// A briefing is emailed once every person's email is sent.
async function settle(db,workspaceId=null){
  if(!await ready(db))return;
  await db.query(`UPDATE ${table} d SET status=CASE WHEN x.sent=cardinality(d.communication_ids) THEN 'SENT' ELSE 'FAILED' END,updated_at=clock_timestamp(),
      hold_reason=CASE WHEN x.sent=cardinality(d.communication_ids) THEN NULL ELSE left(coalesce(x.error,'The mailbox could not send the briefing.'),500) END
    FROM (SELECT d.workspace_id,d.report_date,count(*) FILTER (WHERE m.status='SENT')::int AS sent,count(*) FILTER (WHERE m.status IN ('QUEUED','SENDING'))::int AS waiting,
        min(m.error_message) FILTER (WHERE m.status NOT IN ('SENT','QUEUED','SENDING')) AS error
      FROM ${table} d LEFT JOIN customer_communications m ON m.workspace_id=d.workspace_id AND m.id=ANY(d.communication_ids)
      WHERE d.status='QUEUED' AND ($1::text IS NULL OR d.workspace_id=$1) GROUP BY d.workspace_id,d.report_date) x
    WHERE d.workspace_id=x.workspace_id AND d.report_date=x.report_date AND x.waiting=0`,[workspaceId]);
}

const said={QUEUED:'It is on its way by email',SENT:'It was emailed',FAILED:'The email could not be sent'};
// Needs you: the latest briefing, once its time has come.
async function inbox(db,workspaceId){
  if(!await ready(db))return [];
  const row=(await db.query(`SELECT report_date::text AS day,from_date::text AS from_day,status,hold_reason,recipients,slot_at FROM ${table}
    WHERE workspace_id=$1 ORDER BY report_date DESC LIMIT 1`,[workspaceId])).rows[0];
  if(!row){
    const brief=(await db.query(`SELECT report_date,generated_at FROM workspace_daily_digests
      WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief'
      ORDER BY report_date DESC LIMIT 1`,[workspaceId])).rows[0];
    if(!brief)return [];
    return [{kind:'inventory',grouped:true,importance:'Information',priority:45,title:'Your daily briefing',
      happened:'The briefing for '+brief.report_date+' is ready.',
      why:'StockChief prepares the briefing from your inventory records.',
      recommendation:'Read it and follow up on anything waiting.',
      href:path+'?filter='+encodeURIComponent(brief.report_date),actionLabel:'Read the briefing',
      sourceId:'daily-briefing:'+brief.report_date,createdAt:brief.generated_at,at:brief.generated_at}];
  }
  const email=row.status==='HELD'?' The email is waiting: '+row.hold_reason:row.status==='CANCELLED'?'':' '+said[row.status]+' to '+plural(row.recipients.length,'person','people')+'.';
  return [{kind:'inventory',grouped:true,importance:'Information',priority:45,title:'Your daily briefing',
    happened:'What happened on '+span(row.from_day,row.day)+', and what needs you now.'+email,
    why:'StockChief writes it from your records each business day at the time you chose.',
    recommendation:row.status==='HELD'?'Read it here, then send the email or fix what stopped it.':'Read it and follow up on anything waiting.',
    href:path+'?filter='+row.day,actionLabel:'Read the briefing',sourceId:'daily-briefing:'+row.day,createdAt:row.slot_at,at:row.slot_at}];
}

// What the briefing page shows about delivery.
async function panel(db,ctx){
  if(!await ready(db))return null;
  const account=await policy.accountState(db,ctx.workspaceId);
  const saved=await mail().setting(db,ctx.workspaceId,JOB),boxes=await require('./agent-alerts').mailboxes(db,ctx.workspaceId),team=await mail().people(db,ctx.workspaceId);
  const chosen=saved?.email_connector_id?boxes.find(b=>b.id===saved.email_connector_id)||{id:saved.email_connector_id,name:'A mailbox that is no longer connected',missing:true}:null;
  const stop=await policy.stopped(db,ctx.workspaceId,account,ACTION,true),ownerStop=stop?await policy.stopped(db,ctx.workspaceId,account,ACTION,false):null;
  const latest=(await db.query(`SELECT report_date::text AS day,status,hold_reason,recipients,mailbox FROM ${table} WHERE workspace_id=$1 ORDER BY report_date DESC LIMIT 1`,[ctx.workspaceId])).rows[0]||null;
  const owner=team.find(p=>p.is_owner),ids=saved?.recipient_user_ids?.length?saved.recipient_user_ids:owner?[owner.id]:[];
  const zone=(await time.forWorkspace(db,ctx.workspaceId)).timeZone;
  const s=saved||DEFAULT;
  return {job:JOB,action:'/autopilot/report-emails/'+JOB,revision:saved?.revision||0,mailboxes:boxes,chosen,stop,ownerStop,
    people:team.map(p=>({id:p.id,name:p.name,email:p.email,chosen:ids.includes(p.id)})),
    hour:Number(s.send_hour),minute:Number(s.send_minute),days:s.send_days,zone,next:saved?.next_send_at?mail().localTime(saved.next_send_at,zone):null,
    latest,canSend:Boolean(latest?.status==='HELD'&&!ownerStop)};
}

module.exports={JOB,ACTION,key,path,table,ready,slotAfter,ensureSchedule,nextAfterChange,enqueueDue,plan,letter,run,sendNow,emailAuthority,settle,inbox,panel};

'use strict';

// Job 155: scheduled reports are emailed on their own, alone on every plan.
// Job 156 (autopilot/briefing-email.js) sends the daily briefing through the
// same mailbox choice, people and outbox.
//
// On the Agent terms the worker sends each scheduled slot of a saved report
// (one report_deliveries row per report and slot) from the connected mailbox
// the owner chose for report emails, to the people chosen on the report
// (normally people in the business; the report's owner when nobody else is
// chosen), with the report attached as an Excel or PDF file. The report's
// owner also gets a link to the saved report. A slot waits, and asks in Needs
// you, during the first 14 days, pause, Watch only and Ask me first (where the
// owner presses send), when no mailbox was chosen (StockChief never picks one
// on its own), when the chosen mailbox cannot send, when a chosen person left
// or may not see the report, and when the file would be too large. A later
// slot replaces a waiting one. A replayed slot sends nothing twice. Every send
// and every hold is audited, and the plan, mode, mailbox and people are
// checked again just before the mailbox sends.
//
// "Send now" on a saved report keeps sending a copy to its owner's own
// address, and accounts on older terms keep the earlier email from StockChief
// (postgres-scheduling.js). Live delivery from a real Gmail or Microsoft 365
// mailbox is checked only with the test mail provider.

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const time=require('../lib/business-time');
const config=require('../config');
const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');

const JOB=155,ACTION='report.email',key='report-emails',path='/autopilot/reviews/'+key;
const settingsTable='stockchief_runtime.agent_report_email_settings';
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,MAX_FILE=2097152,MAX_PEOPLE=20;
const LIMITS={xlsx:20001,pdf:5001},NAMES={xlsx:'an Excel file',pdf:'a PDF file'};
const TYPES={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf'};
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const expected=error=>error instanceof DomainError&&[400,402,403,404,409,422].includes(error.status);
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);

async function ready(db){
  return await installed.has(db,settingsTable)&&await installed.has(db,'stockchief_runtime.report_deliveries','hold_reason');
}

// People in the business who can receive email: team members with an
// account email whose access is not switched off.
async function people(db,workspaceId){
  return (await db.query(`SELECT u.id,u.name,u.role,u.permissions,u.warehouse_location_ids,a.email,
      (w.owner_account_id=u.account_id AND u.role='owner') AS is_owner
    FROM users u JOIN workspaces w ON w.id=u.workspace_id JOIN accounts a ON a.id=u.account_id
    WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.name,u.id`,[workspaceId])).rows.filter(p=>EMAIL.test(p.email||''));
}
async function requireOwner(db,ctx){
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the owner can change how reports are emailed.');
}
async function setting(db,workspaceId,job){
  return (await db.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,job])).rows[0]||null;
}
const mailboxes=(db,workspaceId)=>require('../autopilot/agent-alerts').mailboxes(db,workspaceId);

// The mailbox the owner chose for this job. Never one picked on its own.
async function mailbox(db,workspaceId,job){
  const chosen=(await setting(db,workspaceId,job))?.email_connector_id,boxes=await mailboxes(db,workspaceId);
  const what=job===JOB?'report emails':'the briefing';
  if(!chosen)return {problem:boxes.length?`Choose the mailbox ${what} ${job===JOB?'are':'is'} sent from. StockChief never picks one on its own.`
    :`Connect a mailbox that can send email in Connections, then choose it for ${what}.`};
  const box=boxes.find(b=>b.id===chosen);
  if(!box)return {problem:`The mailbox chosen for ${what} is disconnected, paused or cannot send. Reconnect it, or choose another.`};
  return {box};
}

// Whether a person may see everything in a saved report: its owner always;
// anyone else only with access to every warehouse and to every field in it.
function canSee(person,template){
  if(person.id===template.owner_user_id)return true;
  if(person.warehouse_location_ids!=null)return false;
  try{require('./postgres-service').normalize(template.definition,person);return true;}
  catch(error){if(error instanceof DomainError)return false;throw error;}
}
const chosenIds=template=>template.recipient_user_ids?.length?template.recipient_user_ids:[template.owner_user_id];
function recipients(team,template){
  const out=[];
  for(const id of chosenIds(template)){
    const person=team.find(p=>p.id===id);
    if(!person)return {problem:`Someone chosen to get “${template.title}” is no longer in the business or has no email address. Update who gets it.`};
    if(!canSee(person,template))return {problem:`${person.name} may not see everything in “${template.title}”. Update who gets it.`};
    out.push(person);
  }
  return {people:out};
}

// The report, run as the person who saved it, and its file.
function fileName(template,format,day){
  const slug=String(template.title||'').normalize('NFKD').replace(/[^A-Za-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'report';
  return slug+'-'+day+'.'+format;
}
async function build(db,workspaceId,template){
  const format=template.attachment_format==='pdf'?'pdf':'xlsx';
  const actor=(await db.query(`SELECT u.role,u.permissions,u.warehouse_location_ids,a.email FROM users u JOIN accounts a ON a.id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2`,[workspaceId,template.owner_user_id])).rows[0];
  if(!actor)throw new ValidationError(`The person who saved “${template.title}” is no longer in the business.`);
  const result=await require('./postgres-service').run(db,{workspaceId,actorId:template.owner_user_id},actor,template.definition,{limit:LIMITS[format]});
  if(result.hasMore)throw new ValidationError(`“${template.title}” has more than ${(LIMITS[format]-1).toLocaleString('en-US')} rows, too many for ${NAMES[format]}. Narrow its filters${format==='pdf'?' or attach an Excel file':''}.`);
  const content=await require('./exports')[format](result);
  if(content.length>MAX_FILE)throw new ValidationError(`${NAMES[format].replace(/^an? /,'The ')} for “${template.title}” is over 2 MB, too large to attach. Narrow its filters.`);
  const day=time.context(template.schedule_time_zone||'UTC',new Date()).calendarDate;
  return {result,format,content,filename:fileName(template,format,day)};
}
function letter(template,built,{link}){
  const zone=template.schedule_time_zone||'UTC',title=String(built.result.config?.title||template.title).replace(/[\r\n]+/g,' ');
  const when=new Intl.DateTimeFormat('en-US',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(built.result.asOf||Date.now()));
  const findings=(built.result.insights||[]).map(entry=>entry.text).filter(Boolean).slice(0,5);
  const origin=String(config.connections.publicOrigin||'').replace(/\/$/,'');
  const href=link&&origin.startsWith('https://')?origin+'/reports/saved/'+encodeURIComponent(template.id):null;
  return {subject:('StockChief report: '+title).slice(0,200),
    body:[title,'Made from your StockChief records on '+when+'.',plural(built.result.rows.length,'row','rows')+'. The full report is attached as '+NAMES[built.format]+'.',
      ...(findings.length?['','What stands out:',...findings.map(f=>'- '+f),'These compare recorded rows. They are not causes or forecasts.']:[]),
      ...(href?['','Open the saved report: '+href]:[])].join('\n')};
}
async function currentOwner(db,workspaceId){return (await people(db,workspaceId)).find(p=>p.is_owner)||null;}

// What stops this send, if anything. `manual` is the owner pressing send.
async function check(db,workspaceId,account,template,{manual}){
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return {problem:'Report emails need an active StockChief plan.'};
  const stop=await policy.stopped(db,workspaceId,account,ACTION,!manual);
  if(stop)return {problem:stop};
  const box=await mailbox(db,workspaceId,JOB);
  if(box.problem)return box;
  const team=await people(db,workspaceId),sender=team.find(p=>p.is_owner);
  if(!sender)return {problem:'The business owner has no email address, so no report email was sent.'};
  const chosen=recipients(team,template);
  if(chosen.problem)return chosen;
  try{return {box:box.box,people:chosen.people,sender,built:await build(db,workspaceId,template)};}
  catch(error){if(!expected(error))throw error;return {problem:error.message};}
}

const DELIVERY=`SELECT t.*,d.id AS delivery_id,d.status AS delivery_status,d.schedule_key,cardinality(d.communication_ids)::int AS queued
  FROM stockchief_runtime.report_templates t JOIN stockchief_runtime.report_deliveries d ON d.template_id=t.id AND d.workspace_id=t.workspace_id
  WHERE t.workspace_id=$1 AND t.id=$2 AND d.id=$3`;

// The worker's step for one scheduled slot (from report.generate-delivery),
// or the owner sending a waiting slot (`manual`).
async function deliver(database,workspaceId,templateId,deliveryId,{manual=false}={}){
  const wanted=manual?'HELD':'PENDING',open=row=>row&&row.delivery_status===wanted&&!row.queued&&!row.deleted_at&&(manual||!row.schedule_paused);
  const row=(await database.query(DELIVERY,[workspaceId,templateId,deliveryId])).rows[0];
  if(!open(row)){if(manual)throw new ValidationError('This report email was already sent, replaced or stopped.');return {skipped:'delivery_no_longer_pending'};}
  const account=await policy.accountState(database,workspaceId);
  const plan=await check(database,workspaceId,account,row,{manual});
  return tx(database,async c=>{
    const current=(await c.query(DELIVERY+' FOR UPDATE OF d',[workspaceId,templateId,deliveryId])).rows[0];
    if(!open(current)){if(manual)throw new ValidationError('This report email was already sent, replaced or stopped.');return {skipped:'replayed'};}
    const owner=plan.sender||await currentOwner(c,workspaceId),ctx={workspaceId,actorId:owner?.id||null};
    if(!manual)await c.query(`UPDATE stockchief_runtime.report_deliveries SET status='CANCELLED',hold_reason=NULL,completed_at=clock_timestamp(),
      error_message='A later scheduled report replaced it.' WHERE workspace_id=$1 AND template_id=$2 AND status='HELD' AND id<>$3`,[workspaceId,templateId,deliveryId]);
    let problem=plan.problem,ids=[];
    if(!problem){
      await c.query('SAVEPOINT report_email');
      try{
        for(const person of plan.people){
          const words=letter(current,plan.built,{link:person.id===current.owner_user_id});
          const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,{workspaceId,actorId:plan.sender.id},{
            recipientKind:'address',recipientEmail:person.email,connectorId:plan.box.id,subject:words.subject,body:words.body,
            standingAuthority:{kind:'scheduled_report',job:JOB,deliveryId,templateId,userId:person.id,connectorId:plan.box.id,format:plan.built.format,manual}},
          'scheduled-report:'+deliveryId+':'+person.id);
          ids.push(queued.communicationId);
        }
        await c.query('RELEASE SAVEPOINT report_email');
      }catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT report_email');await c.query('RELEASE SAVEPOINT report_email');
        problem=error.message;ids=[];
      }
    }
    if(problem){
      if(manual)throw new ValidationError(problem);
      await c.query(`UPDATE stockchief_runtime.report_deliveries SET status='HELD',hold_reason=$4 WHERE workspace_id=$1 AND template_id=$2 AND id=$3`,
        [workspaceId,templateId,deliveryId,String(problem).slice(0,500)]);
      await audit.record(c,ctx,{action:'Report email held',reference:deliveryId,after:{report:current.title,reason:String(problem).slice(0,500)}});
      return {held:problem};
    }
    await c.query(`UPDATE stockchief_runtime.report_deliveries SET status='PENDING',hold_reason=NULL,error_message=NULL,communication_ids=$4,recipients=$5,
      mailbox=$6,row_count=$7,sent_by_owner=$8 WHERE workspace_id=$1 AND template_id=$2 AND id=$3`,
      [workspaceId,templateId,deliveryId,ids,plan.people.map(p=>p.email),plan.box.name,plan.built.result.rows.length,manual]);
    await audit.record(c,ctx,{action:'Report email queued',reference:deliveryId,after:{report:current.title,to:plan.people.map(p=>p.email),mailbox:plan.box.name,
      file:plan.built.format,rows:plan.built.result.rows.length,...(manual?{sentByOwner:true}:{})}});
    return {queued:ids.length,communicationIds:ids};
  });
}

// The owner sends a waiting slot (Ask me first, or after fixing what stopped it).
async function sendHeld(database,ctx,deliveryId){
  await requireOwner(database,ctx);
  await policy.requireWorkspaceJob(database,ctx.workspaceId,JOB,'suggest');
  const row=(await database.query(`SELECT template_id FROM stockchief_runtime.report_deliveries WHERE workspace_id=$1 AND id=$2 AND status='HELD'`,
    [ctx.workspaceId,String(deliveryId||'')])).rows[0];
  if(!row)throw new NotFoundError('That report email is no longer waiting.');
  return deliver(database,ctx.workspaceId,row.template_id,String(deliveryId),{manual:true});
}

// Checked again just before the mailbox sends, and the file is made fresh.
async function authority(db,workspaceId,grant){
  if(Number(grant?.job)!==JOB)throw new ValidationError('This report email is not recognised, so it was not sent.');
  const account=await policy.accountState(db,workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,JOB,'automatic');
  const stop=await policy.stopped(db,workspaceId,account,ACTION,grant.manual!==true);
  if(stop)throw new ValidationError(stop+' The report email is held.');
  if((await setting(db,workspaceId,JOB))?.email_connector_id!==grant.connectorId)throw new ValidationError('The mailbox for report emails changed, so this email was not sent.');
  const row=(await db.query(DELIVERY,[workspaceId,String(grant.templateId||''),String(grant.deliveryId||'')])).rows[0];
  if(!row||row.delivery_status!=='PENDING'||row.deleted_at||(!grant.manual&&row.schedule_paused))
    throw new ValidationError('This report was paused, deleted or replaced, so the email was not sent.');
  const person=(await people(db,workspaceId)).find(p=>p.id===grant.userId);
  if(!person||!chosenIds(row).includes(person.id)||!canSee(person,row))throw new ValidationError('Who gets this report changed, so this email was not sent.');
  return row;
}
async function attachments(db,workspaceId,grant){
  const row=await authority(db,workspaceId,grant),built=await build(db,workspaceId,row);
  if(built.format!==grant.format)throw new ValidationError('The report file type changed, so this email was not sent.');
  return [{filename:built.filename,contentType:TYPES[built.format],content:built.content}];
}

// A slot is sent once every person's email is sent, and needs attention once
// any of them fails. The worker's sweep calls this.
async function settle(db,workspaceId=null){
  if(!await ready(db))return;
  const settled=await db.query(`UPDATE stockchief_runtime.report_deliveries d SET status=CASE WHEN x.sent=cardinality(d.communication_ids) THEN 'SENT' ELSE 'FAILED' END,
      provider_message_id=x.message_id,completed_at=coalesce(x.sent_at,clock_timestamp()),
      error_message=CASE WHEN x.sent=cardinality(d.communication_ids) THEN NULL ELSE left(coalesce(x.error,'The mailbox could not send this report email.'),500) END
    FROM (SELECT d.id,count(*) FILTER (WHERE m.status='SENT')::int AS sent,count(*) FILTER (WHERE m.status IN ('QUEUED','SENDING'))::int AS waiting,
        max(m.sent_at::timestamptz) AS sent_at,min(m.external_message_id) AS message_id,min(m.error_message) FILTER (WHERE m.status NOT IN ('SENT','QUEUED','SENDING')) AS error
      FROM stockchief_runtime.report_deliveries d LEFT JOIN customer_communications m ON m.workspace_id=d.workspace_id AND m.id=ANY(d.communication_ids)
      WHERE d.status='PENDING' AND cardinality(d.communication_ids)>0 AND ($1::text IS NULL OR d.workspace_id=$1) GROUP BY d.id) x
    WHERE d.id=x.id AND x.waiting=0 RETURNING d.workspace_id,d.template_id,d.status,d.completed_at,d.error_message`,[workspaceId]);
  for(const d of settled.rows)await db.query(`UPDATE stockchief_runtime.report_templates SET
      last_delivered_at=CASE WHEN $3='SENT' THEN $4::timestamptz ELSE last_delivered_at END,last_error=CASE WHEN $3='SENT' THEN NULL ELSE $5 END
    WHERE workspace_id=$1 AND id=$2 AND (last_delivered_at IS NULL OR last_delivered_at<=$4::timestamptz)`,[d.workspace_id,d.template_id,d.status,d.completed_at,d.error_message]);
  await require('../autopilot/briefing-email').settle(db,workspaceId);
}

// Who gets a report, saved with the report (reports.save). The report's own
// person may choose only themselves; the owner may choose anyone in the
// business who may see the report.
async function saveRecipients(c,ctx,row,input={}){
  if(!input.recipientsShown||!await installed.has(c,'stockchief_runtime.report_templates','recipient_user_ids'))return;
  const ids=[...new Set([].concat(input.recipients||[]).map(String).filter(Boolean))];
  const format=input.attach==null||input.attach===''?row.attachment_format||'xlsx':String(input.attach);
  if(!['xlsx','pdf'].includes(format))throw new ValidationError('Attach an Excel or a PDF file.');
  if(ids.length>MAX_PEOPLE)throw new ValidationError('Choose up to '+MAX_PEOPLE+' people.');
  if(row.schedule_frequency!=='none'&&!ids.length)throw new ValidationError('Choose who gets this report.');
  const team=await people(c,ctx.workspaceId),me=team.find(p=>p.id===ctx.actorId);
  for(const id of ids){
    const person=team.find(p=>p.id===id);
    if(!person)throw new ValidationError('Choose people in your business who have an email address.');
    if(id!==ctx.actorId&&!me?.is_owner)throw new AuthorizationError('Only the owner can send a report to other people.');
    if(!canSee(person,row))throw new ValidationError(person.name+' may not see everything in this report. Choose someone else, or remove the fields they may not see.');
  }
  const stored=ids.length===1&&ids[0]===row.owner_user_id?[]:ids;
  const before=row.recipient_user_ids||[];
  if(JSON.stringify(before)===JSON.stringify(stored)&&row.attachment_format===format)return;
  await c.query('UPDATE stockchief_runtime.report_templates SET recipient_user_ids=$3,attachment_format=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,row.id,stored,format]);
  await audit.record(c,ctx,{action:'Report recipients saved',reference:row.id,before:{to:before.length?before:[row.owner_user_id],file:row.attachment_format},
    after:{to:stored.length?stored:[row.owner_user_id],file:format}});
}

// The report form's delivery fields, on the Agent terms only.
async function formLocals(db,ctx){
  if(!await ready(db))return null;
  const account=await policy.accountState(db,ctx.workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'automatic'))return null;
  const team=await people(db,ctx.workspaceId),me=team.find(p=>p.id===ctx.actorId);
  if(!me)return null;
  const box=await mailbox(db,ctx.workspaceId,JOB);
  return {me:me.id,owner:me.is_owner,people:(me.is_owner?team:[me]).map(p=>({id:p.id,name:p.name,email:p.email})),
    mailbox:box.box?.name||null,problem:box.problem||null,settingsHref:me.is_owner?path:null};
}

// The owner's choice of mailbox, and for the briefing who gets it and when.
async function configure(database,ctx,raw,input={}){
  const job=Number(raw);
  if(![155,156].includes(job))throw new NotFoundError('Those email settings are not available.');
  return tx(database,async c=>{
    await requireOwner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,job,'suggest');
    if(!await ready(c))throw new ValidationError('Report emails are being upgraded. Try again shortly.');
    const prior=(await c.query(`SELECT * FROM ${settingsTable} WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE`,[ctx.workspaceId,job])).rows[0];
    if(input.revision!=null&&input.revision!==''&&Number(input.revision)!==(prior?.revision||0))
      throw new ValidationError('These settings changed. Reload the page to see them.');
    const next={connector:prior?.email_connector_id??null,people:prior?.recipient_user_ids||[],hour:prior?.send_hour??7,minute:prior?.send_minute??0,days:prior?.send_days||'daily'};
    if(Object.hasOwn(input,'mailbox')){
      const chosen=String(input.mailbox||'').trim();
      if(!chosen)next.connector=null;
      else{
        const box=(await mailboxes(c,ctx.workspaceId)).find(b=>b.id===chosen);
        if(!box)throw new ValidationError('Choose a connected mailbox that can send email.');
        next.connector=box.id;
      }
    }
    if(job===156){
      if(Object.hasOwn(input,'recipientsShown')){
        const ids=[...new Set([].concat(input.recipients||[]).map(String).filter(Boolean))],team=await people(c,ctx.workspaceId);
        if(!ids.length)throw new ValidationError('Choose who gets the briefing.');
        if(ids.length>MAX_PEOPLE)throw new ValidationError('Choose up to '+MAX_PEOPLE+' people.');
        if(ids.some(id=>!team.some(p=>p.id===id)))throw new ValidationError('Choose people in your business who have an email address.');
        next.people=ids.length===1&&team.find(p=>p.id===ids[0])?.is_owner?[]:ids;
      }
      if(Object.hasOwn(input,'hour')||Object.hasOwn(input,'minute')){
        const hour=Number(input.hour),minute=Number(input.minute??0);
        if(!/^\d{1,2}$/.test(String(input.hour??''))||!Number.isInteger(hour)||hour<0||hour>23||!Number.isInteger(minute)||minute<0||minute>59)
          throw new ValidationError('Choose an hour from 0 to 23 and a minute from 0 to 59.');
        next.hour=hour;next.minute=minute;
      }
      if(Object.hasOwn(input,'days')){
        if(!['daily','weekdays'].includes(input.days))throw new ValidationError('Choose every day or Monday to Friday.');
        next.days=input.days;
      }
    }
    const same=prior&&(prior.email_connector_id??null)===next.connector&&JSON.stringify(prior.recipient_user_ids||[])===JSON.stringify(next.people)
      &&Number(prior.send_hour)===next.hour&&Number(prior.send_minute)===next.minute&&prior.send_days===next.days;
    if(same||(!prior&&!next.connector&&job===JOB))return {unchanged:true};
    const timing=job===156?await require('../autopilot/briefing-email').nextAfterChange(c,ctx.workspaceId,{send_hour:next.hour,send_minute:next.minute,send_days:next.days}):null;
    await c.query(`INSERT INTO ${settingsTable} AS s(workspace_id,job_id,email_connector_id,recipient_user_ids,send_hour,send_minute,send_days,next_send_at,authorized_by,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
      ON CONFLICT(workspace_id,job_id) DO UPDATE SET email_connector_id=excluded.email_connector_id,recipient_user_ids=excluded.recipient_user_ids,
        send_hour=excluded.send_hour,send_minute=excluded.send_minute,send_days=excluded.send_days,next_send_at=excluded.next_send_at,
        authorized_by=excluded.authorized_by,revision=s.revision+1,updated_at=clock_timestamp()`,
      [ctx.workspaceId,job,next.connector,next.people,next.hour,next.minute,next.days,timing?timing.toISOString():null,ctx.actorId]);
    await audit.record(c,ctx,{action:job===JOB?'Report email settings saved':'Briefing settings saved',reference:String(job),
      before:prior?{mailbox:Boolean(prior.email_connector_id),...(job===156?{to:prior.recipient_user_ids,time:prior.send_hour+':'+String(prior.send_minute).padStart(2,'0'),days:prior.send_days}:{})}:{},
      after:{mailbox:Boolean(next.connector),...(job===156?{to:next.people,time:next.hour+':'+String(next.minute).padStart(2,'0'),days:next.days}:{})}});
    return {saved:true};
  });
}

const STATUS={SENT:'Sent',FAILED:'Not sent',CANCELLED:'Replaced or stopped',HELD:'Waiting for you'};
function localTime(value,zone){
  if(!value||!Number.isFinite(Date.parse(value)))return null;
  return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)).replace(',','');
}

// The page and Ask's review: every scheduled report email, newest first.
async function report(db,ctx,{filter='',page=1}){
  if(!await ready(db))return {rows:[],more:false,summary:'Report emails appear here after the next update.'};
  const zone=(await time.forWorkspace(db,ctx.workspaceId)).timeZone;
  const rows=(await db.query(`SELECT d.id,d.status,d.schedule_key,d.created_at,d.hold_reason,d.error_message,d.recipients,d.mailbox,cardinality(d.communication_ids)::int AS queued,
      t.id AS template_id,t.title,t.owner_user_id
    FROM stockchief_runtime.report_deliveries d JOIN stockchief_runtime.report_templates t ON t.workspace_id=d.workspace_id AND t.id=d.template_id
    WHERE d.workspace_id=$1 AND d.schedule_key NOT LIKE 'manual:%' AND ($2='' OR t.title ILIKE '%'||$2||'%')
    ORDER BY d.created_at DESC,d.id DESC LIMIT 101 OFFSET $3`,[ctx.workspaceId,String(filter||''),(page-1)*100])).rows;
  const names=new Map((await people(db,ctx.workspaceId)).map(p=>[p.email.toLowerCase(),p.name]));
  const out=rows.slice(0,100).map(r=>({Report:r.title,'Scheduled for':localTime(r.schedule_key,zone)||localTime(r.created_at,zone),
    'Sent to':(r.recipients||[]).map(e=>names.get(String(e).toLowerCase())||e).join(', '),From:r.mailbox||'',
    Status:r.status==='PENDING'?(r.queued?'On its way':'Preparing'):STATUS[r.status]||r.status,
    Detail:(r.status==='HELD'?r.hold_reason:r.status==='FAILED'||r.status==='CANCELLED'?r.error_message:null)||'',
    link:r.owner_user_id===ctx.actorId?'/reports/saved/'+r.template_id:null}));
  const waiting=out.filter(r=>r.Status==='Waiting for you').length;
  return {rows:out,more:rows.length>100,
    summary:'Each scheduled report is emailed on its own from the mailbox you choose, to the people chosen on the report, with the report attached.'+
      (waiting?' '+plural(waiting,'email is','emails are')+' waiting for you.':'')};
}

// What the Report emails page shows about sending.
async function panel(db,ctx){
  if(!await ready(db))return null;
  const account=await policy.accountState(db,ctx.workspaceId);
  const saved=await setting(db,ctx.workspaceId,JOB),boxes=await mailboxes(db,ctx.workspaceId);
  const chosen=saved?.email_connector_id?boxes.find(b=>b.id===saved.email_connector_id)||{id:saved.email_connector_id,name:'A mailbox that is no longer connected',missing:true}:null;
  const stop=await policy.stopped(db,ctx.workspaceId,account,ACTION,true),ownerStop=stop?await policy.stopped(db,ctx.workspaceId,account,ACTION,false):null;
  const held=(await db.query(`SELECT d.id,d.hold_reason,d.schedule_key,d.created_at,t.title FROM stockchief_runtime.report_deliveries d
    JOIN stockchief_runtime.report_templates t ON t.workspace_id=d.workspace_id AND t.id=d.template_id
    WHERE d.workspace_id=$1 AND d.status='HELD' AND t.deleted_at IS NULL ORDER BY d.created_at DESC,d.id DESC LIMIT 20`,[ctx.workspaceId])).rows;
  const zone=(await time.forWorkspace(db,ctx.workspaceId)).timeZone;
  return {job:JOB,action:'/autopilot/report-emails/'+JOB,revision:saved?.revision||0,mailboxes:boxes,chosen,stop,ownerStop,
    held:held.map(h=>({id:h.id,title:h.title,reason:h.hold_reason,at:localTime(h.schedule_key,zone)||localTime(h.created_at,zone)})),canSend:!ownerStop};
}

// Needs you: scheduled report emails waiting for the owner, and the briefing.
async function inbox(db,workspaceId){
  if(!await ready(db))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account))return [];
  const out=[];
  if(policy.permits(account.plan,JOB,'automatic')){
    const held=(await db.query(`SELECT d.id,d.hold_reason,d.created_at,t.title FROM stockchief_runtime.report_deliveries d
      JOIN stockchief_runtime.report_templates t ON t.workspace_id=d.workspace_id AND t.id=d.template_id
      WHERE d.workspace_id=$1 AND d.status='HELD' AND t.deleted_at IS NULL ORDER BY d.created_at DESC,d.id DESC LIMIT 20`,[workspaceId])).rows;
    for(const h of held)out.push({kind:'other',importance:'Needs You',priority:48,title:'Report email waiting: '+h.title,happened:h.hold_reason,
      why:'StockChief emails scheduled reports only from a mailbox you chose, to people you chose, and only while it may act.',
      recommendation:/Ask me first/.test(h.hold_reason||'')?'Send it, or let the next one go on its own.':'Fix what stopped it, then send it.',
      href:path,actionLabel:'Review report emails',sourceId:'report-email:'+h.id,createdAt:h.created_at,at:h.created_at});
  }
  if(policy.permits(account.plan,156,'automatic'))out.push(...await require('../autopilot/briefing-email').inbox(db,workspaceId));
  return out;
}

const definition={id:JOB,key,label:'Report emails',filterLabel:'Report name',readPage:(db,ctx,o)=>report(db,ctx,o)};
module.exports={JOB,ACTION,key,path,settingsTable,ready,people,requireOwner,setting,mailbox,canSee,recipients,build,letter,deliver,sendHeld,
  authority,attachments,settle,saveRecipients,formLocals,configure,report,panel,inbox,definition,localTime,expected,tx,plural};

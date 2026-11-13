'use strict';

// Jobs 166, 167, 168, 170 and 171 deliver their alerts the same way. Job 172
// (escalations.js) uses the same mailbox choice and outbox for the emails it
// sends to the person an unanswered item is passed to, and job 175
// (approval-links.js) for the approval links it sends.
//
// The alerts are agent notices: the routine check (operational-notices.refresh,
// run by the worker) opens, updates and clears them. Every alert is shown in
// the app and in Needs you on every plan and in every mode, because an alert
// changes nothing.
//
// After each check this module:
//  - records which alerts opened and cleared, and audits the change once;
//  - emails the alerts that opened since the last email, as one message per
//    kind of alert, from the connected mailbox the owner chose to the owner;
//  - texts and pushes them too when the owner chose that for the kind of alert
//    (job 173, alert-phones.js), to the owner's confirmed mobile number and the
//    devices they turned push on in.
// Sending is work StockChief does on its own, so it waits during the first 14
// days (shadow mode), pause, Watch only, the job's Watch only or Ask me first,
// job 173's own mode, and while saved rules exceed the plan's allowance. The
// waiting alerts are sent once StockChief may act again, if they are still
// open. With Ask me first the owner can send them from the alert page.
//
// The email goes through the existing mailbox outbox; live delivery from a
// real Gmail or Microsoft 365 mailbox is checked only with the test provider.
// Texts and push need the server's provider settings (alert-providers.js).

const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const exact=require('../domain/exact-quantity');
const installed=require('../db/schema-installed');
const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const {newId}=require('../lib/util');

const channels='stockchief_runtime.agent_alert_channels',deliveries='stockchief_runtime.agent_alert_deliveries';
const MAX_EMAIL=200,EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const JOBS={
  166:{action:'alert.low_stock',name:'Low stock and stock-out alerts',module:'./stock-alerts',
    subject:(n,first)=>n===1?first.split(' (')[0]:n+' stock alerts',intro:'StockChief found stock that needs you.'},
  167:{action:'alert.watch_rule',name:'Watch rules',module:'./watch-rules',
    subject:(n,first)=>n===1?'Watch rule: '+first.split(' (')[0]:n+' watch rule alerts',intro:'Your watch rules found something.'},
  168:{action:'alert.overdue',name:'Late orders, shipments and invoices',module:'./overdue-alerts',
    subject:(n,first)=>n===1?'Overdue: '+first.split(' (')[0]:n+' overdue orders, shipments or invoices',intro:'StockChief found work that is past its date.'},
  // Needs migration 473.
  170:{action:'alert.cost_margin',name:'Cost and margin alerts',module:'./cost-alerts',needs473:true,
    subject:(n,first)=>n===1?first.split(':')[0]:n+' cost and margin alerts',
    intro:'StockChief found costs that went up or margins under your minimum. Margins are gross margins, before fees and shipping.'},
  171:{action:'alert.unusual_activity',name:'Unusual activity',module:'./unusual-activity',needs473:true,
    subject:(n,first)=>n===1?'Unusual activity: '+first.split(':')[0]:n+' unusual activity alerts',
    intro:'StockChief noticed activity that looks unusual. Nothing was blocked.'},
  // Needs migration 474. It sends its own emails (escalations.js deliver).
  172:{action:'alert.escalation',name:'Unanswered alerts and approvals',module:'./escalations',needs474:true,own:true},
  // Job 175, needs migration 490: approval links to the person who has each
  // approval, sent by approval-links.js.
  175:{action:'approval.link',name:'Approvals waiting for you',module:'./approval-links',needs490:true,own:true}
};
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const expected=error=>error instanceof DomainError&&[400,402,403,404,409,422].includes(error.status);
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const job=value=>{const id=Number(value);if(!JOBS[id])throw new NotFoundError('That alert is not available.');return id;};
const pathFor=id=>require(JOBS[id].module).path;
// The alert jobs this database can record: 170 and later need migration 473.
async function tracked(db){
  const later=await installed.has(db,'stockchief_runtime.agent_alert_settings','cost_rise_pct');
  const latest=later&&await installed.has(db,'stockchief_runtime.agent_escalations');
  const links=latest&&await installed.has(db,'stockchief_runtime.agent_approval_links');
  return Object.keys(JOBS).map(Number).filter(id=>(later||!JOBS[id].needs473)&&(latest||!JOBS[id].needs474)&&(links||!JOBS[id].needs490));
}
// Texts and push need migration 490.
const phoneColumns=db=>installed.has(db,channels,'sms');
// The alert job behind a review page, if any.
const forKey=key=>Object.keys(JOBS).map(Number).find(id=>require(JOBS[id].module).key===key)||null;

async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id,a.email FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    JOIN accounts a ON a.id=u.account_id WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]||null;
}
async function owner(db,ctx){
  const allowed=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId])).rowCount;
  if(!allowed)throw new AuthorizationError('Only the owner can change how alerts are sent.');
}

function canSend(value){try{const grants=typeof value==='string'?JSON.parse(value):value;return Array.isArray(grants)&&grants.some(g=>g==='MAIL_SEND'||g==='mail:send');}catch{return false;}}
// Connected mailboxes that can send email now.
async function mailboxes(db,workspaceId){
  return (await db.query(`SELECT id,display_name,provider_type,provider_account_name,provider_account_id,capabilities,setup_status FROM workspace_connectors
    WHERE workspace_id=$1 AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL ORDER BY display_name,id`,[workspaceId])).rows
    .filter(b=>b.provider_account_id&&canSend(b.capabilities)&&b.setup_status!=='REAUTHORIZATION_REQUIRED')
    .map(b=>({id:b.id,name:b.display_name,address:b.provider_account_name}));
}

// Records which alerts opened and cleared since the last check, audits that,
// and emails new alerts. Runs after every routine check.
async function track(db,workspaceId,account){
  if(!await installed.has(db,deliveries))return null;
  return tx(db,async c=>{
    const cleared=(await c.query(`DELETE FROM ${deliveries} d WHERE d.workspace_id=$1 AND NOT EXISTS(
      SELECT 1 FROM stockchief_runtime.agent_operational_notices n WHERE n.workspace_id=d.workspace_id AND n.job_id=d.job_id
        AND n.kind=d.kind AND n.reference=d.reference AND n.link=d.link AND NOT n.resolved) RETURNING job_id`,[workspaceId])).rows;
    const raised=(await c.query(`INSERT INTO ${deliveries}(workspace_id,job_id,kind,reference,link)
      SELECT n.workspace_id,n.job_id,n.kind,n.reference,n.link FROM stockchief_runtime.agent_operational_notices n
      WHERE n.workspace_id=$1 AND n.job_id=ANY($2::int[]) AND NOT n.resolved AND NOT EXISTS(SELECT 1 FROM ${deliveries} d
        WHERE d.workspace_id=n.workspace_id AND d.job_id=n.job_id AND d.kind=n.kind AND d.reference=n.reference AND d.link=n.link)
      ON CONFLICT DO NOTHING RETURNING job_id`,[workspaceId,await tracked(c)])).rows;
    if(raised.length||cleared.length){
      const count=rows=>{const out={};for(const r of rows)out[r.job_id]=(out[r.job_id]||0)+1;return out;};
      const person=await currentOwner(c,workspaceId);
      await audit.record(c,{workspaceId,actorId:person?.id||null},{action:'Alerts updated',after:{opened:count(raised),cleared:count(cleared)}});
    }
    const email=await deliver(c,workspaceId,account);
    return {raised:raised.length,cleared:cleared.length,email};
  });
}

// Sends the open alerts of each kind that have not gone out yet: by email
// from the chosen mailbox, and by text and push where the owner chose them.
// `manual` is the owner's own request from the alert page (Ask me first).
async function deliver(c,workspaceId,account,{only=null,manual=false}={}){
  const out={};
  if(!policy.usesAgentTerms(account))return out;
  const phones=await phoneColumns(c);
  const settings=(await c.query(`SELECT * FROM ${channels} WHERE workspace_id=$1 AND (email_connector_id IS NOT NULL${phones?' OR sms OR push':''})
    AND ($2::int IS NULL OR job_id=$2) ORDER BY job_id FOR UPDATE`,[workspaceId,only])).rows;
  for(const setting of settings){
    const id=Number(setting.job_id),spec=JOBS[id];
    if(!spec||!policy.permits(account.plan,id,'automatic'))continue;
    if(spec.own){out[id]=await require(spec.module).deliver(c,workspaceId,account,setting,{manual});continue;}
    out[id]={emailed:0,note:null,texted:0,pushed:0,phoneNote:null};
    if(setting.email_connector_id)Object.assign(out[id],await emailAlerts(c,workspaceId,account,setting,{manual}));
    if(phones)Object.assign(out[id],await phoneAlerts(c,workspaceId,account,setting,{manual}));
  }
  return out;
}

async function emailAlerts(c,workspaceId,account,setting,{manual}){
  const id=Number(setting.job_id),spec=JOBS[id];
  const pending=(await c.query(`SELECT kind,reference,link FROM ${deliveries} WHERE workspace_id=$1 AND job_id=$2 AND email_batch IS NULL
    ORDER BY raised_at,kind,reference,link LIMIT ${MAX_EMAIL}`,[workspaceId,id])).rows;
  const note=async text=>{
    if((setting.email_note||null)!==(text||null))await c.query(`UPDATE ${channels} SET email_note=$3 WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,id,text?text.slice(0,500):null]);
    return {emailed:0,note:text||null};
  };
  if(!pending.length)return note(null);
  const stop=await require('./alert-phones').held(c,workspaceId,account,spec.action,manual);
  if(stop)return note('No email was sent. '+stop);
  const person=await currentOwner(c,workspaceId);
  if(!person||!EMAIL.test(person.email||''))return note('Your account has no email address, so no email was sent.');
  const box=(await mailboxes(c,workspaceId)).find(b=>b.id===setting.email_connector_id);
  if(!box)return note('The chosen mailbox is disconnected, paused or cannot send. Reconnect it, or choose another. No email was sent.');
  const text=await require(spec.module).lines(c,workspaceId,pending);
  const queued=await queue(c,workspaceId,{job:id,person,box,manual,count:pending.length,
    subject:spec.subject(pending.length,text[0]),
    body:spec.intro+'\n\n'+text.map(line=>'- '+line).join('\n')+'\n\nOpen '+spec.name+' in StockChief to see every alert.'});
  if(queued.problem)return note('No email was sent. '+queued.problem);
  await mark(c,workspaceId,id,'email_batch',queued.batch,pending,queued.communicationId);
  await c.query(`UPDATE ${channels} SET email_note=NULL,last_communication_id=$3,last_emailed_at=clock_timestamp() WHERE workspace_id=$1 AND job_id=$2`,
    [workspaceId,id,queued.communicationId]);
  return {emailed:pending.length,communicationId:queued.communicationId,note:null};
}
// Records which alerts went out in a batch: email_batch, sms_batch or push_batch.
async function mark(c,workspaceId,id,column,batch,pending,communicationId=null){
  if(!['email_batch','sms_batch','push_batch'].includes(column))throw new TypeError('Unknown alert channel.');
  await c.query(`UPDATE ${deliveries} d SET ${column}=$3,email_communication_id=CASE WHEN $7::boolean THEN $8 ELSE d.email_communication_id END
    FROM unnest($4::text[],$5::text[],$6::text[]) k(kind,reference,link)
    WHERE d.workspace_id=$1 AND d.job_id=$2 AND d.kind=k.kind AND d.reference=k.reference AND d.link=k.link AND d.${column} IS NULL`,
  [workspaceId,id,batch,pending.map(p=>p.kind),pending.map(p=>p.reference),pending.map(p=>p.link),column==='email_batch',communicationId]);
}

// One text and one push (to each device) per kind of alert and check, to the owner.
async function phoneAlerts(c,workspaceId,account,setting,{manual}){
  const id=Number(setting.job_id),spec=JOBS[id],phones=require('./alert-phones');
  const want=['sms','push'].filter(ch=>setting[ch]);
  const result={texted:0,pushed:0,phoneNote:null};
  const note=async text=>{
    if((setting.phone_note||null)!==(text||null))await c.query(`UPDATE ${channels} SET phone_note=$3 WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,id,text?text.slice(0,500):null]);
    result.phoneNote=text||null;return result;
  };
  const pending={};
  for(const ch of want)pending[ch]=(await c.query(`SELECT kind,reference,link FROM ${deliveries} WHERE workspace_id=$1 AND job_id=$2 AND ${ch}_batch IS NULL
    ORDER BY raised_at,kind,reference,link LIMIT ${MAX_EMAIL}`,[workspaceId,id])).rows;
  if(!want.some(ch=>pending[ch].length))return note(null);
  const stop=await phones.held(c,workspaceId,account,spec.action,manual);
  if(stop)return note('Nothing was texted or pushed. '+stop);
  const person=await currentOwner(c,workspaceId);
  if(!person)return note('The owner’s account is not available, so nothing was texted or pushed.');
  const problems=[],url=phones.link(pathFor(id));
  for(const ch of want){
    const rows=pending[ch];if(!rows.length)continue;
    const text=await require(spec.module).lines(c,workspaceId,rows),title=spec.subject(rows.length,text[0]);
    const body=rows.length===1?text[0]:title+'. '+text.slice(0,2).join(' ')+(rows.length>2?' And '+(rows.length-2)+' more.':'');
    const batch=newId('alert-'+ch);
    const queued=await phones.queue(c,workspaceId,{purpose:'ALERT',job:id,batch,userId:person.id,sms:ch==='sms',push:ch==='push',title,body,url,manual});
    if(!queued[ch]){problems.push(...queued.problems);continue;}
    await mark(c,workspaceId,id,ch+'_batch',batch,rows);
    await audit.record(c,{workspaceId,actorId:person.id},{action:ch==='sms'?'Alert text queued':'Alert push queued',reference:batch,
      after:{job:id,alerts:rows.length,...(ch==='push'?{devices:queued.push}:{}),...(manual?{sentByOwner:true}:{})}});
    result[ch==='sms'?'texted':'pushed']+=rows.length;
  }
  await note(problems.length?problems.join(' '):null);
  return result;
}

// Queues one alert email from the chosen mailbox and audits it. A refusal the
// mailbox or plan gives is returned as {problem}, with nothing queued.
// `sender` is the owner StockChief acts for; it defaults to the recipient.
async function queue(c,workspaceId,{job:id,person,box,subject,body,manual=false,count=1,authority={},sender=person.id}){
  const batch=newId('alert-email');
  await c.query('SAVEPOINT agent_alert_email');
  try{
    const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,{workspaceId,actorId:sender},{
      recipientKind:'address',recipientEmail:person.email,connectorId:box.id,subject:subject.replace(/[\r\n]+/g,' ').slice(0,200),body,
      standingAuthority:{kind:'agent_alert',job:id,batch,connectorId:box.id,manual,...authority}},'agent-alert-email:'+batch);
    await c.query('RELEASE SAVEPOINT agent_alert_email');
    await audit.record(c,{workspaceId,actorId:sender},{action:'Alert email queued',reference:queued.communicationId,
      after:{job:id,alerts:count,mailbox:box.name,to:person.email,...(manual?{sentByOwner:true}:{})}});
    return {batch,communicationId:queued.communicationId};
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT agent_alert_email');await c.query('RELEASE SAVEPOINT agent_alert_email');
    return {problem:error.message};
  }
}

// Checked again just before the mailbox sends: the job may still act, the
// owner still wants email from that mailbox, and an alert in it is still open.
async function emailAuthority(db,workspaceId,grant){
  const id=Number(grant?.job);
  if(!JOBS[id])throw new ValidationError('This alert email is not recognised, so it was not sent.');
  const account=await policy.accountState(db,workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,id,'automatic');
  const stop=await require('./alert-phones').held(db,workspaceId,account,JOBS[id].action,grant.manual===true);
  if(stop)throw new ValidationError(stop+' The alert email is held.');
  const setting=(await db.query(`SELECT email_connector_id FROM ${channels} WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,id])).rows[0];
  if(!setting||setting.email_connector_id!==grant.connectorId)throw new ValidationError('The alert email settings changed, so this email was not sent.');
  if(JOBS[id].own)return require(JOBS[id].module).emailAuthority(db,workspaceId,grant);
  const open=(await db.query(`SELECT 1 FROM ${deliveries} WHERE workspace_id=$1 AND job_id=$2 AND email_batch=$3 LIMIT 1`,
    [workspaceId,id,String(grant.batch||'')])).rowCount;
  if(!open)throw new ValidationError('These alerts cleared before the email was sent, so it was not sent.');
}

// The owner's choice: email from a connected mailbox, or the app only. For
// low stock, also the alert level for products with no reorder point.
async function configure(database,ctx,raw,input={}){
  const id=job(raw);
  return database.transaction(async c=>{
    await owner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,id,'suggest');
    if(!(await tracked(c)).includes(id))throw new ValidationError('These alerts are being upgraded. Try again shortly.');
    const prior=(await c.query(`SELECT * FROM ${channels} WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE`,[ctx.workspaceId,id])).rows[0];
    if(input.revision!=null&&input.revision!==''&&Number(input.revision)!==(prior?.revision||0))
      throw new ValidationError('These alert settings changed. Reload the page to see them.');
    let connector=prior?.email_connector_id??null;
    if(Object.hasOwn(input,'mailbox')){
      const chosen=String(input.mailbox||'').trim();
      if(!chosen)connector=null;
      else{
        const box=(await mailboxes(c,ctx.workspaceId)).find(b=>b.id===chosen);
        if(!box)throw new ValidationError('Choose a connected mailbox that can send email, or the app only.');
        connector=box.id;
      }
    }
    let units=prior?.low_stock_units==null?null:exact.canonical(String(prior.low_stock_units));
    if(id===166&&Object.hasOwn(input,'lowStockUnits')){
      const typed=String(input.lowStockUnits??'').trim();
      units=typed===''?null:exact.canonical(typed,{label:'Alert level',scale:6});
      if(units!==null&&exact.safeNumber(units,{label:'Alert level'})>1e12)throw new ValidationError('Enter an alert level up to 1,000,000,000,000.');
    }
    let hours=prior?.escalation_hours??null;
    if(id===172&&Object.hasOwn(input,'escalationHours')){
      const typed=String(input.escalationHours??'').trim();
      hours=typed===''?null:Number(typed);
      if(hours!==null&&(!/^\d+$/.test(typed)||hours<1||hours>720))throw new ValidationError('Choose between 1 and 720 hours, or leave it empty to stop passing items on.');
    }
    // Job 173: text and push. The form says it carries the two boxes, since
    // an unticked box is not sent at all.
    const phones=await phoneColumns(c);
    let sms=Boolean(prior?.sms),push=Boolean(prior?.push);
    if(phones&&Object.hasOwn(input,'phoneChannels')){
      const on=value=>value===true||value==='1'||value==='on';
      sms=on(input.sms);push=on(input.push);
      if((sms&&!prior?.sms)||(push&&!prior?.push)){
        await policy.requireWorkspaceJob(c,ctx.workspaceId,173,'suggest');
        const available=require('../notifications/alert-providers').available();
        if(sms&&!prior?.sms&&!available.sms)throw new ValidationError('Text messages are not set up on this StockChief server yet.');
        if(push&&!prior?.push&&!available.push)throw new ValidationError('Push is not set up on this StockChief server yet.');
        // The owner gets these alerts; passed-on items and approvals go to whoever has them.
        if(![172,175].includes(id)){
          const mine=await require('./alert-phones').contact(c,ctx.workspaceId,ctx.actorId);
          if(sms&&!prior?.sms&&!mine.verified)throw new ValidationError('Add and confirm your mobile number on Your phone and devices first.');
          if(push&&!prior?.push&&!mine.devices.length)throw new ValidationError('Turn on push on one of your devices first, on Your phone and devices.');
        }
      }
    }else if(!phones&&(input.sms==='1'||input.push==='1'))throw new ValidationError('Text and push alerts are being upgraded. Try again shortly.');
    if(prior&&(prior.email_connector_id??null)===connector&&(prior.low_stock_units==null?null:exact.canonical(String(prior.low_stock_units)))===units&&(prior.escalation_hours??null)===hours
      &&Boolean(prior.sms)===sms&&Boolean(prior.push)===push)return {unchanged:true};
    if(!prior&&connector===null&&units===null&&hours===null&&!sms&&!push)return {unchanged:true};
    await c.query(`INSERT INTO ${channels} AS a(workspace_id,job_id,email_connector_id,low_stock_units,authorized_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,job_id) DO UPDATE SET email_connector_id=excluded.email_connector_id,low_stock_units=excluded.low_stock_units,
        authorized_by=excluded.authorized_by,email_note=NULL,revision=a.revision+1,updated_at=clock_timestamp()`,
      [ctx.workspaceId,id,connector,units,ctx.actorId]);
    if(id===172)await c.query(`UPDATE ${channels} SET escalation_hours=$3 WHERE workspace_id=$1 AND job_id=$2`,[ctx.workspaceId,id,hours]);
    if(phones)await c.query(`UPDATE ${channels} SET sms=$3,push=$4,phone_note=NULL WHERE workspace_id=$1 AND job_id=$2`,[ctx.workspaceId,id,sms,push]);
    await audit.record(c,ctx,{action:'Alert settings saved',reference:String(id),
      before:prior?{email:Boolean(prior.email_connector_id),...(id===166?{lowStockUnits:prior.low_stock_units==null?null:exact.canonical(String(prior.low_stock_units))}:{}),
        ...(id===172?{hours:prior.escalation_hours??null}:{}),...(phones?{text:Boolean(prior.sms),push:Boolean(prior.push)}:{})}:{},
      after:{email:Boolean(connector),...(id===166?{lowStockUnits:units}:{}),...(id===172?{hours}:{}),...(phones?{text:sms,push}:{})}});
    // A new alert level changes which products are low right away.
    if(id===166)await require('./operational-notices').refresh(c,ctx.workspaceId);
    return {saved:true};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// The owner sends the waiting alerts now. This is their own approval, so it
// works with Ask me first and during pause, but not in the first 14 days,
// Watch only or the job's Watch only.
async function sendNow(database,ctx,raw){
  const id=job(raw);
  return database.transaction(async c=>{
    await owner(c,ctx);
    const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,id,'suggest');
    const result=(await deliver(c,ctx.workspaceId,account,{only:id,manual:true}))[id];
    if(!result)throw new ValidationError('Choose how to send these alerts first.');
    const sent=Number(result.emailed||0)+Number(result.texted||0)+Number(result.pushed||0);
    if(!sent)throw new ValidationError(result.note||result.phoneNote||'Every open alert was already sent.');
    return {...result,sent};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Open alerts not yet sent on a channel the owner chose.
async function waitingCount(db,workspaceId,id,setting){
  if(JOBS[id].own)return require(JOBS[id].module).waiting(db,workspaceId,setting);
  const phones=setting&&await phoneColumns(db);
  const unsent=[setting?.email_connector_id?'email_batch IS NULL':null,phones&&setting.sms?'sms_batch IS NULL':null,phones&&setting.push?'push_batch IS NULL':null].filter(Boolean);
  if(!unsent.length)unsent.push('email_batch IS NULL');
  return Number((await db.query(`SELECT count(*) AS n FROM ${deliveries} WHERE workspace_id=$1 AND job_id=$2 AND (${unsent.join(' OR ')})`,[workspaceId,id])).rows[0].n);
}

// What the alert page shows about sending.
async function panel(db,ctx,raw){
  const id=job(raw);
  if(!await installed.has(db,channels)||!(await tracked(db)).includes(id))return null;
  const account=await policy.accountState(db,ctx.workspaceId);
  const setting=(await db.query(`SELECT a.*,m.status AS last_status FROM ${channels} a
    LEFT JOIN customer_communications m ON m.workspace_id=a.workspace_id AND m.id=a.last_communication_id
    WHERE a.workspace_id=$1 AND a.job_id=$2`,[ctx.workspaceId,id])).rows[0]||null;
  const waiting=await waitingCount(db,ctx.workspaceId,id,setting);
  const person=await currentOwner(db,ctx.workspaceId),boxes=await mailboxes(db,ctx.workspaceId);
  const chosen=setting?.email_connector_id?boxes.find(b=>b.id===setting.email_connector_id)||{id:setting.email_connector_id,name:'A mailbox that is no longer connected',missing:true}:null;
  // Job 173: text and push, on every plan with the Agent terms.
  const phones=await phoneColumns(db)&&policy.usesAgentTerms(account)&&policy.permits(account.plan,173,'suggest');
  const providers=require('../notifications/alert-providers').available();
  const mine=phones?await require('./alert-phones').contact(db,ctx.workspaceId,person?.id):null;
  const sms=Boolean(phones&&setting?.sms),push=Boolean(phones&&setting?.push),any=Boolean((chosen&&!chosen.missing)||sms||push);
  const held=require('./alert-phones').held;
  const stop=chosen||sms||push?await held(db,ctx.workspaceId,account,JOBS[id].action,false):null;
  const ownerStop=stop?await held(db,ctx.workspaceId,account,JOBS[id].action,true):null;
  return {job:id,action:'/autopilot/alerts/'+id,revision:setting?.revision||0,mailboxes:boxes,chosen,to:person?.email||null,
    lowStockUnits:id===166&&setting?.low_stock_units!=null?exact.canonical(String(setting.low_stock_units)):'',escalationHours:setting?.escalation_hours??'',
    waiting,note:setting?.email_note||null,stop,lastStatus:setting?.last_status||null,lastAt:setting?.last_emailed_at||null,
    phones:Boolean(phones),sms,push,smsReady:providers.sms,pushReady:providers.push,phoneNote:phones?setting?.phone_note||null:null,
    ownPhone:mine?.verified?mine.ending:null,ownDevices:mine?mine.devices.length:0,toWhoever:[172,175].includes(id),devicesPath:require('./alert-phones').path,
    canSendNow:Boolean(any&&waiting&&stop&&!ownerStop)};
}

// Every kind of alert this plan sends and the channels each one uses, for
// "Your phone and devices".
async function kinds(db,workspaceId,account){
  if(!policy.usesAgentTerms(account)||!await installed.has(db,channels))return [];
  const phones=await phoneColumns(db);
  const rows=(await db.query(`SELECT * FROM ${channels} WHERE workspace_id=$1`,[workspaceId])).rows;
  return (await tracked(db)).filter(id=>policy.permits(account.plan,id,'automatic')).map(id=>{
    const r=rows.find(x=>Number(x.job_id)===id);
    return {job:id,name:JOBS[id].name,email:Boolean(r?.email_connector_id),sms:Boolean(phones&&r?.sms),push:Boolean(phones&&r?.push)};
  });
}

module.exports={JOBS,track,deliver,queue,emailAuthority,configure,sendNow,panel,kinds,mailboxes,pathFor,forKey,currentOwner,tracked};

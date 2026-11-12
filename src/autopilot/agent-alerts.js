'use strict';

// Jobs 166, 167 and 168 deliver their alerts the same way.
//
// The alerts are agent notices: the routine check (operational-notices.refresh,
// run by the worker) opens, updates and clears them. Every alert is shown in
// the app and in Needs you on every plan and in every mode, because an alert
// changes nothing.
//
// After each check this module:
//  - records which alerts opened and cleared, and audits the change once;
//  - emails the alerts that opened since the last email, as one message per
//    kind of alert, from the connected mailbox the owner chose to the owner.
// Sending is work StockChief does on its own, so it waits during the first 14
// days (shadow mode), pause, Watch only, the job's Watch only or Ask me first,
// and while saved rules exceed the plan's allowance. The waiting alerts are
// emailed once StockChief may act again, if they are still open. With Ask me
// first the owner can send them from the alert page.
//
// Push and SMS are not built. The email goes through the existing mailbox
// outbox; live delivery from a real Gmail or Microsoft 365 mailbox is checked
// only with the test provider.

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
    subject:(n,first)=>n===1?first.split(' (')[0]:n+' stock alerts',intro:'StockChief found stock that needs you.'}
};
const plural=(n,one,many)=>n+' '+(Number(n)===1?one:many);
const expected=error=>error instanceof DomainError&&[400,402,403,404,409,422].includes(error.status);
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const job=value=>{const id=Number(value);if(!JOBS[id])throw new NotFoundError('That alert is not available.');return id;};
const pathFor=id=>require(JOBS[id].module).path;
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
      WHERE n.workspace_id=$1 AND n.job_id IN (166,167,168) AND NOT n.resolved AND NOT EXISTS(SELECT 1 FROM ${deliveries} d
        WHERE d.workspace_id=n.workspace_id AND d.job_id=n.job_id AND d.kind=n.kind AND d.reference=n.reference AND d.link=n.link)
      ON CONFLICT DO NOTHING RETURNING job_id`,[workspaceId])).rows;
    if(raised.length||cleared.length){
      const count=rows=>{const out={};for(const r of rows)out[r.job_id]=(out[r.job_id]||0)+1;return out;};
      const person=await currentOwner(c,workspaceId);
      await audit.record(c,{workspaceId,actorId:person?.id||null},{action:'Alerts updated',after:{opened:count(raised),cleared:count(cleared)}});
    }
    const email=await deliver(c,workspaceId,account);
    return {raised:raised.length,cleared:cleared.length,email};
  });
}

// Emails the open alerts of each kind that have not been emailed yet.
// `manual` is the owner's own request from the alert page (Ask me first).
async function deliver(c,workspaceId,account,{only=null,manual=false}={}){
  const out={};
  if(!policy.usesAgentTerms(account))return out;
  const settings=(await c.query(`SELECT * FROM ${channels} WHERE workspace_id=$1 AND email_connector_id IS NOT NULL AND ($2::int IS NULL OR job_id=$2)
    ORDER BY job_id FOR UPDATE`,[workspaceId,only])).rows;
  for(const setting of settings){
    const id=Number(setting.job_id),spec=JOBS[id];
    if(!policy.permits(account.plan,id,'automatic'))continue;
    const pending=(await c.query(`SELECT kind,reference,link FROM ${deliveries} WHERE workspace_id=$1 AND job_id=$2 AND email_batch IS NULL
      ORDER BY raised_at,kind,reference,link LIMIT ${MAX_EMAIL}`,[workspaceId,id])).rows;
    const note=async text=>{
      if((setting.email_note||null)!==(text||null))await c.query(`UPDATE ${channels} SET email_note=$3 WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,id,text?text.slice(0,500):null]);
      out[id]={emailed:0,note:text||null};
    };
    if(!pending.length){await note(null);continue;}
    const stop=await policy.stopped(c,workspaceId,account,spec.action,!manual);
    if(stop){await note('No email was sent. '+stop);continue;}
    const person=await currentOwner(c,workspaceId);
    if(!person||!EMAIL.test(person.email||'')){await note('Your account has no email address, so no email was sent.');continue;}
    const box=(await mailboxes(c,workspaceId)).find(b=>b.id===setting.email_connector_id);
    if(!box){await note('The chosen mailbox is disconnected, paused or cannot send. Reconnect it, or choose another. No email was sent.');continue;}
    const text=await require(spec.module).lines(c,workspaceId,pending);
    const batch=newId('alert-email');
    await c.query('SAVEPOINT agent_alert_email');
    try{
      const queued=await require('../connections/postgres-outbound-mail').queueInTransaction(c,{workspaceId,actorId:person.id},{
        recipientKind:'address',recipientEmail:person.email,connectorId:box.id,
        subject:spec.subject(pending.length,text[0]).replace(/[\r\n]+/g,' ').slice(0,200),
        body:spec.intro+'\n\n'+text.map(line=>'- '+line).join('\n')+'\n\nOpen '+spec.name+' in StockChief to see every alert.',
        standingAuthority:{kind:'agent_alert',job:id,batch,connectorId:box.id,manual}},'agent-alert-email:'+batch);
      await c.query('RELEASE SAVEPOINT agent_alert_email');
      await c.query(`UPDATE ${deliveries} d SET email_batch=$3,email_communication_id=$4
        FROM unnest($5::text[],$6::text[],$7::text[]) k(kind,reference,link)
        WHERE d.workspace_id=$1 AND d.job_id=$2 AND d.kind=k.kind AND d.reference=k.reference AND d.link=k.link AND d.email_batch IS NULL`,
      [workspaceId,id,batch,queued.communicationId,pending.map(p=>p.kind),pending.map(p=>p.reference),pending.map(p=>p.link)]);
      await c.query(`UPDATE ${channels} SET email_note=NULL,last_communication_id=$3,last_emailed_at=clock_timestamp() WHERE workspace_id=$1 AND job_id=$2`,
        [workspaceId,id,queued.communicationId]);
      await audit.record(c,{workspaceId,actorId:person.id},{action:'Alert email queued',reference:queued.communicationId,
        after:{job:id,alerts:pending.length,mailbox:box.name,to:person.email,...(manual?{sentByOwner:true}:{})}});
      out[id]={emailed:pending.length,communicationId:queued.communicationId};
    }catch(error){
      if(!expected(error))throw error;
      await c.query('ROLLBACK TO SAVEPOINT agent_alert_email');await c.query('RELEASE SAVEPOINT agent_alert_email');
      await note('No email was sent. '+error.message);
    }
  }
  return out;
}

// Checked again just before the mailbox sends: the job may still act, the
// owner still wants email from that mailbox, and an alert in it is still open.
async function emailAuthority(db,workspaceId,grant){
  const id=Number(grant?.job);
  if(!JOBS[id])throw new ValidationError('This alert email is not recognised, so it was not sent.');
  const account=await policy.accountState(db,workspaceId);
  policy.requireJob(policy.usesAgentTerms(account)?account.plan:null,id,'automatic');
  const stop=await policy.stopped(db,workspaceId,account,JOBS[id].action,grant.manual!==true);
  if(stop)throw new ValidationError(stop+' The alert email is held.');
  const setting=(await db.query(`SELECT email_connector_id FROM ${channels} WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,id])).rows[0];
  if(!setting||setting.email_connector_id!==grant.connectorId)throw new ValidationError('The alert email settings changed, so this email was not sent.');
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
    if(prior&&(prior.email_connector_id??null)===connector&&(prior.low_stock_units==null?null:exact.canonical(String(prior.low_stock_units)))===units)return {unchanged:true};
    if(!prior&&connector===null&&units===null)return {unchanged:true};
    await c.query(`INSERT INTO ${channels} AS a(workspace_id,job_id,email_connector_id,low_stock_units,authorized_by) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(workspace_id,job_id) DO UPDATE SET email_connector_id=excluded.email_connector_id,low_stock_units=excluded.low_stock_units,
        authorized_by=excluded.authorized_by,email_note=NULL,revision=a.revision+1,updated_at=clock_timestamp()`,
      [ctx.workspaceId,id,connector,units,ctx.actorId]);
    await audit.record(c,ctx,{action:'Alert settings saved',reference:String(id),
      before:prior?{email:Boolean(prior.email_connector_id),...(id===166?{lowStockUnits:prior.low_stock_units==null?null:exact.canonical(String(prior.low_stock_units))}:{})}:{},
      after:{email:Boolean(connector),...(id===166?{lowStockUnits:units}:{})}});
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
    if(!result)throw new ValidationError('Choose a mailbox for these alerts first.');
    if(!result.emailed)throw new ValidationError(result.note||'Every open alert was already emailed.');
    return result;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// What the alert page shows about sending.
async function panel(db,ctx,raw){
  const id=job(raw);
  if(!await installed.has(db,channels))return null;
  const account=await policy.accountState(db,ctx.workspaceId);
  const setting=(await db.query(`SELECT a.*,m.status AS last_status FROM ${channels} a
    LEFT JOIN customer_communications m ON m.workspace_id=a.workspace_id AND m.id=a.last_communication_id
    WHERE a.workspace_id=$1 AND a.job_id=$2`,[ctx.workspaceId,id])).rows[0]||null;
  const waiting=Number((await db.query(`SELECT count(*) AS n FROM ${deliveries} WHERE workspace_id=$1 AND job_id=$2 AND email_batch IS NULL`,
    [ctx.workspaceId,id])).rows[0].n);
  const person=await currentOwner(db,ctx.workspaceId),boxes=await mailboxes(db,ctx.workspaceId);
  const chosen=setting?.email_connector_id?boxes.find(b=>b.id===setting.email_connector_id)||{id:setting.email_connector_id,name:'A mailbox that is no longer connected',missing:true}:null;
  const stop=chosen?await policy.stopped(db,ctx.workspaceId,account,JOBS[id].action,true):null;
  const ownerStop=stop?await policy.stopped(db,ctx.workspaceId,account,JOBS[id].action,false):null;
  return {job:id,action:'/autopilot/alerts/'+id,revision:setting?.revision||0,mailboxes:boxes,chosen,to:person?.email||null,
    lowStockUnits:id===166&&setting?.low_stock_units!=null?exact.canonical(String(setting.low_stock_units)):'',
    waiting,note:setting?.email_note||null,stop,lastStatus:setting?.last_status||null,lastAt:setting?.last_emailed_at||null,
    canSendNow:Boolean(chosen&&!chosen.missing&&waiting&&stop&&!ownerStop)};
}

module.exports={JOBS,track,deliver,emailAuthority,configure,sendNow,panel,mailboxes,pathFor,forKey};

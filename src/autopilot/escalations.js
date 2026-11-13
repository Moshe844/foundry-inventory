'use strict';

// Job 172: pass an alert or approval nobody answers to the next person.
// Alone on Pro and Custom; Starter and Growth are excluded.
//
// Once the owner chooses a window (hours), every check (the worker's
// agent.escalations job, queued by the routine check) follows each open item:
//  - an alert from jobs 166 to 171 (low stock, watch rules, late work, sales
//    channels, cost and margin, unusual activity);
//  - an approval in the owner's Needs you. Two-person purchase signatures keep
//    their own routing and window (jobs 176 and 172 in approval-routing.js).
// An item nobody answered within the window is passed to the next person:
// team members who hold the permission the item needs and, when it has an
// amount, a purchase approval limit that covers it, lowest limit and staff
// before people who manage settings (job 176's order), and the owner last.
// Each holder gets the same window. The person it is passed to sees it in
// Needs you and gets an email from the mailbox the owner chose, and a text or
// push to their own confirmed number and devices when the owner chose those
// (job 173).
//
// Answering stops it: "I'm on it" from the holder, anyone it was passed to or
// the owner, or the alert clearing or the approval being decided. Passing on
// is work StockChief does on its own, so it waits in the first 14 days, pause,
// Watch only, the job's Watch only and Ask me first; with Ask me first or pause
// the owner can pass a due item on. Every pass and answer is audited.

const {createHash}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const permissions=require('../actions/permissions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=172,ACTION='alert.escalation',key='unanswered',path='/autopilot/reviews/'+key;
const label='Pass unanswered alerts and approvals to the next person';
const table='stockchief_runtime.agent_escalations',channels='stockchief_runtime.agent_alert_channels';
const ALERT_JOBS=[166,167,168,169,170,171];
const names={166:'Stock alert',167:'Watch rule',168:'Overdue',169:'Sales channel alert',170:'Cost and margin alert',171:'Unusual activity'};
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,40);
const hours=n=>n+' hour'+(Number(n)===1?'':'s');

async function ready(db){return installed.has(db,table);}
async function windowHours(db,workspaceId){
  if(!await installed.has(db,channels,'escalation_hours'))return null;
  return (await db.query(`SELECT escalation_hours FROM ${channels} WHERE workspace_id=$1 AND job_id=${JOB}`,[workspaceId])).rows[0]?.escalation_hours||null;
}
const alone=state=>policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'automatic');
// Whether the routine check should queue a check of unanswered items.
async function enabled(db,workspaceId,state){return alone(state)&&await ready(db)&&Boolean(await windowHours(db,workspaceId));}

async function team(db,workspaceId){
  return (await db.query(`SELECT u.id,u.name,u.role,u.permissions,u.po_approval_limit_minor,u.po_approval_currency,u.warehouse_location_ids,a.email,
      w.owner_account_id=u.account_id AND u.role='owner' AS is_owner
    FROM users u JOIN workspaces w ON w.id=u.workspace_id JOIN accounts a ON a.id=u.account_id
    WHERE u.workspace_id=$1 AND u.account_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id`,[workspaceId])).rows;
}

// Who gets an item next: team members who may see it and whose purchase
// approval limit covers its amount, the least senior first, the owner last.
function chain(item,people){
  const owner=people.find(p=>p.is_owner);
  const covers=p=>item.amount_minor==null||!item.currency||p.po_approval_limit_minor==null&&p.warehouse_location_ids==null||
    p.po_approval_currency===item.currency&&Number(item.amount_minor)<=Number(p.po_approval_limit_minor);
  const limit=p=>p.po_approval_limit_minor==null?Number.MAX_SAFE_INTEGER:Number(p.po_approval_limit_minor);
  const helpers=people.filter(p=>!p.is_owner&&p.role!=='owner'&&permissions.can(p,item.permission)&&covers(p))
    .sort((a,b)=>Number(permissions.can(a,permissions.ADMIN))-Number(permissions.can(b,permissions.ADMIN))||
      (item.amount_minor==null?0:limit(a)-limit(b))||String(a.name).localeCompare(String(b.name))||String(a.id).localeCompare(String(b.id)));
  return owner?[...helpers,owner]:helpers;
}

// The permission an alert needs, from its job and kind.
function alertPermission(job,kind){
  if(job===168)return /invoice|bill/i.test(kind)?permissions.VIEW_ACCOUNTING:/purchase/i.test(kind)?permissions.VIEW_PURCHASING:permissions.VIEW_SALES;
  if(job===169||job===171)return permissions.ADMIN;
  if(job===170)return permissions.VIEW_ACCOUNTING;
  return permissions.VIEW_PURCHASING;
}

// Every open alert and owner approval now, keyed for tracking.
async function currentItems(database,workspaceId,owner,state){
  const jobs=ALERT_JOBS.filter(job=>policy.permits(state.plan,job,'automatic'));
  const delivered=await installed.has(database,'stockchief_runtime.agent_alert_deliveries');
  const notices=(await database.query(`SELECT n.job_id,n.kind,n.reference,n.link,${delivered?'d.raised_at':'NULL::timestamptz AS raised_at'}
    FROM stockchief_runtime.agent_operational_notices n
    ${delivered?`LEFT JOIN stockchief_runtime.agent_alert_deliveries d ON d.workspace_id=n.workspace_id AND d.job_id=n.job_id AND d.kind=n.kind
      AND d.reference=n.reference AND d.link=n.link`:''}
    WHERE n.workspace_id=$1 AND NOT n.resolved AND n.job_id=ANY($2::int[]) ORDER BY n.job_id,n.kind,n.reference LIMIT 2000`,[workspaceId,jobs])).rows;
  const items=[],alerts=require('./agent-alerts');
  for(const job of jobs){
    const mine=notices.filter(n=>Number(n.job_id)===job);if(!mine.length)continue;
    const keys=mine.map(n=>({kind:n.kind,reference:n.reference,link:n.link}));
    const text=alerts.JOBS[job]?await require(alerts.JOBS[job].module).lines(database,workspaceId,keys):keys.map(k=>names[job]+': '+k.kind+'.');
    mine.forEach((n,i)=>items.push({key:'alert:'+job+':'+hash([n.kind,n.reference,n.link]),source:'ALERT',job_id:job,title:String(text[i]||n.kind).slice(0,300),
      href:String(n.link).slice(0,500),permission:alertPermission(job,n.kind),amount_minor:null,currency:null,opened_at:n.raised_at||null}));
  }
  const decisions=await require('../projections/postgres-service').needs(database,workspaceId,owner.id);
  for(const d of decisions){
    const source=String(d.sourceId||'');
    if(d.kind!=='approval'||!d.href||source.startsWith('escalation:')||source.startsWith('po-signature-'))continue;
    const amount=Number.isSafeInteger(d.moneyValue)&&/^[A-Z]{3}$/.test(d.moneyCurrency||'')?d.moneyValue:null;
    items.push({key:'approval:'+hash([source,d.href]),source:'APPROVAL',job_id:null,title:String(d.title||'An approval').slice(0,300),href:String(d.href).slice(0,500),
      permission:String((d.requiredPermissions||[])[0]||permissions.VIEW).slice(0,60),amount_minor:amount,currency:amount==null?null:d.moneyCurrency,
      opened_at:d.createdAt&&!Number.isNaN(Date.parse(d.createdAt))?new Date(d.createdAt).toISOString():null});
  }
  return items;
}

async function currentOwner(db,workspaceId){
  return (await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]||null;
}
async function note(c,workspaceId,text){
  await c.query(`UPDATE ${channels} SET email_note=$2 WHERE workspace_id=$1 AND job_id=${JOB} AND email_note IS DISTINCT FROM $2`,[workspaceId,text?text.slice(0,500):null]);
}

// Moves one item to its next person. Returns who got it, or null.
async function pass(c,ctx,row,people,{manual=false}={}){
  const next=chain(row,people)[row.step];
  if(!next)return null;
  const before=people.find(p=>p.id===row.holder_user_id);
  await c.query(`UPDATE ${table} SET holder_user_id=$3,step=step+1,passed_to=passed_to||to_jsonb($3::text),passed_at=clock_timestamp(),
    email_batch=NULL,email_communication_id=NULL${await phoneColumns(c)?",sms_batch=NULL,push_batch=NULL":""},updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id,next.id]);
  await audit.record(c,ctx,{action:row.source==='ALERT'?'Unanswered alert passed on':'Unanswered approval passed on',reference:row.title,
    before:{with:before?before.name:'Owner',step:row.step},after:{with:next.name,step:row.step+1,...(manual?{passedByOwner:true}:{})}});
  return next;
}

// Sends each person the items passed to them: by email from the chosen
// mailbox, and by text and push to their own number and devices (job 173).
async function deliver(c,workspaceId,account,setting,{manual=false}={}){
  const out={emailed:0,note:null,texted:0,pushed:0,phoneNote:null};
  if(setting.email_connector_id)Object.assign(out,await deliverEmail(c,workspaceId,account,setting,{manual}));
  if(setting.sms||setting.push)Object.assign(out,await deliverPhone(c,workspaceId,account,setting,{manual}));
  return out;
}
const phoneColumns=db=>installed.has(db,table,'sms_batch');
async function deliverPhone(c,workspaceId,account,setting,{manual}){
  const out={texted:0,pushed:0,phoneNote:null};
  if(!await phoneColumns(c))return out;
  const phones=require('./alert-phones'),want=['sms','push'].filter(ch=>setting[ch]);
  const notePhone=async text=>{
    await c.query(`UPDATE ${channels} SET phone_note=$2 WHERE workspace_id=$1 AND job_id=${JOB} AND phone_note IS DISTINCT FROM $2`,[workspaceId,text?text.slice(0,500):null]);
    out.phoneNote=text||null;return out;
  };
  const rows=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='WAITING' AND step>0 AND holder_user_id IS NOT NULL
    AND (${want.map(ch=>ch+'_batch IS NULL').join(' OR ')}) ORDER BY holder_user_id,passed_at,id LIMIT 200`,[workspaceId])).rows;
  if(!rows.length)return notePhone(null);
  const stop=await phones.held(c,workspaceId,account,ACTION,manual);
  if(stop)return notePhone('Nothing was texted or pushed. '+stop);
  const people=await team(c,workspaceId),problems=[];
  for(const holder of [...new Set(rows.map(r=>r.holder_user_id))]){
    const person=people.find(p=>p.id===holder);if(!person)continue;
    for(const ch of want){
      const list=rows.filter(r=>r.holder_user_id===holder&&!r[ch+'_batch']);if(!list.length)continue;
      const title=list.length===1?(person.is_owner?'Nobody answered: ':'Passed to you: ')+list[0].title.split('. ')[0]:list.length+' unanswered alerts and approvals passed to you';
      const body=list.length===1?list[0].title:title+'. '+list.slice(0,2).map(r=>r.title.split('. ')[0]+'.').join(' ')+(list.length>2?' And '+(list.length-2)+' more.':'');
      const batch=newId('escalation-'+ch);
      const queued=await phones.queue(c,workspaceId,{purpose:'ALERT',job:JOB,batch,userId:person.id,sms:ch==='sms',push:ch==='push',
        title,body,url:phones.link(list.length===1?list[0].href:'/needs-you'),manual});
      if(!queued[ch]){problems.push(person.name+': '+queued.problems.join(' '));continue;}
      await c.query(`UPDATE ${table} SET ${ch}_batch=$3 WHERE workspace_id=$1 AND id=ANY($2::text[])`,[workspaceId,list.map(r=>r.id),batch]);
      await audit.record(c,{workspaceId,actorId:people.find(p=>p.is_owner)?.id||person.id},{action:ch==='sms'?'Alert text queued':'Alert push queued',reference:batch,
        after:{job:JOB,alerts:list.length,to:person.name,...(manual?{sentByOwner:true}:{})}});
      out[ch==='sms'?'texted':'pushed']+=list.length;
    }
  }
  return notePhone(problems.length?problems.join(' ').slice(0,500):null);
}
// Checked again just before a text or push goes out: the items are still
// waiting with the same person.
async function phoneAuthority(db,workspaceId,m){
  const column=m.channel==='SMS'?'sms_batch':'push_batch';
  const open=(await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND ${column}=$2 AND status='WAITING' AND holder_user_id=$3 LIMIT 1`,
    [workspaceId,String(m.batch||''),String(m.user_id||'')])).rowCount;
  if(!open)throw new ValidationError('These items were answered or moved on before the message was sent, so it was not sent.');
}
// Items passed on and not sent yet on a channel the owner chose.
async function waiting(db,workspaceId,setting){
  const phones=setting&&await phoneColumns(db);
  const unsent=[setting?.email_connector_id?'email_batch IS NULL':null,phones&&setting.sms?'sms_batch IS NULL':null,phones&&setting.push?'push_batch IS NULL':null].filter(Boolean);
  if(!unsent.length)unsent.push('email_batch IS NULL');
  return Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE workspace_id=$1 AND status='WAITING' AND step>0 AND holder_user_id IS NOT NULL
    AND (${unsent.join(' OR ')})`,[workspaceId])).rows[0].n);
}

// Emails each person the items passed to them that were not emailed yet.
async function deliverEmail(c,workspaceId,account,setting,{manual=false}={}){
  const waiting=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='WAITING' AND step>0 AND email_batch IS NULL
    AND holder_user_id IS NOT NULL ORDER BY holder_user_id,passed_at,id LIMIT 200`,[workspaceId])).rows;
  const alerts=require('./agent-alerts');
  if(!waiting.length){await note(c,workspaceId,null);return {emailed:0,note:null};}
  const stop=await require('./alert-phones').held(c,workspaceId,account,ACTION,manual);
  if(stop){const text='No email was sent. '+stop;await note(c,workspaceId,text);return {emailed:0,note:text};}
  const box=(await alerts.mailboxes(c,workspaceId)).find(b=>b.id===setting.email_connector_id);
  if(!box){const text='The chosen mailbox is disconnected, paused or cannot send. Reconnect it, or choose another. No email was sent.';await note(c,workspaceId,text);return {emailed:0,note:text};}
  const people=await team(c,workspaceId);let emailed=0,last=null;
  for(const holder of [...new Set(waiting.map(r=>r.holder_user_id))]){
    const person=people.find(p=>p.id===holder),rows=waiting.filter(r=>r.holder_user_id===holder);
    if(!person||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.email||''))continue;
    const subject=rows.length===1?(person.is_owner?'Nobody answered: ':'Passed to you: ')+rows[0].title.split('. ')[0]:rows.length+' unanswered alerts and approvals passed to you';
    const body=(person.is_owner?'Nobody on your team answered these in time, so they are back with you.':'Nobody answered these in time, so StockChief passed them to you.')+
      '\n\n'+rows.map(r=>'- '+r.title).join('\n')+'\n\nOpen Needs you in StockChief and tap "I\'m on it" when you take one.';
    const queued=await alerts.queue(c,workspaceId,{job:JOB,person,box,subject,body,manual,count:rows.length,authority:{userId:person.id},
      sender:people.find(p=>p.is_owner)?.id||person.id});
    if(queued.problem){await note(c,workspaceId,'No email was sent. '+queued.problem);continue;}
    await c.query(`UPDATE ${table} SET email_batch=$3,email_communication_id=$4 WHERE workspace_id=$1 AND id=ANY($2::text[])`,
      [workspaceId,rows.map(r=>r.id),queued.batch,queued.communicationId]);
    emailed+=rows.length;last=queued.communicationId;
  }
  if(last)await c.query(`UPDATE ${channels} SET email_note=NULL,last_communication_id=$2,last_emailed_at=clock_timestamp() WHERE workspace_id=$1 AND job_id=${JOB}`,[workspaceId,last]);
  return {emailed,note:null};
}

// Checked again just before the mailbox sends: the items are still waiting
// with the same person.
async function emailAuthority(db,workspaceId,grant){
  const open=(await db.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1 AND email_batch=$2 AND status='WAITING' AND holder_user_id=$3 LIMIT 1`,
    [workspaceId,String(grant.batch||''),String(grant.userId||'')])).rowCount;
  if(!open)throw new ValidationError('These items were answered or moved on before the email was sent, so it was not sent.');
}

// The worker: follow every open item, close answered ones and pass due ones.
async function run(database,workspaceId){
  const state=await policy.accountState(database,workspaceId);
  if(!alone(state))return {skipped:'plan'};
  if(!await ready(database))return {skipped:'upgrade'};
  const window=await windowHours(database,workspaceId);if(!window)return {skipped:'off'};
  const owner=await currentOwner(database,workspaceId);if(!owner)return {skipped:'owner_unavailable'};
  const items=await currentItems(database,workspaceId,owner,state);
  return tx(database,async c=>{
    const ctx={workspaceId,actorId:owner.id},resetPhones=await phoneColumns(c)?',sms_batch=NULL,push_batch=NULL':'';
    const rows=new Map((await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 FOR UPDATE`,[workspaceId])).rows.map(r=>[r.item_key,r]));
    const seen=new Set(items.map(i=>i.key));let opened=0,closed=0;
    for(const item of items){
      const row=rows.get(item.key);
      if(row&&row.status!=='CLOSED'){
        if(row.title!==item.title||row.href!==item.href)await c.query(`UPDATE ${table} SET title=$3,href=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.id,item.title,item.href]);
        continue;
      }
      opened++;
      const fields=[item.source,item.job_id,item.title,item.href,item.permission,item.amount_minor,item.currency,item.opened_at];
      if(row)await c.query(`UPDATE ${table} SET source=$3,job_id=$4,title=$5,href=$6,permission=$7,amount_minor=$8,currency=$9,opened_at=coalesce($10::timestamptz,clock_timestamp()),
          step=0,holder_user_id=NULL,passed_to='[]',passed_at=NULL,status='WAITING',answered_by=NULL,answered_at=NULL,closed_at=NULL,email_batch=NULL,email_communication_id=NULL${resetPhones},
          updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.id,...fields]);
      else await c.query(`INSERT INTO ${table}(workspace_id,id,item_key,source,job_id,title,href,permission,amount_minor,currency,opened_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,clock_timestamp())) ON CONFLICT DO NOTHING`,[workspaceId,newId('escalation'),item.key,...fields]);
    }
    for(const row of rows.values())if(row.status!=='CLOSED'&&!seen.has(row.item_key)){
      closed++;await c.query(`UPDATE ${table} SET status='CLOSED',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,row.id]);
    }
    const due=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='WAITING'
      AND coalesce(passed_at,opened_at)+make_interval(hours=>$2)<=clock_timestamp() ORDER BY opened_at,id`,[workspaceId,window])).rows;
    const people=await team(c,workspaceId),passing=due.filter(r=>chain(r,people)[r.step]);
    const stop=passing.length?await policy.stopped(c,workspaceId,state,ACTION,true):null;
    // While held, the page shows why (actions) and the owner may pass a due item on.
    let passed=0;
    if(!stop)for(const row of passing)if(await pass(c,ctx,row,people))passed++;
    const setting=(await c.query(`SELECT * FROM ${channels} WHERE workspace_id=$1 AND job_id=${JOB}`,[workspaceId])).rows[0];
    // Emails that waited (pause, Ask me first, the first 14 days) go out once StockChief may act again.
    const email=setting&&(setting.email_connector_id||setting.sms||setting.push)?await deliver(c,workspaceId,state,setting):null;
    return {opened,closed,passed,held:stop?passing.length:0,email};
  });
}

async function member(c,ctx){
  const user=(await c.query(`SELECT u.*,w.owner_account_id=u.account_id AND u.role='owner' AS is_owner FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.workspace_id=$1 AND u.id=$2`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!user)throw new AuthorizationError('You are not on this team.');
  return user;
}
async function answered(c,ctx,row,user){
  await c.query(`UPDATE ${table} SET status='ANSWERED',answered_by=$3,answered_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,row.id,user.id]);
  await audit.record(c,ctx,{action:row.source==='ALERT'?'Answered an alert':'Answered an approval',reference:row.title,after:{by:user.name,step:row.step}});
}
// "I'm on it": the person who has it, anyone it was passed to, or the owner.
async function answer(database,ctx,id){
  return tx(database,async c=>{
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'suggest');
    const user=await member(c,ctx);
    const row=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
    if(!row)throw new NotFoundError('That item is not in this inventory.');
    if(row.status!=='WAITING')return {replayed:true};
    if(!user.is_owner&&row.holder_user_id!==user.id&&!row.passed_to.includes(user.id))throw new AuthorizationError('Only the person it was passed to, or the owner, can answer it.');
    await answered(c,ctx,row,user);
    return {answered:1};
  });
}
// The owner answers every waiting alert of one kind from Needs you.
async function answerJob(database,ctx,raw){
  const job=Number(raw);
  if(!ALERT_JOBS.includes(job))throw new NotFoundError('That alert is not available.');
  return tx(database,async c=>{
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'suggest');
    const user=await member(c,ctx);
    if(!user.is_owner)throw new AuthorizationError('Only the owner can answer every alert at once.');
    const rows=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='WAITING' AND source='ALERT' AND job_id=$2 ORDER BY id FOR UPDATE`,[ctx.workspaceId,job])).rows;
    for(const row of rows)await answered(c,ctx,row,user);
    return {answered:rows.length};
  });
}
// The owner's approval to pass a due item on, under Ask me first or pause.
async function passNow(database,ctx,id){
  return tx(database,async c=>{
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    const user=await member(c,ctx);
    if(!user.is_owner)throw new AuthorizationError('Only the owner can pass an item on.');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);if(stop)throw new ValidationError(stop);
    const window=await windowHours(c,ctx.workspaceId);if(!window)throw new ValidationError('Choose how long to wait for an answer first.');
    const row=(await c.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND status='WAITING'
      AND coalesce(passed_at,opened_at)+make_interval(hours=>$3)<=clock_timestamp() FOR UPDATE`,[ctx.workspaceId,String(id||''),window])).rows[0];
    if(!row)throw new ValidationError('This item is answered, closed or not due yet.');
    const next=await pass(c,ctx,row,await team(c,ctx.workspaceId),{manual:true});
    if(!next)throw new ValidationError('Everyone who can take this has had it.');
    const setting=(await c.query(`SELECT * FROM ${channels} WHERE workspace_id=$1 AND job_id=${JOB}`,[ctx.workspaceId])).rows[0];
    if(setting&&(setting.email_connector_id||setting.sms||setting.push))await deliver(c,ctx.workspaceId,state,setting,{manual:true});
    return {to:next.name};
  });
}

// Needs you: what was passed to this person.
async function inbox(db,workspaceId,actorId){
  if(!actorId||!await ready(db))return [];
  const rows=(await db.query(`SELECT e.*,(SELECT count(*) FROM jsonb_array_elements_text(e.passed_to)) AS passes FROM ${table} e
    WHERE e.workspace_id=$1 AND e.status='WAITING' AND e.step>0 AND e.holder_user_id=$2 ORDER BY e.passed_at,e.id LIMIT 50`,[workspaceId,actorId])).rows;
  if(!rows.length)return [];
  const state=await policy.accountState(db,workspaceId);if(!alone(state))return [];
  const window=await windowHours(db,workspaceId),owner=await currentOwner(db,workspaceId),mine=owner?.id===actorId;
  return rows.map(r=>({kind:'approval',requiredPermissions:[r.permission],importance:mine?'Urgent':'Important',priority:mine?93:89,
    title:(mine?'Nobody answered: ':'Passed to you: ')+r.title.split('. ')[0],
    happened:r.title+(window?' Nobody answered it within '+hours(window)+(mine?', so it is back with you.':', so StockChief passed it to you.'):''),
    why:'The owner asked StockChief to pass alerts and approvals on when nobody answers.',
    recommendation:'Open it and deal with it. Tap "I\'m on it" so nobody else is asked.',
    href:r.href,actionLabel:r.source==='ALERT'?'Open alert':'Open approval',
    dismiss:{action:'/autopilot/escalations/'+encodeURIComponent(r.id)+'/answer',label:'I\'m on it'},
    sourceId:'escalation:'+r.id,createdAt:r.passed_at,timeLabel:'Passed on',at:r.passed_at}));
}
// The alert kinds the owner can answer at once from Needs you.
async function answerable(db,workspaceId){
  if(!await ready(db))return new Set();
  return new Set((await db.query(`SELECT DISTINCT job_id FROM ${table} WHERE workspace_id=$1 AND status='WAITING' AND source='ALERT'`,[workspaceId])).rows.map(r=>Number(r.job_id)));
}

// The page: what is waiting, who has it, who is next and when.
async function review(db,ctx,{page=1}){
  if(!await ready(db))return {rows:[],more:false,summary:'This is being upgraded. Check back shortly.'};
  const window=await windowHours(db,ctx.workspaceId);
  const summary=window?'Alerts and approvals in your Needs you that nobody answered within '+hours(window)+' go to the next person who can take them: '+
    'the team member with the right permission and enough approval limit, then the owner. Two-person purchase signatures follow their own window.'
    :'Choose how many hours to wait for an answer, and StockChief passes unanswered alerts and approvals to the next person, then back to you.';
  const rows=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND status='WAITING' ORDER BY opened_at,id LIMIT 101 OFFSET $2`,[ctx.workspaceId,(page-1)*100])).rows;
  const people=await team(db,ctx.workspaceId),zone=(await require('../lib/business-time').forWorkspace(db,ctx.workspaceId)).timeZone;
  const local=value=>new Intl.DateTimeFormat('en-US',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
  return {summary,more:rows.length>100,rows:rows.slice(0,100).map(r=>{
    const next=chain(r,people)[r.step],holder=people.find(p=>p.id===r.holder_user_id);
    const due=window?new Date(new Date(r.passed_at||r.opened_at).getTime()+window*3600000):null;
    return {Item:r.title,Kind:r.source==='ALERT'?'Alert':'Approval','With now':holder?holder.name:'Owner','Waiting since':local(r.opened_at),
      Next:!window?'Not passed on':next?next.name+(due?', '+local(due):''):'Nobody else can take it',link:r.href};
  })};
}
// The answer and pass-on buttons under the list.
async function actions(db,ctx){
  if(!await ready(db))return null;
  const window=await windowHours(db,ctx.workspaceId),state=await policy.accountState(db,ctx.workspaceId);
  const rows=(await db.query(`SELECT id,title,step,coalesce(passed_at,opened_at)+make_interval(hours=>coalesce($2::int,0))<=clock_timestamp() AS due
    FROM ${table} WHERE workspace_id=$1 AND status='WAITING' ORDER BY opened_at,id LIMIT 100`,[ctx.workspaceId,window])).rows;
  const stop=window?await policy.stopped(db,ctx.workspaceId,state,ACTION,true):null;
  const ownerStop=stop?await policy.stopped(db,ctx.workspaceId,state,ACTION,false):null;
  const people=await team(db,ctx.workspaceId),full=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=ANY($2::text[])`,[ctx.workspaceId,rows.map(r=>r.id)])).rows;
  return {window,stop,items:rows.map(r=>{const row=full.find(x=>x.id===r.id);
    return {id:r.id,title:r.title.split('. ')[0],canPass:Boolean(window&&r.due&&stop&&!ownerStop&&chain(row,people)[row.step])};})};
}

const definition={id:JOB,key,label,readPage:review};
module.exports={JOB,ACTION,key,path,label,definition,ready,enabled,windowHours,chain,run,deliver,emailAuthority,phoneAuthority,waiting,answer,answerJob,passNow,inbox,answerable,actions,review};

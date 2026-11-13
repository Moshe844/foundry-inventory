'use strict';

// Job 173: alerts by text message and push, as well as email. Alone on every
// plan.
//
// Each person sets up their own channels on "Your phone and devices":
//  - a mobile number, used only after they type back the code it was sent;
//  - push, turned on in each browser they use.
// The owner then chooses, for each kind of alert (jobs 166 to 172) and for
// approvals waiting for a person (job 175), whether it goes by email, text,
// push, or any of them (agent-alerts.configure). Alerts go to the owner;
// alerts passed on (job 172) and approvals (job 175) go to the person who has
// them.
//
// Sending is work StockChief does on its own: like email, it waits during the
// first 14 days, pause, Watch only, the alert job's own mode, this job's mode
// (Watch only or Ask me first) and an exceeded rule allowance. Every text and
// push is a row in agent_alert_messages, sent by the worker
// (agent.alert-message). Just before it goes out the worker checks again that
// StockChief may send, the owner still wants that channel, the number is still
// confirmed or the device still on, and the alerts are still open (or the
// approval still waiting). A message is sent once: one whose outcome is
// unclear is never sent again. Texts are capped at 30 a person a day.

const crypto=require('node:crypto');
const config=require('../config');
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const installed=require('../db/schema-installed');
const providers=require('../notifications/alert-providers');
const jobs=require('../operations/postgres-job-queue');
const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const {newId}=require('../lib/util');

const JOB=173,ACTION='alert.send',path='/autopilot/alert-devices';
const phones='stockchief_runtime.agent_alert_phones',devices='stockchief_runtime.agent_push_devices',messages='stockchief_runtime.agent_alert_messages';
const channels='stockchief_runtime.agent_alert_channels';
const DAILY_TEXTS=30,DAILY_CODES=5,CODE_TRIES=5,MAX_DEVICES=10;
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const scoped=c=>({query:(sql,values=[])=>c.query(sql,values),transaction:fn=>fn(c)});
const codeHash=(row,code)=>crypto.createHash('sha256').update([row.workspace_id,row.user_id,row.phone,code].join('|')).digest('hex');
const ending=phone=>phone?String(phone).slice(-4):null;

async function ready(db){return installed.has(db,messages);}
function link(target){
  const origin=config.connections.publicOrigin;
  if(!origin||!target)return null;
  try{return new URL(target,origin).href;}catch{return null;}
}

// Paused, Watch only, the first 14 days, the alert job's own mode, this job's
// mode or too many saved rules: the reason sending waits, or null.
async function held(db,workspaceId,account,action,manual=false){
  return await policy.stopped(db,workspaceId,account,action,!manual)||await policy.stopped(db,workspaceId,account,ACTION,!manual);
}

async function member(db,ctx){
  const user=(await db.query(`SELECT u.id,u.name,u.role,w.owner_account_id=u.account_id AND u.role='owner' AS is_owner FROM users u
    JOIN workspaces w ON w.id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.account_id IS NOT NULL`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!user)throw new AuthorizationError('You are not on this team.');
  return user;
}
// Setting up channels is this job's own page; its plan check, for every person.
async function allowed(db,ctx){
  if(!await ready(db))throw new ValidationError('Text and push alerts are being upgraded. Try again shortly.');
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  return member(db,ctx);
}

// A person's confirmed number and their devices with push on.
async function contact(db,workspaceId,userId){
  if(!userId||!await ready(db))return {phone:null,verified:false,devices:[]};
  const [phone,list]=await Promise.all([
    db.query(`SELECT phone,verified_at,code_expires_at>clock_timestamp() AS code_live,code_message_id FROM ${phones} WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,userId]),
    db.query(`SELECT id,label,created_at,last_sent_at FROM ${devices} WHERE workspace_id=$1 AND user_id=$2 AND disabled_at IS NULL ORDER BY created_at,id`,[workspaceId,userId])]);
  const row=phone.rows[0];
  return {phone:row?.phone||null,ending:ending(row?.phone),verified:Boolean(row?.verified_at),pending:Boolean(row&&!row.verified_at),
    codeLive:Boolean(row?.code_live),devices:list.rows};
}

async function enqueue(c,workspaceId,id){
  await jobs.enqueue(scoped(c),{workspaceId,kind:'agent.alert-message',idempotencyKey:'alert-message:'+id,payload:{messageId:id},priority:30,maxAttempts:6});
}
async function insert(c,workspaceId,m){
  const id=newId('alert-msg');
  await c.query(`INSERT INTO ${messages}(workspace_id,id,user_id,channel,purpose,job_id,batch,manual,phone,device_id,title,body,url)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[workspaceId,id,m.userId,m.channel,m.purpose,m.job??null,m.batch||null,Boolean(m.manual),
    m.phone||null,m.deviceId||null,String(m.title).replace(/[\r\n]+/g,' ').slice(0,200),String(m.body).slice(0,1000),m.url||null]);
  await enqueue(c,workspaceId,id);
  return id;
}

// Queues a text and/or a push for one person, as the alert or approval
// module asks. Returns how many were queued and, when a channel could not be
// used, why.
async function queue(c,workspaceId,{purpose,job,batch,userId,sms=false,push=false,title,body,url=null,manual=false}){
  const out={sms:0,push:0,problems:[]};
  if(!sms&&!push)return out;
  if(!await ready(c)){out.problems.push('Text and push alerts are being upgraded.');return out;}
  const available=providers.available(),person=await contact(c,workspaceId,userId);
  if(sms){
    const sent=Number((await c.query(`SELECT count(*) AS n FROM ${messages} WHERE workspace_id=$1 AND user_id=$2 AND channel='SMS' AND purpose<>'CODE'
      AND status IN ('QUEUED','SENDING','SENT','UNCERTAIN') AND created_at>clock_timestamp()-interval '24 hours'`,[workspaceId,userId])).rows[0].n);
    if(!available.sms)out.problems.push('Text messages are not set up on this StockChief server, so no text was sent.');
    else if(!person.verified)out.problems.push('There is no confirmed mobile number, so no text was sent.');
    else if(sent>=DAILY_TEXTS)out.problems.push('The daily limit of '+DAILY_TEXTS+' texts was reached, so no text was sent. They will show in the app.');
    else{
      const text=('StockChief: '+body+(url?' '+url:'')).slice(0,640);
      await insert(c,workspaceId,{userId,channel:'SMS',purpose,job,batch,manual,phone:person.phone,title,body:text,url});out.sms=1;
    }
  }
  if(push){
    if(!available.push)out.problems.push('Push is not set up on this StockChief server, so no push was sent.');
    else if(!person.devices.length)out.problems.push('Push is not on for any device, so no push was sent.');
    else for(const device of person.devices){
      await insert(c,workspaceId,{userId,channel:'PUSH',purpose,job,batch,manual,deviceId:device.id,title,body,url});out.push++;
    }
  }
  return out;
}

// Checked again just before a text or push goes out.
async function authority(db,workspaceId,m){
  if(m.purpose==='CODE'){
    const row=(await db.query(`SELECT 1 FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 AND phone=$3 AND code_message_id=$4 AND verified_at IS NULL`,
      [workspaceId,m.user_id,m.phone,m.id])).rowCount;
    if(!row)throw new ValidationError('This code is no longer needed, so it was not sent.');
    return;
  }
  const alerts=require('./agent-alerts'),id=Number(m.job_id),spec=alerts.JOBS[id];
  if(!spec)throw new ValidationError('This alert is not recognised, so it was not sent.');
  const account=await policy.accountState(db,workspaceId),plan=policy.usesAgentTerms(account)?account.plan:null;
  policy.requireJob(plan,id,'automatic');policy.requireJob(plan,JOB,'automatic');
  const stop=await held(db,workspaceId,account,spec.action,m.manual===true);
  if(stop)throw new ValidationError(stop+' The message is held.');
  const setting=(await db.query(`SELECT sms,push FROM ${channels} WHERE workspace_id=$1 AND job_id=$2`,[workspaceId,id])).rows[0];
  if(!setting||!(m.channel==='SMS'?setting.sms:setting.push))throw new ValidationError('The alert settings changed, so this message was not sent.');
  if(m.channel==='SMS'){
    const ok=(await db.query(`SELECT 1 FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 AND phone=$3 AND verified_at IS NOT NULL`,[workspaceId,m.user_id,m.phone])).rowCount;
    if(!ok)throw new ValidationError('That mobile number was changed or removed, so the text was not sent.');
  }else{
    const ok=(await db.query(`SELECT 1 FROM ${devices} WHERE workspace_id=$1 AND user_id=$2 AND id=$3 AND disabled_at IS NULL`,[workspaceId,m.user_id,m.device_id])).rowCount;
    if(!ok)throw new ValidationError('Push was turned off on that device, so it was not sent.');
  }
  if(spec.own)return require(spec.module).phoneAuthority(db,workspaceId,m);
  const column=m.channel==='SMS'?'sms_batch':'push_batch';
  const open=(await db.query(`SELECT 1 FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=$2 AND ${column}=$3 LIMIT 1`,
    [workspaceId,id,String(m.batch||'')])).rowCount;
  if(!open)throw new ValidationError('These alerts cleared before the message was sent, so it was not sent.');
}

// The worker: send one text or push, once.
async function process(database,job,senders={}){
  const workspaceId=job.workspaceId,id=String(job.payload?.messageId||'');
  if(!await ready(database))return {skipped:'upgrade'};
  const claim=await tx(database,async c=>{
    const m=(await c.query(`SELECT * FROM ${messages} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,id])).rows[0];
    if(!m)return {skipped:'missing'};
    if(m.status==='SENDING'){
      await c.query(`UPDATE ${messages} SET status='UNCERTAIN',error='The worker stopped before the provider answered. StockChief did not send it again.',updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2`,[workspaceId,id]);
      return {skipped:'uncertain'};
    }
    if(m.status!=='QUEUED')return {replayed:true,status:m.status};
    try{await authority(c,workspaceId,m);}
    catch(error){
      if(!(error instanceof DomainError))throw error;
      await c.query(`UPDATE ${messages} SET status='HELD',error=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,error.message.slice(0,500)]);
      return {held:error.message};
    }
    let target=m.phone,body=m.body;
    if(m.channel==='PUSH')target=(await c.query(`SELECT * FROM ${devices} WHERE workspace_id=$1 AND id=$2`,[workspaceId,m.device_id])).rows[0];
    if(m.purpose==='CODE'){
      const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
      const row=(await c.query(`SELECT * FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`,[workspaceId,m.user_id])).rows[0];
      await c.query(`UPDATE ${phones} SET code_hash=$3,code_expires_at=clock_timestamp()+interval '15 minutes',code_attempts=0,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,m.user_id,codeHash(row,code)]);
      body='StockChief code: '+code+'. It works for 15 minutes. Reply STOP to stop texts.';
    }
    const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(c,workspaceId);
    await require('../commercial/control-service').recordCost(c,scope,{
      provider:m.channel==='SMS'?'twilio':'web_push',operation:'alert_delivery',unit:'submission',quantity:1,
      idempotencyKey:`alert-delivery:${id}:attempt:${job.attemptCount||1}`,detail:{channel:m.channel,purpose:m.purpose}
    });
    await c.query(`UPDATE ${messages} SET status='SENDING',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,id]);
    return {m,target,body};
  });
  if(!claim.m)return claim;
  const {m,target,body}=claim;
  try{
    const result=m.channel==='SMS'?await (senders.sms||providers.sendSms)({to:target,body})
      :await (senders.push||providers.sendPush)({device:target,message:{title:m.title,body:m.body,url:m.url,tag:m.batch||m.id}});
    await tx(database,async c=>{
      await c.query(`UPDATE ${messages} SET status='SENT',provider_reference=$3,sent_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 AND status='SENDING'`,[workspaceId,id,String(result?.reference||'').slice(0,300)||null]);
      if(m.channel==='PUSH')await c.query(`UPDATE ${devices} SET last_sent_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,m.device_id]);
    });
    return {sent:m.channel};
  }catch(error){
    const status=Number(error?.status)||0,uncertain=Boolean(error?.providerOutcomeUncertain)||!status;
    const retry=!uncertain&&(status>=500||[408,429].includes(status));
    await tx(database,async c=>{
      await c.query(`UPDATE ${messages} SET status=$3,error=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status='SENDING'`,
        [workspaceId,id,retry?'QUEUED':uncertain?'UNCERTAIN':'FAILED',String(error?.message||'The provider refused the message.').slice(0,500)]);
      if(error?.gone&&m.channel==='PUSH')await c.query(`UPDATE ${devices} SET disabled_at=clock_timestamp(),disabled_reason=$3 WHERE workspace_id=$1 AND id=$2 AND disabled_at IS NULL`,
        [workspaceId,m.device_id,'The browser turned push off.']);
    });
    if(retry)throw Object.assign(error,{retryable:true});
    return {failed:uncertain?'uncertain':'refused',reason:String(error?.message||'')};
  }
}

// --- Your phone and devices -------------------------------------------------

async function codeLimit(c,workspaceId,userId){
  const recent=(await c.query(`SELECT count(*) AS n,max(created_at)>clock_timestamp()-interval '60 seconds' AS soon FROM ${messages}
    WHERE workspace_id=$1 AND user_id=$2 AND purpose='CODE' AND created_at>clock_timestamp()-interval '24 hours'`,[workspaceId,userId])).rows[0];
  if(recent.soon)throw new ValidationError('A code was just sent. Wait a minute before asking for another.');
  if(Number(recent.n)>=DAILY_CODES)throw new ValidationError('Too many codes were sent today. Try again tomorrow.');
}
async function sendCode(c,ctx,row){
  if(!providers.available().sms)throw new ValidationError('Text messages are not set up on this StockChief server yet.');
  await codeLimit(c,ctx.workspaceId,ctx.actorId);
  const id=await insert(c,ctx.workspaceId,{userId:ctx.actorId,channel:'SMS',purpose:'CODE',phone:row.phone,title:'Your StockChief code',body:'A code to confirm this number.'});
  await c.query(`UPDATE ${phones} SET code_message_id=$3,code_hash=NULL,code_expires_at=NULL,code_attempts=0,codes_sent=codes_sent+1,updated_at=clock_timestamp()
    WHERE workspace_id=$1 AND user_id=$2`,[ctx.workspaceId,ctx.actorId,id]);
  return id;
}
// A person adds or changes their number. It is texted a code to confirm it.
async function setPhone(database,ctx,raw){
  const typed=String(raw||'').replace(/[\s().-]/g,'');
  if(!typed.startsWith('+')||!providers.PHONE.test(typed))throw new ValidationError('Enter your mobile number with its country code, like +1 555 555 0123.');
  return tx(database,async c=>{
    await allowed(c,ctx);
    const prior=(await c.query(`SELECT * FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(prior?.phone===typed&&prior.verified_at)return {unchanged:true};
    await c.query(`INSERT INTO ${phones}(workspace_id,user_id,phone) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE
      SET phone=excluded.phone,verified_at=NULL,code_hash=NULL,code_expires_at=NULL,code_attempts=0,code_message_id=NULL,updated_at=clock_timestamp()`,[ctx.workspaceId,ctx.actorId,typed]);
    await sendCode(c,ctx,{phone:typed});
    await audit.record(c,ctx,{action:'Alert phone added',before:prior?{ending:ending(prior.phone),confirmed:Boolean(prior.verified_at)}:{},after:{ending:ending(typed),confirmed:false}});
    return {sent:true,ending:ending(typed)};
  });
}
async function resendCode(database,ctx){
  return tx(database,async c=>{
    await allowed(c,ctx);
    const row=(await c.query(`SELECT * FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!row||row.verified_at)throw new ValidationError('There is no number waiting for a code.');
    await sendCode(c,ctx,row);
    return {sent:true,ending:ending(row.phone)};
  });
}
// The person types back the code they were texted.
async function confirmPhone(database,ctx,raw){
  const code=String(raw||'').replace(/\s/g,'');
  return tx(database,async c=>{
    await allowed(c,ctx);
    const row=(await c.query(`SELECT *,code_expires_at>clock_timestamp() AS live FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!row)throw new ValidationError('Add your mobile number first.');
    if(row.verified_at)return {replayed:true};
    if(!row.code_hash||!row.live)return {wrong:'This code expired or was not sent yet. Send a new code.'};
    if(row.code_attempts>=CODE_TRIES)return {wrong:'Too many tries. Send a new code.'};
    const ok=/^\d{6}$/.test(code)&&crypto.timingSafeEqual(Buffer.from(codeHash(row,code)),Buffer.from(row.code_hash));
    if(!ok){
      await c.query(`UPDATE ${phones} SET code_attempts=code_attempts+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2`,[ctx.workspaceId,ctx.actorId]);
      return {wrong:'That code is not right. Check the latest text and try again.'};
    }
    await c.query(`UPDATE ${phones} SET verified_at=clock_timestamp(),code_hash=NULL,code_expires_at=NULL,code_attempts=0,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND user_id=$2`,[ctx.workspaceId,ctx.actorId]);
    await audit.record(c,ctx,{action:'Alert phone confirmed',after:{ending:ending(row.phone)}});
    return {confirmed:true,ending:ending(row.phone)};
  });
}
async function removePhone(database,ctx){
  return tx(database,async c=>{
    await member(c,ctx);
    if(!await ready(c))return {unchanged:true};
    const row=(await c.query(`DELETE FROM ${phones} WHERE workspace_id=$1 AND user_id=$2 RETURNING phone,verified_at`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!row)return {unchanged:true};
    await audit.record(c,ctx,{action:'Alert phone removed',before:{ending:ending(row.phone),confirmed:Boolean(row.verified_at)}});
    return {removed:true};
  });
}
function deviceLabel(agent){
  const ua=String(agent||'');
  const browser=/Edg\//.test(ua)?'Edge':/Firefox\//.test(ua)?'Firefox':/Chrome\//.test(ua)?'Chrome':/Safari\//.test(ua)?'Safari':'Browser';
  const system=/iPhone|iPad/.test(ua)?'iPhone':/Android/.test(ua)?'Android':/Windows/.test(ua)?'Windows':/Mac OS X/.test(ua)?'Mac':/Linux/.test(ua)?'Linux':null;
  return system?browser+' on '+system:browser;
}
// The browser's push subscription, from the "Turn on push" button.
async function addDevice(database,ctx,input={},agent=''){
  const endpoint=String(input.endpoint||''),p256dh=String(input.p256dh||''),auth=String(input.auth||'');
  if(!providers.available().push)throw new ValidationError('Push is not set up on this StockChief server yet.');
  if(!providers.validEndpoint(endpoint))throw new ValidationError('This browser’s push service is not one StockChief can send to.');
  if(Buffer.from(p256dh,'base64url').length!==65||Buffer.from(auth,'base64url').length!==16||!/^[A-Za-z0-9_-]+$/.test(p256dh+auth))
    throw new ValidationError('This browser did not give valid push keys. Try again.');
  return tx(database,async c=>{
    await allowed(c,ctx);
    const count=Number((await c.query(`SELECT count(*) AS n FROM ${devices} WHERE workspace_id=$1 AND user_id=$2 AND disabled_at IS NULL AND endpoint<>$3`,
      [ctx.workspaceId,ctx.actorId,endpoint])).rows[0].n);
    if(count>=MAX_DEVICES)throw new ValidationError('Push is on for '+MAX_DEVICES+' devices already. Turn it off on one first.');
    const label=deviceLabel(agent);
    const row=(await c.query(`INSERT INTO ${devices}(workspace_id,id,user_id,endpoint,p256dh,auth,label) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(workspace_id,user_id,endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,label=excluded.label,disabled_at=NULL,disabled_reason=NULL
      RETURNING id,(xmax=0) AS created`,[ctx.workspaceId,newId('push-device'),ctx.actorId,endpoint,p256dh,auth,label])).rows[0];
    await audit.record(c,ctx,{action:'Push turned on for a device',reference:row.id,after:{device:label}});
    return {id:row.id,label};
  });
}
async function removeDevice(database,ctx,id){
  return tx(database,async c=>{
    await member(c,ctx);
    const row=(await c.query(`DELETE FROM ${devices} WHERE workspace_id=$1 AND user_id=$2 AND id=$3 RETURNING label`,[ctx.workspaceId,ctx.actorId,String(id||'')])).rows[0];
    if(!row)throw new NotFoundError('That device is not one of yours.');
    await audit.record(c,ctx,{action:'Push turned off for a device',reference:String(id),before:{device:row.label}});
    return {removed:true};
  });
}

// "Your phone and devices": the person's own channels and, for the owner,
// what each kind of alert uses.
async function page(db,ctx){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,'suggest');
  const user=await member(db,ctx);
  if(!await ready(db))return {upgrading:true,available:{sms:false,push:false},phone:{},devices:[],isOwner:user.is_owner,kinds:[]};
  const available=providers.available(),mine=await contact(db,ctx.workspaceId,ctx.actorId);
  let kinds=[];
  if(user.is_owner){
    const alerts=require('./agent-alerts'),account=await policy.accountState(db,ctx.workspaceId),list=await alerts.kinds(db,ctx.workspaceId,account);
    kinds=list.map(k=>({...k,href:alerts.pathFor(k.job)}));
  }
  return {available,publicKey:providers.publicKey(),phone:mine,devices:mine.devices,isOwner:user.is_owner,kinds};
}

module.exports={JOB,ACTION,path,ready,held,link,contact,queue,authority,process,setPhone,resendCode,confirmPhone,removePhone,addDevice,removeDevice,page,deviceLabel};

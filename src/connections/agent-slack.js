'use strict';

const {createHash,randomBytes}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError,RateLimitError}=require('../domain/errors');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const credentials=require('./credentials');
const slack=require('./slack-agent-command');
const jobs=require('../operations/postgres-job-queue');
const chat=require('./chat-providers');
const answers=require('./chat-answers');

const path='/autopilot/slack',publicPath='/integrations/stockchief/slack/command',kind='agent.slack.answer.v1';
const apps='stockchief_runtime.agent_slack_apps',members='stockchief_runtime.agent_slack_members',questions='stockchief_runtime.agent_slack_questions';
const action='agent.answer_slack',operation='slack_command_reply',providerName='StockChief Slack';
const digest=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(24).toString('base64url');
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const tokenPattern=/^[A-Za-z0-9_-]{32}$/;
const seal=value=>{
  const {ciphertext,iv,authTag}=credentials.encrypt(value);
  return JSON.stringify({ciphertext,iv,auth_tag:authTag});
};
const audit=(db,ctx,action)=>require('../operations/postgres-security-audit').record(db,ctx,{action,reference:ctx.workspaceId});

async function member(db,ctx,owner=false){
  const actor=(await db.query(`SELECT u.id,u.role,u.permissions,u.warehouse_location_ids FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access p WHERE p.account_id=u.account_id AND p.disabled_at IS NOT NULL)
    AND ($3=false OR u.role='owner' AND u.account_id=w.owner_account_id)`,[ctx.workspaceId,ctx.actorId,owner])).rows[0];
  if(!actor||actor.warehouse_location_ids!==null)throw new AuthorizationError('Slack questions require an active inventory-wide StockChief membership.');
  return actor;
}

async function authorize(db,ctx,{owner=false,routine=false}={}){
  const actor=await member(db,ctx,owner);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,188,routine?'automatic':'draft');
  if(routine){
    const reason=await policy.stopped(db,ctx.workspaceId,state,action,true);
    if(reason)throw new ValidationError(reason);
  }
  return actor;
}

async function configuration(db,workspaceId){
  return (await db.query(`SELECT endpoint_id,slack_team,slack_app,enabled,revision FROM ${apps} WHERE workspace_id=$1`,[workspaceId])).rows[0];
}

async function configure(db,ctx,input){
  return db.transaction(async c=>{
    await member(c,ctx,true);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-slack:'+ctx.workspaceId]);
    const prior=await configuration(c,ctx.workspaceId);
    if(input.confirmed!=='yes'||Number(input.revision)!==(prior?.revision||0))
      throw new ValidationError('Review the current Slack connection before saving.');
    if(input.stop==='yes'){
      await c.query(`UPDATE ${apps} SET enabled=false,revision=revision+1 WHERE workspace_id=$1`,[ctx.workspaceId]);
      await c.query(`DELETE FROM ${members} WHERE workspace_id=$1`,[ctx.workspaceId]);
      await c.query(`UPDATE ${questions} SET sealed_question=NULL,status='HELD' WHERE workspace_id=$1 AND status IN ('PENDING','CLAIMED')`,[ctx.workspaceId]);
      await audit(c,ctx,'Slack questions disconnected');
      return;
    }
    await authorize(c,ctx,{owner:true});
    const team=String(input.team||'').trim(),app=String(input.app||'').trim(),secret=String(input.secret||'').trim();
    if(!slack.teamFormat.test(team)||!slack.appFormat.test(app)||!/^[a-f0-9]{32,128}$/i.test(secret))
      throw new ValidationError('Enter the Slack team ID, app ID and signing secret from the same Slack app.');
    const endpoint=prior?.endpoint_id||random();
    await c.query(`INSERT INTO ${apps} AS old(workspace_id,endpoint_id,slack_team,slack_app,sealed_secret,enabled)
      VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(workspace_id) DO UPDATE SET slack_team=EXCLUDED.slack_team,
      slack_app=EXCLUDED.slack_app,sealed_secret=EXCLUDED.sealed_secret,enabled=true,revision=old.revision+1`,
    [ctx.workspaceId,endpoint,team,app,seal({secret})]);
    await c.query(`DELETE FROM ${members} WHERE workspace_id=$1`,[ctx.workspaceId]);
    await c.query(`UPDATE ${questions} SET sealed_question=NULL,status='HELD' WHERE workspace_id=$1 AND status IN ('PENDING','CLAIMED')`,[ctx.workspaceId]);
    await audit(c,ctx,'Slack question connection saved');
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function code(db,ctx){
  return db.transaction(async c=>{
    await authorize(c,ctx);
    const configured=(await c.query(`SELECT 1 FROM ${apps} WHERE workspace_id=$1 AND enabled FOR SHARE`,[ctx.workspaceId])).rowCount;
    if(!configured)throw new ValidationError('Connect the Slack app before linking your user.');
    const token=random();
    await c.query(`INSERT INTO ${members}(workspace_id,actor_id,code_hash,code_expires_at)
      VALUES($1,$2,$3,clock_timestamp()+interval '10 minutes') ON CONFLICT(workspace_id,actor_id) DO UPDATE
      SET code_hash=EXCLUDED.code_hash,code_expires_at=EXCLUDED.code_expires_at`,[ctx.workspaceId,ctx.actorId,digest(token)]);
    return token;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function unlink(db,ctx){
  await member(db,ctx);
  await db.query(`DELETE FROM ${members} WHERE workspace_id=$1 AND actor_id=$2`,[ctx.workspaceId,ctx.actorId]);
}

async function page(db,ctx){
  const actor=await member(db,ctx),state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,188,'draft');
  const connection=await configuration(db,ctx.workspaceId);
  const linked=allowed?(await db.query(`SELECT slack_user FROM ${members} WHERE workspace_id=$1 AND actor_id=$2`,
    [ctx.workspaceId,ctx.actorId])).rows[0]?.slack_user:null;
  const recent=allowed?(await db.query(`SELECT id,status,problem_code,created_at::text FROM ${questions}
    WHERE workspace_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 30`,[ctx.workspaceId,ctx.actorId])).rows:[];
  return {allowed,owner:actor.role==='owner',connection,linked,recent};
}

async function resolve(db,endpoint){
  if(!tokenPattern.test(endpoint))throw new NotFoundError();
  const row=(await db.query(`SELECT * FROM ${apps} WHERE endpoint_id=$1 AND enabled`,[endpoint])).rows[0];
  if(!row)throw new NotFoundError();
  return row;
}

async function linkWithin(db,app,input,token){
  if(!tokenPattern.test(token))throw new ValidationError('Use a fresh link code from your signed-in StockChief settings.');
  const row=(await db.query(`SELECT actor_id FROM ${members} WHERE workspace_id=$1 AND code_hash=$2 AND code_expires_at>clock_timestamp() FOR UPDATE`,
    [app.workspace_id,digest(token)])).rows[0];
  if(!row)throw new ValidationError('This link code expired or was already used. Generate a new code in StockChief.');
  const ctx={workspaceId:app.workspace_id,actorId:row.actor_id};
  await authorize(db,ctx);
  const previous=(await db.query(`SELECT actor_id FROM ${members} WHERE workspace_id=$1 AND slack_user=$2`,[app.workspace_id,input.user])).rows[0];
  if(previous&&previous.actor_id!==ctx.actorId)throw new AuthorizationError('This Slack user is already connected to a different membership.');
  await db.query(`UPDATE ${members} SET slack_user=$3,code_hash=NULL,code_expires_at=NULL WHERE workspace_id=$1 AND actor_id=$2`,
    [app.workspace_id,ctx.actorId,input.user]);
  await audit(db,ctx,'Slack user linked');
}

async function receive(db,endpoint,raw,signature){
  const initial=await resolve(db,endpoint),input=chat.get('slack').inbound({raw,connection:{...credentials.decrypt(initial.sealed_secret),
    team:initial.slack_team,app:initial.slack_app},headers:{'x-slack-request-timestamp':signature.timestamp,'x-slack-signature':signature.signature}});
  if(input.sslCheck)return null;
  return db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-slack:'+initial.workspace_id]);
    const app=await resolve(c,endpoint);
    if(initial.revision!==app.revision)throw new AuthorizationError('This Slack connection changed. Retry the command.');
    const linking=/^connect\s+(\S+)$/i.exec(input.text);
    if(linking){
      await linkWithin(c,app,input,linking[1]);
      return 'Your Slack user is linked. Ask a question with /stockchief.';
    }
    const held=(await c.query(`SELECT actor_id FROM ${members} WHERE workspace_id=$1 AND slack_user=$2`,[app.workspace_id,input.user])).rows[0];
    if(!held)throw new AuthorizationError('Link your Slack user from StockChief settings first.');
    const ctx={workspaceId:app.workspace_id,actorId:held.actor_id};
    await authorize(c,ctx,{routine:true});
    await c.query(`UPDATE ${questions} SET sealed_question=NULL,status='HELD'
      WHERE workspace_id=$1 AND id IN(SELECT id FROM ${questions} WHERE workspace_id=$1 AND expires_at<clock_timestamp()
        AND sealed_question IS NOT NULL ORDER BY expires_at LIMIT 100)`,[ctx.workspaceId]);
    const fingerprint=digest(raw),id=newId('slackquestion');
    if((await c.query(`SELECT 1 FROM ${questions} WHERE workspace_id=$1 AND fingerprint=$2`,[ctx.workspaceId,fingerprint])).rowCount)return null;
    const recent=(await c.query(`SELECT count(*)::int AS count FROM (SELECT 1 FROM ${questions}
      WHERE workspace_id=$1 AND actor_id=$2 AND created_at>clock_timestamp()-interval '1 minute' LIMIT 5) q`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(recent.count>=5)throw new RateLimitError('Wait a minute before asking another Slack question.');
    const tx=scoped(c);
    await require('../commercial/storage-capacity').reserve(tx,ctx.workspaceId,'slack-question:'+id,8192,{finished:true});
    await c.query(`INSERT INTO ${questions}(workspace_id,id,actor_id,slack_user,app_revision,fingerprint,sealed_question,status,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',clock_timestamp()+interval '10 minutes')`,
    [ctx.workspaceId,id,ctx.actorId,input.user,app.revision,fingerprint,seal({text:input.text,callback:input.callback})]);
    await jobs.enqueue(tx,{workspaceId:ctx.workspaceId,kind,idempotencyKey:id,payload:{questionId:id},maxAttempts:1});
    return 'Checking StockChief. Your answer will appear privately here.';
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function live(db,workspaceId,id,status){
  return (await db.query(`SELECT q.*,a.slack_team FROM ${questions} q JOIN ${apps} a ON a.workspace_id=q.workspace_id AND a.enabled AND a.revision=q.app_revision
    JOIN ${members} m ON m.workspace_id=q.workspace_id AND m.actor_id=q.actor_id AND m.slack_user=q.slack_user
    WHERE q.workspace_id=$1 AND q.id=$2 AND q.status=$3 AND q.expires_at>clock_timestamp()`,
  [workspaceId,id,status])).rows[0];
}

async function mark(db,workspaceId,id,status,prior){
  return (await db.query(`UPDATE ${questions} SET status=$3,sealed_question=NULL WHERE workspace_id=$1 AND id=$2 AND status=$4`,
    [workspaceId,id,status,prior])).rowCount;
}

async function refund(db,ctx,id){
  const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(db,ctx.workspaceId);
  const key=ctx.workspaceId+':slack:'+id;
  if((await db.query(`SELECT 1 FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits'
    AND idempotency_key=$2 AND status='RESERVED'`,[ctx.workspaceId,key])).rowCount)
    await require('../commercial/entitlements').reverseUsage(db,scope,{meter:'ai_work_credits',idempotencyKey:key,
      reason:'Slack answer could not be delivered under current authority.'});
}

async function process(job,db,options={}){
  const workspaceId=job.workspaceId,id=job.payload.questionId,question=await live(db,workspaceId,id,'PENDING');
  if(!question)return {status:'expired_or_stopped'};
  const ctx={workspaceId,actorId:question.actor_id};
  let actor;
  try{actor=await authorize(db,ctx,{routine:true});}
  catch(error){if(error.status>=400&&error.status<500){await mark(db,workspaceId,id,'HELD','PENDING');return {status:'authority_changed'};}throw error;}
  const {text,callback}=credentials.decrypt(question.sealed_question);
  const destination=slack.destination(callback,question.slack_team);
  let result,problem=null,outcome='failed';
  try{({text:result,outcome}=await answers.answer(db,ctx,actor,text,{provider:options.provider,key:'slack:'+id}));}
  catch(error){
    problem={code:error.code||'answer_failed',message:error.message};
    await db.query(`UPDATE ${questions} SET problem_code=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,problem.code]);
    result='StockChief could not complete that answer. Open StockChief to check the records or try a narrower question.';
  }
  const claimed=await db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-slack:'+workspaceId]);
    if(!await live(c,workspaceId,id,'PENDING'))return false;
    try{
      const current=await authorize(c,ctx,{routine:true});
      if(current.role!==actor.role||JSON.stringify(current.permissions)!==JSON.stringify(actor.permissions))
        throw new AuthorizationError('Your StockChief permissions changed while preparing the answer.');
    }
    catch(error){if(error.status>=400&&error.status<500){await mark(c,workspaceId,id,'HELD','PENDING');return false;}throw error;}
    return mark(c,workspaceId,id,'CLAIMED','PENDING');
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(!claimed){await refund(db,ctx,id);return {status:'authority_changed'};}
  try{
    await require('../commercial/operations').run(db,workspaceId,{operation,provider:'slack',key:id,capability:'ask.lookup'},async()=>{
      await db.transaction(async client=>{
        const tx=scoped(client);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-slack:'+workspaceId]);
        await client.query('SELECT id FROM users WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,ctx.actorId]);
        await client.query(`SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id
          WHERE w.id=$1 FOR SHARE OF s`,[workspaceId]);
        if(!await live(client,workspaceId,id,'CLAIMED'))throw new AuthorizationError('This Slack connection was stopped before delivery.');
        const current=await authorize(tx,ctx,{routine:true});
        if(current.role!==actor.role||JSON.stringify(current.permissions)!==JSON.stringify(actor.permissions))
          throw new AuthorizationError('Your StockChief permissions changed before delivery.');
        await chat.get('slack').deliver({connection:{team:question.slack_team},target:{callback:destination},text:result});
      },{isolation:'READ COMMITTED'});
    });
  }catch(error){await mark(db,workspaceId,id,'HELD','CLAIMED');await refund(db,ctx,id);throw error;}
  await db.transaction(async client=>{
    const tx=scoped(client),key=workspaceId+':slack:'+id;
    const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(tx,workspaceId);
    if((await client.query(`SELECT 1 FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits'
      AND idempotency_key=$2 AND status='RESERVED'`,[workspaceId,key])).rowCount)
      await require('../commercial/entitlements').commitUsage(tx,scope,{meter:'ai_work_credits',idempotencyKey:key});
    if(await mark(client,workspaceId,id,'REPLIED','CLAIMED'))await answers.audited(client,ctx,{channel:'slack',question:id,outcome});
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return {status:'replied',answerProblem:problem};
}

async function recover(db,job){
  const row=(await db.query(`SELECT actor_id,status FROM ${questions} WHERE workspace_id=$1 AND id=$2`,
    [job.workspaceId,job.payload.questionId])).rows[0];
  if(!row||row.status==='REPLIED')return;
  const tx=typeof db.transaction==='function'?db:scoped(db);
  await mark(db,job.workspaceId,job.payload.questionId,'HELD',row.status);
  await refund(tx,{workspaceId:job.workspaceId,actorId:row.actor_id},job.payload.questionId);
}

async function review(db,ctx){
  const data=await page(db,ctx),chats=await require('./agent-chat').page(db,ctx),names={slack:'Slack',teams:'Teams',whatsapp:'WhatsApp'};
  const rows=data.recent.map(row=>({...row,channel:'slack'})).concat(chats.recent).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))).slice(0,30);
  return {rows:rows.map(row=>({Received:row.created_at,Channel:names[row.channel],Status:row.problem_code?'Needs review':
    ({PENDING:'Waiting',CLAIMED:'Sending',REPLIED:'Replied',HELD:'Held for review'})[row.status],link:'/autopilot/chat'})),
    action:{label:'Open chat answers',href:'/autopilot/chat'},
    summary:'Ask StockChief in Slack, Microsoft Teams or WhatsApp. Each linked person receives private answers using their current inventory permissions, and nothing is changed from a chat.'};
}

module.exports={path,publicPath,kind,configure,code,unlink,page,receive,process,recover,providerName,
  definition:{id:188,key:'slack-answers',label:'Ask StockChief in Slack, Teams or WhatsApp',readPage:review}};

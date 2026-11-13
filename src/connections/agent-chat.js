'use strict';
// Job 188: answers in Microsoft Teams and WhatsApp, the same way as Slack
// (agent-slack.js). The person asking is matched to their own StockChief
// membership: a Teams user linked with a one-use code, or the mobile number
// they confirmed for alerts (job 173). Each answer is read with that person's
// current permissions, plan and job mode, delivered privately, and audited.
// Nothing is changed from a chat; a request to change something links back to
// the app. The worker prepares answers, so a slow model never holds a webhook.
const {createHash,randomBytes}=require('node:crypto');
const {AuthorizationError,NotFoundError,ValidationError,RateLimitError}=require('../domain/errors');
const {newId}=require('../lib/util');
const policy=require('../commercial/agent-plan');
const credentials=require('./credentials');
const chat=require('./chat-providers');
const answers=require('./chat-answers');
const jobs=require('../operations/postgres-job-queue');

const path='/autopilot/chat',kind='agent.chat.answer.v1',action='agent.answer_slack';
const publicPaths={teams:'/integrations/stockchief/teams',whatsapp:'/integrations/stockchief/whatsapp'};
const connections='stockchief_runtime.agent_chat_connections',members='stockchief_runtime.agent_chat_members',questions='stockchief_runtime.agent_chat_questions';
const CHANNELS={teams:{label:'Microsoft Teams',operation:'teams_reply',provider:'microsoft_teams'},whatsapp:{label:'WhatsApp',operation:'whatsapp_reply',provider:'twilio_whatsapp'}};
const digest=value=>createHash('sha256').update(value).digest('hex');
const random=()=>randomBytes(24).toString('base64url');
const tokenPattern=/^[A-Za-z0-9_-]{32}$/;
const scoped=c=>typeof c.transaction==='function'?c:{query:(...args)=>c.query(...args),transaction:fn=>fn(c)};
const seal=value=>{const {ciphertext,iv,authTag}=credentials.encrypt(value);return JSON.stringify({ciphertext,iv,auth_tag:authTag});};
const audit=(db,ctx,action,after={})=>require('../operations/postgres-security-audit').record(db,ctx,{action,reference:ctx.workspaceId,after});
const known=channel=>{if(!Object.hasOwn(CHANNELS,channel))throw new NotFoundError();return CHANNELS[channel];};

async function member(db,ctx,owner=false){
  const actor=(await db.query(`SELECT u.id,u.role,u.permissions,u.warehouse_location_ids FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access p WHERE p.account_id=u.account_id AND p.disabled_at IS NOT NULL)
    AND ($3=false OR u.role='owner' AND u.account_id=w.owner_account_id)`,[ctx.workspaceId,ctx.actorId,owner])).rows[0];
  if(!actor||actor.warehouse_location_ids!==null)throw new AuthorizationError('Chat questions require an active inventory-wide StockChief membership.');
  return actor;
}
// Pro and Custom; answering on its own also respects the watch period, Watch
// only, pause, "Ask me first" and the rule allowance.
async function authorize(db,ctx,{owner=false,routine=false}={}){
  const actor=await member(db,ctx,owner);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,188,routine?'automatic':'draft');
  if(routine){const reason=await policy.stopped(db,ctx.workspaceId,state,action,true);if(reason)throw new ValidationError(reason);}
  return actor;
}
async function configuration(db,workspaceId,channel){
  return (await db.query(`SELECT workspace_id,channel,endpoint_id,tenant,app,sealed_secret,enabled,revision FROM ${connections} WHERE workspace_id=$1 AND channel=$2`,[workspaceId,channel])).rows[0];
}
const secretOf=row=>row?.sealed_secret?credentials.decrypt(row.sealed_secret).secret:null;
async function phoneOf(db,ctx){
  return (await db.query(`SELECT phone FROM stockchief_runtime.agent_alert_phones WHERE workspace_id=$1 AND user_id=$2 AND verified_at IS NOT NULL`,[ctx.workspaceId,ctx.actorId])).rows[0]?.phone||null;
}
async function hold(c,workspaceId,channel){
  await c.query(`DELETE FROM ${members} WHERE workspace_id=$1 AND channel=$2`,[workspaceId,channel]);
  await c.query(`UPDATE ${questions} SET sealed_question=NULL,status='HELD' WHERE workspace_id=$1 AND channel=$2 AND status IN ('PENDING','CLAIMED')`,[workspaceId,channel]);
}

async function configure(db,ctx,channel,input={}){
  const about=known(channel);
  return db.transaction(async c=>{
    await member(c,ctx,true);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-chat:'+ctx.workspaceId+':'+channel]);
    const prior=await configuration(c,ctx.workspaceId,channel);
    if(input.confirmed!=='yes'||Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Review the current '+about.label+' connection before saving.');
    if(input.stop==='yes'){
      if(!prior)return;
      await c.query(`UPDATE ${connections} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND channel=$2`,[ctx.workspaceId,channel]);
      await hold(c,ctx.workspaceId,channel);
      await audit(c,ctx,'Chat questions disconnected',{channel});
      return;
    }
    await authorize(c,ctx,{owner:true});
    let tenant=null,app=null,secret=null;
    if(channel==='teams'){
      tenant=String(input.tenant||'').trim().toLowerCase();app=String(input.app||'').trim().toLowerCase();secret=String(input.secret||'').trim();
      if(!chat.GUID.test(tenant)||!chat.GUID.test(app)||!secret||secret.length>200||/[\u0000-\u001f\u007f]/.test(secret))
        throw new ValidationError('Enter the Microsoft tenant ID, the bot’s app ID and its client secret from the same Azure bot.');
    }else if(!chat.get('whatsapp').configured())throw new ValidationError('WhatsApp is not set up on this server yet.');
    const endpoint=prior?.endpoint_id||random();
    await c.query(`INSERT INTO ${connections} AS old(workspace_id,channel,endpoint_id,tenant,app,sealed_secret,enabled) VALUES($1,$2,$3,$4,$5,$6,true)
      ON CONFLICT(workspace_id,channel) DO UPDATE SET tenant=EXCLUDED.tenant,app=EXCLUDED.app,sealed_secret=EXCLUDED.sealed_secret,enabled=true,revision=old.revision+1`,
    [ctx.workspaceId,channel,endpoint,tenant,app,secret?seal({secret}):null]);
    await hold(c,ctx.workspaceId,channel);
    await audit(c,ctx,'Chat question connection saved',{channel});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Teams: a one-use code the person sends to the bot as "connect CODE".
async function code(db,ctx){
  return db.transaction(async c=>{
    await authorize(c,ctx);
    if(!(await c.query(`SELECT 1 FROM ${connections} WHERE workspace_id=$1 AND channel='teams' AND enabled FOR SHARE`,[ctx.workspaceId])).rowCount)
      throw new ValidationError('Connect the Teams bot before linking your user.');
    const token=random();
    await c.query(`INSERT INTO ${members}(workspace_id,channel,actor_id,code_hash,code_expires_at) VALUES($1,'teams',$2,$3,clock_timestamp()+interval '10 minutes')
      ON CONFLICT(workspace_id,channel,actor_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,code_expires_at=EXCLUDED.code_expires_at`,[ctx.workspaceId,ctx.actorId,digest(token)]);
    return token;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
// WhatsApp: the mobile number the person confirmed with a texted code (job 173).
async function linkPhone(db,ctx){
  return db.transaction(async c=>{
    await authorize(c,ctx);
    if(!(await c.query(`SELECT 1 FROM ${connections} WHERE workspace_id=$1 AND channel='whatsapp' AND enabled FOR SHARE`,[ctx.workspaceId])).rowCount)
      throw new ValidationError('The owner has not turned on WhatsApp questions for this inventory.');
    const phone=await phoneOf(c,ctx);
    if(!phone)throw new ValidationError('Confirm your mobile number in your alert settings first.');
    if((await c.query(`SELECT 1 FROM ${members} WHERE channel='whatsapp' AND external_user=$1 AND NOT(workspace_id=$2 AND actor_id=$3)`,[phone,ctx.workspaceId,ctx.actorId])).rowCount)
      throw new ValidationError('This number already asks another inventory or person. Turn WhatsApp questions off there first.');
    await c.query(`INSERT INTO ${members}(workspace_id,channel,actor_id,external_user) VALUES($1,'whatsapp',$2,$3)
      ON CONFLICT(workspace_id,channel,actor_id) DO UPDATE SET external_user=EXCLUDED.external_user,code_hash=NULL,code_expires_at=NULL`,[ctx.workspaceId,ctx.actorId,phone]);
    await audit(c,ctx,'Chat user linked',{channel:'whatsapp'});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function unlink(db,ctx,channel){
  known(channel);await member(db,ctx);
  await db.query(`DELETE FROM ${members} WHERE workspace_id=$1 AND channel=$2 AND actor_id=$3`,[ctx.workspaceId,channel,ctx.actorId]);
}

async function page(db,ctx){
  const actor=await member(db,ctx),state=await policy.accountState(db,ctx.workspaceId);
  const allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,188,'draft');
  const result={allowed,owner:actor.role==='owner',teams:null,whatsapp:null,recent:[],phone:null,whatsappReady:chat.get('whatsapp').configured()};
  if(!await require('../db/schema-installed').has(db,connections))return result;
  for(const channel of Object.keys(CHANNELS)){
    const row=await configuration(db,ctx.workspaceId,channel);
    result[channel]={connection:row?{endpoint_id:row.endpoint_id,tenant:row.tenant,app:row.app,enabled:row.enabled,revision:row.revision}:null,
      linked:allowed?(await db.query(`SELECT external_user FROM ${members} WHERE workspace_id=$1 AND channel=$2 AND actor_id=$3`,[ctx.workspaceId,channel,ctx.actorId])).rows[0]?.external_user||null:null};
  }
  if(allowed){
    result.phone=await phoneOf(db,ctx);
    result.recent=(await db.query(`SELECT id,channel,status,problem_code,created_at::text FROM ${questions} WHERE workspace_id=$1 AND actor_id=$2 ORDER BY created_at DESC LIMIT 30`,[ctx.workspaceId,ctx.actorId])).rows;
  }
  return result;
}

async function linkTeams(c,connection,user,token){
  if(!tokenPattern.test(token))return 'Use a fresh link code from StockChief.';
  const row=(await c.query(`SELECT actor_id FROM ${members} WHERE workspace_id=$1 AND channel='teams' AND code_hash=$2 AND code_expires_at>clock_timestamp() FOR UPDATE`,
    [connection.workspace_id,digest(token)])).rows[0];
  if(!row)return 'This link code expired or was already used. Make a new code in StockChief.';
  const ctx={workspaceId:connection.workspace_id,actorId:row.actor_id};
  await authorize(c,ctx);
  const previous=(await c.query(`SELECT actor_id FROM ${members} WHERE workspace_id=$1 AND channel='teams' AND external_user=$2`,[ctx.workspaceId,user])).rows[0];
  if(previous&&previous.actor_id!==ctx.actorId)return 'This Teams user is already linked to someone else in StockChief.';
  await c.query(`UPDATE ${members} SET external_user=$3,code_hash=NULL,code_expires_at=NULL WHERE workspace_id=$1 AND channel='teams' AND actor_id=$2`,[ctx.workspaceId,ctx.actorId,user]);
  await audit(c,ctx,'Chat user linked',{channel:'teams'});
  return 'Your Teams user is linked. Ask StockChief a question here.';
}

// Reads one incoming message. Returns {notice,target,workspaceId} when the
// person should be told something now (not linked, plan, pause), or null.
async function receive(db,channel,{endpoint=null,raw,headers={},url=''}){
  known(channel);
  const provider=chat.get(channel);
  let connection=null;
  if(channel==='teams'){
    if(!tokenPattern.test(String(endpoint||'')))throw new NotFoundError();
    connection=(await db.query(`SELECT * FROM ${connections} WHERE endpoint_id=$1 AND channel='teams' AND enabled`,[endpoint])).rows[0];
    if(!connection)throw new NotFoundError();
  }
  const scope=connection?await require('../commercial/entitlements').ownerScopeForWorkspace(db,connection.workspace_id):null;
  const read=()=>provider.inbound({raw,headers,url,connection:connection?{tenant:connection.tenant,app:connection.app,secret:secretOf(connection)}:{}});
  const input=scope?await require('../commercial/context').run({database:db,scope,system:true,requestId:'teams-inbound'},read):await read();
  const tell=(notice,workspaceId=connection?.workspace_id)=>({notice,target:input.target,workspaceId});
  if(input.ignore)return input.notice?tell(input.notice):null;
  if(!input.text)return null;
  if(channel==='whatsapp'){
    connection=(await db.query(`SELECT c.* FROM ${members} m JOIN ${connections} c ON c.workspace_id=m.workspace_id AND c.channel=m.channel AND c.enabled
      WHERE m.channel='whatsapp' AND m.external_user=$1`,[input.user])).rows[0];
    if(!connection)return tell('This number is not linked to StockChief. Turn on WhatsApp questions in StockChief first.',null);
  }
  try{
    return await db.transaction(async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-chat:'+connection.workspace_id+':'+channel]);
      const current=(await c.query(`SELECT * FROM ${connections} WHERE workspace_id=$1 AND channel=$2 AND enabled`,[connection.workspace_id,channel])).rows[0];
      if(!current||current.revision!==connection.revision)return tell('This StockChief connection changed. Send your question again.');
      const linking=channel==='teams'&&/^connect\s+(\S+)$/i.exec(input.text);
      if(linking)return tell(await linkTeams(c,current,input.user,linking[1]));
      const held=(await c.query(`SELECT actor_id FROM ${members} WHERE workspace_id=$1 AND channel=$2 AND external_user=$3`,[current.workspace_id,channel,input.user])).rows[0];
      if(!held)return tell(channel==='teams'?'Link your Teams user from StockChief first: make a link code there and send “connect” with the code here.':'This number is not linked to StockChief. Turn on WhatsApp questions in StockChief first.');
      const ctx={workspaceId:current.workspace_id,actorId:held.actor_id};
      if(channel==='whatsapp'&&await phoneOf(c,ctx)!==input.user)return tell('Confirm this mobile number in StockChief again before asking here.');
      await authorize(c,ctx,{routine:true});
      await c.query(`UPDATE ${questions} SET sealed_question=NULL,status='HELD' WHERE workspace_id=$1 AND id IN(SELECT id FROM ${questions}
        WHERE workspace_id=$1 AND expires_at<clock_timestamp() AND sealed_question IS NOT NULL ORDER BY expires_at LIMIT 100)`,[ctx.workspaceId]);
      const fingerprint=digest(channel+':'+raw.toString('utf8')),id=newId('chatquestion');
      if((await c.query(`SELECT 1 FROM ${questions} WHERE workspace_id=$1 AND channel=$2 AND fingerprint=$3`,[ctx.workspaceId,channel,fingerprint])).rowCount)return null;
      const recent=(await c.query(`SELECT count(*)::int AS count FROM (SELECT 1 FROM ${questions} WHERE workspace_id=$1 AND actor_id=$2
        AND created_at>clock_timestamp()-interval '1 minute' LIMIT 5) q`,[ctx.workspaceId,ctx.actorId])).rows[0];
      if(recent.count>=5)return tell('Wait a minute before asking another question.');
      await require('../commercial/storage-capacity').reserve(scoped(c),ctx.workspaceId,'chat-question:'+id,8192,{finished:true});
      await c.query(`INSERT INTO ${questions}(workspace_id,id,channel,actor_id,external_user,connection_revision,fingerprint,sealed_question,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',clock_timestamp()+interval '10 minutes')`,
      [ctx.workspaceId,id,channel,ctx.actorId,input.user,current.revision,fingerprint,seal({text:input.text,target:input.target})]);
      await jobs.enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind,idempotencyKey:id,payload:{questionId:id,channel},maxAttempts:1});
      return null;
    },{isolation:'SERIALIZABLE',retrySafe:true});
  }catch(error){
    if(error.status>=400&&error.status<500&&error.status!==404)return tell(error.message);
    throw error;
  }
}

// Sends a short notice through the channel inside its registered operation.
async function notify(db,channel,{notice,target,workspaceId}){
  const about=known(channel),provider=chat.get(channel);
  if(!workspaceId||channel==='whatsapp')return;
  const connection=await configuration(db,workspaceId,channel);
  if(!connection?.enabled)return;
  await require('../commercial/operations').run(db,workspaceId,{operation:about.operation,provider:about.provider,key:'notice:'+newId('chatnotice'),capability:'ask.lookup'},
    ()=>provider.deliver({connection:{tenant:connection.tenant,app:connection.app,secret:secretOf(connection)},target,text:notice}));
}

async function live(db,workspaceId,id,status){
  return (await db.query(`SELECT q.*,c.tenant,c.app,c.sealed_secret FROM ${questions} q
    JOIN ${connections} c ON c.workspace_id=q.workspace_id AND c.channel=q.channel AND c.enabled AND c.revision=q.connection_revision
    JOIN ${members} m ON m.workspace_id=q.workspace_id AND m.channel=q.channel AND m.actor_id=q.actor_id AND m.external_user=q.external_user
    WHERE q.workspace_id=$1 AND q.id=$2 AND q.status=$3 AND q.expires_at>clock_timestamp()`,[workspaceId,id,status])).rows[0];
}
async function mark(db,workspaceId,id,status,prior){
  return (await db.query(`UPDATE ${questions} SET status=$3,sealed_question=NULL WHERE workspace_id=$1 AND id=$2 AND status=$4`,[workspaceId,id,status,prior])).rowCount;
}
const usageKey=(channel,id)=>channel+':'+id;
async function refund(db,ctx,channel,id){
  const key=ctx.workspaceId+':'+usageKey(channel,id);
  if((await db.query(`SELECT 1 FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits' AND idempotency_key=$2 AND status='RESERVED'`,[ctx.workspaceId,key])).rowCount)
    await require('../commercial/entitlements').reverseUsage(scoped(db),await require('../commercial/entitlements').ownerScopeForWorkspace(db,ctx.workspaceId),
      {meter:'ai_work_credits',idempotencyKey:key,reason:'Chat answer could not be delivered under current authority.'});
}
// The person's role, permissions and (for WhatsApp) confirmed number must be
// unchanged from when the answer was prepared.
async function unchanged(db,ctx,actor,question){
  const current=await authorize(db,ctx,{routine:true});
  if(current.role!==actor.role||JSON.stringify(current.permissions)!==JSON.stringify(actor.permissions))
    throw new AuthorizationError('Your StockChief permissions changed while preparing the answer.');
  if(question.channel==='whatsapp'&&await phoneOf(db,ctx)!==question.external_user)throw new AuthorizationError('Your confirmed mobile number changed.');
}

async function process(job,db,options={}){
  const workspaceId=job.workspaceId,id=job.payload.questionId,question=await live(db,workspaceId,id,'PENDING');
  if(!question)return {status:'expired_or_stopped'};
  const ctx={workspaceId,actorId:question.actor_id},channel=question.channel,about=known(channel);
  let actor;
  try{actor=await authorize(db,ctx,{routine:true});}
  catch(error){if(error.status>=400&&error.status<500){await mark(db,workspaceId,id,'HELD','PENDING');return {status:'authority_changed'};}throw error;}
  const {text,target}=credentials.decrypt(question.sealed_question);
  let result,outcome='failed',problem=null;
  try{({text:result,outcome}=await answers.answer(db,ctx,actor,text,{provider:options.provider,key:usageKey(channel,id)}));}
  catch(error){
    problem={code:error.code||'answer_failed',message:error.message};
    await db.query(`UPDATE ${questions} SET problem_code=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,id,problem.code]);
    result='StockChief could not complete that answer. Open StockChief to check the records or try a narrower question.';
  }
  const claimed=await db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-chat:'+workspaceId+':'+channel]);
    if(!await live(c,workspaceId,id,'PENDING'))return false;
    try{await unchanged(c,ctx,actor,question);}
    catch(error){if(error.status>=400&&error.status<500){await mark(c,workspaceId,id,'HELD','PENDING');return false;}throw error;}
    return mark(c,workspaceId,id,'CLAIMED','PENDING');
  },{isolation:'SERIALIZABLE',retrySafe:true});
  if(!claimed){await refund(db,ctx,channel,id);return {status:'authority_changed'};}
  try{
    await require('../commercial/operations').run(db,workspaceId,{operation:about.operation,provider:about.provider,key:id,capability:'ask.lookup'},async()=>{
      await db.transaction(async client=>{
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-chat:'+workspaceId+':'+channel]);
        await client.query('SELECT id FROM users WHERE workspace_id=$1 AND id=$2 FOR SHARE',[workspaceId,ctx.actorId]);
        await client.query(`SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s`,[workspaceId]);
        const current=await live(client,workspaceId,id,'CLAIMED');
        if(!current)throw new AuthorizationError('This chat connection was stopped before delivery.');
        await unchanged(client,ctx,actor,question);
        await chat.get(channel).deliver({connection:{tenant:current.tenant,app:current.app,secret:secretOf(current)},target,text:result});
      },{isolation:'READ COMMITTED'});
    });
  }catch(error){await mark(db,workspaceId,id,'HELD','CLAIMED');await refund(db,ctx,channel,id);throw error;}
  await db.transaction(async client=>{
    const key=workspaceId+':'+usageKey(channel,id);
    if((await client.query(`SELECT 1 FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits' AND idempotency_key=$2 AND status='RESERVED'`,[workspaceId,key])).rowCount)
      await require('../commercial/entitlements').commitUsage(scoped(client),await require('../commercial/entitlements').ownerScopeForWorkspace(scoped(client),workspaceId),{meter:'ai_work_credits',idempotencyKey:key});
    if(await mark(client,workspaceId,id,'REPLIED','CLAIMED'))await answers.audited(client,ctx,{channel,question:id,outcome});
  },{isolation:'SERIALIZABLE',retrySafe:true});
  return {status:'replied',outcome,answerProblem:problem};
}

async function recover(db,job){
  const row=(await db.query(`SELECT actor_id,status,channel FROM ${questions} WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,job.payload.questionId])).rows[0];
  if(!row||row.status==='REPLIED')return;
  await mark(db,job.workspaceId,job.payload.questionId,'HELD',row.status);
  await refund(scoped(db),{workspaceId:job.workspaceId,actorId:row.actor_id},row.channel,job.payload.questionId);
}

module.exports={path,publicPaths,kind,CHANNELS,configure,code,linkPhone,unlink,page,receive,notify,process,recover};

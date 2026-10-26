'use strict';

const {ValidationError,NotFoundError,AuthorizationError}=require('../domain/errors');
const {nowIso}=require('../lib/util');
const permissions=require('../actions/permissions');
const entitlements=require('../commercial/entitlements');
const CAPABILITY='communications.ai_drafts';
const within=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
const parse=value=>typeof value==='string'?JSON.parse(value||'{}'):value||{};

async function actor(db,ctx,owner=false){
  const row=(await db.query('SELECT role,permissions,account_id FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row||owner&&row.role!=='owner')throw new AuthorizationError('Only this inventory’s owner can change automatic preparation.');
  permissions.assertCan(row,permissions.OPERATE,'prepare business replies');return row;
}
async function authorize(db,ctx,source){
  await actor(db,ctx);
  const message=(await db.query(`SELECT m.*,c.config,c.status AS connection_status,c.paused_at
    FROM connection_email_messages m JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    WHERE m.workspace_id=$1 AND m.id=$2`,[ctx.workspaceId,source.messageId])).rows[0];
  if(!message||!['NEEDS_REPLY'].includes(message.reply_state)||message.reply_sent_at||message.draft_source==='owner')
    throw new ValidationError('This email no longer needs an automatic reply. Your saved work is kept.');
  if(message.connection_status!=='connected'||message.paused_at||source.automatic&&parse(message.config).replyPreparationEnabled!==true)
    throw new AuthorizationError('Automatic reply preparation is off or the mailbox needs sign-in.');
  await entitlements.assertCapability(db,await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId),CAPABILITY);
  return message;
}
async function configure(db,ctx,id,enabled){
  if(typeof enabled!=='boolean')throw new ValidationError('Choose whether automatic preparation is on or off.');
  return within(db,async client=>{
    const owner=await actor(client,ctx,true);
    const row=(await client.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!row||!['gmail','microsoft365'].includes(row.provider_type))throw new NotFoundError('That business mailbox was not found.');
    if(enabled){
      await entitlements.assertCapability(client,await entitlements.ownerScopeForWorkspace(client,ctx.workspaceId),CAPABILITY);
      if(row.status!=='connected'||row.paused_at)throw new ValidationError('Sign in and resume this mailbox before automatic preparation.');
    }
    const config=parse(row.config),prior=config.replyPreparationEnabled===true;
    if(prior===enabled)return {enabled,replayed:true};
    config.replyPreparationEnabled=enabled;
    await client.query('UPDATE workspace_connectors SET config=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,JSON.stringify(config),nowIso()]);
    await require('../commercial/control-service').audit(client,{actorAccountId:owner.account_id,subjectType:'mail_preparation_settings',subjectId:id,
      action:'changed',beforeState:{enabled:prior},afterState:{enabled,prepareOnly:true},reason:'Owner changed automatic reply preparation.'});
    return {enabled,replayed:false};
  });
}
async function request(db,ctx,messageId,{automatic=false}={}){
  return within(db,async client=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['mail-preparation:'+ctx.workspaceId+':'+messageId]);
    const source={capability:CAPABILITY,messageId,automatic};
    const message=await authorize(client,ctx,source);
    if(automatic&&message.draft_source==='model')return {skipped:'already_prepared'};
    const active=(await client.query(`SELECT id,checkpoint FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2
      AND checkpoint->'sourceAutomation'->>'capability'=$3 AND checkpoint->'sourceAutomation'->>'messageId'=$4
      AND status IN ('READY','RUNNING') ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,ctx.actorId,CAPABILITY,messageId])).rows[0];
    if(active){if(active.checkpoint.sourceAutomation.automatic&&parse(message.config).replyPreparationEnabled!==true)
      throw new ValidationError('The earlier automatic preparation is stopping. Wait for its saved result before trying again.');
      return {queued:true,nativeGoalId:active.id,replayed:true};}
    const pilot=require('../assistant/postgres-codex-pilot');
    if(!pilot.configured(ctx))throw new ValidationError('Reply preparation is unavailable. Your email and draft are kept.');
    const scoped={query:client.query,transaction:fn=>fn(client)};
    const task='Prepare an unsent reply for the received business email at /mail/'+encodeURIComponent(messageId)+'.';
    const started=await pilot.start(scoped,ctx,task,{usageKey:'mail-preparation:'+messageId+':'+
      (automatic?'automatic':require('../lib/util').newId('request')),page:{path:'/mail/'+encodeURIComponent(messageId)},budgetMinor:100});
    source.expectedDraftDigest=require('./postgres-reply-drafting').draftDigest(message);
    // Pure processing sees only this sender's bounded evidence packet. It has
    // no browser, business tools, other contacts, or mutation authority.
    source.processingInput={message:{sender:message.sender,subject:message.subject,body_text:message.body_text},
      facts:await require('./postgres-reply-drafting').factsFor(client,ctx.workspaceId,message)};
    await client.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=jsonb_set(checkpoint,'{sourceAutomation}',$4::jsonb) WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3",
      [ctx.workspaceId,ctx.actorId,started.goalId,JSON.stringify(source)]);
    return {queued:true,nativeGoalId:started.goalId};
  });
}
async function completeProcessing(db,ctx,goal,draft){
  const source=goal.checkpoint.sourceAutomation;
  await authorize(db,ctx,source);
  if(!draft||Object.keys(draft).sort().join(',')!=='body,subject')return {verified:false,
    verificationFailure:'MAIL_REPLY_CONTENT_UNVERIFIED',answer:'StockChief did not return a complete reply. Nothing was sent.'};
  try{await require('./postgres-reply-drafting').savePrepared(db,ctx,source.messageId,draft,{expectedDraftDigest:source.expectedDraftDigest});}
  catch(error){if(!(error instanceof ValidationError))throw error;
    return {verified:false,verificationFailure:'MAIL_REPLY_CONTENT_UNVERIFIED',answer:'The prepared reply could not be verified. Your saved email and edits are kept.'};}
  return {verified:true,verificationScope:'bounded_sender_evidence_and_current_mail_records',
    answer:'The reply is prepared for your review. Nothing has been sent.',
    delivery:require('../assistant/agent-delivery').create({status:'completed',answer:'Reply prepared.',claims:[],
      workProducts:[{title:'Prepared reply',content:'Subject: '+draft.subject+'\n\n'+draft.body}]})};
}
async function discard(db,ctx,id){
  return within(db,async client=>{
    await actor(client,ctx);
    const row=(await client.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!row)throw new NotFoundError('That business email was not found.');
    if(row.reply_sent_at)throw new ValidationError('A verified sent reply cannot be discarded.');
    const pending=(await client.query("SELECT 1 FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1 AND message_id=$2 AND status IN ('PENDING','SENDING','AMBIGUOUS') LIMIT 1",[ctx.workspaceId,id])).rows.length;
    if(pending)throw new ValidationError('Wait for the saved send outcome before discarding this reply.');
    await client.query(`UPDATE connection_email_messages SET reply_state='HANDLED',reply_reason='Reply discarded; original email and draft retained.',
      reply_state_by_user_id=$3,reply_state_at=$4 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,ctx.actorId,nowIso()]);
    return {discarded:true,originalEmailAndDraftPreserved:true};
  });
}
async function state(db,ctx,id,{providerConfigured=false}={}){
 const connection=await require('./postgres-service').get(db,ctx.workspaceId,id);
 const capable=(await entitlements.capabilityState(db,await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId),CAPABILITY)).enabled;
 const configured=providerConfigured||require('../config').ai.configured||require('../assistant/postgres-codex-pilot').configured(ctx);
 const connected=connection.status==='connected'&&!connection.paused_at;
 const enabled=connection.config.replyPreparationEnabled===true;
 const messages=(await db.query(`SELECT m.id,m.subject,m.draft_source,m.draft_at,m.reply_state,m.reply_sent_at,
   job.status AS job_status,job.result,job.updated_at AS job_updated_at,goal.status AS goal_status,goal.updated_at AS goal_updated_at
   FROM connection_email_messages m LEFT JOIN LATERAL (SELECT status,result,updated_at FROM stockchief_runtime.jobs
     WHERE workspace_id=m.workspace_id AND kind='mail.reply-draft' AND payload->>'messageId'=m.id ORDER BY created_at DESC,id DESC LIMIT 1) job ON true
   LEFT JOIN LATERAL (SELECT status,updated_at FROM stockchief_runtime.assistant_goals
     WHERE workspace_id=m.workspace_id AND checkpoint->'sourceAutomation'->>'capability'=$3
       AND checkpoint->'sourceAutomation'->>'messageId'=m.id ORDER BY created_at DESC,id DESC LIMIT 1) goal ON true
   WHERE m.workspace_id=$1 AND m.connector_id=$2 AND (job.status IS NOT NULL OR goal.status IS NOT NULL OR m.draft_at IS NOT NULL)
   ORDER BY greatest(job.updated_at,goal.updated_at,NULLIF(m.draft_at::text,'')::timestamptz) DESC NULLS LAST,m.id LIMIT 10`,[ctx.workspaceId,id,CAPABILITY])).rows;
 const entries=messages.map(m=>({id:m.id,subject:m.subject||'No subject',at:m.draft_at||m.goal_updated_at||m.job_updated_at,
   label:m.reply_sent_at?'Sent and verified':m.reply_state==='HANDLED'?'Handled; email and draft retained':m.draft_source==='owner'?'Your edited reply':m.draft_source==='model'?'Reply ready':
     ['READY','RUNNING'].includes(m.goal_status)||['PENDING','RETRY','RUNNING'].includes(m.job_status)?'Preparing reply':
     m.result?.skipped==='automatic_preparation_off'?'Stopped; preparation is off':'Needs review'}));
 return {enabled,available:capable&&configured,connected,
   label:!capable?'Not included in this plan':!configured?'Reply preparation is unavailable':connection.paused_at?'Mailbox checks are paused':!connected?'Mailbox sign-in needed':
     enabled?'Automatic preparation is on':'Automatic preparation is off',entries};
}
module.exports={CAPABILITY,authorize,configure,request,completeProcessing,discard,state};

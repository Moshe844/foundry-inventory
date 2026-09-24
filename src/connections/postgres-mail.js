'use strict';

const crypto=require('node:crypto');
const {newId,nowIso,trimOrNull}=require('../lib/util');
const {NotFoundError,ValidationError,InvariantError}=require('../domain/errors');
const access=require('../actions/permissions');
const providerService=require('./postgres-provider-service');
const defaultProviders=require('./providers/registry');
const providerEffects=require('../operations/postgres-provider-effects');

function contentHash(message){return crypto.createHash('sha256').update(JSON.stringify({sender:message.sender,
  subject:message.subject||'',body:message.bodyText||message.body||'',receivedAt:message.receivedAt||''})).digest('hex');}

async function capture(database,connection,message){
  const sender=trimOrNull(message.sender)?.toLowerCase();
  if(!sender)throw new ValidationError('A mailbox message needs a sender.');
  const externalId=trimOrNull(message.externalMessageId||message.messageId||message.id);
  if(!externalId)throw new ValidationError('A mailbox message needs a provider message id.');
  return database.transaction(async(client)=>{
    const supplier=(await client.query(`SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active'
      AND lower(email)=lower($2) ORDER BY id LIMIT 2`,[connection.workspace_id,sender])).rows;
    const customer=(await client.query(`SELECT id,name FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE'
      AND lower(email)=lower($2) ORDER BY id LIMIT 2`,[connection.workspace_id,sender])).rows;
    const matches=[...supplier.map((row)=>({...row,kind:'supplier'})),...customer.map((row)=>({...row,kind:'customer'}))];
    if(matches.length!==1){
      const id=newId('emailaside');const at=nowIso();
      const inserted=await client.query(`INSERT INTO connection_email_set_aside
        (id,workspace_id,connector_id,external_message_id,sender,subject,received_at,reason,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(workspace_id,connector_id,external_message_id) DO NOTHING RETURNING id`,
      [id,connection.workspace_id,connection.id,externalId,sender,trimOrNull(message.subject),
        message.receivedAt||at,matches.length?'Sender matches more than one business contact.':'Sender is not a customer or supplier.',at]);
      if(inserted.rows.length)return {accepted:false,setAside:true,replayed:false,id};
      const existing=(await client.query(`SELECT id FROM connection_email_set_aside WHERE workspace_id=$1
        AND connector_id=$2 AND external_message_id=$3`,[connection.workspace_id,connection.id,externalId])).rows[0];
      return {accepted:false,setAside:true,replayed:true,id:existing.id};
    }
    const match=matches[0];const id=newId('emailmsg');const at=nowIso();
    const inserted=await client.query(`INSERT INTO connection_email_messages
      (id,workspace_id,connector_id,external_message_id,sender,recipients,subject,body_text,received_at,
       supplier_id,trust_status,classification,external_thread_id,internet_message_id,content_hash,
       processing_status,reply_state,reply_reason,reply_state_at,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'TRUSTED',$11,$12,$13,$14,'CAPTURED','NEEDS_REPLY',$15,$16,$16)
      ON CONFLICT(workspace_id,connector_id,external_message_id) DO NOTHING RETURNING id`,
    [id,connection.workspace_id,connection.id,externalId,sender,JSON.stringify(message.recipients||[]),
      trimOrNull(message.subject),trimOrNull(message.bodyText||message.body),message.receivedAt||at,
      match.kind==='supplier'?match.id:null,match.kind,message.externalThreadId||message.threadId||null,message.internetMessageId||null,
      contentHash(message),`${match.kind} message from ${match.name} needs a response.`,at]);
    if(!inserted.rows.length){
      const existing=(await client.query(`SELECT id FROM connection_email_messages WHERE workspace_id=$1
        AND connector_id=$2 AND external_message_id=$3`,[connection.workspace_id,connection.id,externalId])).rows[0];
      return {accepted:true,replayed:true,messageId:existing.id};
    }
    await client.query('UPDATE workspace_connectors SET last_activity_at=$3,updated_at=$3 WHERE workspace_id=$1 AND id=$2',
      [connection.workspace_id,connection.id,at]);
    return {accepted:true,replayed:false,messageId:id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function counts(database,workspaceId){
  const rows=(await database.query(`SELECT reply_state,COUNT(*)::integer AS count FROM connection_email_messages
    WHERE workspace_id=$1 GROUP BY reply_state`,[workspaceId])).rows;
  return Object.fromEntries(rows.map((row)=>[row.reply_state,Number(row.count)]));
}

async function list(database,workspaceId,state='NEEDS_REPLY'){
  return (await database.query(`SELECT message.*,connector.display_name,connector.provider_type
    FROM connection_email_messages message JOIN workspace_connectors connector ON connector.id=message.connector_id
    WHERE message.workspace_id=$1 AND message.reply_state=$2 ORDER BY message.received_at ASC,message.id ASC`,
  [workspaceId,state])).rows;
}

async function get(database,workspaceId,id){
  const result=await database.query(`SELECT message.*,connector.display_name,connector.provider_type,
      supplier.name AS supplier_name,
      (SELECT status FROM stockchief_runtime.email_reply_outbox outbox WHERE outbox.workspace_id=message.workspace_id
        AND outbox.message_id=message.id ORDER BY started_at DESC LIMIT 1) AS outbox_status
    FROM connection_email_messages message JOIN workspace_connectors connector ON connector.id=message.connector_id
    LEFT JOIN suppliers supplier ON supplier.id=message.supplier_id
    WHERE message.workspace_id=$1 AND message.id=$2`,[workspaceId,id]);
  if(!result.rows.length)throw new NotFoundError('That business message was not found.');
  return result.rows[0];
}

async function requireOperator(database,ctx,what){
  const actor=(await database.query('SELECT id,role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');
  access.assertCan(actor,access.OPERATE,what);
}

async function setState(database,ctx,id,state,reason){
  await requireOperator(database,ctx,'sort the mailbox');
  if(!['NEEDS_REPLY','WAITING','HANDLED'].includes(state))throw new ValidationError('Choose a valid mailbox state.');
  const result=await database.query(`UPDATE connection_email_messages SET reply_state=$3,reply_reason=$4,
    reply_state_by_user_id=$5,reply_state_at=$6 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
  [ctx.workspaceId,id,state,trimOrNull(reason),ctx.actorId,nowIso()]);
  if(!result.rows.length)throw new NotFoundError('That business message was not found.');
  return get(database,ctx.workspaceId,id);
}

async function saveDraft(database,ctx,id,input){
  await requireOperator(database,ctx,'write replies');
  const subject=trimOrNull(input.subject);const body=trimOrNull(input.body);
  if(!subject||!body)throw new ValidationError('A reply needs both a subject and a body.');
  const result=await database.query(`UPDATE connection_email_messages SET draft_subject=$3,draft_body=$4,
    draft_source='owner',draft_rejected_because=NULL,draft_at=$5 WHERE workspace_id=$1 AND id=$2 RETURNING id`,
  [ctx.workspaceId,id,subject,body,nowIso()]);
  if(!result.rows.length)throw new NotFoundError('That business message was not found.');
  return get(database,ctx.workspaceId,id);
}

async function queueSend(database,ctx,id,input={},options={}){
  const message=await saveDraft(database,ctx,id,input);
  if(message.reply_sent_at)return {sent:true,replayed:true,message};
  const provider=(options.providers||defaultProviders).get(message.provider_type);
  if(!provider?.send)throw new ValidationError('This mailbox connection cannot send replies.');
  const connection=(await database.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,message.connector_id])).rows[0];
  if(!connection||connection.status!=='connected'||connection.paused_at)throw new ValidationError('Reconnect or resume this mailbox before sending.');
  const unresolved=(await database.query(`SELECT status FROM stockchief_runtime.email_reply_outbox
    WHERE workspace_id=$1 AND message_id=$2 AND status IN ('PENDING','SENDING','AMBIGUOUS')
    ORDER BY started_at DESC LIMIT 1`,[ctx.workspaceId,id])).rows[0];
  if(unresolved)throw new InvariantError(
    'The mailbox provider outcome is uncertain. StockChief will not send another reply for this message. Check Sent mail, then mark the conversation waiting or handled.',
    'email_send_ambiguous');
  const idempotencyKey=crypto.createHash('sha256').update(`${id}\n${message.draft_subject}\n${message.draft_body}`).digest('hex');
  return database.transaction(async(client)=>{const outboxId=newId('mailout');
    const started=await client.query(`INSERT INTO stockchief_runtime.email_reply_outbox
      (id,workspace_id,message_id,connector_id,idempotency_key,recipient,subject,body,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING')
      ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,
    [outboxId,ctx.workspaceId,id,message.connector_id,idempotencyKey,message.sender,message.draft_subject,message.draft_body]);
    if(!started.rows.length){const prior=(await client.query(`SELECT * FROM stockchief_runtime.email_reply_outbox
        WHERE workspace_id=$1 AND idempotency_key=$2 FOR UPDATE`,[ctx.workspaceId,idempotencyKey])).rows[0];
      if(prior.status==='SENT')return {sent:true,replayed:true,message:await get(client,ctx.workspaceId,id)};
      if(['PENDING','SENDING'].includes(prior.status))return {queued:true,replayed:true,effectId:(await client.query(`SELECT id
        FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.reply.send'
        AND payload->>'outboxId'=$2 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,prior.id])).rows[0]?.id};
      if(prior.status==='AMBIGUOUS')throw new InvariantError('The mailbox provider outcome is uncertain. StockChief will not send this reply again automatically.','email_send_ambiguous');
      throw new ValidationError(prior.error_message||'The reply was not sent. Change the draft after correcting the connection, then try again.');}
    const queued=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:'mail.reply.send',
      provider:message.provider_type,aggregateType:'email_message',aggregateId:id,idempotencyKey,
      requestedByUserId:ctx.actorId,payload:{outboxId,messageId:id,connectorId:message.connector_id,actorId:ctx.actorId},
      priority:10,maxAttempts:12});return {queued:true,replayed:false,effectId:queued.effect.id,outboxId};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function executeSendEffect(database,workspaceId,effectId,options={}){const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {message:await get(database,workspaceId,claimed.effect.aggregateId),replayed:true};
  const effect=claimed.effect;const input=effect.payload;const provider=options.provider||defaultProviders.get(effect.provider);
  let outbox;let message;let connection;let providerCalled=false;
  try{const loaded=await database.transaction(async(client)=>{outbox=(await client.query(`UPDATE stockchief_runtime.email_reply_outbox
      SET status='SENDING' WHERE workspace_id=$1 AND id=$2 AND status='PENDING' RETURNING *`,[workspaceId,input.outboxId])).rows[0];
    if(!outbox)throw Object.assign(new ValidationError('That queued reply is no longer pending.'),{code:'email_outbox_not_pending'});
    message=(await client.query(`SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.messageId])).rows[0];
    connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.connectorId])).rows[0];
    if(!message||!connection||connection.status!=='connected'||connection.paused_at)
      throw Object.assign(new ValidationError('Reconnect or resume this mailbox before sending.'),{code:'email_connection_unavailable'});
    return {message,connection};},{isolation:'SERIALIZABLE',retrySafe:true});message=loaded.message;connection=loaded.connection;
    if(!provider?.send)throw Object.assign(new ValidationError('This mailbox connection cannot send replies.'),{code:'email_send_unavailable'});
    const providerCredentials=await providerService.loadProviderCredentials(database,connection,provider);
    providerCalled=true;const result=await provider.send({credentials:providerCredentials,message:{id:outbox.id,recipient:outbox.recipient,
      subject:outbox.subject,body:outbox.body,externalThreadId:message.external_thread_id},idempotencyKey:effect.idempotencyKey});
    await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{messageId:result.externalMessageId||null},
      result:{externalMessageId:result.externalMessageId||null,externalThreadId:result.externalThreadId||null},apply:async(client)=>{const at=nowIso();
      await client.query(`UPDATE stockchief_runtime.email_reply_outbox SET status='SENT',provider_message_id=$2,
        provider_thread_id=$3,error_message=NULL,finished_at=$4 WHERE id=$1`,[outbox.id,result.externalMessageId||null,result.externalThreadId||null,at]);
      await client.query(`UPDATE connection_email_messages SET reply_state='WAITING',reply_reason='Reply sent; waiting on them.',
        reply_state_by_user_id=$3,reply_state_at=$4,reply_sent_at=$4,reply_external_message_id=$5
        WHERE workspace_id=$1 AND id=$2`,[workspaceId,input.messageId,input.actorId,at,result.externalMessageId||null]);}});
    return {message:await get(database,workspaceId,input.messageId),replayed:false};
  }catch(error){const ambiguous=providerCalled&&!providerEffects.definiteFailure(error);await providerEffects.finishError(database,workspaceId,effectId,
    effect.claimToken,error,{ambiguous,apply:async(client)=>{const at=nowIso();await client.query(`UPDATE stockchief_runtime.email_reply_outbox
      SET status=$2,error_message=$3,finished_at=$4 WHERE workspace_id=$5 AND id=$1 AND status IN ('PENDING','SENDING')`,
    [input.outboxId,ambiguous?'AMBIGUOUS':'FAILED',String(error.message||'Mailbox provider failed.').slice(0,500),at,workspaceId]);
    if(ambiguous)await client.query(`INSERT INTO connection_issues
      (id,workspace_id,connector_id,external_event_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'EMAIL_SEND_AMBIGUOUS',$5,'Email delivery could not be verified',$6,$7,'OPEN',$8,$8)
      ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at`,
    [newId('conissue'),workspaceId,input.connectorId,input.messageId,`email-send:${input.outboxId}`,
      'The provider may have accepted the reply before the connection failed. StockChief did not retry it.',
      'Check the mailbox Sent folder, then mark the message appropriately.',at]);}});
    throw Object.assign(error,{code:ambiguous?'email_send_ambiguous':(error.code||'email_send_failed'),retryable:false});}
}

module.exports={capture,counts,list,get,setState,saveDraft,queueSend,executeSendEffect};

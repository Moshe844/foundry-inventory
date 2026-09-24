'use strict';

const {newId,nowIso,trimOrNull}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');
const access=require('../actions/permissions');
const providerService=require('./postgres-provider-service');
const defaultProviders=require('./providers/registry');
const providerEffects=require('../operations/postgres-provider-effects');

async function requireOperator(client,ctx){
  const actor=(await client.query('SELECT id,role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');
  access.assertCan(actor,access.OPERATE,'send business email');
}

async function contacts(database,workspaceId,search,kind=null){
  const value=trimOrNull(search);if(!value)return [];
  const role=/^(?:the\s+|our\s+|my\s+|an?\s+)?(supplier|vendor|customer|client)\s+(?:named\s+|called\s+)?(.+)$/i.exec(value);
  const requestedKind=kind||(role?(/supplier|vendor/i.test(role[1])?'supplier':'customer'):null);
  const name=role?role[2].trim():value;
  const exactEmail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(name)?name.toLowerCase():null;
  const rows=[];
  if(requestedKind!=='supplier')rows.push(...(await database.query(`SELECT id,name,email,'customer' AS kind FROM customers
    WHERE workspace_id=$1 AND record_state='ACTIVE' AND ($2::text IS NOT NULL AND (lower(name)=lower($2) OR lower(email)=lower($2)))
    ORDER BY name,id LIMIT 10`,[workspaceId,name])).rows);
  if(requestedKind!=='customer')rows.push(...(await database.query(`SELECT id,name,email,'supplier' AS kind FROM suppliers
    WHERE workspace_id=$1 AND status='active' AND ($2::text IS NOT NULL AND (lower(name)=lower($2) OR lower(email)=lower($2)))
    ORDER BY name,id LIMIT 10`,[workspaceId,name])).rows);
  if(rows.length||exactEmail)return rows.length?rows:[{id:null,name,email:name,kind:'address'}];
  if(requestedKind!=='supplier')rows.push(...(await database.query(`SELECT id,name,email,'customer' AS kind FROM customers
    WHERE workspace_id=$1 AND record_state='ACTIVE' AND name ILIKE '%'||$2||'%' ORDER BY name,id LIMIT 10`,
  [workspaceId,name])).rows);
  if(requestedKind!=='customer')rows.push(...(await database.query(`SELECT id,name,email,'supplier' AS kind FROM suppliers
    WHERE workspace_id=$1 AND status='active' AND name ILIKE '%'||$2||'%' ORDER BY name,id LIMIT 10`,
  [workspaceId,name])).rows);
  return rows;
}

async function mailboxes(database,workspaceId){
  return (await database.query(`SELECT id,display_name,provider_type,provider_account_name FROM workspace_connectors
    WHERE workspace_id=$1 AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL
    ORDER BY display_name,id`,[workspaceId])).rows;
}

async function resolveMailbox(database,workspaceId,requested){
  const available=await mailboxes(database,workspaceId);
  if(!requested)return available.length===1?{row:available[0]}:{missing:available.length===0,ambiguous:available};
  const matches=available.filter((row)=>[row.id,row.display_name,row.provider_account_name,row.provider_type]
    .filter(Boolean).some((value)=>String(value).toLowerCase()===String(requested).trim().toLowerCase()));
  return matches.length===1?{row:matches[0]}:{notFound:matches.length===0,ambiguous:matches};
}

async function resolveRecipient(database,workspaceId,search,kind=null){
  if(!trimOrNull(search))return {missing:true};
  const rows=await contacts(database,workspaceId,search,kind);
  return rows.length===1?{row:rows[0]}:rows.length?{ambiguous:rows}:{notFound:true};
}

function tableFor(kind){return kind==='supplier'?'supplier_communications':'customer_communications';}

async function queueInTransaction(client,ctx,payload,idempotencyKey){
  await requireOperator(client,ctx);
  const table=tableFor(payload.recipientKind);const at=nowIso();
  let contact=null;
  if(payload.recipientKind==='supplier')contact=(await client.query(`SELECT id,name,email FROM suppliers
    WHERE workspace_id=$1 AND id=$2 AND status='active' FOR UPDATE`,[ctx.workspaceId,payload.recipientId])).rows[0];
  else if(payload.recipientKind==='customer')contact=(await client.query(`SELECT id,name,email FROM customers
    WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE' FOR UPDATE`,[ctx.workspaceId,payload.recipientId])).rows[0];
  if(payload.recipientKind!=='address'&&!contact)throw new NotFoundError('That recipient is no longer an active business contact.');
  const recipient=contact?.email||payload.recipientEmail;
  if(!recipient||recipient.toLowerCase()!==String(payload.recipientEmail||'').toLowerCase())
    throw new ValidationError('The recipient email changed after this message was prepared. Review it again before sending.');
  const connection=(await client.query(`SELECT id,provider_type FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
    AND provider_type IN ('gmail','microsoft365') AND status='connected' AND paused_at IS NULL FOR UPDATE`,
  [ctx.workspaceId,payload.connectorId])).rows[0];
  if(!connection)throw new ValidationError('Reconnect or resume the selected mailbox before sending.');
  const id=newId('businessmsg');const columns=payload.recipientKind==='supplier'?'supplier_id':'customer_id';
  const inserted=await client.query(`INSERT INTO ${table}
    (id,workspace_id,${columns},channel,recipient,subject,body,status,transport,message_kind,connector_id,
     approved_by_user_id,approved_at,idempotency_key,created_at,queued_at,updated_at)
    VALUES($1,$2,$3,'email',$4,$5,$6,'QUEUED',$7,'owner_message',$8,$9,$10,$11,$10,$10,$10)
    ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,
  [id,ctx.workspaceId,payload.recipientId,recipient,payload.subject,payload.body,connection.provider_type,
    connection.id,ctx.actorId,at,idempotencyKey]);
  const message=inserted.rows[0]||(await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND idempotency_key=$2`,
    [ctx.workspaceId,idempotencyKey])).rows[0];
  const queued=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,kind:'mail.outbound.send',
    provider:connection.provider_type,aggregateType:payload.recipientKind==='supplier'?'supplier_communication':'customer_communication',
    aggregateId:message.id,idempotencyKey,requestedByUserId:ctx.actorId,
    payload:{communicationId:message.id,communicationKind:payload.recipientKind,connectorId:connection.id},priority:10,maxAttempts:12});
  return {communicationId:message.id,communicationKind:payload.recipientKind,status:message.status,effectId:queued.effect.id,
    queued:queued.effect.status==='PENDING'};
}

async function get(database,workspaceId,kind,id){
  const table=tableFor(kind);const contact=kind==='supplier'?'supplier':'customer';
  const key=kind==='supplier'?'supplier_id':'customer_id';
  const row=(await database.query(`SELECT communication.*,contact.name AS contact_name,connector.display_name,
      effect.status AS provider_status,effect.error_message AS provider_error
    FROM ${table} communication LEFT JOIN ${contact}s contact ON contact.id=communication.${key}
    LEFT JOIN workspace_connectors connector ON connector.id=communication.connector_id
    LEFT JOIN stockchief_runtime.provider_effects effect ON effect.workspace_id=communication.workspace_id
      AND effect.kind='mail.outbound.send' AND effect.aggregate_id=communication.id
    WHERE communication.workspace_id=$1 AND communication.id=$2 ORDER BY effect.created_at DESC LIMIT 1`,[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That business message was not found.');return {...row,communication_kind:kind};
}

async function executeSendEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  const effect=claimed.effect;const input=effect.payload;const kind=input.communicationKind;
  if(claimed.replayed)return {message:await get(database,workspaceId,kind,effect.aggregateId),replayed:true};
  const table=tableFor(kind);const provider=options.provider||defaultProviders.get(effect.provider);let providerCalled=false;
  try{
    const loaded=await database.transaction(async(client)=>{
      const message=(await client.query(`UPDATE ${table} SET status='SENDING',updated_at=$3
        WHERE workspace_id=$1 AND id=$2 AND status='QUEUED' RETURNING *`,[workspaceId,input.communicationId,nowIso()])).rows[0];
      const connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2`,
        [workspaceId,input.connectorId])).rows[0];
      if(!message)throw Object.assign(new ValidationError('That queued message is no longer pending.'),{code:'email_outbox_not_pending'});
      if(!connection||connection.status!=='connected'||connection.paused_at)
        throw Object.assign(new ValidationError('Reconnect or resume this mailbox before sending.'),{code:'email_connection_unavailable'});
      return {message,connection};
    },{isolation:'SERIALIZABLE',retrySafe:true});
    if(!provider?.send)throw Object.assign(new ValidationError('This mailbox connection cannot send messages.'),{code:'email_send_unavailable'});
    const providerCredentials=await providerService.loadProviderCredentials(database,loaded.connection,provider);
    providerCalled=true;
    const result=await provider.send({credentials:providerCredentials,message:{id:loaded.message.id,
      recipient:loaded.message.recipient,subject:loaded.message.subject,body:loaded.message.body},idempotencyKey:effect.idempotencyKey});
    await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{messageId:result.externalMessageId||null},
      result:{externalMessageId:result.externalMessageId||null,externalThreadId:result.externalThreadId||null},apply:async(client)=>{
        const at=nowIso();await client.query(`UPDATE ${table} SET status='SENT',external_message_id=$3,
          external_thread_id=$4,error_message=NULL,sent_at=$5,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
        [workspaceId,input.communicationId,result.externalMessageId||null,result.externalThreadId||null,at]);
      }});
    return {message:await get(database,workspaceId,kind,input.communicationId),replayed:false};
  }catch(error){
    const ambiguous=providerCalled&&!providerEffects.definiteFailure(error);
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous,apply:async(client)=>{
      const at=nowIso();await client.query(`UPDATE ${table} SET status='FAILED',error_message=$3,updated_at=$4
        WHERE workspace_id=$1 AND id=$2 AND status IN ('QUEUED','SENDING')`,[workspaceId,input.communicationId,
        String(ambiguous?'The mailbox provider outcome is uncertain. StockChief did not send this message again.':error.message).slice(0,500),at]);
      if(ambiguous)await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,
        fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,'EMAIL_SEND_AMBIGUOUS',$5,'Email delivery could not be verified',$6,$7,'OPEN',$8,$8)
        ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at`,
      [newId('conissue'),workspaceId,input.connectorId,input.communicationId,`email-send:${effectId}`,
        'The provider may have accepted the message before the connection failed. StockChief did not retry it.',
        'Check the mailbox Sent folder before taking any further action.',at]);
    }});
    throw Object.assign(error,{code:ambiguous?'email_send_ambiguous':(error.code||'email_send_failed'),retryable:false});
  }
}

module.exports={contacts,mailboxes,resolveMailbox,resolveRecipient,queueInTransaction,get,executeSendEffect};

'use strict';

const {newId,nowIso}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError}=require('../domain/errors');
const entitlements=require('../entitlements/postgres-service');
const jobs=require('../operations/postgres-job-queue');
const mail=require('./postgres-mail');
const progress='stockchief_runtime.mailbox_poll_progress';
const view=client=>({query:(...args)=>client.query(...args),transaction:work=>work(client)});
const mailboxIdentity=connection=>hash([connection.provider_type,connection.provider_account_id||null,connection.authorized_by_user_id||null]);

async function current(db,job,connection){
  const active=(await db.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
    AND status='connected' AND paused_at IS NULL FOR UPDATE`,[job.workspaceId,connection.id])).rows[0];
  return active&&mailboxIdentity(active)===mailboxIdentity(connection)?active:null;
}

async function fence(db,job){
  if(!job.leaseToken)return;
  const row=await db.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND id=$2 AND lease_token=$3
    AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`,[job.workspaceId,job.id,job.leaseToken]);
  if(!row.rowCount)throw new ValidationError('The mailbox check lost its worker lease. Its completed messages are preserved.');
}

async function begin(db,job,connection){
  return db.transaction(async c=>{
    const active=await current(c,job,connection);
    if(!active)return null;
    await fence(c,job);
    const identity=mailboxIdentity(active);
    const prior=(await c.query(`SELECT * FROM ${progress} WHERE workspace_id=$1 AND connector_id=$2 FOR UPDATE`,
      [job.workspaceId,active.id])).rows[0];
    if(job.payload.windowId&&(prior?.window_id!==job.payload.windowId||prior.page_number!==job.payload.page))return null;
    if(prior?.mailbox_identity===identity)return prior;
    if(prior)await c.query(`DELETE FROM ${progress} WHERE workspace_id=$1 AND connector_id=$2`,[job.workspaceId,active.id]);
    const at=nowIso(),since=active.last_synced_at||active.created_at||at;
    return (await c.query(`INSERT INTO ${progress}(connector_id,workspace_id,mailbox_identity,window_id,since_at,until_at)
      VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz) RETURNING *`,[active.id,job.workspaceId,identity,newId('mailbox-window'),since,at])).rows[0];
  });
}

async function saveMessage(db,job,connection,message){
  async function save(metadataOnlyReason){
    return db.transaction(async c=>{
      const active=await current(c,job,connection);
      if(!active)return null;
      await fence(c,job);
      const result=await mail.capture(view(c),active,message,{metadataOnlyReason});
      await fence(c,job);
      return result;
    },{isolation:'SERIALIZABLE',retrySafe:true});
  }
  try{return await save(message.sourceIssue||null);}
  catch(error){
    if(error.details?.source!=='mailbox_attachment_bounds')throw error;
    return save(require('./providers/mailbox-source').originalReview);
  }
}

async function advance(db,job,connection,window,next,{restart=false}={}){
  return db.transaction(async c=>{
    if(!await current(c,job,connection))return false;
    await fence(c,job);
    if(next||restart){
      const page=window.page_number+1;
      const saved=await c.query(`UPDATE ${progress} SET cursor=$4::jsonb,page_number=$5,updated_at=clock_timestamp(),
        last_cursor_reset_at=CASE WHEN $7 THEN clock_timestamp() ELSE last_cursor_reset_at END
        WHERE workspace_id=$1 AND connector_id=$2 AND window_id=$3 AND page_number=$6`,
        [job.workspaceId,connection.id,window.window_id,JSON.stringify(next),page,window.page_number,restart]);
      if(!saved.rowCount)return false;
      await jobs.enqueue(view(c),{workspaceId:job.workspaceId,kind:'mailbox.poll',idempotencyKey:window.window_id+':'+page,
        payload:{connectorId:connection.id,windowId:window.window_id,page},priority:30,maxAttempts:5});
      return true;
    }
    const finished=await c.query(`DELETE FROM ${progress} WHERE workspace_id=$1 AND connector_id=$2 AND window_id=$3 AND page_number=$4`,
      [job.workspaceId,connection.id,window.window_id,window.page_number]);
    if(!finished.rowCount)return false;
    const at=nowIso(),watermark=new Date(window.until_at).toISOString();
    await c.query(`UPDATE workspace_connectors SET last_synced_at=$3,last_error=NULL,updated_at=$4,
      config=jsonb_set(config::jsonb,'{syncCadenceStartedAt}',to_jsonb($3::text),true)::text WHERE workspace_id=$1 AND id=$2`,
      [job.workspaceId,connection.id,watermark,at]);
    await c.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
      WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN'`,[job.workspaceId,'connector-stale:'+connection.id,at]);
    return true;
  });
}

function expiredCursor(error){
  const body=error.providerBody?.error;
  const details=[error.message,body?.message,body?.code].filter(Boolean).join(' ');
  return [400,410].includes(error.status)&&/invalid.{0,25}(?:page|skip).{0,15}token|(?:page|skip).{0,15}token.{0,25}(?:expired|invalid)|SyncStateNotFound/iu.test(details);
}

async function run(database,job,connection,provider){
  const outcome=await database.withSessionLock('mailbox-poll:'+job.workspaceId+':'+connection.id,async db=>{
    const window=await begin(db,job,connection);
    if(!window)return {skipped:'mailbox_window_stale'};
    const scope=await entitlements.ownerScopeForWorkspace(db,job.workspaceId);
    const incoming=await require('../commercial/usage-categories').incomingMeter(db,scope);
    if(incoming==='incoming_emails'){
      const {remaining}=await entitlements.meterState(db,scope,incoming);
      if(remaining!==null&&remaining<=0)throw new entitlements.EntitlementError('Incoming email processing has reached the current allowance. Add a pack or upgrade to resume processing.',{meter:incoming});
    }
    let credentials;
    const totals={accepted:0,setAside:0,replayed:0,ignoredOwn:0,checked:0};
    async function accept(message){
      totals.checked++;
      if(message.stockChiefMessageId||String(message.sender||'').toLowerCase()===String(credentials.mailbox||'').toLowerCase()){
        totals.ignoredOwn++;return true;
      }
      const stored=await saveMessage(db,job,connection,message);
      if(!stored)return false;
      if(stored.replayed)totals.replayed++;
      else if(stored.accepted)totals.accepted++;
      else if(stored.setAside)totals.setAside++;
      return true;
    }
    let result;
    try{result=await require('../commercial/operations').run(database,job.workspaceId,{capability:'communications.email_ingestion',
      key:'mailbox-poll:'+job.id,retryReversed:true,operation:'mailbox_poll',provider:connection.provider_type},async()=>{
      credentials=await require('./postgres-provider-service').loadProviderCredentials(database,connection,provider);
      return provider.pollPage({credentials,since:new Date(window.since_at).toISOString(),
        until:new Date(window.until_at).toISOString(),cursor:window.cursor,accept});
    });}catch(error){
      if(error.code==='provider_unavailable')error.retryAfterMs=Math.max(120000,error.retryAfterMs||0);
      if(!window.cursor||!expiredCursor(error)||window.last_cursor_reset_at&&Date.now()-Date.parse(window.last_cursor_reset_at)<300000)throw error;
      const saved=await advance(db,job,connection,window,null,{restart:true});
      return {...totals,continued:saved,restarted:saved};
    }
    if(result.stopped)return {...totals,skipped:'connection_not_active'};
    for(const message of result.messages||[])if(!await accept(message))return {...totals,skipped:'connection_not_active'};
    const saved=await advance(db,job,connection,window,result.next);
    return {...totals,at:nowIso(),continued:Boolean(saved&&result.next),...(saved?{}:{skipped:'mailbox_window_stale'})};
  });
  return outcome.busy?{skipped:'mailbox_check_in_progress'}:outcome;
}

module.exports={run};

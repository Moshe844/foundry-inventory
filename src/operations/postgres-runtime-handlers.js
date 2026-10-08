'use strict';

const { newId,nowIso }=require('../lib/util');
const jobs=require('./postgres-job-queue');
const mail=require('../connections/postgres-mail');
const outboundMail=require('../connections/postgres-outbound-mail');
const providerService=require('../connections/postgres-provider-service');
const providerSync=require('../connections/postgres-provider-sync');
const credentialStore=require('../connections/postgres-credential-store');
const defaultProviders=require('../connections/providers/registry');
const autonomy=require('../autopilot/postgres-service');
const shipping=require('../shipping/postgres-service');
const shippingProviders=require('../shipping/provider');
const payments=require('../payments/postgres-collection');
const accountingSync=require('../accounting/postgres-integration-sync');
const paymentProviders=require('../payments');
const providerEffects=require('./postgres-provider-effects');
const config=require('../config');
const email=require('./email');
const monitoring=require('./postgres-monitoring');
const checkpoints=require('./postgres-checkpoints');
const commercialNotifications=require('../commercial/notifications');
const entitlements=require('../entitlements/postgres-service');

function milliseconds(value){return Number(value || Date.now());}
function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation,options)=>typeof client.transaction==='function'?client.transaction(operation,options):operation(client)};}

async function mailboxPoll(job,client,providers=defaultProviders){
  const connectorId=job.payload?.connectorId;
  if(!job.workspaceId||!connectorId)throw Object.assign(new Error('A mailbox poll needs workspace and connection identity.'),
    {code:'invalid_mailbox_poll',retryable:false});
  const connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
    AND provider_type IN ('gmail','microsoft365') FOR UPDATE`,[job.workspaceId,connectorId])).rows[0];
  if(!connection)return {skipped:'connection_missing'};
  if(connection.status!=='connected'||connection.paused_at)return {skipped:'connection_not_active'};
  const provider=providers.get(connection.provider_type);
  if(!provider?.poll)throw Object.assign(new Error('This mailbox provider has no polling implementation.'),
    {code:'mailbox_poll_unavailable',retryable:false});
  const database=scopedDatabase(client);
  let credentials;
  const result=await require('../commercial/operations').run(database,job.workspaceId,{capability:'communications.email_ingestion',
    key:`mailbox-poll:${job.id}`,retryReversed:true,operation:'mailbox_poll',provider:connection.provider_type},
    async()=>{credentials=await providerService.loadProviderCredentials(database,connection,provider);
      return provider.poll({credentials,since:connection.last_synced_at||connection.created_at});});
  let accepted=0;let setAside=0;let replayed=0;let ignoredOwn=0;
  for(const message of result.messages||[]){
    if(message.stockChiefMessageId||String(message.sender||'').toLowerCase()===String(credentials.mailbox||'').toLowerCase()){
      ignoredOwn+=1;continue;
    }
    const captured=await mail.capture(database,connection,message);
    if(captured.replayed)replayed+=1;
    else if(captured.accepted)accepted+=1;
    else if(captured.setAside)setAside+=1;
  }
  const at=nowIso();
  await client.query(`UPDATE workspace_connectors SET last_synced_at=$3,last_error=NULL,updated_at=$3
    WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,connectorId,at]);
  await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
    WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN'`,[job.workspaceId,`connector-stale:${connectorId}`,at]);
  return {accepted,setAside,replayed,ignoredOwn,checked:(result.messages||[]).length,cursor:result.cursor||null,at};
}

async function mailReplyDraft(job,database,options={}){
  const messageId=job.payload?.messageId;
  const actorId=job.payload?.actorId;
  if(!job.workspaceId||!messageId||!actorId)throw Object.assign(new Error('A mail draft needs workspace, message and owner identity.'),
    {code:'invalid_mail_reply_draft',retryable:false});
  const row=(await database.query(`SELECT reply_state,reply_sent_at,draft_source FROM connection_email_messages
    WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,messageId])).rows[0];
  if(!row)return {skipped:'message_missing'};
  if(row.reply_state!=='NEEDS_REPLY'||row.reply_sent_at)return {skipped:'reply_no_longer_needed'};
  if(row.draft_source==='owner'||row.draft_source==='model')return {skipped:'draft_already_prepared_or_edited'};
  if(!options.aiProvider&&!config.ai.configured)return {skipped:'model_not_configured',holdingDraftRetained:true};
  const scope=await entitlements.ownerScopeForWorkspace(database,job.workspaceId);
  if(!(await entitlements.capabilityState(database,scope,'communications.ai_drafts')).enabled)
    return {skipped:'draft_capability_unavailable',holdingDraftRetained:true};
  try{
    await require('../connections/postgres-reply-drafting').prepare(database,
      {workspaceId:job.workspaceId,actorId},messageId,{provider:options.aiProvider,automatic:true,
        key:`mail-reply:${messageId}:auto:${job.attemptCount}`});
    return {prepared:true,messageId};
  }catch(error){
    if(error.code==='entitlement_required')throw error;
    if(error.code==='validation_error'||error.name==='ValidationError')
      return {skipped:'model_draft_rejected',holdingDraftRetained:true,reason:String(error.message).slice(0,300)};
    throw error;
  }
}

function pushExpiration(providerType,providerCredentials){
  if(providerType==='gmail')return Number(providerCredentials.watchExpiration||0);
  if(providerType==='microsoft365')return Date.parse(providerCredentials.subscriptionExpiresAt||0);
  return 0;
}

function providerCredentialExpiry(providerCredentials){
  const value=Number(providerCredentials.expiresAt||0);
  return Number.isFinite(value)&&value>0?new Date(value).toISOString():null;
}

function mailboxWebhookUrl(providerType,connectorId,publicOrigin){
  const origin=String(publicOrigin||'').replace(/\/$/,'');
  if(!origin.startsWith('https://'))return null;
  return providerType==='gmail'?`${origin}/api/v1/connections/gmail/webhooks`:
    `${origin}/api/v1/connections/microsoft365/webhooks/${encodeURIComponent(connectorId)}`;
}

async function mailboxPushRenewal(job,client,providers=defaultProviders,options={}){
  const connectorId=job.payload?.connectorId;const now=milliseconds(job.payload?.now);
  if(!job.workspaceId||!connectorId)throw Object.assign(new Error('A mailbox push renewal needs workspace and connection identity.'),
    {code:'invalid_mailbox_push_renewal',retryable:false});
  const connection=(await client.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2
    AND provider_type IN ('gmail','microsoft365') FOR UPDATE`,[job.workspaceId,connectorId])).rows[0];
  if(!connection)return {skipped:'connection_missing'};
  if(connection.status!=='connected'||connection.paused_at)return {skipped:'connection_not_active'};
  const provider=providers.get(connection.provider_type);
  if(!provider?.registerWebhooks)return {skipped:'push_not_supported'};
  const database=scopedDatabase(client);
  let providerCredentials=await providerService.loadProviderCredentials(database,connection,provider);
  const expiration=pushExpiration(connection.provider_type,providerCredentials);
  if(providerCredentials.deliveryMode==='push'&&Number.isFinite(expiration)&&expiration>now+12*60*60_000){
    return {renewed:false,healthy:true,expiresAt:expiration};
  }
  const webhookUrl=mailboxWebhookUrl(connection.provider_type,connectorId,
    options.publicOrigin||config.connections.publicOrigin);
  if(!webhookUrl)return {renewed:false,skipped:'public_https_required'};
  const renew=provider.renewWebhooks||provider.registerWebhooks;
  const result=await require('../commercial/operations').run(database,job.workspaceId,{capability:'communications.email_ingestion',
    key:`mailbox-renewal:${job.id}`,retryReversed:true,operation:'push_renewal',provider:connection.provider_type},
    ()=>renew({credentials:providerCredentials,webhookUrl,connection}));
  if(result?.credentials){providerCredentials=result.credentials;
    await credentialStore.put(client,job.workspaceId,connectorId,'provider',providerCredentials,
      result.expiresAt||providerCredentialExpiry(providerCredentials));}
  const at=nowIso();const renewedExpiration=pushExpiration(connection.provider_type,providerCredentials);
  if(providerCredentials.deliveryMode==='push'){
    await client.query(`UPDATE workspace_connectors SET last_error=NULL,updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
      [job.workspaceId,connectorId,at]);
    await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
      WHERE workspace_id=$1 AND fingerprint IN ($2,$4) AND status='OPEN'`,
    [job.workspaceId,`push-setup:${connectorId}`,at,`push-renewal:${connectorId}`]);
  }
  return {renewed:providerCredentials.deliveryMode==='push',deliveryMode:providerCredentials.deliveryMode||'poll',
    expiresAt:Number.isFinite(renewedExpiration)?renewedExpiration:null};
}

async function runtimeSweep(job,client,options={}){
  const now=milliseconds(job.payload?.now);const at=new Date(now).toISOString();
  const staleImportAt=new Date(now-15*60_000).toISOString();
  const staleEmailAt=new Date(now-5*60_000).toISOString();
  const paused=(await client.query(`SELECT * FROM stockchief_runtime.jobs WHERE status='PAUSED'
    AND workspace_id IS NOT NULL ORDER BY updated_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
  for(const pending of paused){const scope=await entitlements.ownerScopeForWorkspace(client,pending.workspace_id);
    const subscription=await entitlements.subscriptionFor(client,scope.accountId);
    if((subscription||config.commercial.requirePaidWorkspace)&&!entitlements.operationalAccess(subscription,new Date(now)).canOperate)continue;
    const detail=pending.last_error?.details||{};
    if(detail.capability&&!(await entitlements.capabilityState(client,scope,detail.capability,{now:at})).enabled)continue;
    if(detail.meter){const balance=await entitlements.meterState(client,scope,detail.meter,{now:at});
      if(balance.remaining!==null&&balance.remaining<Number(detail.additional||detail.units||1))continue;
      if(subscription?.billing_interval!=='CUSTOM'&&balance.periodEnd&&balance.periodEnd<=new Date(now))continue;}
    await client.query(`UPDATE stockchief_runtime.jobs SET status='RETRY',available_at=$2,last_error=NULL,
      updated_at=$3 WHERE id=$1 AND status='PAUSED'`,[pending.id,now,at]);
  }
  await client.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
    SELECT 'stale-reservation:'||id,account_id,'stale-reservation:'||id,'STALE_USAGE_RESERVATION',
      jsonb_build_object('workspaceId',workspace_id,'usageKey',idempotency_key,'reservationRetained',true)
    FROM commercial_usage_events WHERE status='RESERVED' AND occurred_at<$1::timestamptz-interval '30 minutes'
    ON CONFLICT(fingerprint) DO NOTHING`,[at]);
  const sessions=await client.query('DELETE FROM stockchief_runtime.sessions WHERE expires_at <= $1 RETURNING sid',[now]);
  const suspendedSubscriptions=await client.query(`UPDATE account_subscriptions SET status='SUSPENDED',updated_at=now()
    WHERE (status='GRACE' AND grace_ends_at IS NOT NULL AND grace_ends_at<=now())
      OR (status='TRIALING' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now())
    RETURNING account_id,COALESCE(grace_ends_at,trial_ends_at) AS expired_at`);
  for(const subscription of suspendedSubscriptions.rows){
    await commercialNotifications.queueSubscriptionSuspended(scopedDatabase(client),{accountId:subscription.account_id,
      expiredAt:new Date(subscription.expired_at).toISOString()});
  }
  const staleImports=await client.query(`UPDATE import_executions SET status='FAILED',stage='recovered_after_interruption',
    error_message='The process stopped before this import completed. Its inventory transaction did not commit.',finished_at=$2
    WHERE status='EXECUTING' AND started_at<$1 RETURNING workspace_id,import_id,id`,[staleImportAt,at]);
  for(const execution of staleImports.rows){
    await client.query(`UPDATE import_plans SET status='READY' WHERE workspace_id=$1 AND id=$2 AND status='EXECUTING'`,
      [execution.workspace_id,execution.import_id]);
  }
  const uncertainEmails=await client.query(`UPDATE stockchief_runtime.email_reply_outbox
    SET status='AMBIGUOUS',error_message='The process stopped before the mailbox provider outcome was verified.',finished_at=$2
    WHERE status='SENDING' AND started_at<$1 RETURNING id,workspace_id,connector_id,message_id`,[staleEmailAt,at]);
  for(const outbox of uncertainEmails.rows){
    await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,
      fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'EMAIL_SEND_AMBIGUOUS',$5,'Email delivery could not be verified',$6,$7,'OPEN',$8,$8)
      ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,
        updated_at=EXCLUDED.updated_at`,[newId('conissue'),outbox.workspace_id,outbox.connector_id,outbox.message_id,
      `email-send:${outbox.id}`,'The provider may have accepted the reply before StockChief stopped. It was not sent again.',
      'Check the mailbox Sent folder, then mark the conversation appropriately.',at]);
  }
  const staleProviderEffects=await providerEffects.markStaleAmbiguous(client,{olderThanMinutes:5});
  for(const effect of staleProviderEffects.rows){
    if(effect.kind==='shipping.label.purchase'&&effect.payload?.transactionId){
      await client.query(`UPDATE shipping_label_transactions SET status='REVIEW',
        error_message='The worker stopped before the carrier outcome was verified. StockChief did not buy the label again.',
        completed_at=$2,updated_at=$2 WHERE id=$1 AND status='PENDING'`,[effect.payload.transactionId,at]);
    }
    if(effect.kind==='mail.reply.send'&&effect.payload?.outboxId){const recovered=(await client.query(`UPDATE stockchief_runtime.email_reply_outbox
        SET status='AMBIGUOUS',error_message='The worker stopped before the mailbox provider outcome was verified.',finished_at=$2
        WHERE id=$1 AND status IN ('PENDING','SENDING') RETURNING workspace_id,connector_id,message_id`,
      [effect.payload.outboxId,at])).rows[0];
      if(recovered)await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,external_event_id,issue_type,
        fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
        VALUES($1,$2,$3,$4,'EMAIL_SEND_AMBIGUOUS',$5,'Email delivery could not be verified',$6,$7,'OPEN',$8,$8)
        ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at`,
      [newId('conissue'),recovered.workspace_id,recovered.connector_id,recovered.message_id,
        `email-send:${effect.payload.outboxId}`,'The provider may have accepted the reply before StockChief stopped. It was not sent again.',
        'Check the mailbox Sent folder, then mark the conversation appropriately.',at]);
    }
    if(effect.kind==='mail.outbound.send'&&effect.payload?.communicationId){
      const table=effect.payload.communicationKind==='supplier'?'supplier_communications':'customer_communications';
      await client.query(`UPDATE ${table} SET status='FAILED',
        error_message='The worker stopped before the mailbox provider outcome was verified. StockChief did not send the message again.',
        updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status IN ('QUEUED','SENDING')`,
      [effect.workspace_id,effect.payload.communicationId,at]);
    }
    if(effect.kind==='payment.request.create'&&effect.payload?.requestId){
      await client.query(`UPDATE payment_requests SET status='REVIEW',
        last_error='The worker stopped before the payment provider outcome was verified. StockChief did not create another request.',
        updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,
      [effect.workspace_id,effect.payload.requestId,at]);
    }
    if(effect.kind==='payment.refund.create'&&effect.payload?.refundRequestId){
      await client.query(`UPDATE payment_refund_requests SET status='REVIEW',
        last_error='The worker stopped before the refund outcome was verified. StockChief did not refund again.',
        updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,
      [effect.workspace_id,effect.payload.refundRequestId,at]);
    }
  }
  const connectors=(await client.query(`SELECT id,workspace_id,display_name,provider_type,expected_interval_minutes,
      GREATEST(COALESCE(last_activity_at,''),COALESCE(last_synced_at,''),created_at) AS evidence_at,
      last_synced_at,created_at,status,paused_at
    FROM workspace_connectors WHERE status='connected' AND paused_at IS NULL AND expected_interval_minutes>0`)).rows;
  let staleConnectors=0;let recoveredConnectors=0;let scheduledMailboxPolls=0;let scheduledMailboxRenewals=0;
  for(const connector of connectors){
    const fingerprint=`connector-stale:${connector.id}`;
    const grace=['gmail','microsoft365'].includes(connector.provider_type)?2:1;
    const stale=Date.parse(connector.evidence_at)+Number(connector.expected_interval_minutes)*grace*60_000<now;
    if(stale){
      staleConnectors+=1;
      await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,
        resolution_hint,status,created_at,updated_at) VALUES($1,$2,$3,'stale_connection',$4,$5,$6,$7,'OPEN',$8,$8)
        ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,
          resolution_hint=EXCLUDED.resolution_hint,updated_at=EXCLUDED.updated_at`,
      [newId('conissue'),connector.workspace_id,connector.id,fingerprint,`${connector.display_name} stopped updating`,
        `The last verified activity was ${connector.evidence_at}. StockChief no longer claims this source is current.`,
        `Reconnect ${connector.provider_type} or confirm the source should stay paused.`,at]);
    } else {
      const resolved=await client.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
        WHERE workspace_id=$1 AND fingerprint=$2 AND status='OPEN' RETURNING id`,[connector.workspace_id,fingerprint,at]);
      recoveredConnectors+=resolved.rowCount;
    }
    if(['gmail','microsoft365'].includes(connector.provider_type)){
      if(config.commercial.requirePaidWorkspace){const commercialAccess=await entitlements.operationalAccessForWorkspace(
        scopedDatabase(client),connector.workspace_id,{now:at});if(!commercialAccess.access.canOperate)continue;}
      const renewalBucket=Math.floor(now/(6*60*60_000));
      const renewalActive=await client.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1
        AND kind='mailbox.renew-push' AND payload->>'connectorId'=$2 AND status IN ('PENDING','RUNNING','RETRY') LIMIT 1`,
      [connector.workspace_id,connector.id]);
      if(!renewalActive.rows.length){
        const renewal=await jobs.enqueue(scopedDatabase(client),{workspaceId:connector.workspace_id,kind:'mailbox.renew-push',
          idempotencyKey:`mailbox-renew-push:${connector.id}:${renewalBucket}`,payload:{connectorId:connector.id,now},
          priority:35,maxAttempts:5,availableAt:now,now});
        if(renewal.created)scheduledMailboxRenewals+=1;
      }
      const intervalMs=Number(connector.expected_interval_minutes)*60_000;
      const due=Date.parse(connector.last_synced_at||connector.created_at)+intervalMs<=now;
      const active=await client.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1
        AND kind='mailbox.poll' AND payload->>'connectorId'=$2 AND status IN ('PENDING','RUNNING','RETRY') LIMIT 1`,
      [connector.workspace_id,connector.id]);
      if(due&&!active.rows.length){
        const bucket=Math.floor(now/intervalMs);
        const scheduled=await jobs.enqueue(scopedDatabase(client),{workspaceId:connector.workspace_id,kind:'mailbox.poll',
          idempotencyKey:`mailbox-poll:${connector.id}:${bucket}`,payload:{connectorId:connector.id},priority:30,
          maxAttempts:5,availableAt:now,now});
        if(scheduled.created)scheduledMailboxPolls+=1;
      }
    }
  }
  let scheduledAlertDeliveries=0;
  const alertWebhookUrl=options.alertWebhookUrl===undefined?config.operations.alertWebhookUrl:options.alertWebhookUrl;
  if(alertWebhookUrl){const alerts=(await client.query(`SELECT id,workspace_id,occurrence_count FROM operational_alerts
      WHERE status='OPEN' ORDER BY first_seen_at,id LIMIT 100`)).rows;
    for(const alert of alerts){const scheduled=await jobs.enqueue(scopedDatabase(client),{workspaceId:alert.workspace_id,
      kind:'system.alert-delivery',idempotencyKey:`alert-delivery:${alert.id}:${alert.occurrence_count}`,
      payload:{alertId:alert.id},priority:5,maxAttempts:8,availableAt:now,now});
      if(scheduled.created)scheduledAlertDeliveries+=1;}}
  const billingFilter=config.commercial.requirePaidWorkspace?`AND EXISTS(SELECT 1 FROM account_subscriptions subscription
      WHERE subscription.account_id=w.owner_account_id AND (subscription.status IN ('ACTIVE','COMP')
        OR (subscription.status='TRIALING' AND (subscription.trial_ends_at IS NULL OR subscription.trial_ends_at>now()))
        OR (subscription.status='GRACE' AND (subscription.grace_ends_at IS NULL OR subscription.grace_ends_at>now()))
        OR (subscription.status='CANCELLED' AND subscription.current_period_end>now())))`:'';
  const autonomyDue=(await client.query(`SELECT w.id AS workspace_id,u.id AS actor_id
    FROM workspaces w JOIN LATERAL (SELECT id FROM users WHERE workspace_id=w.id AND role='owner' ORDER BY created_at,id LIMIT 1) u ON true
    LEFT JOIN workspace_autopilot a ON a.workspace_id=w.id
    WHERE COALESCE(a.paused,0)=0 AND COALESCE(a.suspended,0)=0
      ${billingFilter}
      AND (a.next_evaluation_at IS NULL OR a.next_evaluation_at<=$1)`,[at])).rows;
  let scheduledAutopilotChecks=0;
  for(const due of autonomyDue){
    const bucket=Math.floor(now/(15*60_000));
    const scheduled=await jobs.enqueue(scopedDatabase(client),{workspaceId:due.workspace_id,kind:'autopilot.evaluate',
      idempotencyKey:`autopilot-evaluate:${due.workspace_id}:${bucket}`,payload:{actorId:due.actor_id},priority:40,
      maxAttempts:3,availableAt:now,now});
    if(scheduled.created)scheduledAutopilotChecks+=1;
  }
  const stockAlerts=await require('../manager/postgres-stock-threshold-alerts').evaluate(client);
  return {expiredSessions:sessions.rowCount,suspendedSubscriptions:suspendedSubscriptions.rowCount,recoveredImports:staleImports.rowCount,
    ambiguousEmails:uncertainEmails.rowCount,ambiguousProviderEffects:staleProviderEffects.rowCount,
    staleConnectors,recoveredConnectors,scheduledMailboxPolls,
    scheduledMailboxRenewals,scheduledAlertDeliveries,scheduledAutopilotChecks,stockAlerts,at};
}

async function autopilotEvaluate(job,client){
  if(!job.workspaceId||!job.payload?.actorId)throw Object.assign(new Error('An autopilot evaluation needs workspace and owner identity.'),
    {code:'invalid_autopilot_evaluation',retryable:false});
  const scope=await entitlements.ownerScopeForWorkspace(client,job.workspaceId);
  const subscription=await entitlements.subscriptionFor(client,scope.accountId);
  if((subscription||config.commercial.requirePaidWorkspace)&&!entitlements.operationalAccess(subscription).canOperate)
    return {skipped:'subscription_read_only'};
  return autonomy.run(scopedDatabase(client),{workspaceId:job.workspaceId,actorId:job.payload.actorId});
}

function external(handler){handler.externalEffect=true;return handler;}

async function providerEffect(job,database,options={},providers=defaultProviders){
  const effectId=job.payload?.effectId;
  if(!job.workspaceId||!effectId)throw Object.assign(new Error('A provider job needs workspace and effect identity.'),
    {code:'invalid_provider_effect',retryable:false});
  const effect=await providerEffects.get(database,job.workspaceId,effectId);
  const capability={'shipping.label.purchase':'shipping.labels','mail.reply.send':'communications.send_approved',
    'mail.outbound.send':'communications.send_approved','payment.request.create':'payments.customer',
    'payment.refund.create':'payments.customer','accounting.journal.export':'accounting.post_connected'}[effect.kind];
  if(capability&&effect.status==='PENDING'){
    const scope=await entitlements.ownerScopeForWorkspace(database,job.workspaceId);
    await entitlements.assertCapability(database,scope,capability);
    const budget=await entitlements.meterState(database,scope,'connected_operations');
    if(budget.remaining!==null&&budget.remaining<1)throw new entitlements.EntitlementError(
      'Connected Operations are exhausted. This pending operation is paused.',{meter:'connected_operations',units:1,capability});
  }
  if(effect.kind==='shipping.label.purchase')return shipping.executeLabelPurchaseEffect(database,job.workspaceId,effectId,{
    provider:options.shippingProviderResolver?options.shippingProviderResolver(effect.provider):shippingProviders.get(effect.provider),
  });
  if(effect.kind==='mail.reply.send')return mail.executeSendEffect(database,job.workspaceId,effectId,{provider:providers.get(effect.provider)});
  if(effect.kind==='mail.outbound.send')return outboundMail.executeSendEffect(database,job.workspaceId,effectId,{provider:providers.get(effect.provider)});
  if(effect.kind==='payment.request.create')return payments.executeRequestEffect(database,job.workspaceId,effectId,{
    provider:options.paymentProviderResolver?options.paymentProviderResolver(effect.provider):paymentProviders.get(effect.provider),
    accountContext:options.paymentAccountContext,
  });
  if(effect.kind==='payment.refund.create')return payments.executeRefundEffect(database,job.workspaceId,effectId,{
    provider:options.paymentProviderResolver?options.paymentProviderResolver(effect.provider):paymentProviders.get(effect.provider),
    accountContext:options.paymentAccountContext,
  });
  if(effect.kind==='accounting.journal.export')return accountingSync.executeExportEffect(database,job.workspaceId,effectId,{
    provider:options.accountingProviderResolver?options.accountingProviderResolver(effect.provider):providers.get(effect.provider),
    credentials:options.accountingCredentials,
  });
  throw Object.assign(new Error(`No provider-effect handler is registered for ${effect.kind}.`),
    {code:'provider_effect_handler_missing',retryable:false});
}

async function alertDelivery(job,database,options={}){
  if(!job.payload?.alertId)throw Object.assign(new Error('An alert delivery needs alert identity.'),
    {code:'invalid_alert_delivery',retryable:false});
  return monitoring.deliver(database,job.workspaceId,job.payload.alertId,{url:options.alertWebhookUrl,
    token:options.alertWebhookToken,publicOrigin:options.publicOrigin,fetch:options.fetch});
}

async function systemEmail(job,database,options={}){
  const message=email.unseal(job.payload);const sender=options.emailSender||email.sendResend;
  const accountId=job.payload?.accountId||(await database.query('SELECT id FROM accounts WHERE lower(email)=lower($1)',[message.to])).rows[0]?.id;
  const recordAttempt=attempt=>require('../commercial/control-service').recordCost(database,{accountId:accountId||null},{provider:'resend',operation:'system_email',
    unit:'message',quantity:1,idempotencyKey:`${job.id}:attempt:${attempt}`,detail:{messageType:job.payload?.messageType}});
  const accepted=async result=>{
    if(job.payload?.messageType==='password_reset')await checkpoints.record(database,'password_recovery.delivery','PASS',{
      provider:result.provider||'configured',externalId:result.externalId||null,releaseRef:config.operations.releaseRef});
    return result;
  };
  const digest=require('node:crypto').createHash('sha256').update(JSON.stringify({message,
    from:options.emailOptions?.from||config.email.from})).digest('hex');
  await database.query(`INSERT INTO commercial_email_deliveries(job_id,payload_sha256) VALUES($1,$2)
    ON CONFLICT(job_id) DO NOTHING`,[job.id,digest]);
  const receipt=(await database.query(`SELECT *,first_attempt_at>now()-interval '23 hours' AS retry_safe
    FROM commercial_email_deliveries WHERE job_id=$1`,[job.id])).rows[0];
  if(receipt.payload_sha256!==digest)throw Object.assign(new Error('The durable email payload changed; delivery needs review.'),
    {code:'email_payload_changed',retryable:false});
  if(receipt.provider_id){await recordAttempt(receipt.accepted_attempt);return accepted({provider:'resend',externalId:receipt.provider_id,replayed:true});}
  if(!receipt.retry_safe){
    await database.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
      VALUES($1,$2,$3,'EMAIL_DELIVERY_RECONCILIATION_REQUIRED',$4::jsonb)
      ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN'`,
    [require('../lib/util').newId('critical'),accountId||null,`email-delivery:${job.id}`,
      JSON.stringify({jobId:job.id,reason:'Provider idempotency window expired; no automatic resend.'})]);
    throw Object.assign(new Error('Email acceptance is uncertain and the retry window expired. Reconcile before resending.'),
      {code:'email_delivery_uncertain',retryable:false});
  }
  let result;try{result=await sender(message,{...options.emailOptions,idempotencyKey:`stockchief-email:${job.id}`});
    if(!result.externalId)throw Object.assign(new Error('Email provider did not return an acceptance identity.'),{retryable:true});
    await database.query('UPDATE commercial_email_deliveries SET provider_id=$2,accepted_at=now(),accepted_attempt=$3 WHERE job_id=$1',
      [job.id,result.externalId,job.attemptCount||1]);
  }finally{
    await recordAttempt(job.attemptCount||1);}
  return accepted(result);
}

function create(providers=defaultProviders,options={}){return {'system.runtime-sweep':(job,client)=>runtimeSweep(job,client,options),
  'shipping.quote':external(async(job,database)=>{
    const {shipmentId,actorId,fingerprint,provider}=job.payload||{};
    if(!job.workspaceId||!shipmentId||!actorId||!fingerprint||!provider)throw Object.assign(
      new Error('Carrier-rate job is missing its frozen parcel identity.'),
      {code:'shipping_quote_job_invalid',retryable:false});
    const view=await shipping.state(database,job.workspaceId,shipmentId);
    if(!view.ready||view.account?.provider!==provider||shipping.quoteFingerprint(view)!==fingerprint||
      !['PICKING','PACKED'].includes(view.shipment.status))throw Object.assign(
      new Error('Parcel details changed after carrier rates were approved. Request fresh rates.'),
      {code:'shipping_quote_changed',retryable:false});
    const quoted=await shipping.quote(database,{workspaceId:job.workspaceId,actorId},shipmentId,
      {idempotencyKey:job.idempotencyKey,
        provider:options.shippingProviderResolver?options.shippingProviderResolver(provider):shippingProviders.get(provider)});
    return {shipmentId,rateCount:quoted.rates?.length||0};
  }),
  'import.execute-approved':external(async(job,database)=>{
    const {planId,actorId,integrityHash}=job.payload||{};
    if(!job.workspaceId||!planId||!actorId||!integrityHash)throw Object.assign(
      new Error('Approved import job is missing its frozen plan identity.'),
      {code:'import_job_invalid',retryable:false});
    const plan=(await database.query(`SELECT integrity_hash,approval_status,status FROM import_plans
      WHERE workspace_id=$1 AND id=$2`,[job.workspaceId,planId])).rows[0];
    if(!plan||plan.integrity_hash!==integrityHash||plan.approval_status!=='APPROVED')
      throw Object.assign(new Error('The approved import changed after it was queued.'),
        {code:'import_approval_changed',retryable:false});
    return require('../imports/postgres-service').execute(database,
      {workspaceId:job.workspaceId,actorId},planId);
  }),
  'system.alert-delivery':external((job,database)=>alertDelivery(job,database,options)),
  'system.email-send':external((job,database)=>systemEmail(job,database,options)),
  'mailbox.poll':external((job,database)=>mailboxPoll(job,database,providers)),
  'mail.reply-draft':external((job,database)=>mailReplyDraft(job,database,options)),
  'mailbox.renew-push':external((job,database)=>mailboxPushRenewal(job,database,providers,options)),
  'provider.catalog-sync':external((job,database)=>providerSync.sync(job,database,providers)),
  'commercial.auto-top-up':external((job,database)=>require('../commercial/addons').runTopup(database,
    {accountId:job.payload.accountId,workspaceId:job.workspaceId},job.payload.category,options.commercialOptions||{})),
  'commercial.stripe-financial-sync':external((job,database)=>require('../commercial/stripe-financials').sync(database,job,options.commercialOptions||{})),
    'commercial.stripe-invoice-sync':external((job,database)=>require('../commercial/stripe-financials').syncInvoice(database,job,options.commercialOptions||{})),
  'provider.effect':external((job,database)=>providerEffect(job,database,options,providers)),
  'autopilot.evaluate':autopilotEvaluate};}

module.exports={create,runtimeSweep,mailboxPoll,mailReplyDraft,mailboxPushRenewal,mailboxWebhookUrl,pushExpiration,autopilotEvaluate,
  providerEffect,alertDelivery,systemEmail};

'use strict';

const { ValidationError } = require('../domain/errors');
const effects = require('../operations/postgres-provider-effects');
const { nowIso } = require('../lib/util');

function confirmedSql(message = 'm', effect = 'e') {
  return `${message}.status='SENT' AND ${effect}.status='SUCCEEDED'
    AND nullif(btrim(${message}.external_message_id),'') IS NOT NULL
    AND ${message}.external_message_id NOT LIKE 'm365:%'
    AND ${effect}.result->>'externalMessageId'=${message}.external_message_id
    AND ${effect}.payload->'standingAuthority'->>'recordId'=${message}.invoice_dispute_bill_id`;
}

function confirmedIdentity(result) {
  return typeof result?.externalMessageId === 'string' && Boolean(result.externalMessageId.trim())
    && !result.externalMessageId.startsWith('m365:');
}

async function recover(database, workspaceId, effectId) {
  const row = (await database.query(`SELECT e.id,e.aggregate_id,e.payload,e.provider_reference,
      m.recipient,c.id connector_id,c.provider_account_id,c.status,c.paused_at
    FROM stockchief_runtime.provider_effects e JOIN supplier_communications m
      ON m.workspace_id=e.workspace_id AND m.id=e.aggregate_id
    JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    WHERE e.workspace_id=$1 AND e.id=$2 AND e.kind='mail.outbound.send' AND e.provider='microsoft365'
      AND e.status='AMBIGUOUS' AND e.payload->'standingAuthority'->>'kind'='invoice_dispute'`,[workspaceId,effectId])).rows[0];
  if (!row) return { skipped:'no_uncertain_dispute' };
  const grant = row.payload.standingAuthority;
  await require('./agent-supplier-invoice-intake').owner(database,{workspaceId,actorId:grant.actorId});
  await require('../commercial/agent-plan').requireWorkspaceJob(database,workspaceId,100,'draft');
  if (row.status !== 'connected' || row.paused_at || row.provider_account_id !== grant.mailboxAccount
      || row.provider_reference?.externalId !== row.aggregate_id || !row.provider_reference?.lookupFrom) {
    return { skipped:'mailbox_evidence_unavailable' };
  }
  const claim = await effects.claimVerification(database,workspaceId,effectId,'mail.outbound.send');
  if (claim.replayed) return { verified:true,replayed:true };
  const { claimToken } = claim.effect;
  try {
    const connection=(await database.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[workspaceId,row.connector_id])).rows[0];
    if (!connection || connection.status!=='connected' || connection.paused_at || connection.provider_account_id!==grant.mailboxAccount) {
      throw new ValidationError('Reconnect the original mailbox to check Sent Items.');
    }
    const provider=require('../connections/providers/microsoft365');
    const credentials=await require('../connections/postgres-provider-service').loadProviderCredentials(database,connection,provider);
    const result=await provider.findSent({credentials,id:row.aggregate_id,recipient:row.recipient,since:row.provider_reference.lookupFrom});
    if (!confirmedIdentity(result) || !result.externalThreadId) throw new ValidationError('Microsoft Sent Items does not yet verify this dispute.');
    await effects.succeed(database,workspaceId,effectId,claimToken,{providerReference:{messageId:result.externalMessageId},result,apply:async db=>{
      const at=nowIso();
      await db.query(`UPDATE supplier_communications SET status='SENT',external_message_id=$3,external_thread_id=$4,
        error_message=NULL,sent_at=$5,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
      [workspaceId,row.aggregate_id,result.externalMessageId,result.externalThreadId,result.sentAt||at]);
      await db.query(`UPDATE connection_issues SET status='RESOLVED',resolved_at=$3,updated_at=$3
        WHERE workspace_id=$1 AND fingerprint=$2`,[workspaceId,'email-send:'+effectId,at]);
    }});
    return { verified:true };
  } catch (error) {
    // Verification is read-only at the provider. Restore the uncertain claim
    // when the provider still cannot prove which message went out.
    await effects.finishError(database,workspaceId,effectId,claimToken,
      Object.assign(new Error(error.message),{code:'invoice_dispute_delivery_unverified'}),{ambiguous:true});
    return { verified:false };
  }
}

module.exports = { confirmedSql,confirmedIdentity,recover };

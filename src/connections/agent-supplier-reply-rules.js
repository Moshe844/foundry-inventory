'use strict';

const { createHash } = require('node:crypto');
const { has } = require('../db/schema-installed');
const { newId } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const policy = require('../commercial/agent-plan');

const job = 89;
const table = 'stockchief_runtime.agent_supplier_reply_rules';
const questionText = body => require('../accounting/statement-request').own(body).trim();
const signature = (message, subject, body) => createHash('sha256').update(JSON.stringify([
  String(message.subject || '').trim(),questionText(message.body_text),String(subject).trim(),String(body).trim(),
])).digest('hex');

async function samples(db, ctx, exampleId = null) {
  const rows = (await db.query(`SELECT m.id,m.subject,m.body_text,o.subject AS reply_subject,o.body AS reply_body,
    b.id AS connector_id,b.display_name AS mailbox,b.provider_account_id,o.recipient,s.id AS supplier_id,s.name AS supplier
    FROM connection_email_messages m JOIN stockchief_runtime.email_reply_outbox o
      ON o.workspace_id=m.workspace_id AND o.message_id=m.id AND o.connector_id=m.connector_id
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id
      AND e.kind='mail.reply.send' AND e.status='SUCCEEDED' AND e.payload->>'outboxId'=o.id
    JOIN workspace_connectors b ON b.workspace_id=m.workspace_id AND b.id=m.connector_id
    JOIN suppliers s ON s.workspace_id=m.workspace_id AND s.id=m.supplier_id AND s.status='active' AND lower(s.email)=lower(o.recipient)
    WHERE m.workspace_id=$1 AND e.requested_by_user_id=$2 AND NOT(e.payload ? 'agentJob')
      AND e.payload->>'trainingMailboxAccount'=b.provider_account_id
      AND m.classification='supplier' AND m.trust_status='TRUSTED' AND lower(m.sender)=lower(o.recipient)
      AND o.status='SENT' AND o.provider_message_id IS NOT NULL AND b.provider_account_id IS NOT NULL
      AND b.status='connected' AND b.paused_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM connection_email_attachments a WHERE a.workspace_id=m.workspace_id AND a.message_id=m.id)
      AND ($3::text IS NULL OR m.id=$3)
    ORDER BY o.finished_at DESC,m.id LIMIT 30`,[ctx.workspaceId,ctx.actorId,exampleId])).rows;
  const { MONEY, COMMITMENT } = require('./agent-mail-replies');
  return rows.filter(sample => {
    const question = questionText(sample.body_text);
    const text = [sample.subject,question,sample.reply_subject,sample.reply_body].join('\n');
    return question.length > 0 && !MONEY.test(text) && !COMMITMENT.test(text);
  });
}

async function matchingRule(db, workspaceId, message, supplierId) {
  if (!await has(db,table)) return null;
  const result = await db.query(`SELECT r.id,r.connector_id FROM ${table} r
    JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id AND s.status='active'
    JOIN workspace_connectors b ON b.workspace_id=r.workspace_id AND b.id=r.connector_id
    JOIN workspaces w ON w.id=r.workspace_id
    JOIN users u ON u.workspace_id=w.id AND u.id=r.approved_by AND u.account_id=w.owner_account_id AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.supplier_id=$2 AND r.connector_id=$3 AND r.recipient=$4 AND r.signature=$5
      AND lower(s.email)=lower(r.recipient) AND b.provider_account_id=r.mailbox_account AND r.enabled
      AND w.deletion_requested_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,
  [workspaceId,supplierId,message.connector_id,message.sender.toLowerCase(),signature(message,message.draft_subject,message.draft_body)]);
  return result.rows[0] || null;
}

async function read(db, ctx, { teaching }) {
  if (!await has(db,table)) return null;
  const rules = (await db.query(`SELECT r.id,r.example_id,s.name AS supplier,m.subject
    FROM ${table} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    JOIN connection_email_messages m ON m.workspace_id=r.workspace_id AND m.id=r.example_id
    WHERE r.workspace_id=$1 AND r.enabled ORDER BY s.name,m.subject,r.id LIMIT 100`,[ctx.workspaceId])).rows;
  return teaching||rules.length?{rules,examples:teaching?await samples(db,ctx):[],teaching}:null;
}

async function save(db, ctx, form) {
  return db.transaction(async client => {
    await require('../purchasing/agent-supplier-delivery-chases').owner(client,ctx,{lock:true});
    const state=await policy.requireWorkspaceJob(client,ctx.workspaceId,job,'draft');
    if (form.stop) {
      const stopped=await client.query(`UPDATE ${table} SET enabled=false WHERE workspace_id=$1 AND id=$2 AND enabled`,[ctx.workspaceId,form.stop]);
      if(stopped.rowCount)await require('../operations/postgres-security-audit').record(client,ctx,{
        action:'Exact supplier reply rule stopped',reference:form.stop,
      });
      return {message:'Supplier reply rule stopped.'};
    }
    if (state.plan!=='growth') throw new ValidationError('Teaching exact supplier replies is for the Growth plan.');
    const [sample] = await samples(client,ctx,String(form.exampleId || ''));
    if (!sample || form.exampleId !== sample.id) {
      throw new ValidationError('Choose a supplier reply you personally sent and the mailbox confirmed.');
    }
    const key=signature(sample,sample.reply_subject,sample.reply_body);
    const values=[ctx.workspaceId,sample.supplier_id,sample.connector_id,sample.provider_account_id,sample.recipient.toLowerCase(),key];
    const prior=(await client.query(`SELECT id,enabled FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2
      AND connector_id=$3 AND mailbox_account=$4 AND recipient=$5 AND signature=$6 FOR UPDATE`,values)).rows[0];
    if (prior?.enabled) return {message:'This exact supplier reply rule is already active.'};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(client,ctx,[],1);
    const id = prior?.id || newId('supplier-reply-rule');
    if (!prior) await require('../commercial/storage-capacity').reserve(client,ctx.workspaceId,'supplier-reply-rule:'+id,4096,{finished:true});
    await client.query(`INSERT INTO ${table}(workspace_id,supplier_id,connector_id,mailbox_account,recipient,signature,id,example_id,approved_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(workspace_id,id) DO UPDATE SET enabled=true,example_id=EXCLUDED.example_id,approved_by=EXCLUDED.approved_by`,
    [...values,id,sample.id,ctx.actorId]);
    await require('../operations/postgres-security-audit').record(client,ctx,{
      action:'Exact supplier reply taught',reference:id,after:{supplierId:sample.supplier_id,exampleId:sample.id},
    });
    return {message:'Supplier reply rule saved.'};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports = { job,matchingRule,read,save };

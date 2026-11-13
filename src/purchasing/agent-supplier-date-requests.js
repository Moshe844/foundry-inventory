'use strict';

const policy = require('../commercial/agent-plan');
const { newId } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { owner, contact } = require('./agent-supplier-delivery-chases');

const job = 89;
const phase = 'supplier_delivery_date_missing';
const path = '/autopilot/supplier-date-requests';
const table = 'stockchief_runtime.agent_supplier_date_request_rules';

async function activeRule(db, workspaceId, supplierId) {
  if (!await require('../db/schema-installed').has(db, table)) return null;
  return (await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2 AND enabled`,
    [workspaceId, supplierId])).rows[0] || null;
}

async function examples(db, ctx, supplierId, id = null) {
  return (await db.query(`SELECT m.id,m.connector_id,m.recipient,p.po_number,b.display_name,
      e.payload->'standingAuthority'->>'mailboxAccount' AS mailbox_account
    FROM supplier_communications m
    JOIN purchase_orders p ON p.workspace_id=m.workspace_id AND p.id=m.purchase_order_id
    JOIN workspace_connectors b ON b.workspace_id=m.workspace_id AND b.id=m.connector_id
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id
      AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
    WHERE m.workspace_id=$1 AND m.supplier_id=$2 AND m.approved_by_user_id=$3
      AND m.status='SENT' AND m.external_message_id IS NOT NULL
      AND e.payload->'standingAuthority'->>'kind'='purchase_followup'
      AND e.payload->'standingAuthority'->>'manual'='true'
      AND e.payload->'standingAuthority'->>'phase'=$4
      AND ($5::text IS NULL OR m.id=$5)
    ORDER BY m.sent_at DESC,m.id LIMIT 50`, [ctx.workspaceId, supplierId, ctx.actorId, phase, id])).rows;
}

async function matchesExample(db, ctx, id, supplierId, delivery) {
  if (!id) return false;
  const [sample] = await examples(db, ctx, supplierId, id);
  return Boolean(sample && sample.connector_id === delivery.mailbox.id && sample.recipient === delivery.supplier.email
    && sample.mailbox_account === delivery.mailbox.provider_account_id);
}

async function priorContact(db, workspaceId, order, delivery) {
  return (await db.query(`SELECT 1 FROM supplier_communications m
    WHERE m.workspace_id=$1 AND m.purchase_order_id=$2 AND m.supplier_id=$3 AND m.connector_id=$4
      AND lower(m.recipient)=lower($5) AND m.status='SENT' AND nullif(m.external_message_id,'') IS NOT NULL
      AND (m.message_kind='purchase_order' OR EXISTS(
        SELECT 1 FROM stockchief_runtime.provider_effects e
        WHERE e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
          AND e.status='SUCCEEDED' AND NOT(e.payload ? 'standingAuthority'))) LIMIT 1`,
  [workspaceId, order.id, order.supplier_id, delivery.mailbox.id, delivery.supplier.email])).rowCount > 0;
}

async function authority(db, workspaceId, scope, order) {
  const rule = await activeRule(db, workspaceId, order.supplier_id);
  if (!rule || rule.id !== scope.ruleId || rule.revision !== scope.ruleRevision || rule.connector_id !== scope.connectorId
      || rule.recipient !== scope.recipientEmail || order.delivery_kind !== 'WAREHOUSE' || !order.ordered_at
      || !['ORDERED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
    throw new ValidationError('The supplier date request rule or purchase changed. Review the current order.');
  }
  const ctx = { workspaceId, actorId: rule.authorized_by };
  await owner(db, ctx);
  const delivery = await contact(db, workspaceId, order.supplier_id, rule.connector_id);
  if (!delivery.ready || delivery.supplier.email !== rule.recipient || delivery.mailbox.provider_account_id !== rule.mailbox_account) {
    throw new ValidationError('The authorized supplier address or mailbox changed. Review the date request rule.');
  }
  const state = await policy.accountState(db, workspaceId);
  const trained = state.plan !== 'growth' || await matchesExample(db, ctx, rule.example_id, order.supplier_id, delivery);
  await policy.requireWorkspaceJob(db, workspaceId, job, 'automatic', { trained });
  if (!await priorContact(db, workspaceId, order, delivery)) {
    throw new ValidationError('Send a message about this purchase from this mailbox before StockChief asks for its date automatically.');
  }
  return { delivery, options: { maximum: 1, intervalHours: 24 } };
}

async function configure(db, ctx, input) {
  return db.transaction(async client => {
    await owner(client, ctx, { lock: true });
    const current = (await client.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2 FOR UPDATE`,
      [ctx.workspaceId, String(input.supplierId || '')])).rows[0];
    if (current && current.revision !== Number(input.revision)) throw new ValidationError('Reload the current supplier rule before changing it.');
    if (input.stop === 'yes') {
      if (!current) throw new NotFoundError('Choose the supplier date request rule to stop.');
      await client.query(`UPDATE ${table} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [ctx.workspaceId, current.id]);
      await require('../operations/postgres-security-audit').record(client, ctx, { action: 'Supplier date requests stopped', reference: current.id });
      return { stopped: true };
    }
    const state = await policy.requireWorkspaceJob(client, ctx.workspaceId, job, 'draft');
    const delivery = await contact(client, ctx.workspaceId, String(input.supplierId || ''), String(input.connectorId || ''));
    if (!delivery.ready) throw new ValidationError(delivery.reason);
    if (input.confirmed !== 'yes' || input.expectedRecipient !== delivery.supplier.email) {
      throw new ValidationError('Confirm the current supplier address, mailbox and one request per purchase.');
    }
    const exampleId = String(input.exampleId || '').trim() || null;
    const trained = await matchesExample(client, ctx, exampleId, delivery.supplier.id, delivery);
    policy.requireJob(state.plan, job, 'automatic', { trained });
    if (exampleId && !trained) throw new ValidationError('Choose an approved example sent to this supplier from this mailbox.');
    const id = current?.id || newId('supplier-date-rule');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(client, ctx, [], current?.enabled ? 0 : 1);
    if (!current) await require('../commercial/storage-capacity').reserve(client, ctx.workspaceId, 'supplier-date-rule:'+id, 4096, { finished:true });
    await client.query(`INSERT INTO ${table} AS rule (workspace_id,id,supplier_id,connector_id,authorized_by,recipient,mailbox_account,example_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,supplier_id) DO UPDATE
      SET connector_id=EXCLUDED.connector_id,authorized_by=EXCLUDED.authorized_by,recipient=EXCLUDED.recipient,
      mailbox_account=EXCLUDED.mailbox_account,example_id=EXCLUDED.example_id,enabled=true,revision=rule.revision+1`,
    [ctx.workspaceId,id,delivery.supplier.id,delivery.mailbox.id,ctx.actorId,delivery.supplier.email,delivery.mailbox.provider_account_id,exampleId]);
    await require('../operations/postgres-security-audit').record(client, ctx, { action:'Supplier date requests authorized', reference:id,
      after:{supplierId:delivery.supplier.id,connectorId:delivery.mailbox.id,recipient:delivery.supplier.email,exampleId} });
    return { id };
  }, { isolation:'SERIALIZABLE', retrySafe:true });
}

async function page(db, ctx, { supplierId = '', supplierName = '' } = {}) {
  await owner(db, ctx);
  const state = await policy.accountState(db, ctx.workspaceId);
  const allowed = policy.usesAgentTerms(state) && policy.permits(state.plan, job, 'draft');
  if (!allowed) return { allowed };
  const choices = (await db.query(`SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND status='active'
    AND ($2<>'' AND id=$2 OR $2='' AND $3<>'' AND lower(name)=lower($3)) ORDER BY id LIMIT 2`,
  [ctx.workspaceId, String(supplierId).slice(0,240), String(supplierName).trim().slice(0,240)])).rows;
  const supplier = choices.length === 1 ? choices[0] : null;
  const rules = (await db.query(`SELECT r.*,s.name FROM ${table} r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    WHERE r.workspace_id=$1 ORDER BY s.name,r.id LIMIT 100`, [ctx.workspaceId])).rows;
  const current = supplier ? (await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND supplier_id=$2`, [ctx.workspaceId,supplier.id])).rows[0] : null;
  const samples = supplier ? await examples(db,ctx,supplier.id) : [];
  const mailboxes = supplier ? await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId) : [];
  return { allowed, supplier, rules, current, samples, mailboxes, plan:state.plan, path, missing:Boolean(!supplier&&(supplierId||supplierName)) };
}

const definition = { id:job, key:'supplier-date-requests', label:'Email suppliers about purchase dates',
  readPage:async()=>({summary:'Ask a supplier for the expected delivery date after they accept a purchase without one. Review the first email and authorize one request per purchase.',
    rows:[{Action:'Review supplier date requests',link:path}],more:false}) };

module.exports = { job, phase, path, activeRule, authority, configure, page, definition };

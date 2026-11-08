'use strict';

const rows = require('./agent-plan-v3.json');
const { operationalAccess, EntitlementError } = require('./entitlements');
const jobs = new Map(rows.map(row => [row.id, Object.freeze(row)]));
const plans = Object.freeze(['starter', 'growth', 'pro', 'enterprise']);
const labels = { starter: 'Starter', growth: 'Growth', pro: 'Pro', enterprise: 'Custom' };

// These are the ceilings for an agent job. Neither a paid plan nor a trained
// rule alone grants authority to spend money or change a business record.
function allowance(plan, id) {
  // The owner chose page 11 for these two conflicts. A Starter supplier
  // link accompanies a human-approved PO. Growth playbooks run only steps
  // the owner has taught, within their individual plan permissions.
  if (plan === 'starter' && id === 35) return 'draft';
  if (plan === 'growth' && id === 213) return 'trained';
  return plans.includes(plan) ? jobs.get(id)?.[plan] || 'excluded' : 'excluded';
}

function permits(plan, id, operation, { trained = false, edi = false } = {}) {
  const mode = allowance(plan, id);
  if (mode === 'excluded' || (id === 185 && plan === 'pro' && edi !== true)) return false;
  switch (operation) {
    case 'suggest': return true;
    case 'draft': return mode !== 'suggest';
    case 'automatic': return mode === 'alone' || (mode === 'trained' && trained === true);
    default: return false;
  }
}

async function accountState(database, workspaceId) {
  const { rows: [row] } = await database.query(`SELECT s.*, a.id AS owner_id,
    a.created_at::timestamptz + interval '336 hours' AS shadow_ends_at,
    a.created_at::timestamptz + interval '336 hours' > CURRENT_TIMESTAMP AS shadow,
    x.disabled_at AS platform_access_disabled_at, v.configuration AS terms
    FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id
    LEFT JOIN account_subscriptions s ON s.account_id=a.id
    LEFT JOIN platform_account_access x ON x.account_id=a.id
    LEFT JOIN commercial_plan_versions v ON v.id=s.plan_version_id AND v.plan_id=s.plan_id
    WHERE w.id=$1`, [workspaceId]);
  const plan = operationalAccess(row?.id ? row : null).canOperate ? row.plan_id : null;
  return { plan, subscribed: Boolean(row?.id), accountId: row?.owner_id, shadow: row?.shadow !== false,
    shadowEndsAt: row?.shadow_ends_at, terms: row?.terms || {} };
}

function requireJob(plan, id, operation, facts) {
  if (permits(plan, id, operation, facts)) return;
  if(id===185 && facts?.edi!==true)
    throw new EntitlementError('EDI requires Pro with the EDI add-on, or Custom.',{jobId:id,currentPlan:plan,minimum:'pro',addon:'agent-pro-edi'});
  const minimum = plans.find(p => permits(p, id, operation, facts));
  throw new EntitlementError(minimum
    ? `This agent job requires the ${labels[minimum]} plan for that level of control.`
    : 'This agent job needs additional authorization.', { jobId: id, currentPlan: plan, minimum });
}

function purchaseLimits(state) {
  if (state.plan === 'growth') return { perOrder: 500, perWeek: 2000, currency: 'USD' };
  if (state.plan === 'pro') return { perOrder: 1000, perWeek: 5000, currency: 'USD' };
  const contract = state.terms?.agentPurchaseLimits;
  if (state.plan === 'enterprise' && contract && /^[A-Z]{3}$/.test(contract.currency) &&
      [contract.perOrder, contract.perWeek].every(n => Number.isFinite(n) && n > 0)) return contract;
  return null;
}

async function requireWorkspaceJob(database, workspaceId, id, operation, {trained=false}={}) {
  const state = await accountState(database,workspaceId);
  let edi = false;
  if (id === 185 && state.plan === 'pro') {
    const access=await require('./entitlements').meterState(database,{accountId:state.accountId,workspaceId},'agent_edi');
    edi=access.hardLimit !== null && access.hardLimit >= 1;
  }
  requireJob(state.plan,id,operation,{trained,edi});
  return state;
}

// Called both before the purchase is committed and just before provider delivery.
// Prior orders used as evidence must already have been sent and cannot be the
// order currently awaiting delivery.
async function purchaseReview(database, workspaceId, candidate, policy, state, committedId) {
  const cap = purchaseLimits(state);
  if (!cap) return 'Automatic ordering needs agreed purchase limits.';
  if (candidate.currency !== cap.currency || !Number.isFinite(candidate.value) ||
      candidate.value <= 0 || candidate.value > cap.perOrder) return 'This order needs approval under your plan’s per-order limit.';
  if (state.plan === 'growth' && !policy.itemScope.includes(candidate.skuId)) return 'Choose this item as trusted before automatic ordering.';
  const prior = await database.query(`SELECT po.currency,line.unit_cost,line.units_per_purchase_unit,line.sku_id FROM purchase_orders po
    JOIN purchase_order_lines line ON line.workspace_id=po.workspace_id AND line.purchase_order_id=po.id
    WHERE po.workspace_id=$1 AND po.supplier_id=$2 AND po.id IS DISTINCT FROM $3
      AND po.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND (line.sku_id=$4 OR $5=false) ORDER BY (line.sku_id=$4) DESC,po.ordered_at::timestamptz DESC NULLS LAST,po.id DESC,line.line_number LIMIT 1`,
    [workspaceId, candidate.supplierId, committedId, candidate.skuId,state.plan==='growth']);
  if (!prior.rowCount) return 'A person must approve the first order for this supplier or trusted item.';
  const last=prior.rows[0];
  if(last.sku_id===candidate.skuId && (last.currency!==candidate.currency || last.unit_cost==null || Number(last.unit_cost)!==Number(candidate.unitCost) ||
     Number(last.units_per_purchase_unit || 1)!==Number(candidate.unitsPerPurchaseUnit || 1)))
    return 'The latest supplier order used a different currency, price or pack. A person must approve the changed terms.';
  const ledger = await database.query(`SELECT po.currency, sum(l.quantity_units*l.unit_cost::numeric) AS amount,
      bool_or(l.unit_cost IS NULL) AS missing_cost
    FROM work_items wi JOIN workspaces w ON w.id=wi.workspace_id
    JOIN purchase_orders po ON po.id=wi.purchase_order_id AND po.workspace_id=w.id
    JOIN purchase_order_lines l ON l.purchase_order_id=po.id AND l.workspace_id=w.id
    WHERE w.owner_account_id=$1 AND wi.source='postgres_autopilot' AND wi.approval_requirement='NONE'
      AND po.id IS DISTINCT FROM $2 AND po.approved_at::timestamptz>=CURRENT_TIMESTAMP-interval '168 hours'
    GROUP BY po.currency`, [state.accountId, committedId]);
  let committed = 0;
  const money = require('../domain/currency');
  for (const row of ledger.rows) {
    if (row.currency !== cap.currency || row.missing_cost) return 'Review the account’s automatic purchase commitments before spending more.';
    committed += money.toMinor(String(row.amount), cap.currency);
  }
  if (committed + money.toMinor(String(candidate.value), cap.currency) > money.toMinor(String(cap.perWeek), cap.currency))
    return 'This order would exceed the weekly automatic purchasing limit across your inventories.';
  return null;
}

// A mission approval cannot substitute for confirming the physical or
// financial fact at the moment this particular action is ready.
// A broad mission has no trusted supplier, SKU, price or rolling spend proof.
const separateApproval=new Set(['purchase_order.place','purchase_order.approve','communication.send_email']);
const actionJobs=new Map([
  ['manufacturing.create_work_order',14],['manufacturing.start',14],['manufacturing.complete',14],
  ['sales_order.reserve_all',12],['sales_order.allocation_priority',65],
  ['warehouse.wave.create',57],['warehouse.wave.scan',57],['warehouse.wave.pack',57],['warehouse.wave.shortage',57],['warehouse.wave.refresh',57],
  ['customer_return.refund',107],['customer_return.credit_receipt',107],['shipping.return_parcel',112],['customer_return.inspect',113],
  ['customer_return.receive',114],['supplier_return.request',115],['supplier_return.authorize',115],['supplier_return.ship',115],['supplier_return.reconcile',115],
  ['inventory.transfer',118],['transfer.approve',118],['shipping.label',59],['shipping.batch_purchase',59],
  ['purchase_order.record_supplier_invoice',98],['supplier_invoice.recheck',98],
  ['connection.accounting_export',184],['report.template.create',154],['report.template.schedule',155],['report.template.resume',155],['report.template.send_now',155]
]);
function actionJob(name,operation,payload) {
  if(name==='communication.send_email'&&payload){
    const phase=payload.followUpPhase||(/^supplier-follow-up:[^:]+:(supplier_confirmation_due|supplier_delivery_late):\d+$/.exec(payload.idempotencyKey||'')||[])[1];
    if(phase==='supplier_confirmation_due')return 29;
    if(phase==='supplier_delivery_late')return 30;
    if(payload.recipientKind==='supplier'&&payload.purchaseOrderId)return 28;
    return payload.recipientKind==='supplier'?89:187;
  }
  if(operation==='automatic' && ['transfer.approve','inventory.transfer'].includes(name)) return 119;
  return actionJobs.get(name);
}
function usesAgentTerms(state){return state.terms?.offerId==='agent-v3'||state.plan==='enterprise';}
const humanSteps=new Set([
  'inventory.receive','purchase_order.receive','transfer.receive','customer_return.receive',
  'shipping.receipt_accept','inventory.adjust','inventory.issue','connection.confirm_count',
  'customer_return.refund','supplier_payment.record','sales_order.cancel','catalog.set_price',
  'catalog.set_purchase_cost','pricing.rule.configure','supplier.link_product','supplier.update',
  'customer_return.inspect','manufacturing.complete','warehouse.wave.scan','warehouse.wave.pack','warehouse.wave.shortage','contact.create','autopilot.resume','autopilot.mode','shipping.operation_mode',
  'shipping.purchase_limits','connection.accounting_authority','customer.update'
]);
function needsPerson(capability){return humanSteps.has(capability)||separateApproval.has(capability);}

module.exports = { actionJob,usesAgentTerms,needsPerson, requireWorkspaceJob, purchaseReview, allowance, permits, requireJob, accountState, purchaseLimits };

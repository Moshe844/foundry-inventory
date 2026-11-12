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
  // The owner also requires one approval per Starter shipment notice.
  if (plan === 'starter' && (id === 35 || id === 60)) return 'draft';
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
  const terms=row?.terms||{};
  return { plan, subscribed: Boolean(row?.id), accountId: row?.owner_id, shadow: usesAgentTerms({plan,terms})&&row?.shadow !== false,
    shadowEndsAt: row?.shadow_ends_at, terms };
}

function requireJob(plan, id, operation, facts) {
  if (permits(plan, id, operation, facts)) return;
  if(id===185 && facts?.edi!==true)
    throw new EntitlementError('EDI requires Pro with the EDI add-on, or Custom.',{jobId:id,currentPlan:plan,minimum:'pro',addon:'agent-pro-edi'});
  const minimum = plans.find(p => permits(p, id, operation, facts));
  if(operation==='automatic'&&allowance(plan,id)==='trained'&&facts?.trained!==true)
    throw new EntitlementError('Individually approve a matching example and teach its scope and limit before StockChief can handle this step on '+labels[plan]+'.'+(minimum?' Automatic handling without a taught rule requires '+labels[minimum]+'.':''),{jobId:id,currentPlan:plan,minimum});
  const taughtMinimum=operation==='automatic'?plans.find(p=>permits(p,id,operation,{...facts,trained:true})):null;
  if(taughtMinimum&&minimum&&taughtMinimum!==minimum&&allowance(taughtMinimum,id)==='trained')throw new EntitlementError(`This agent job requires the ${labels[taughtMinimum]} plan with a completed taught rule, or the ${labels[minimum]} plan without training.`,{jobId:id,currentPlan:plan,minimum:taughtMinimum,requiresTraining:true,automaticWithoutTraining:minimum});
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
  const plan=usesAgentTerms(state)?state.plan:null;
  let edi = false;
  if (id === 185 && plan === 'pro') {
    const access=await require('./entitlements').meterState(database,{accountId:state.accountId,workspaceId},'agent_edi');
    edi=access.hardLimit !== null && access.hardLimit >= 1;
  }
  requireJob(plan,id,operation,{trained,edi});
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
  const buying=require('../purchasing/agent-order-quantities');
  if(buying.usesTopUp(candidate)&&!candidate.topUpSignature)return 'Review a fresh order with the current supplier minimum and shipping terms.';
  if(state.plan==='growth'&&candidate.topUpSignature){
    const taught=await database.query(`SELECT 1 FROM work_items wi
      JOIN purchase_orders po ON po.workspace_id=wi.workspace_id AND po.id=wi.purchase_order_id
      JOIN workspaces w ON w.id=wi.workspace_id
      JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.id=wi.approved_by_user_id AND u.role='owner'
      WHERE wi.workspace_id=$1 AND wi.source='postgres_autopilot' AND po.id IS DISTINCT FROM $2
        AND po.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED') AND po.supplier_id=$3
        AND wi.recommended_action::jsonb->>'skuId'=$4 AND wi.recommended_action::jsonb->>'destinationLocationId'=$5
        AND wi.recommended_action::jsonb->>'topUpSignature'=$6 LIMIT 1`,
    [workspaceId,committedId,candidate.supplierId,candidate.skuId,candidate.destinationLocationId,candidate.topUpSignature]);
    if(!taught.rowCount)return 'Approve and send one matching supplier minimum or free-shipping order before this routine repeats.';
  }
  const needsPackExample=state.plan==='growth'&&buying.usesPacks(candidate);
  const prior = await database.query(`SELECT po.currency,line.unit_cost,line.units_per_purchase_unit,line.sku_id,
      line.purchase_unit,line.quantity_purchase_units FROM purchase_orders po
    JOIN purchase_order_lines line ON line.workspace_id=po.workspace_id AND line.purchase_order_id=po.id
    WHERE po.workspace_id=$1 AND po.supplier_id=$2 AND po.id IS DISTINCT FROM $3
      AND po.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      AND (line.sku_id=$4 OR $5=false)
      AND (NOT $6 OR EXISTS (
        SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
        WHERE u.workspace_id=po.workspace_id AND u.id=po.approved_by_user_id AND u.role='owner'
        AND NOT EXISTS (SELECT 1 FROM work_items wi WHERE wi.workspace_id=po.workspace_id AND wi.purchase_order_id=po.id
          AND wi.source='postgres_autopilot' AND wi.approved_by_user_id IS NULL)))
    ORDER BY (line.sku_id=$4) DESC,po.ordered_at::timestamptz DESC NULLS LAST,po.id DESC,line.line_number LIMIT 1`,
    [workspaceId,candidate.supplierId,committedId,candidate.skuId,state.plan==='growth',needsPackExample]);
  if (!prior.rowCount) return needsPackExample?'Approve and place an example order in these supplier packs before automating this trusted item.':'A person must approve the first order for this supplier or trusted item.';
  const last=prior.rows[0];
  if(last.sku_id===candidate.skuId && (last.currency!==candidate.currency || last.unit_cost==null || Number(last.unit_cost)!==Number(candidate.unitCost) ||
     Number(last.units_per_purchase_unit || 1)!==Number(candidate.unitsPerPurchaseUnit || 1)||
     (needsPackExample&&((candidate.purchaseUnit!=null&&last.purchase_unit!==candidate.purchaseUnit)||
       Number(last.quantity_purchase_units)%Number(candidate.purchaseMultiple??1)!==0))))
    return 'The latest supplier order used a different currency, price or pack. A person must approve the changed terms.';
  const money = require('../domain/currency');
  const ledger=await automaticPurchaseCommitments(database,state,cap.currency,committedId);
  if(ledger.unknown)return 'Review the account’s automatic purchase commitments before spending more.';
  if (money.sum([ledger.committed, money.toMinor(String(candidate.value), cap.currency)]) > money.toMinor(String(cap.perWeek), cap.currency))
    return 'This order would exceed the weekly automatic purchasing limit across your inventories.';
  return null;
}

async function automaticPurchaseCommitments(database,state,currency,exceptId=null){
  const money=require('../domain/currency');
  const totalsSql = require('../operations/postgres-team-access').purchaseTotalsSql('po.workspace_id','po.id','$3::numeric');
  const ledger = await database.query(`WITH automated AS (
    SELECT po.workspace_id,po.id,po.currency,totals.lines,totals.charges,totals.priced
    FROM purchase_orders po JOIN workspaces w ON w.id=po.workspace_id
    CROSS JOIN LATERAL (${totalsSql}) totals
    WHERE w.owner_account_id=$1
      AND po.approved_at::timestamptz>=CURRENT_TIMESTAMP-interval '168 hours'
      AND EXISTS(SELECT 1 FROM work_items wi WHERE wi.workspace_id=po.workspace_id AND wi.purchase_order_id=po.id
        AND wi.source='postgres_autopilot' AND wi.approval_requirement='NONE')
  ) SELECT currency,lines,charges,priced FROM automated WHERE id IS DISTINCT FROM $2
  UNION ALL
  SELECT e.detail::jsonb->'commitment'->>'currency',(e.detail::jsonb->'commitment'->>'addedMinor')::numeric,0,true
  FROM purchase_order_events e JOIN workspaces w ON w.id=e.workspace_id
  WHERE w.owner_account_id=$1 AND e.event='supplier_purchase_amended'
    AND e.created_at::timestamptz>=CURRENT_TIMESTAMP-interval '168 hours'
    AND e.detail::jsonb->'commitment' IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM automated a WHERE a.workspace_id=e.workspace_id AND a.id=e.purchase_order_id)`,
    [state.accountId,exceptId,10**money.exponent(currency)]);
  let committed = 0;
  for (const row of ledger.rows) {
    if (row.currency !== currency || !row.priced) return {unknown:true};
    const amount = money.sum([money.integer(row.lines), money.integer(row.charges,'Purchase charges',{signed:true})]);
    if (amount < 0) return {unknown:true};
    committed = money.sum([committed, amount]);
  }
  return {committed,unknown:false};
}

// A mission approval cannot substitute for confirming the physical or
// financial fact at the moment this particular action is ready.
// A broad mission has no trusted supplier, SKU, price or rolling spend proof.
const separateApproval=new Set(['sales_order.notify_stock_ready','customer_invoice.remind','purchase_order.place','purchase_order.approve','communication.send_email']);
const actionJobs=new Map([
  ['purchasing.supplier_direct',37],
  ['document.read_contract',143],['document.read_shipping_original',137],['document.discover_filing',142],['document.link_lot_certificate',196],
  ['warehouse.read_shelf_photo',140],
  ['sales_order.reserve_rotation',192],['purchase_order.reorder_drafts',19],['purchasing.select_supplier',22],['purchasing.switch_backup_supplier',95],
  ['purchasing.prepare_blanket_release',42],
  ['catalog.write_channel_copy',128],
  ['website.answer_stock',84],
  ['customer_order.from_page',83],
  ['customer_order.from_preorder',68],['customer_order.fill_preorder',68],
  ['channel_sync.recover',182],
  ['customer_return.plan_disposition',113],
  ['shipping.prepare_export_papers',70],
  ['customer_return.send_label',112],
  ['inventory.inspect_delivery',51],
  ['supplier.request_quotes',93],
  ['channel.set_stock_buffer',183],
  ['inventory.plan_annual_stocktake',16],
  ['warehouse.release_partial_order',61],
  ['supplier.open_damage_claim',45],
  ['supplier.attach_damage_photos',46],
  ['purchasing.plan_supplier_shutdown',147],
  ['purchasing.plan_promotion_stock',145],
  ['catalog.retire_discontinued',132],
  ['team.write_procedure',178],
  ['purchasing.plan_container',38],
  ['supplier.email_terms',96],
  ['supplier.claim_benefit',97],
  ['purchase_order.update_delivery_date',31],
  ['purchase_order.close_stale_incoming',32],
  ['purchasing.fx_alert',40],
  ['report.net_margin_alert',85],
  ['report.month_end_stock',158],
  ['report.change_digest',157],
  ['report.board_pack',159],
  ['report.roi',161],
  ['report.stock_health',162],
  ['report.service_levels',163],
  ['channel.price_check',87],
  ['inventory.correct_bin',11],
  ['customer_return.from_email',111],
  ['supplier.share_forecast',36],
  ['customer.statement',81],
  ['sales_quote.followup',74],
  ['customer_invoice.prepare_document',101],['customer_invoice.remind',102],
  ['customer_payment.match_bank_line',103],
  ['document.save_product_facts',136],
  ['import.count_sheet',5],
  ['purchase_order.receive_from_document',43],
  ['catalog.supplier_price_list',135],
  ['sales_order.recurring',67],
  ['import.supplier_catalog',127],['import.variants',130],['import.map_columns',133],['onboarding.old_system_migration',190],
  ['kit.replenish_parts',13],
  ['sales_quote.create',73],['sales_quote.accept',75],['customer.check_in',78],['sales_quote.add_companions',79],
  ['planning.safety_stock',150],['planning.location_reorder',120],['planning.reorder_refresh',21],['planning.demand_forecast',144],['planning.launch_forecast',146],['planning.demand_trend',148],['inventory.plan_daily_cycle_count',4],['planning.open_to_buy',26],['inventory.plan_warehouse_slotting',122],
  ['supplier.negotiation_draft',94],
  ['catalog.fill_supplier_specs',129],
  ['catalog.fix_data',126],
  ['catalog.classify_products',131],
  ['purchase_order.combine_drafts',24],['purchase_order.split_draft',25],
  ['catalog.restore_margin',77],
  ['catalog.clearance_plan',86],
  ['inventory.slow_stock_step',9],
  ['inventory.expiry_warning',191],
  ['alert.low_stock',166],['alert.watch_rule',167],['alert.overdue',168],
  ['report.compliance',197],
  ['inventory.write_down_aged',17],
  ['manufacturing.create_work_order',14],['manufacturing.start',14],['manufacturing.complete',14],
  ['sales_order.reserve_all',12],['inventory.protect_stock',12],['sales_order.reserve_arrived',48],['sales_order.notify_stock_ready',50],['sales_order.repeat',53],['sales_order.allocation_priority',65],['sales_order.allocate_backorders',64],['sales_order.share_scarce_stock',65],['sales_order.route_warehouse',121],['sales_order.split_partial',61],['sales_order.check',54],['sales_order.credit_hold',55],
  ['landed_cost.apply',49],['warehouse.prepare_putaway',47],['warehouse.release_orders',56],['warehouse.wave.create',57],['warehouse.wave.scan',57],['warehouse.wave.pack',57],['warehouse.wave.shortage',57],['warehouse.wave.refresh',57],
  ['customer_return.refund',107],['customer_return.credit_receipt',107],['customer_credit.prepare',107],['shipping.return_parcel',112],['customer_return.inspect',113],
  ['customer_return.receive',114],['supplier_return.request',115],['supplier_return.authorize',115],['supplier_return.ship',115],['supplier_return.reconcile',115],
  ['inventory.transfer',118],['transfer.approve',118],['transfer.prepare_balance',118],['shipping.label',59],['shipping.batch_purchase',59],['shipping.address_check',69],['shipping.choose_rate',58],['shipping.parcel_watch',62],
  ['shipping.carrier_claim',63],['shipping.freight_pickup',66],['shipping.plan_van_routes',71],['purchasing.track_inbound_freight',39],['agent.answer_slack',188],
  ['purchase_order.record_supplier_invoice',98],['supplier_invoice.recheck',98],['supplier_invoice.dispute',100],['supplier_credit.apply_note',105],
  ['connection.accounting_export',184],['report.template.create',154],['report.template.schedule',155],['report.template.resume',155],['report.template.send_now',155]
]);
function actionJob(name,operation,payload) {
  if(name?.startsWith('document.file_to_'))return require('../documents/agent-filing').job(payload?.documentKind);
  if(name==='pricing.rule.configure'&&payload?.definition?.enabled!==false&&payload?.definition?.scope?.customerIds?.length)return 76;
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
const newAgentActions=new Set(['customer_invoice.prepare_document','sales_quote.followup','customer.statement','landed_cost.apply','warehouse.prepare_putaway','warehouse.release_orders','supplier_invoice.dispute','sales_order.notify_stock_ready','sales_order.reserve_arrived','customer_invoice.remind','customer_payment.match_bank_line','document.save_product_facts','document.file_to_purchase_order','document.file_to_sales_order','document.file_to_item','import.count_sheet','purchase_order.receive_from_document','catalog.supplier_price_list','sales_order.recurring','import.supplier_catalog','import.variants','kit.replenish_parts','sales_quote.create','sales_quote.accept','purchase_order.combine_drafts','purchase_order.split_draft','sales_order.repeat','catalog.restore_margin','catalog.fill_supplier_specs']);
newAgentActions.add('purchase_order.reorder_drafts');newAgentActions.add('purchasing.select_supplier');
newAgentActions.add('sales_order.reserve_rotation');
newAgentActions.add('sales_quote.add_companions');
newAgentActions.add('customer.check_in');
newAgentActions.add('transfer.prepare_balance');
newAgentActions.add('inventory.write_down_aged');
function actionPlan(state,name){
  if(usesAgentTerms(state))return state.plan;
  // Earlier offers retain their existing contracts. The new Agent-only contracts require the new offer.
  return newAgentActions.has(name)?null:undefined;
}
const humanSteps=new Set([
  'import.count_sheet',
  'purchase_order.receive_from_document',
  'sales_quote.accept',
  'sales_quote.add_companions',
  'customer.check_in',
  'catalog.restore_margin',
  'inventory.write_down_aged',
  'inventory.receive','purchase_order.receive','transfer.receive','transfer.pick','transfer.dispatch','transfer.depart','transfer.in_transit','customer_return.receive',
  'shipping.receipt_accept','inventory.adjust','inventory.issue','connection.confirm_count',
  'customer_return.refund','customer_credit.prepare','supplier_payment.record','sales_order.cancel','catalog.set_price',
  'catalog.set_purchase_cost','pricing.rule.configure','supplier.link_product','supplier.update',
  'customer_return.inspect','manufacturing.start','manufacturing.complete','warehouse.wave.scan','warehouse.wave.pack','warehouse.wave.shortage','contact.create','autopilot.resume','autopilot.mode','shipping.operation_mode',
  'shipping.purchase_limits','connection.accounting_authority','customer.update'
]);
function needsPerson(capability,payload,state){if(capability==='sales_order.reserve_rotation'&&payload?.needsHistoricalFifoConfirmation)return true;if(['purchase_order.reorder_drafts','purchasing.select_supplier'].includes(capability)&&payload?.needsPurchaseTermsConfirmation!==false)return true;if(['inventory.transfer','transfer.approve'].includes(capability)&&state&&usesAgentTerms(state))return true;return (state?.plan==='starter'&&usesAgentTerms(state))||(capability?.startsWith('document.file_to_')&&payload?.needsTargetConfirmation!==false)||(['accounting.bank_import','customer_payment.record','customer_invoice.payment'].includes(capability)&&state&&usesAgentTerms(state))||(capability==='customer_payment.match_bank_line'&&payload?.needsPaymentConfirmation!==false)||(capability==='document.save_product_facts'&&payload?.needsFactConfirmation!==false)||(capability==='catalog.supplier_price_list'&&payload?.overReviewThreshold!==false)||(capability==='supplier_invoice.dispute'&&payload?.needsDisputeConfirmation!==false)||(capability==='purchase_order.record_supplier_invoice'&&state&&usesAgentTerms(state)&&payload?.needsInvoiceConfirmation!==false)||(capability==='warehouse.wave.create'&&state&&usesAgentTerms(state)&&payload?.needsWaveConfirmation!==false)||(capability==='warehouse.prepare_putaway'&&payload?.needsPutawayConfirmation!==false)||(capability==='customer.statement'&&payload?.needsStatementConfirmation!==false)||(capability==='landed_cost.apply'&&payload?.needsLandedCostConfirmation!==false)||humanSteps.has(capability)||separateApproval.has(capability);}
async function stopped(db,workspaceId,account,capability,automatic,payload){
  if(!account.plan||!usesAgentTerms(account)||['autopilot.pause','autopilot.resume','autopilot.mode','report.template.create'].includes(capability))return null;
  if(account.shadow)return 'StockChief is watching during the first 14 days. Record this action manually or approve it after shadow mode.';
  const {rows:[config]}=await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId]);
  if(config?.mode==='OBSERVE')return 'StockChief is in watch-only mode. Change its authority before approving an agent change.';
  if(automatic&&(Number(config?.paused)||Number(config?.suspended)))return 'Automatic work is paused. Review the inventory’s automation settings.';
  if(capability?.startsWith('document.file_to_')){
    const filingMode=await require('../autopilot/job-modes').restriction(db,workspaceId,142,automatic);
    if(filingMode)return filingMode;
  }
  const job=actionJob(capability,automatic?'automatic':'draft',payload);
  const jobRestriction=await require('../autopilot/job-modes').restriction(db,workspaceId,job,automatic);
  if(jobRestriction)return jobRestriction;
  return automatic?require('./agent-rule-quota').restriction(db,account):null;
}

async function customerOrderNeedsPerson(db,workspaceId,capability,payload,proposalId=null,state=null){
  if(!['sales_order.create','sales_order.repeat'].includes(capability))return false;
  if(!payload&&proposalId)payload=(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2 AND action_type=$3',
    [workspaceId,proposalId,capability])).rows[0]?.payload;
  state=state||await accountState(db,workspaceId);
  // Owner-directed orders follow the page 11 authority ceiling. Document
  // ingestion is the separate job 52 and retains its own stricter tier rules.
  if(usesAgentTerms(state)&&capability==='sales_order.create'&&state.plan==='growth'&&
    !await require('../autopilot/draft-authority').trained(db,workspaceId,capability,payload,proposalId))return true;
  const order=capability==='sales_order.repeat'?payload?.input:payload;
  if(!order?.customerId)return true;
  const pickup=order.deliveryMethod==='PICKUP';
  const destination=capability==='sales_order.repeat'?payload.address:order.shipToAddress;
  if(!pickup&&!destination)return true;
  // These two capabilities create staff-directed orders. Authenticated
  // storefront order ingestion has a separate entry point.
  const known=await db.query(`SELECT 1 FROM sales_orders o WHERE o.workspace_id=$1 AND o.customer_id=$2
    AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
    AND coalesce(o.customer_decision_required,0)=0 AND coalesce(o.delivery_decision_required,0)=0
    AND ($3 OR o.delivery_method='SHIP' AND lower(trim(o.ship_to_address))=lower(trim($4::text))) LIMIT 1`,
    [workspaceId,order.customerId,pickup,destination||null]);
  return !known.rowCount;
}

module.exports = { actionJob,actionPlan,usesAgentTerms,needsPerson,stopped,customerOrderNeedsPerson,requireWorkspaceJob,
  purchaseReview,automaticPurchaseCommitments,allowance,permits,requireJob,accountState,purchaseLimits };

'use strict';

/**
 * Mission 11's deterministic decision layer.
 *
 * Forecasting supplies demand; operational records supply stock, suppliers and
 * prices; Accounting supplies cash and obligations. This module compares the
 * possible answers. It does not execute any of them and it never turns a
 * missing amount, date, conversion or identity into a convenient assumption.
 */

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const permissions = require('../actions/permissions');
const { ValidationError } = require('../domain/errors');

const DAY_MS = 24 * 60 * 60 * 1000;
const json = (value) => JSON.stringify(value === undefined ? null : value);
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const day = (value) => String(value || '').slice(0, 10);
const addDays = (date, count) => new Date(Date.parse(`${date}T00:00:00.000Z`)
  + Number(count || 0) * DAY_MS).toISOString().slice(0, 10);
const money = (minor, currency = 'USD') => `${currency === 'USD' ? '$' : `${currency} `}`
  + (Number(minor || 0) / 100).toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
const numberOrNull = (value) => value === null || value === undefined || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const whole = (value) => Math.max(0, Math.ceil(Number(value || 0)));

const SERVICE_WEIGHT = Object.freeze({ lean:35, balanced:80, protective:150 });
const TYPE_ORDER = Object.freeze({ TRANSFER:1, SUBSTITUTE:2, TRANSFER_AND_BUY:3,
  BUY_ALTERNATE:4, BUY:5, EXPEDITE:6, WAIT:7 });

function paymentDays(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return null;
  if (/due\s+(?:on\s+)?receipt|cod|cash\s+on\s+delivery|prepaid|in\s+advance/.test(value)) return 0;
  const match = /(?:net|within)\s*(\d{1,3})/.exec(value);
  return match ? Number(match[1]) : null;
}

function roundToSupplier(requestedUnits, supplier) {
  const unitsPer = Math.max(1, whole(supplier.unitsPerPurchaseUnit || 1));
  const minimum = Math.max(0, whole(supplier.minimumOrderQuantity || 0));
  const multiple = Math.max(1, whole(supplier.orderMultiple || 1));
  let purchaseUnits = Math.ceil(whole(requestedUnits) / unitsPer);
  purchaseUnits = Math.max(purchaseUnits, minimum);
  purchaseUnits = Math.ceil(purchaseUnits / multiple) * multiple;
  return { purchaseUnits, units:purchaseUnits * unitsPer, unitsPerPurchaseUnit:unitsPer,
    minimumOrderQuantity:minimum, orderMultiple:multiple };
}

function purchaseCandidate(input, supplier, requestedUnits, kind = 'BUY', expedited = false) {
  const converted = roundToSupplier(requestedUnits, supplier);
  const unitCost = numberOrNull(expedited ? supplier.expeditedUnitCostMinor : supplier.unitCostMinor);
  const lead = numberOrNull(expedited ? supplier.expeditedLeadTimeDays : supplier.leadTimeDays);
  const landed = numberOrNull(supplier.landedCostPerUnitMinor);
  const productCostMinor = unitCost === null ? null : Math.round(unitCost * converted.units);
  const landedCostMinor = landed === null ? null : Math.round(landed * converted.units);
  const totalCostMinor = productCostMinor === null ? null : productCostMinor + (landedCostMinor || 0);
  const termsDays = paymentDays(supplier.paymentTerms);
  const dueInsideHorizon = termsDays === null || termsDays <= input.horizonDays;
  const cashRequiredMinor = dueInsideHorizon ? totalCostMinor : 0;
  const cashFits = !input.cash.known || cashRequiredMinor === null
    || cashRequiredMinor <= input.cash.availableForNewCommitmentsMinor;
  const arrivesInTime = lead !== null && (input.daysUntilStockout === null || lead <= input.daysUntilStockout);
  const quantityCovers = converted.units >= requestedUnits;
  const missing = [];
  if (unitCost === null) missing.push('supplier price');
  if (lead === null) missing.push(expedited ? 'expedited delivery time' : 'supplier lead time');
  if (landed === null) missing.push('landed-cost estimate');
  if (termsDays === null) missing.push('payment terms');
  const lateDemand = lead !== null && input.daysUntilStockout !== null
    && input.dailyDemandUnits !== null
    ? whole(Math.max(0, lead - input.daysUntilStockout) * input.dailyDemandUnits)
    : requestedUnits;
  const expectedShortageUnits = arrivesInTime
    ? Math.max(0, requestedUnits - converted.units)
    : Math.min(requestedUnits, lateDemand);
  const reliability = numberOrNull(supplier.onTimeRate);
  const expectedMarginMinor = input.sellingPriceMinor === null || totalCostMinor === null
    ? null : input.sellingPriceMinor * Math.min(requestedUnits, converted.units) - totalCostMinor;
  const feasible = unitCost !== null && lead !== null && quantityCovers && cashFits;
  const reasons = [];
  if (unitCost === null) reasons.push('No evidenced supplier price is recorded.');
  if (lead === null) reasons.push('No evidenced delivery time is recorded.');
  if (!cashFits) reasons.push(`${money(cashRequiredMinor, input.currency)} would be due inside the planning horizon, but only ${money(input.cash.availableForNewCommitmentsMinor, input.currency)} is available after known obligations and the cash reserve.`);
  if (!arrivesInTime && lead !== null) reasons.push(`It is expected in ${lead} days, after the projected stockout.`);
  return {
    id:`${kind.toLowerCase()}:${supplier.supplierId || supplier.supplierItemId || 'supplier'}`,
    type:kind,
    label:expedited ? `Expedite from ${supplier.supplierName}`
      : `Buy from ${supplier.supplierName}`,
    supplierId:supplier.supplierId || null, supplierName:supplier.supplierName || null,
    requestedUnits, quantityUnits:converted.units, quantityPurchaseUnits:converted.purchaseUnits,
    purchaseUnit:supplier.purchaseUnit || 'unit', arrivalDays:lead,
    productCostMinor, landedCostMinor, totalCostMinor, cashRequiredMinor,
    paymentTerms:supplier.paymentTerms || null, paymentDueDays:termsDays,
    expectedShortageUnits, expectedMarginMinor, onTimeRate:reliability,
    feasible, missing, reasons, overbuyUnits:Math.max(0, converted.units - requestedUnits),
    evidence:{ supplierItemId:supplier.supplierItemId || null,
      reliabilityOrders:supplier.reliabilityOrders || 0,
      expediteEvidence:expedited ? supplier.expediteEvidence || null : null },
  };
}

function score(candidate, input) {
  if (!candidate.feasible) return null;
  const serviceWeight = SERVICE_WEIGHT[input.objective.serviceLevel] || SERVICE_WEIGHT.balanced;
  const cost = Number(candidate.totalCostMinor || candidate.transferCostMinor || 0) / 100;
  const shortage = Number(candidate.expectedShortageUnits || 0);
  const evidencedLoss = input.stockoutCostPerUnitMinor === null
    ? shortage * serviceWeight * 10
    : shortage * input.stockoutCostPerUnitMinor / 100;
  const servicePenalty = shortage * serviceWeight * 100 + evidencedLoss;
  const reliabilityPenalty = candidate.onTimeRate === null || candidate.onTimeRate === undefined
    ? (candidate.type.startsWith('BUY') || candidate.type === 'EXPEDITE' ? input.requiredUnits * 12 : 0)
    : (100 - candidate.onTimeRate) * input.requiredUnits * serviceWeight / 100;
  const cashPenalty = Number(candidate.cashRequiredMinor || 0) / 100 * 0.08;
  const capPenalty = input.inventoryCapRemainingMinor !== null && candidate.totalCostMinor !== null
    && candidate.totalCostMinor > input.inventoryCapRemainingMinor
    ? (candidate.totalCostMinor - input.inventoryCapRemainingMinor) / 100 * 2 : 0;
  const storagePenalty = Number(candidate.overbuyUnits || 0)
    * Number(input.storageCostPerUnitMinor || 0) / 100;
  const negativeMarginPenalty = candidate.expectedMarginMinor !== null && candidate.expectedMarginMinor < 0
    ? Math.abs(candidate.expectedMarginMinor) / 100 * 5 : 0;
  const uncertaintyPenalty = (candidate.missing || []).length * 20;
  return Math.round((cost + servicePenalty + reliabilityPenalty + cashPenalty + capPenalty
    + storagePenalty + negativeMarginPenalty + uncertaintyPenalty) * 100) / 100;
}

/** Pure optimiser. All quantities and money entering it are already evidence. */
function optimize(raw = {}) {
  const asOf = day(raw.asOf || new Date().toISOString());
  const horizonDays = Math.max(1, whole(raw.horizonDays || 30));
  const promotionMultiplier = raw.demand?.promotionEvidence
    ? numberOrNull(raw.demand?.promotionMultiplier) || 1 : 1;
  const seasonalMultiplier = raw.demand?.seasonalEvidence
    || raw.demand?.modelId === 'weekday_seasonal'
    ? numberOrNull(raw.demand?.seasonalMultiplier) || 1 : 1;
  const requiredUnits = whole(Number(raw.requiredUnits || 0) * promotionMultiplier * seasonalMultiplier);
  const cash = {
    known:Boolean(raw.cash?.known), cashMinor:whole(raw.cash?.cashMinor),
    upcomingObligationsMinor:whole(raw.cash?.upcomingObligationsMinor),
    reserveMinor:whole(raw.cash?.reserveMinor),
    availableForNewCommitmentsMinor:Math.max(0, whole(raw.cash?.availableForNewCommitmentsMinor)),
  };
  const input = {
    asOf, horizonDays, requiredUnits, cash,
    currency:raw.currency || 'USD',
    daysUntilStockout:numberOrNull(raw.daysUntilStockout),
    dailyDemandUnits:numberOrNull(raw.demand?.dailyRate),
    sellingPriceMinor:numberOrNull(raw.sellingPriceMinor),
    stockoutCostPerUnitMinor:numberOrNull(raw.stockoutCostPerUnitMinor),
    storageCostPerUnitMinor:numberOrNull(raw.storageCostPerUnitMinor),
    inventoryCapRemainingMinor:numberOrNull(raw.inventoryCapRemainingMinor),
    objective:{ serviceLevel:raw.objective?.serviceLevel || 'balanced',
      prioritiseCoreProducts:Boolean(raw.objective?.prioritiseCoreProducts),
      preserveCash:true },
  };
  const alternatives = [];
  const uncertainty = [...(raw.uncertainty || [])];

  alternatives.push({ id:'wait', type:'WAIT', label:'Wait', feasible:true,
    quantityUnits:0, totalCostMinor:0, cashRequiredMinor:0,
    expectedShortageUnits:requiredUnits, expectedMarginMinor:0,
    missing:[], reasons:requiredUnits ? ['Waiting preserves cash but leaves the projected shortage unresolved.']
      : ['Existing stock and supply cover the planning horizon.'] });

  const timelyTransfers = (raw.transfers || []).filter((row) => whole(row.units) > 0);
  if (timelyTransfers.length) {
    const missingTiming = timelyTransfers.some((row) => numberOrNull(row.arrivalDays) === null);
    const timely = timelyTransfers.filter((row) => numberOrNull(row.arrivalDays) !== null
      && (input.daysUntilStockout === null || Number(row.arrivalDays) <= input.daysUntilStockout));
    const transferable = timely.reduce((sum, row) => sum + whole(row.units), 0);
    const moved = Math.min(requiredUnits, transferable);
    const knownCosts = timely.map((row) => numberOrNull(row.costMinor));
    const transferCostMinor = knownCosts.every((value) => value !== null)
      ? knownCosts.reduce((sum, value) => sum + value, 0) : null;
    alternatives.push({ id:'transfer', type:'TRANSFER', label:'Transfer existing stock',
    feasible:moved > 0 && (!cash.known || transferCostMinor === null
      || transferCostMinor <= cash.availableForNewCommitmentsMinor), quantityUnits:moved, transferCostMinor,
      totalCostMinor:transferCostMinor, cashRequiredMinor:transferCostMinor || 0,
      expectedShortageUnits:Math.max(0, requiredUnits - moved), onTimeRate:100,
      missing:[...(missingTiming ? ['transfer timing'] : []),
        ...(transferCostMinor === null ? ['transfer cost'] : [])],
      reasons:moved > 0 ? [`${moved} units can arrive from stock already owned before the projected shortage.`,
        ...(cash.known && transferCostMinor !== null
          && transferCostMinor > cash.availableForNewCommitmentsMinor
          ? [`The evidenced transfer cost exceeds cash available after obligations and reserve.`] : [])]
        : ['Existing stock was considered, but none has evidenced timing that reaches this shortage.'],
      transfers:timely, sourceUnitsConsidered:timelyTransfers.reduce((sum, row) => sum + whole(row.units), 0) });
  } else {
    alternatives.push({ id:'transfer', type:'TRANSFER', label:'Transfer existing stock', feasible:false,
      quantityUnits:0, expectedShortageUnits:requiredUnits, missing:['viable excess stock'],
      reasons:['No other location has evidenced spare stock for this shortage.'] });
  }

  const suppliers = raw.suppliers || [];
  suppliers.forEach((supplier, index) => alternatives.push(purchaseCandidate(input, supplier,
    requiredUnits, index === 0 || supplier.preferred ? 'BUY' : 'BUY_ALTERNATE')));
  suppliers.filter((supplier) => supplier.expediteEvidence).forEach((supplier) =>
    alternatives.push(purchaseCandidate(input, supplier, requiredUnits, 'EXPEDITE', true)));

  const transfer = alternatives.find((row) => row.type === 'TRANSFER' && row.feasible);
  const primary = suppliers.length ? purchaseCandidate(input, suppliers[0],
    Math.max(0, requiredUnits - Number(transfer?.quantityUnits || 0)), 'BUY') : null;
  if (transfer && transfer.quantityUnits > 0 && transfer.quantityUnits < requiredUnits && primary) {
    // The transfer covers its share on time. Any remaining exposure is exactly
    // the demand that occurs while the purchased remainder is late.
    const expectedShortageUnits = Number(primary.expectedShortageUnits || 0);
    alternatives.push({ id:'transfer-and-buy', type:'TRANSFER_AND_BUY', label:'Transfer and buy the remainder',
      feasible:primary.feasible, quantityUnits:requiredUnits,
      transferUnits:transfer.quantityUnits, purchaseUnits:primary.quantityUnits,
      quantityPurchaseUnits:primary.quantityPurchaseUnits, supplierId:primary.supplierId,
      supplierName:primary.supplierName, totalCostMinor:primary.totalCostMinor,
      cashRequiredMinor:primary.cashRequiredMinor, transferCostMinor:transfer.transferCostMinor,
      expectedShortageUnits, expectedMarginMinor:primary.expectedMarginMinor,
      onTimeRate:primary.onTimeRate, overbuyUnits:primary.overbuyUnits,
      missing:[...(transfer.missing || []), ...(primary.missing || [])],
      reasons:[...(transfer.reasons || []), ...(primary.reasons || [])],
      transfers:transfer.transfers, purchase:primary });
  }

  for (const substitute of raw.substitutes || []) {
    const ratio = numberOrNull(substitute.unitsPerRequiredUnit);
    const needed = ratio === null ? null : Math.ceil(requiredUnits * ratio);
    const available = whole(substitute.spareUnits);
    alternatives.push({ id:`substitute:${substitute.skuId || 'unknown'}`, type:'SUBSTITUTE',
      label:`Use ${substitute.displayName || 'approved substitute'}`,
      feasible:Boolean(substitute.verified && needed !== null && available >= needed),
      quantityUnits:needed || 0, totalCostMinor:0, cashRequiredMinor:0,
      expectedShortageUnits:substitute.verified && needed !== null && available >= needed ? 0 : requiredUnits,
      missing:[...(!substitute.verified ? ['approved substitution'] : []),
        ...(ratio === null ? ['substitution conversion'] : []),
        ...(needed !== null && available < needed ? ['enough substitute stock'] : [])],
      reasons:[substitute.verified
        ? `${available} spare units are recorded with an approved ${ratio}:1 conversion.`
        : 'Foundry has no verified authority to treat another SKU as this product.'],
      substitute });
  }

  for (const candidate of alternatives) candidate.score = score(candidate, input);
  const viable = alternatives.filter((candidate) => candidate.feasible)
    .sort((a, b) => a.score - b.score || (TYPE_ORDER[a.type] || 99) - (TYPE_ORDER[b.type] || 99));
  const chosen = viable[0] || alternatives[0];
  const fullBuy = alternatives.filter((row) => ['BUY','BUY_ALTERNATE'].includes(row.type)
    && row.feasible).sort((a, b) => (a.totalCostMinor || Infinity) - (b.totalCostMinor || Infinity))[0];
  const cashSavedMinor = fullBuy && chosen.totalCostMinor !== null
    ? Math.max(0, fullBuy.totalCostMinor - Number(chosen.totalCostMinor || 0)) : null;
  const expectedResult = {
    plannedRequirementUnits:requiredUnits,
    shortagePrevented:requiredUnits > 0 && Number(chosen.expectedShortageUnits || 0) === 0,
    expectedShortageUnits:Number(chosen.expectedShortageUnits || 0),
    cashCommittedMinor:Number(chosen.cashRequiredMinor || 0),
    inventoryUnitsAdded:Number(chosen.purchaseUnits || (chosen.type.startsWith('BUY') ? chosen.quantityUnits : 0) || 0),
    transferUnits:Number(chosen.transferUnits || (chosen.type === 'TRANSFER' ? chosen.quantityUnits : 0) || 0),
    expectedMarginMinor:chosen.expectedMarginMinor ?? null,
    cashSavedVersusFullPurchaseMinor:cashSavedMinor,
  };
  const explanation = explainChoice({ chosen, requiredUnits, expectedResult, cash, currency:input.currency });
  if (!cash.known) uncertainty.push('No verified accounting cash balance is available, so cash did not disqualify a plan.');
  if (raw.demand?.confidence === 'learning') uncertainty.push('Demand is still in cold start; only committed demand is treated as certain.');
  if (raw.demand?.promotionMultiplier && !raw.demand?.promotionEvidence) uncertainty.push('A promotion multiplier without evidence was ignored.');

  return {
    asOf, horizonEnd:addDays(asOf, horizonDays), requiredUnits,
    objective:input.objective,
    constraints:{ cash, currency:input.currency, inventoryCapRemainingMinor:input.inventoryCapRemainingMinor,
      daysUntilStockout:input.daysUntilStockout, promotionMultiplier, seasonalMultiplier },
    alternatives, chosen, expectedResult, uncertainty:[...new Set(uncertainty)],
    confidence:raw.demand?.confidence || 'learning',
    status:chosen.type === 'WAIT' && requiredUnits > 0 ? 'INFEASIBLE' : 'SHADOW',
    shadow:true, explanation,
  };
}

function explainChoice({ chosen, requiredUnits, expectedResult, cash, currency }) {
  if (!requiredUnits) return 'Existing stock and confirmed supply cover the period, so waiting avoids unnecessary inventory.';
  if (chosen.type === 'TRANSFER_AND_BUY') {
    return `Transfer ${chosen.transferUnits} and buy ${chosen.purchaseUnits}. `
      + `${expectedResult.shortagePrevented ? 'That prevents the projected shortage' : 'Some shortage risk remains'}`
      + `${expectedResult.cashSavedVersusFullPurchaseMinor ? ` while preserving ${money(expectedResult.cashSavedVersusFullPurchaseMinor, currency)} compared with buying the whole requirement` : ''}.`;
  }
  if (chosen.type === 'TRANSFER') return `Move ${chosen.quantityUnits} units already owned. `
    + `${expectedResult.shortagePrevented ? 'That covers the shortage without buying the same stock again.' : `${expectedResult.expectedShortageUnits} units may still be short.`}`;
  if (chosen.type === 'SUBSTITUTE') return `Use the verified substitute ${chosen.label.replace(/^Use /, '')}; it covers the requirement without a new purchase.`;
  if (chosen.type === 'EXPEDITE') return `${chosen.label}. It is the lowest-risk evidenced option that reaches the shortage in time.`;
  if (chosen.type.startsWith('BUY')) return `${chosen.label}: ${chosen.quantityUnits} units for ${money(chosen.totalCostMinor, currency)}.`
    + `${expectedResult.expectedShortageUnits > 0
      ? ` About ${expectedResult.expectedShortageUnits} units may still be short before it arrives.` : ''} `
    + `${cash.known ? 'It fits the current cash boundary.'
      : 'Cash is not yet verified, so execution must remain separately authorized.'}`;
  const blocked = (chosen.reasons || []).join(' ');
  return `Do not place a purchase yet. ${blocked}`;
}

function cashPosition(db, workspaceId, { asOf = day(new Date().toISOString()), horizonDays = 30,
  reserveMinor = 0 } = {}) {
  const horizonEnd = addDays(asOf, horizonDays);
  const settings = db.prepare('SELECT enabled FROM accounting_settings WHERE workspace_id = ?').get(workspaceId);
  const cash = db.prepare(`SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS n,
      COUNT(*) AS evidence_count
    FROM accounting_journal_lines l
    JOIN accounting_journal_entries e ON e.id = l.entry_id AND e.status = 'POSTED'
    JOIN accounting_accounts a ON a.id = l.account_id AND a.subtype = 'CASH'
    WHERE l.workspace_id = ? AND e.posting_date <= ?`).get(workspaceId, asOf);
  const bills = db.prepare(`SELECT COALESCE(SUM(balance_minor), 0) AS n
    FROM accounting_supplier_bills WHERE workspace_id = ?
      AND status IN ('OPEN','PARTIALLY_PAID') AND due_date IS NOT NULL AND due_date <= ?`)
    .get(workspaceId, horizonEnd);
  const commitments = db.prepare(`SELECT po.id AS purchase_order_id, po.order_date, po.expected_date,
      s.payment_terms, pol.id AS purchase_order_line_id,
      ROUND(pol.quantity_units * COALESCE(pol.unit_cost, 0) * 100) AS ordered_minor,
      COALESCE(SUM(CASE WHEN b.status <> 'VOID' THEN bl.line_total_minor ELSE 0 END), 0) AS billed_minor
    FROM purchase_order_lines pol JOIN purchase_orders po ON po.id = pol.purchase_order_id
    JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN accounting_supplier_bill_lines bl ON bl.purchase_order_line_id = pol.id
    LEFT JOIN accounting_supplier_bills b ON b.id = bl.bill_id
    WHERE pol.workspace_id = ?
      AND po.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED','RECEIVED')
    GROUP BY po.id, pol.id`).all(workspaceId);
  let committedMinor = 0;
  let unknownPaymentTerms = 0;
  for (const row of commitments) {
    const remaining = Math.max(0, Number(row.ordered_minor || 0) - Number(row.billed_minor || 0));
    if (!remaining) continue;
    const terms = paymentDays(row.payment_terms);
    if (terms === null) unknownPaymentTerms += 1;
    // Unknown terms are treated conservatively as immediate. A known future
    // term is included only if cash can actually fall due inside this horizon.
    const due = addDays(row.expected_date || row.order_date || asOf, terms ?? 0);
    if (due <= horizonEnd) committedMinor += remaining;
  }
  const known = Boolean(settings?.enabled && Number(cash.evidence_count || 0) > 0);
  const cashMinor = Number(cash.n || 0);
  const upcomingObligationsMinor = Math.round(Number(bills.n || 0) + committedMinor);
  return { known, cashMinor, upcomingObligationsMinor, reserveMinor:Number(reserveMinor || 0),
    availableForNewCommitmentsMinor:known
      ? Math.max(0, cashMinor - upcomingObligationsMinor - Number(reserveMinor || 0)) : 0,
    asOf, horizonEnd, evidence:{ postedCashLines:Number(cash.evidence_count || 0),
      supplierBillsDueMinor:Number(bills.n || 0), purchaseCommitmentsMinor:committedMinor,
      unknownPaymentTerms } };
}

function activeEvidence(db, workspaceId, skuId, asOf) {
  return db.prepare(`SELECT * FROM inventory_decision_evidence
    WHERE workspace_id = ? AND sku_id = ? AND active = 1
      AND (effective_from IS NULL OR effective_from <= ?)
      AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY created_at`).all(workspaceId, skuId, asOf, asOf)
    .map((row) => ({ ...row, value:parse(row.value, {}) }));
}

function historicalLandedCostPerUnit(db, workspaceId, skuId) {
  const row = db.prepare(`SELECT SUM(x.amount_minor) AS amount_minor, SUM(x.quantity_units) AS quantity_units
    FROM (SELECT a.receipt_line_id, SUM(a.amount_minor) AS amount_minor,
        MAX(rl.quantity_units) AS quantity_units
      FROM landed_cost_allocations a JOIN purchase_order_receipt_lines rl ON rl.id = a.receipt_line_id
      JOIN landed_cost_documents d ON d.id = a.document_id AND d.status = 'APPLIED'
      WHERE a.workspace_id = ? AND a.sku_id = ? GROUP BY a.receipt_line_id) x`).get(workspaceId, skuId);
  return Number(row?.quantity_units || 0) > 0
    ? Math.round(Number(row.amount_minor || 0) / Number(row.quantity_units)) : null;
}

function forSku(db, workspaceId, context, options = {}) {
  const asOf = day(new Date(options.now || Date.now()).toISOString());
  const workspaceContext = options.workspaceContext || {};
  const evidence = activeEvidence(db, workspaceId, context.sku.skuId, asOf);
  const byKind = (kind) => evidence.filter((row) => row.kind === kind);
  const selling = require('../pricing/price-service').currentForSku(db, workspaceId, context.sku.skuId);
  const landed = historicalLandedCostPerUnit(db, workspaceId, context.sku.skuId);
  const supplierComparison = require('./supplier-reliability').compareForSku(db, workspaceId,
    context.sku.skuId, { now:options.now || Date.now() });
  const suppliers = supplierComparison.candidates.map((candidate) => {
    const source = (context.suppliers || []).find((row) => row.supplierId === candidate.supplierId) || {};
    const supplier = db.prepare('SELECT payment_terms FROM suppliers WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, candidate.supplierId);
    const expedite = byKind('EXPEDITE').find((row) => row.supplier_id === candidate.supplierId);
    return { ...source, ...candidate, unitCostMinor:candidate.unitCost === null ? null
      : Math.round(candidate.unitCost * 100), landedCostPerUnitMinor:landed,
    unitsPerPurchaseUnit:source.unitsPerPurchaseUnit || 1,
    purchaseUnit:source.purchaseUnit || 'unit', paymentTerms:supplier?.payment_terms || null,
    onTimeRate:candidate.reliability?.onTimeRate ?? null,
    reliabilityOrders:candidate.reliability?.ratedOrders || 0,
    expeditedLeadTimeDays:expedite?.value.leadTimeDays,
    expeditedUnitCostMinor:expedite?.value.unitCostMinor,
    expediteEvidence:expedite ? { sourceType:expedite.source_type, sourceId:expedite.source_id } : null };
  }).sort((a, b) => Number(b.preferred) - Number(a.preferred));

  const timing = byKind('TRANSFER_TIMING');
  const transferCost = byKind('TRANSFER_COST');
  const transfers = (context.transfers?.transfers || context.transfers || []).map((move) => {
    const time = timing.find((row) => !row.location_id || row.location_id === move.toLocationId);
    const cost = transferCost.find((row) => !row.location_id || row.location_id === move.toLocationId);
    return { ...move, arrivalDays:time?.value.days, costMinor:cost?.value.amountMinor };
  });
  const substitutes = byKind('SUBSTITUTE').map((row) => {
    const balance = db.prepare(`SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances
      WHERE workspace_id = ? AND sku_id = ?`).get(workspaceId, row.related_sku_id);
    const related = db.prepare(`SELECT i.name, s.variant_label FROM skus s JOIN items i ON i.id=s.item_id
      WHERE s.workspace_id=? AND s.id=?`).get(workspaceId, row.related_sku_id);
    return { skuId:row.related_sku_id,
      displayName:related ? (related.variant_label ? `${related.name} / ${related.variant_label}` : related.name) : null,
      spareUnits:Number(balance.n || 0), unitsPerRequiredUnit:row.value.unitsPerRequiredUnit,
      verified:Boolean(row.verified_by_user_id), evidenceId:row.id };
  });
  const promotion = byKind('PROMOTION')[0];
  const seasonal = byKind('SEASONALITY')[0];
  const stockout = byKind('STOCKOUT_COST')[0];
  const storage = byKind('STORAGE_COST')[0];
  const target = context.policy.targetStock ?? context.advice?.recommended?.target ?? null;
  const baseRequired = target === null ? context.projection.shortfallUnits
    : Math.max(context.projection.shortfallUnits,
      Math.ceil(target - context.projection.onHand - context.projection.onOrder));
  // These are workspace-wide facts. A planning sweep may assess thousands of
  // SKUs, but cash and total inventory value do not change while that read-only
  // sweep is running. Accept a frozen snapshot so the caller reads each once
  // rather than rescanning the whole accounting book once per SKU.
  const inventoryPosition = workspaceContext.inventoryPosition
    || require('./goals').inventoryPosition(db, workspaceId, context.goals);
  const cash = workspaceContext.cash || cashPosition(db, workspaceId, {
    asOf, horizonDays:context.horizonDays,
    reserveMinor:context.goals.cashReserveMinor || 0,
  });
  return optimize({ asOf, horizonDays:context.horizonDays, requiredUnits:baseRequired,
    daysUntilStockout:context.projection.daysUntilStockout,
    cash,
    currency:suppliers[0]?.currency || 'USD',
    sellingPriceMinor:selling.amount_minor,
    stockoutCostPerUnitMinor:stockout?.value.amountMinor ?? (selling.amount_minor !== null
      && suppliers[0]?.unitCostMinor !== null ? Math.max(0, selling.amount_minor
        - suppliers[0].unitCostMinor - Number(landed || 0)) : null),
    storageCostPerUnitMinor:storage?.value.amountMinor,
    inventoryCapRemainingMinor:inventoryPosition.capMinor === null ? null
      : Math.max(0, inventoryPosition.capMinor - inventoryPosition.heldMinor),
    objective:{ serviceLevel:context.goals.serviceLevel,
      prioritiseCoreProducts:context.goals.prioritiseCoreProducts },
    demand:{ confidence:context.forecast.confidence,
      dailyRate:context.forecast.dailyRate,
      promotionMultiplier:promotion?.value.demandMultiplier,
      promotionEvidence:promotion ? { sourceType:promotion.source_type, sourceId:promotion.source_id } : null,
      seasonalMultiplier:seasonal?.value.demandMultiplier || 1,
      seasonalEvidence:seasonal ? { sourceType:seasonal.source_type, sourceId:seasonal.source_id } : null,
      modelId:context.forecast.model?.id || null },
    transfers, suppliers, substitutes,
    uncertainty:[...(landed === null ? ['No historical landed cost is available; supplier price is compared without invented freight or duty.'] : []),
      ...(context.forecast.confidenceReasons || [])],
  });
}

function hydrate(row) {
  return row && { id:row.id, workspaceId:row.workspace_id, skuId:row.sku_id,
    asOf:row.as_of, horizonEnd:row.horizon_end, objective:parse(row.objective, {}),
    constraints:parse(row.constraints, {}), alternatives:parse(row.alternatives, []),
    chosen:parse(row.chosen_plan, {}), expectedResult:parse(row.expected_result, {}),
    actualResult:parse(row.actual_result, {}), confidence:row.confidence,
    uncertainty:parse(row.uncertainty, []), status:row.status, shadow:Boolean(row.shadow),
    idempotencyKey:row.idempotency_key, createdAt:row.created_at, scoredAt:row.scored_at };
}

function record(db, workspaceId, skuId, plan) {
  const digest = crypto.createHash('sha256').update(json({ skuId, asOf:plan.asOf,
    chosen:plan.chosen, constraints:plan.constraints })).digest('hex').slice(0, 24);
  const key = `adaptive:${skuId}:${plan.asOf}:${digest}`;
  const existing = db.prepare(`SELECT * FROM inventory_decision_plans
    WHERE workspace_id=? AND idempotency_key=?`).get(workspaceId, key);
  if (existing) return hydrate(existing);
  const id = newId('iplan'); const now = nowIso();
  db.prepare(`INSERT INTO inventory_decision_plans
    (id,workspace_id,sku_id,as_of,horizon_end,objective,constraints,alternatives,chosen_plan,
     expected_result,actual_result,confidence,uncertainty,status,shadow,idempotency_key,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, skuId, plan.asOf,
    plan.horizonEnd, json(plan.objective), json(plan.constraints), json(plan.alternatives),
    json(plan.chosen), json(plan.expectedResult), '{}', plan.confidence, json(plan.uncertainty),
    plan.status, 1, key, now);
  return hydrate(db.prepare('SELECT * FROM inventory_decision_plans WHERE id=?').get(id));
}

function recordOutcome(db, workspaceId, planId, actual, { scoredAt = nowIso() } = {}) {
  const row = db.prepare('SELECT * FROM inventory_decision_plans WHERE workspace_id=? AND id=?')
    .get(workspaceId, planId);
  if (!row) throw new ValidationError('That inventory decision plan does not exist.');
  if (row.status === 'SCORED') return hydrate(row);
  db.prepare(`UPDATE inventory_decision_plans SET actual_result=?, status='SCORED', scored_at=?
    WHERE workspace_id=? AND id=?`).run(json(actual), scoredAt, workspaceId, planId);
  return hydrate(db.prepare('SELECT * FROM inventory_decision_plans WHERE id=?').get(planId));
}

function scoreDue(db, workspaceId, { now = Date.now() } = {}) {
  const today = day(new Date(now).toISOString());
  const rows = db.prepare(`SELECT * FROM inventory_decision_plans
    WHERE workspace_id=? AND status IN ('SHADOW','INFEASIBLE') AND horizon_end < ?`)
    .all(workspaceId, today);
  return rows.map((row) => {
    const expected = parse(row.expected_result, {});
    const onHand = db.prepare(`SELECT COALESCE(SUM(on_hand),0) n FROM balances
      WHERE workspace_id=? AND sku_id=?`).get(workspaceId, row.sku_id).n;
    const demand = db.prepare(`SELECT COALESCE(SUM(ABS(quantity_delta)),0) n FROM movements
      WHERE workspace_id=? AND sku_id=? AND quantity_delta < 0 AND occurred_at >= ? AND occurred_at < ?`)
      .get(workspaceId, row.sku_id, `${row.as_of}T00:00:00.000Z`, `${addDays(row.horizon_end, 1)}T00:00:00.000Z`).n;
    const recommendation = db.prepare(`SELECT status, decided_by_user_id, decided_at, resulting_action
      FROM planning_recommendations WHERE workspace_id=? AND evidence LIKE ?
      ORDER BY created_at DESC LIMIT 1`).get(workspaceId, `%\"adaptiveDecisionPlanId\":\"${row.id}\"%`);
    return recordOutcome(db, workspaceId, row.id, { observedAt:today,
      onHandUnits:Number(onHand || 0), outboundUnits:Number(demand || 0),
      forecastDriftUnits:Number(demand || 0) - Number(expected.plannedRequirementUnits || 0),
      shortageObserved:Number(onHand || 0) <= 0,
      ownerIntervention:Boolean(recommendation?.decided_by_user_id),
      ownerDecision:recommendation ? { status:recommendation.status,
        decidedAt:recommendation.decided_at, resultingAction:recommendation.resulting_action } : null,
      evidence:'Current inventory balance and immutable movement history.' });
  });
}

function recordEvidence(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.OPERATE, 'record inventory planning evidence');
  if (!['PROMOTION','SEASONALITY','EXPEDITE','SUBSTITUTE','TRANSFER_TIMING','TRANSFER_COST',
    'STOCKOUT_COST','STORAGE_COST'].includes(input.kind)) throw new ValidationError('That planning evidence type is not supported.');
  if (!['owner','document','provider','record'].includes(input.sourceType)) {
    throw new ValidationError('Planning evidence needs a real source.');
  }
  const id = newId('ipev'); const now = nowIso();
  db.prepare(`INSERT INTO inventory_decision_evidence
    (id,workspace_id,sku_id,kind,related_sku_id,supplier_id,location_id,value,source_type,
     source_id,verified_by_user_id,effective_from,effective_to,active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(id, ctx.workspaceId, input.skuId,
    input.kind, input.relatedSkuId || null, input.supplierId || null, input.locationId || null,
    json(input.value || {}), input.sourceType, input.sourceId || null,
    input.verified ? ctx.actorId : null, input.effectiveFrom || null, input.effectiveTo || null, now, now);
  return db.prepare('SELECT * FROM inventory_decision_evidence WHERE id=?').get(id);
}

module.exports = { optimize, forSku, cashPosition, record, recordOutcome, scoreDue,
  recordEvidence, roundToSupplier, paymentDays, hydrate };

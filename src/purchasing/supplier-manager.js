'use strict';

/**
 * Mission 12 — deterministic supplier consequence and response planner.
 *
 * A supplier message is evidence.  This module records that evidence, measures
 * its operational consequences and prepares bounded responses.  It deliberately
 * cannot send mail, place a PO, change stock or post money: those remain owned
 * by supplier-communications, po-service, inventory-engine and accounting.
 */
const { newId, nowIso } = require('../lib/util');
const permissions = require('../actions/permissions');
const planning = require('../forecasting/planning-service');
const supplierReliability = require('../forecasting/supplier-reliability');
const connections = require('../connections/service');

const parse = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
const encode = (value) => JSON.stringify(value ?? null);
const number = (value) => value === null || value === undefined || value === ''
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const dateOnly = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
};
const displayMoney = (minor, currency = 'USD') => new Intl.NumberFormat('en-US', {
  style:'currency', currency:currency || 'USD', maximumFractionDigits:2,
}).format(Number(minor || 0) / 100);

function hydratePlan(row) {
  if (!row) return null;
  return { id:row.id, workspaceId:row.workspace_id, supplierId:row.supplier_id,
    purchaseOrderId:row.purchase_order_id, purchaseOrderLineId:row.purchase_order_line_id,
    skuId:row.sku_id, sourceDocumentId:row.source_document_id, summary:row.summary,
    consequences:parse(row.consequences, {}), alternatives:parse(row.alternatives, []),
    chosenPlan:parse(row.chosen_plan, {}), evidence:parse(row.evidence, []),
    materiality:row.materiality, status:row.status,
    expectedOutcome:parse(row.expected_outcome, {}), actualOutcome:parse(row.actual_outcome, {}),
    requiresPurchasingAuthority:Boolean(row.requires_purchasing_authority),
    requiresCommunicationAuthority:Boolean(row.requires_communication_authority),
    idempotencyKey:row.idempotency_key, createdAt:row.created_at, updatedAt:row.updated_at };
}

function addFact(db, input) {
  const existing = db.prepare(`SELECT * FROM supplier_operational_facts
    WHERE workspace_id=? AND source_document_id=? AND fact_key=?`)
    .get(input.workspaceId, input.documentId, input.factKey);
  if (existing) return existing;
  const at = nowIso();
  db.prepare(`INSERT INTO supplier_operational_facts
    (id,workspace_id,supplier_id,purchase_order_id,purchase_order_line_id,sku_id,
     related_supplier_id,related_sku_id,fact_kind,fact_key,value,source_document_id,
     confidence,observed_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(newId('sfact'), input.workspaceId, input.supplierId, input.purchaseOrderId || null,
      input.purchaseOrderLineId || null, input.skuId || null, input.relatedSupplierId || null,
      input.relatedSkuId || null, input.kind, input.factKey, encode(input.value || {}),
      input.documentId, Math.max(0, Math.min(1, Number(input.confidence ?? 1))),
      input.observedAt || at, at);
  return db.prepare(`SELECT * FROM supplier_operational_facts
    WHERE workspace_id=? AND source_document_id=? AND fact_key=?`)
    .get(input.workspaceId, input.documentId, input.factKey);
}

function factsFromDocument(db, message, document, matched, discrepancies = []) {
  if (!document?.supplier_id) return [];
  const raw = parse(document.facts, {});
  const common = { workspaceId:document.workspace_id, supplierId:document.supplier_id,
    purchaseOrderId:document.purchase_order_id, documentId:document.id,
    confidence:Number(document.confidence || 0), observedAt:message.received_at };
  const created = [];
  const add = (entry) => created.push(addFact(db, { ...common, ...entry }));
  for (const [index, entry] of (matched || []).entries()) {
    const proposed = entry.proposed || {};
    const line = entry.line;
    if (!line) continue;
    const lineCommon = { purchaseOrderLineId:line.id, skuId:line.sku_id };
    const confirmed = number(proposed.confirmedQuantity ?? entry.quantity);
    const shipped = number(proposed.shippedQuantity);
    const backordered = number(proposed.backorderedQuantity);
    const unitPrice = number(entry.unitPrice ?? proposed.unitPrice);
    if (confirmed !== null) add({ ...lineCommon, kind:'ACKNOWLEDGEMENT', factKey:`line:${line.id}:confirmed`,
      value:{ confirmedUnits:confirmed, orderedUnits:Number(line.quantity_units) } });
    if (confirmed !== null && confirmed < Number(line.quantity_units)) {
      add({ ...lineCommon, kind:'CAPACITY', factKey:`line:${line.id}:capacity`,
        value:{ availableUnits:confirmed, requestedUnits:Number(line.quantity_units),
          shortUnits:Number(line.quantity_units) - confirmed } });
    }
    if (backordered !== null && backordered > 0) add({ ...lineCommon, kind:'CONSTRAINT',
      factKey:`line:${line.id}:backorder`, value:{ constraintType:'BACKORDER', units:backordered,
        expectedArrivalDate:dateOnly(proposed.expectedArrivalDate || raw.expectedArrivalDate) } });
    if (shipped !== null) add({ ...lineCommon, kind:'SHIPMENT', factKey:`line:${line.id}:shipment`,
      value:{ shippedUnits:shipped, trackingNumber:raw.trackingNumber || null,
        expectedArrivalDate:dateOnly(proposed.expectedArrivalDate || raw.expectedArrivalDate) } });
    if (unitPrice !== null) add({ ...lineCommon, kind:'PRICE', factKey:`line:${line.id}:price`,
      value:{ unitPrice, priorUnitPrice:number(line.unit_cost), currency:raw.currency || 'USD' } });
    const eta = dateOnly(proposed.expectedArrivalDate || raw.expectedArrivalDate);
    if (eta) add({ ...lineCommon, kind:'DATE', factKey:`line:${line.id}:arrival`,
      value:{ expectedArrivalDate:eta } });
    const substitute = proposed.substitution || proposed.substitute || null;
    if (substitute) add({ ...lineCommon, kind:'SUBSTITUTION', factKey:`line:${line.id}:substitution:${index}`,
      relatedSkuId:substitute.skuId || null, value:{ ...substitute, proposed:true } });
  }
  for (const [index, constraint] of (Array.isArray(raw.constraints) ? raw.constraints : []).entries()) {
    add({ kind:'CONSTRAINT', factKey:`constraint:${index}`, value:constraint });
  }
  for (const [index, offer] of (Array.isArray(raw.offers) ? raw.offers : []).entries()) {
    add({ kind:'OFFER', factKey:`offer:${index}`, skuId:offer.skuId || null,
      relatedSupplierId:offer.supplierId || null, value:offer });
  }
  for (const [index, substitute] of (Array.isArray(raw.substitutions) ? raw.substitutions : []).entries()) {
    add({ kind:'SUBSTITUTION', factKey:`substitution:${index}`, skuId:substitute.forSkuId || null,
      relatedSkuId:substitute.skuId || null, value:{ ...substitute, proposed:true } });
  }
  if (number(raw.depositAmount) !== null) add({ kind:'DEPOSIT', factKey:'deposit',
    value:{ amount:number(raw.depositAmount), currency:raw.currency || 'USD', dueDate:dateOnly(raw.depositDueDate) } });
  if (number(raw.creditAmount) !== null || document.document_type === 'credit') add({ kind:'CREDIT', factKey:'credit',
    value:{ amount:number(raw.creditAmount), currency:raw.currency || 'USD', reference:document.document_reference } });
  if (raw.dispute || document.document_type === 'dispute') add({ kind:'DISPUTE', factKey:'dispute',
    value:{ reason:raw.disputeReason || raw.dispute || 'Supplier disputed part of the purchasing record.' } });
  for (const [index, discrepancy] of discrepancies.entries()) {
    add({ kind:'DISPUTE', factKey:`discrepancy:${index}`, skuId:discrepancy.skuId || null,
      purchaseOrderLineId:discrepancy.lineId || null, value:discrepancy });
  }
  return created;
}

function customerConsequences(db, workspaceId, skuId, availableUnits, expectedSupplyUnits, expectedDate) {
  const rows = db.prepare(`SELECT so.id,so.order_number,so.needed_by,so.allocation_priority,
      sol.quantity_ordered-sol.quantity_fulfilled AS outstanding_units
    FROM sales_order_lines sol JOIN sales_orders so ON so.id=sol.sales_order_id
    WHERE sol.workspace_id=? AND sol.sku_id=?
      AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
      AND sol.quantity_ordered>sol.quantity_fulfilled
    ORDER BY CASE WHEN so.needed_by IS NULL THEN 1 ELSE 0 END,so.needed_by,so.allocation_priority DESC`)
    .all(workspaceId, skuId);
  let cover = Math.max(0, Number(availableUnits || 0) + Number(expectedSupplyUnits || 0));
  return rows.map((row) => {
    const outstanding = Number(row.outstanding_units);
    const covered = Math.min(cover, outstanding);
    cover -= covered;
    const dateRisk = Boolean(row.needed_by && expectedDate && row.needed_by < expectedDate);
    return { orderId:row.id, orderNumber:row.order_number, neededBy:row.needed_by,
      outstandingUnits:outstanding, coveredUnits:covered,
      uncoveredUnits:Math.max(0, outstanding - covered), atRisk:dateRisk || covered < outstanding };
  });
}

function makeDrafts(db, plan, context) {
  const now = nowIso();
  const insert = db.prepare(`INSERT OR IGNORE INTO supplier_response_drafts
    (id,workspace_id,response_plan_id,draft_type,supplier_id,purchase_order_id,subject,body,
     proposed_payload,required_permission,status,source_document_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'PREPARED',?,?,?)`);
  const shortage = Number(context.shortUnits || 0);
  if (shortage || context.dateChanged || context.disputes.length || context.hasSubstitution) {
    const exact = shortage ? `You confirmed ${context.confirmedUnits} of ${context.orderedUnits} units. ` : '';
    const timing = context.expectedDate ? `The latest evidenced arrival date is ${context.expectedDate}. ` : '';
    insert.run(newId('srdraft'), plan.workspaceId, plan.id,
      context.disputes.length || context.hasSubstitution ? 'NEGOTIATION' : 'FOLLOW_UP', plan.supplierId, plan.purchaseOrderId,
      `${context.poNumber}: confirm supply plan`,
      `${exact}${timing}Please confirm the quantity and delivery date you can commit to.`,
      encode({ shortUnits:shortage, confirmedUnits:context.confirmedUnits,
        orderedUnits:context.orderedUnits, expectedDate:context.expectedDate }),
      permissions.MANAGE_SUPPLIERS, plan.sourceDocumentId, now, now);
  }
  const chosen = plan.chosenPlan || {};
  if (['BUY_ALTERNATE','TRANSFER_AND_BUY'].includes(chosen.type) && chosen.supplierId
      && chosen.supplierId !== plan.supplierId && Number(chosen.buyUnits || chosen.units || 0) > 0) {
    insert.run(newId('srdraft'), plan.workspaceId, plan.id, 'ALTERNATE_PO', chosen.supplierId,
      plan.purchaseOrderId, null, null, encode({ supplierId:chosen.supplierId, skuId:plan.skuId,
        quantityUnits:Number(chosen.buyUnits || chosen.units), unitCostMinor:chosen.unitCostMinor,
        sourceResponsePlanId:plan.id }), permissions.CREATE_PO, plan.sourceDocumentId, now, now);
  }
  if (context.customerRisks.some((entry) => entry.atRisk)) {
    insert.run(newId('srdraft'), plan.workspaceId, plan.id, 'CUSTOMER_PROMISE', null,
      plan.purchaseOrderId, null, null, encode({ orders:context.customerRisks.filter((entry) => entry.atRisk),
      proposedDate:context.expectedDate }), permissions.MANAGE_SALES, plan.sourceDocumentId, now, now);
  }
  const depositAmount = number(context.raw.depositAmount);
  if (depositAmount !== null && depositAmount > 0) {
    insert.run(newId('srdraft'), plan.workspaceId, plan.id, 'DEPOSIT_PAYMENT', plan.supplierId,
      plan.purchaseOrderId, null, null, encode({ amountMinor:Math.round(depositAmount * 100),
        currency:context.raw.currency || 'USD', paymentDate:dateOnly(context.raw.depositDueDate),
        sourceDocumentId:plan.sourceDocumentId }), permissions.RECORD_PAYMENTS,
      plan.sourceDocumentId, now, now);
  }
  const creditAmount = number(context.raw.creditAmount);
  if ((creditAmount !== null && creditAmount > 0) || context.documentType === 'credit') {
    insert.run(newId('srdraft'), plan.workspaceId, plan.id, 'SUPPLIER_CREDIT', plan.supplierId,
      plan.purchaseOrderId, null, null, encode({ amountMinor:creditAmount === null ? null : Math.round(creditAmount * 100),
        currency:context.raw.currency || 'USD', reference:context.documentReference,
        sourceDocumentId:plan.sourceDocumentId }), permissions.MANAGE_ACCOUNTING,
      plan.sourceDocumentId, now, now);
  }
}

function scorecard(db, workspaceId, supplierId, { asOf = nowIso().slice(0, 10) } = {}) {
  const reliability = supplierReliability.forSupplier(db, workspaceId, supplierId) || {};
  const evidence = db.prepare(`SELECT fact_kind,COUNT(*) n FROM supplier_operational_facts
    WHERE workspace_id=? AND supplier_id=? AND observed_at<? GROUP BY fact_kind`)
    .all(workspaceId, supplierId, `${asOf}T23:59:59.999Z`);
  const counts = Object.fromEntries(evidence.map((row) => [row.fact_kind, Number(row.n)]));
  const metrics = { orderCount:Number(reliability.orderCount || 0),
    onTimeRate:reliability.onTimeRate ?? null, fillRate:reliability.fillRate ?? null,
    partialRate:reliability.partialRate ?? null, acknowledgementFacts:counts.ACKNOWLEDGEMENT || 0,
    capacityConstraints:(counts.CAPACITY || 0) + (counts.CONSTRAINT || 0),
    disputes:counts.DISPUTE || 0, priceFacts:counts.PRICE || 0,
    enoughEvidence:Boolean(reliability.enoughEvidence), summary:reliability.summary };
  const existing = db.prepare(`SELECT * FROM supplier_scorecards
    WHERE workspace_id=? AND supplier_id=? AND as_of=?`).get(workspaceId, supplierId, asOf);
  if (existing) {
    db.prepare('UPDATE supplier_scorecards SET metrics=?,evidence=?,created_at=? WHERE id=?')
      .run(encode(metrics), encode({ operationalFactCounts:counts,
        deliveredOrderEvidence:reliability.orderCount || 0 }), nowIso(), existing.id);
    return { ...existing, metrics, evidence:{ operationalFactCounts:counts } };
  }
  const id = newId('sscore');
  db.prepare(`INSERT INTO supplier_scorecards
    (id,workspace_id,supplier_id,as_of,metrics,evidence,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, workspaceId, supplierId, asOf, encode(metrics),
      encode({ operationalFactCounts:counts, deliveredOrderEvidence:reliability.orderCount || 0 }), nowIso());
  return { id, workspaceId, supplierId, asOf, metrics,
    evidence:{ operationalFactCounts:counts, deliveredOrderEvidence:reliability.orderCount || 0 } };
}

function capture(db, message, document, matched = [], discrepancies = []) {
  if (!document?.supplier_id || !document.purchase_order_id) return [];
  const facts = factsFromDocument(db, message, document, matched, discrepancies);
  const raw = parse(document.facts, {});
  const plans = [];
  for (const entry of matched) {
    const line = entry.line;
    if (!line) continue;
    const proposed = entry.proposed || {};
    const confirmed = number(proposed.confirmedQuantity ?? entry.quantity);
    const ordered = Number(line.quantity_units);
    const shortUnits = confirmed === null ? 0 : Math.max(0, ordered - confirmed);
    const expectedDate = dateOnly(proposed.expectedArrivalDate || raw.expectedArrivalDate);
    const balance = db.prepare(`SELECT COALESCE(SUM(on_hand),0) n FROM balances
      WHERE workspace_id=? AND sku_id=?`).get(document.workspace_id, line.sku_id);
    let adaptive = null;
    try { adaptive = planning.forSku(db, document.workspace_id, line.sku_id); } catch { adaptive = null; }
    const customerRisks = customerConsequences(db, document.workspace_id, line.sku_id,
      Number(balance.n || 0), confirmed ?? ordered, expectedDate);
    const disputes = discrepancies.filter((item) => !item.skuId || item.skuId === line.sku_id);
    const priceChange = disputes.find((item) => item.type === 'price');
    const dateChanged = Boolean(expectedDate && raw.previousExpectedArrivalDate
      && expectedDate !== dateOnly(raw.previousExpectedArrivalDate));
    const atRiskUnits = customerRisks.reduce((sum, risk) => sum + Number(risk.uncoveredUnits || 0), 0);
    const financialDecision = number(raw.depositAmount) > 0 || number(raw.creditAmount) > 0
      || document.document_type === 'credit';
    const materiality = atRiskUnits > 0 || priceChange || raw.substitutions?.length || financialDecision ? 'HIGH'
      : shortUnits > 0 || expectedDate || disputes.length ? 'MEDIUM' : 'LOW';
    const alternatives = adaptive?.adaptivePlan?.alternatives || [
      { type:'WAIT', feasible:true, explanation:'Keep the evidenced supplier position and monitor it.' },
    ];
    const chosen = adaptive?.adaptivePlan?.chosen || alternatives.find((item) => item.feasible) || {};
    const summary = shortUnits
      ? `${ordered - shortUnits} of ${ordered} units are confirmed; ${shortUnits} remain uncovered by this supplier.`
      : expectedDate ? `${ordered} units are currently expected by ${expectedDate}.`
        : `${document.document_type.replaceAll('_', ' ')} was matched to this purchase line.`;
    const evidence = facts.filter((fact) => !fact.sku_id || fact.sku_id === line.sku_id)
      .map((fact) => ({ factId:fact.id, kind:fact.fact_kind, sourceDocumentId:document.id }));
    const idempotencyKey = `supplier-response:${document.id}:${line.id}`;
    const existing = db.prepare(`SELECT * FROM supplier_response_plans
      WHERE workspace_id=? AND idempotency_key=?`).get(document.workspace_id, idempotencyKey);
    if (existing) { plans.push(hydratePlan(existing)); continue; }
    const id = newId('srplan'); const now = nowIso();
    const requiresPurchase = ['BUY','BUY_ALTERNATE','TRANSFER_AND_BUY','EXPEDITE'].includes(chosen.type);
    const requiresCommunication = shortUnits > 0 || Boolean(expectedDate) || disputes.length > 0;
    const status = materiality === 'HIGH' ? 'NEEDS_APPROVAL' : requiresCommunication ? 'DRAFTED' : 'SHADOW';
    const consequences = { orderedUnits:ordered, confirmedUnits:confirmed, shortUnits,
      expectedDate, onHandUnits:Number(balance.n || 0), customerRisks, atRiskUnits,
      cashBoundary:adaptive?.adaptivePlan?.constraints?.cash || null,
      priceChange:priceChange || null, inventoryWasChanged:false, moneyWasChanged:false };
    db.prepare(`INSERT INTO supplier_response_plans
      (id,workspace_id,supplier_id,purchase_order_id,purchase_order_line_id,sku_id,source_document_id,
       summary,consequences,alternatives,chosen_plan,evidence,materiality,status,expected_outcome,
       actual_outcome,requires_purchasing_authority,requires_communication_authority,idempotency_key,
       created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, document.workspace_id, document.supplier_id, document.purchase_order_id, line.id,
        line.sku_id, document.id, summary, encode(consequences), encode(alternatives), encode(chosen),
        encode(evidence), materiality, status, encode(adaptive?.adaptivePlan?.expectedResult || {}), '{}',
        requiresPurchase ? 1 : 0, requiresCommunication ? 1 : 0, idempotencyKey, now, now);
    const plan = hydratePlan(db.prepare('SELECT * FROM supplier_response_plans WHERE id=?').get(id));
    makeDrafts(db, plan, { poNumber:raw.poNumber || document.document_reference || 'Purchase order',
      orderedUnits:ordered, confirmedUnits:confirmed, shortUnits, expectedDate, dateChanged,
      customerRisks, disputes, hasSubstitution:Boolean(raw.substitutions?.length), raw,
      documentType:document.document_type, documentReference:document.document_reference });
    if (status === 'NEEDS_APPROVAL') {
      const responseCandidate = { kind:'supplier_response_plan', responsePlanId:id,
        purchaseOrderId:document.purchase_order_id, supplierId:document.supplier_id };
      // A price/quantity mismatch already owns one document-review decision.
      // Enrich that same decision rather than making the owner settle two cards
      // about one supplier message.
      const review = db.prepare(`SELECT * FROM connection_issues
        WHERE workspace_id=? AND connector_id=? AND issue_type='SUPPLIER_DOCUMENT_REVIEW'
          AND fingerprint=? AND status='OPEN'`).get(document.workspace_id, message.connector_id,
        `supplier-document:${document.id}`);
      if (review) {
        const candidates = parse(review.candidate_matches, []);
        if (!candidates.some((candidate) => candidate.responsePlanId === id)) candidates.push(responseCandidate);
        db.prepare(`UPDATE connection_issues SET title=?,detail=?,resolution_hint=?,candidate_matches=?,updated_at=?
          WHERE id=?`).run(
          `Supplier change affects ${atRiskUnits ? `${atRiskUnits} committed unit${atRiskUnits === 1 ? '' : 's'}` : 'the purchasing plan'}`,
          `${review.detail || ''} ${summary} Foundry compared ${alternatives.length} response options and changed neither stock nor money.`.trim(),
          'Review the consequence and approve communication and purchasing separately.',
          encode(candidates), nowIso(), review.id);
      } else {
        connections.issue(db, { workspaceId:document.workspace_id, connectorId:message.connector_id,
          externalEventId:message.external_message_id, issueType:'SUPPLIER_RESPONSE_DECISION',
          fingerprint:`supplier-response:${id}`,
          title:`Supplier change affects ${atRiskUnits ? `${atRiskUnits} committed unit${atRiskUnits === 1 ? '' : 's'}` : 'the purchasing plan'}`,
          detail:`${summary} Foundry compared ${alternatives.length} response options and changed neither stock nor money.`,
          resolutionHint:'Review the consequence and approve communication and purchasing separately.',
          candidates:[responseCandidate] });
      }
    }
    plans.push(plan);
  }
  scorecard(db, document.workspace_id, document.supplier_id);
  return plans;
}

function forOrder(db, workspaceId, purchaseOrderId) {
  return db.prepare(`SELECT * FROM supplier_response_plans
    WHERE workspace_id=? AND purchase_order_id=? ORDER BY created_at DESC`)
    .all(workspaceId, purchaseOrderId).map(hydratePlan);
}

function draftsForPlan(db, workspaceId, planId) {
  return db.prepare(`SELECT * FROM supplier_response_drafts
    WHERE workspace_id=? AND response_plan_id=? ORDER BY created_at`).all(workspaceId, planId)
    .map((row) => ({ ...row, proposedPayload:parse(row.proposed_payload, {}) }));
}

function approveDraft(db, ctx, membership, draftId) {
  const row = db.prepare(`SELECT * FROM supplier_response_drafts WHERE workspace_id=? AND id=?`)
    .get(ctx.workspaceId, draftId);
  if (!row) throw new Error('That supplier response draft could not be found.');
  permissions.assertCan(membership, row.required_permission, 'approve this supplier response');
  if (row.status === 'APPROVED') return row;
  if (row.status !== 'PREPARED') throw new Error('Only a prepared supplier response can be approved.');
  const now = nowIso();
  db.prepare(`UPDATE supplier_response_drafts SET status='APPROVED',approved_by_user_id=?,approved_at=?,updated_at=?
    WHERE workspace_id=? AND id=?`).run(ctx.actorId, now, now, ctx.workspaceId, draftId);
  return db.prepare('SELECT * FROM supplier_response_drafts WHERE id=?').get(draftId);
}

function explain(db, workspaceId, planId) {
  const plan = hydratePlan(db.prepare(`SELECT * FROM supplier_response_plans
    WHERE workspace_id=? AND id=?`).get(workspaceId, planId));
  if (!plan) return null;
  const chosen = plan.chosenPlan || {};
  return { whatHappened:plan.summary, evidence:plan.evidence,
    businessConsequences:plan.consequences,
    alternativesConsidered:plan.alternatives,
    decision:chosen.type ? `${chosen.type}: ${chosen.explanation || 'selected by deterministic planning'}`
      : 'No executable response was selected.',
    authority:{ purchasing:plan.requiresPurchasingAuthority,
      supplierCommunication:plan.requiresCommunicationAuthority },
    safety:'The supplier message changed neither physical inventory nor money.',
    cash:plan.consequences.cashBoundary?.known
      ? `${displayMoney(plan.consequences.cashBoundary.availableForNewCommitmentsMinor,
        plan.consequences.cashBoundary.currency || 'USD')} was available for new commitments.` : null };
}

module.exports = { capture, forOrder, draftsForPlan, approveDraft, explain, scorecard,
  factsFromDocument, hydratePlan };

'use strict';

/**
 * Everything waiting for a person, as one list they can actually read.
 *
 * Needs you grew a section per internal mechanism: physical events, manager
 * findings, investigations, prepared corrections, controlled work, readiness
 * decisions. Each section made sense to the part of StockChief that filled it and
 * to nobody else. A sale that could not be recorded appeared under "Deliveries
 * and counts to confirm", headed "StockChief needs one more detail before it can
 * record this" — without saying which detail — above a button that went to the
 * general Tell StockChief box, where the customer's only option was to type the
 * same sentence again and get the same result.
 *
 * The mechanisms stay. What changes is that every one of them has to answer the
 * same four questions before it may put anything in front of a person:
 *
 *   happened — what was done or observed, in their own words where possible
 *   why      — why StockChief stopped instead of carrying on
 *   recommendation — the safest next step StockChief recommends
 *   missing  — the specific decision or fact it does not have
 *   action   — one thing to click, going straight to where it is resolved
 *
 * An entry that cannot answer them is not ready to be shown, and saying so in
 * code is the only way to stop the next mechanism adding another vague card.
 */

const investigations = require('./investigations');
const workItems = require('../autopilot/work-items');
const autopilotPresenter = require('../autopilot/presenter');
const attentionPresenter = require('../attention/presenter');
const managerReadiness = require('./readiness');
const actionPresenter = require('../actions/presenter');
const proposals = require('../actions/proposal-service');
const importPlans = require('../imports/plan-service');
const autopilotPolicies = require('../autopilot/policy-service');
const operatingInstructions = require('./operating-instructions');
const dismissals = require('./needs-you-dismissals');
const permissions = require('../actions/permissions');
const { humanizeUnitMarkers } = require('../lib/util');

/** SKUs already covered by a StockChief-prepared order that still needs placing. */
function preparedReplenishmentSkus(db, workspaceId) {
  return new Set(db.prepare(`SELECT DISTINCT pol.sku_id
    FROM purchase_order_lines pol
    JOIN purchase_orders po ON po.id = pol.purchase_order_id
    WHERE pol.workspace_id = ? AND po.status IN ('DRAFT','AWAITING_APPROVAL')
      AND po.source = 'foundry_recommendation'`).all(workspaceId).map((row) => row.sku_id));
}

/** Customer promises whose shortage the prepared supplier order is intended to cover. */
function customerImpactForPurchase(db, workspaceId, purchaseOrderId) {
  if (!purchaseOrderId) return '';
  const skuIds = new Set(db.prepare(`SELECT sku_id FROM purchase_order_lines
    WHERE workspace_id = ? AND purchase_order_id = ?`).all(workspaceId, purchaseOrderId)
    .map((row) => row.sku_id));
  if (!skuIds.size) return '';
  const affected = require('../sales/sales-order-service').waitingForStock(db, workspaceId)
    .flatMap((order) => order.lines
      .filter((line) => skuIds.has(line.sku_id) && Number(line.backordered) > 0)
      .map((line) => ({ orderNumber: order.order_number, quantity: Number(line.backordered),
        displayName: line.displayName })));
  if (affected.length === 1) {
    const row = affected[0];
    return `${row.orderNumber} is waiting for ${row.quantity} ${row.displayName}.`;
  }
  if (affected.length > 1) {
    return `${affected.length} customer orders are waiting for ${affected.reduce((sum, row) => sum + row.quantity, 0)} units covered by this purchase.`;
  }
  return '';
}

/**
 * What StockChief does not know about a reported event.
 *
 * Worked out from the record rather than by asking a model, because this runs
 * for every row on the page. It is deliberately specific: "which product" and
 * "how many" send someone to the right answer, "one more detail" sends them
 * back to the box they came from.
 */
function missingFromEvent(event) {
  let details = {};
  try { details = JSON.parse(event.details || '{}'); } catch { details = {}; }

  if (event.event_type === 'physical_count') {
    if (!details.skuId) return 'Which product you counted.';
    if (!details.locationId) return 'Which location you counted it at.';
    if (details.countedQuantity === undefined || details.countedQuantity < 0) {
      return 'How many you counted.';
    }
    return 'Whether to correct the recorded stock to match your count.';
  }

  // Anything StockChief could not place at all. It read the sentence and could not
  // tell which inventory operation it describes, or could not carry it out.
  return 'What StockChief should record — it could not work out the exact change from this on its own.';
}

function fromPhysicalEvents(db, workspaceId) {
  const rows = db
    .prepare(
      `SELECT id, event_type, stated_as, details, created_at FROM physical_events
        WHERE workspace_id = ? AND status = 'NEEDS_HUMAN' AND investigation_id IS NULL
        ORDER BY created_at DESC`
    )
    .all(workspaceId);

  return rows.map((row) => {
    const counting = row.event_type === 'physical_count';
    return {
      id: `event:${row.id}`,
      kind: 'event',
      // Named for what the customer did, not for the table it landed in.
      title: counting ? 'A count needs one decision' : 'StockChief could not record this yet',
      happened: `You told StockChief: “${row.stated_as}”`,
      why: counting
        ? 'StockChief will not change recorded stock from a count without you.'
        : 'StockChief will not guess an inventory change, so it stopped rather than record the wrong thing.',
      recommendation: counting
        ? 'Confirm the physical count before changing the inventory record.'
        : 'Supply the missing fact so StockChief can prepare the exact inventory change.',
      missing: missingFromEvent(row),
      actionLabel: counting ? 'Settle this count' : 'Finish recording this',
      href: `/needs-you/event/${row.id}`,
      at: row.created_at,
      priority: 90,
    };
  });
}

function fromInvestigations(db, workspaceId) {
  return investigations
    .list(db, workspaceId, { statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'], limit: 100 })
    // Older versions incorrectly opened a record disagreement when the only
    // missing fact was historical purchase cost. The stock quantities do not
    // disagree in that case, so never present that legacy record as a
    // "Resolve the difference" decision. Accounting owns the exact
    // "Add the missing cost" task instead.
    .filter((entry) => entry.trigger !== 'business_consistency_inventory-cost-coverage')
    .map((entry) => {
      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86400000));
      return ({
      id: `investigation:${entry.investigationId}`,
      kind: 'investigation',
      title: `${(entry.affectedEntities || {}).displayName || 'Stock'} does not match the records`,
      happened: entry.observedDifference && entry.observedDifference.statedAs
        ? `You told StockChief: “${entry.observedDifference.statedAs}”`
        : 'StockChief compared the count with its ledger and they disagree.',
      why: 'StockChief cannot tell which figure is right, and will not overwrite the ledger on a guess.' +
        (ageDays >= 2 ? ` This discrepancy has been unresolved for ${ageDays} days.` : ''),
      recommendation: entry.recommendedNextStep
        || 'Recount the stock, then correct the record only if the physical count is confirmed.',
      // The specific next step StockChief worked out, not a generic invitation to
      // go and look: "Recount Filter Cartridge at Main Warehouse" is an
      // instruction, "look into this" is a shrug.
      missing: entry.recommendedNextStep
        || (entry.unexplainedAmount === null
          ? 'Which figure is correct.'
          : `An explanation for ${entry.unexplainedAmount} unit(s), or a decision to correct the record.`),
      actionLabel: 'Resolve the difference',
      href: `/investigations/${entry.investigationId}`,
      at: entry.createdAt,
      priority: ageDays >= 7 ? 95 : ageDays >= 2 ? 88 : 80,
    });
    });
}

function fromRepairCases(db, workspaceId) {
  // The repair service hydrates every evidence, timeline and before/after JSON
  // document. Needs You only renders the case headline and the simulation's
  // short summary. Reading multi-megabyte evidence for up to 100 cases turned
  // a badge-sized question into seconds of JSON parsing on large migrations.
  return db.prepare(`SELECT id,symptom,failed_invariant,status,materiality,updated_at,
      json_extract(simulation,'$.summary') AS simulation_summary
    FROM repair_cases
    WHERE workspace_id=? AND status IN ('NEEDS_AUTHORITY','FAILED','INCONCLUSIVE')
    ORDER BY updated_at DESC,rowid DESC LIMIT 100`).all(workspaceId).map((repairCase) => ({
    id: `repair:${repairCase.id}`,
    kind: 'repair',
    title: repairCase.symptom,
    happened: `StockChief found that ${repairCase.failedInvariant}.`,
    why: repairCase.status === 'FAILED'
      ? 'The domain repair ran or resumed, but its post-repair checks did not all pass. StockChief has not called it fixed.'
      : repairCase.status === 'INCONCLUSIVE'
        ? 'The records do not prove a safe correction yet, so StockChief stopped instead of forcing the numbers to agree.'
        : 'StockChief diagnosed the cause and simulated the correction, but the materiality or permissions require your approval.',
    recommendation: repairCase.simulation_summary
      || 'Open the repair case to review the evidence and simulated consequences.',
    missing: repairCase.status === 'NEEDS_AUTHORITY' ? 'Your approval for the simulated repair.'
      : repairCase.status === 'INCONCLUSIVE' ? 'The exact source record that proves the correction.'
        : 'A repair whose verification checks pass.',
    actionLabel: repairCase.status === 'NEEDS_AUTHORITY'
      ? 'Authorize the repair'
      : repairCase.status === 'INCONCLUSIVE'
        ? 'Provide the missing evidence'
        : 'Resolve the failed repair',
    href: `/repairs/${repairCase.id}`,
    at: repairCase.updated_at,
    priority: repairCase.materiality === 'high' ? 96 : repairCase.materiality === 'medium' ? 90 : 82,
  }));
}

/** One unresolved universal operation becomes one decision, regardless of how
 * many internal checks explained why it stopped. */
function fromAutonomousOperations(db, workspaceId) {
  const catalog = require('../autonomous/catalog');
  return db.prepare(`SELECT i.id AS intervention_id, i.kind, i.reason, i.created_at,
      o.id, o.operation_type, o.title, o.summary, o.link, o.error_message
    FROM autonomous_operation_interventions i
    JOIN autonomous_operations o ON o.id = i.operation_id
    WHERE i.workspace_id = ? AND i.resolved_at IS NULL
      AND (o.source_kind IS NULL OR o.source_kind NOT IN
        ('work_item','repair_case','domain_event','provider_event'))
      AND NOT EXISTS (SELECT 1 FROM autonomous_operation_interventions newer
        WHERE newer.operation_id = i.operation_id AND newer.resolved_at IS NULL
          AND (newer.created_at > i.created_at OR (newer.created_at = i.created_at AND newer.id > i.id)))
    ORDER BY i.created_at DESC`).all(workspaceId).map((row) => {
      const definition = catalog.requireType(row.operation_type);
      const verification = row.kind === 'VERIFICATION_FAILED';
      return {
        id:`operation:${row.id}`, kind:'operation', title:row.title,
        happened:row.summary || `${definition.title} did not reach a verified outcome.`,
        why:row.reason || row.error_message || 'StockChief stopped before taking an unapproved or unverified action.',
        recommendation:verification
          ? 'Review the evidence and resolve the failed verification before this area resumes.'
          : 'Approve this only if the proposed outcome and limits are correct.',
        missing:verification ? 'A verified outcome or a safe recovery decision.' : 'The required authority or business judgement.',
        actionLabel:verification ? 'Review stopped work' : 'Review this operation',
        href:row.link || `/autopilot/history#operation-${row.id}`, at:row.created_at,
        priority:verification ? 96 : 88, requiredPermission:definition.permission,
      };
    });
}

/** Transfer requests are one custody decision, not a generic stock warning. */
function fromTransfers(db, workspaceId) {
  return db.prepare(`SELECT t.id, t.transfer_number, t.created_at, src.name AS source_name,
      dst.name AS destination_name,
      COALESCE((SELECT SUM(requested_quantity) FROM inventory_transfer_lines WHERE transfer_id = t.id),0) AS quantity
    FROM inventory_transfers t
    JOIN locations src ON src.id = t.source_location_id
    JOIN locations dst ON dst.id = t.destination_location_id
    WHERE t.workspace_id = ? AND t.status = 'REQUESTED'
    ORDER BY t.created_at`).all(workspaceId).map((transfer) => ({
      id: `transfer:${transfer.id}`,
      kind: 'decision',
      title: `${transfer.transfer_number} is waiting for approval`,
      happened: `${transfer.quantity} units were requested from ${transfer.source_name} to ${transfer.destination_name}. No stock has moved.`,
      why: 'Requesting a transfer does not authorize assets to leave a location.',
      recommendation: 'Approve it only if the quantity, source, destination, and physical stock are correct.',
      missing: 'Transfer approval.',
      actionLabel: 'Approve the transfer',
      href: `/transfers/${transfer.id}`,
      at: transfer.created_at,
      priority: 85,
      requiredPermission: permissions.APPROVE_TRANSFER,
    }));
}

function fromCorrections(db, workspaceId) {
  return proposals
    .listOpen(db, workspaceId, { limit: 20 })
    .filter((proposal) => proposal.status === 'AWAITING_APPROVAL')
    .map((proposal) => ({
      id: `proposal:${proposal.proposalId}`,
      kind: 'correction',
      title: 'A change is prepared and waiting for you',
      happened: actionPresenter.oneLine(db, workspaceId, proposal),
      why: 'StockChief has worked out the exact change but will not apply it without approval.',
      recommendation: 'Approve it only if the preview matches what actually happened.',
      missing: 'Your approval.',
      actionLabel: 'Approve the change',
      href: `/actions/${proposal.proposalId}`,
      at: proposal.createdAt,
      priority: 70,
    }));
}

function fromWorkItems(db, workspaceId, { now = Date.now() } = {}) {
  const controlled = workItems.awaitingApproval(db, workspaceId)
    .filter((item) => autopilotPresenter.isCurrentlyActionable(db, workspaceId, item, { now }))
    .map((item) => {
    const action = item.recommendedAction || {};
    const named = (item.affectedEntities || {}).displayName;
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 86400000));
    const base = { id: `work:${item.id}`, at: item.createdAt, href: `/autopilot/work/${item.id}`, ageDays };

    // Checking in a delivery is not an approval, and describing it as one —
    // "StockChief will not move stock or commit money without you", above a button
    // called Review the plan — told somebody the opposite of what to do. It is
    // a box that has arrived, and the job is to count what is in it.
    if (item.category === 'receiving_followup') {
      const state = autopilotPresenter.deliveryState(db, workspaceId, item, { now });
      return {
        ...base,
        kind: 'receiving',
        title: state.title,
        happened: state.late
          ? `It was expected ${state.expected}; ${state.detail}`
          : `It is expected today; ${state.detail}`,
        why: 'StockChief cannot see what is physically in the box, so it will not book a delivery in for you.',
        recommendation: 'Count the delivery against the order and record only what actually arrived.',
        missing: 'How many actually arrived.',
        actionLabel: 'Book it in',
        // Straight to the order, where one button books the whole thing in.
        href: action.purchaseOrderId ? `/purchasing/orders/${action.purchaseOrderId}` : base.href,
        priority: action.late ? 88 : 82,
      };
    }

    if (item.category === 'purchase_approval') {
      const po = action.poNumber || 'A purchase order';
      const exception = item.source === 'price_exception';
      const customerImpact = customerImpactForPurchase(
        db, workspaceId, item.purchaseOrderId || action.purchaseOrderId
      );
      return {
        ...base,
        kind: 'decision',
        title: exception ? `${po} costs more than your rule allows` : `${po} is ready to send`,
        happened: `${(item.policyEvaluation || {}).reason || `${po} for ${action.supplierName || 'a supplier'}.`}` +
          `${customerImpact ? ` ${customerImpact}` : ''}`,
        why: exception
          ? 'Your rule caps how far a price may move, and this order is over it, so StockChief stopped.'
          : 'StockChief prepared it but will not place an order with a supplier by itself.',
        recommendation: exception
          ? 'Check the supplier price and approve only if the increase is acceptable.'
          : 'Place the order if the supplier, price and quantity are correct.',
        missing: exception ? 'Whether to accept the new price.' : 'Your decision to place it.',
        actionLabel: exception ? 'Approve the new price' : 'Place the order',
        priority: 84,
      };
    }

    if (item.category === 'balance_transfer') {
      return {
        ...base,
        kind: 'decision',
        title: `Move ${action.quantity} ${action.displayName || named || 'units'} to ${action.toLocationName || 'the location that needs them'}?`,
        happened: `${action.fromLocationName || 'Another location'} has stock available while ${action.toLocationName || 'another location'} needs it.`,
        why: (item.policyEvaluation || {}).reason
          || 'StockChief prepared the transfer but does not have authority to move this stock automatically.',
        recommendation: `Move the recorded quantity only if the stock is physically available at ${action.fromLocationName || 'the source location'}.`,
        missing: 'Your approval to make this transfer.',
        actionLabel: 'Approve the transfer',
        priority: ageDays >= 3 ? 92 : 90,
      };
    }

    if (item.category === 'replenishment_plan' && action.blocked === 'no_supplier') {
      return {
        ...base,
        kind: 'setup',
        title: `${named || 'This variant'} needs a supplier`,
        happened: action.explanation || 'It is below its reorder point, but nobody is on file to supply it.',
        why: 'Without a supplier, StockChief has no pack size, price or lead time and cannot prepare a truthful order.',
        recommendation: 'Add the supplier and its purchasing terms. StockChief will then recalculate the one replenishment plan.',
        missing: 'Who supplies this variant, its pack size, price and lead time.',
        actionLabel: 'Add supplier',
        href: action.skuId ? `/purchasing/supplier-for/${action.skuId}` : '/purchasing/setup',
        priority: 86,
      };
    }

    if (item.category === 'replenishment_plan') {
      const approval = autopilotPresenter.explain(db, workspaceId, item.id).approvalCopy;
      const skuId = action.skuId || item.affectedEntities?.skuId;
      const customerShortages = skuId
        ? require('../sales/sales-order-service').waitingForStock(db, workspaceId)
          .flatMap((order) => order.lines
            .filter((line) => line.sku_id === skuId && Number(line.backordered) > 0)
            .map((line) => ({ orderNumber: order.order_number,
              quantity: Number(line.backordered), displayName: line.displayName })))
        : [];
      const customerImpact = customerShortages.length === 1
        ? `${customerShortages[0].orderNumber} is waiting for ${customerShortages[0].quantity} ${customerShortages[0].displayName}.`
        : customerShortages.length > 1
          ? `${customerShortages.length} customer orders are waiting for ${customerShortages.reduce((sum, row) => sum + row.quantity, 0)} units of this product.`
          : '';
      if (approval) return {
        ...base,
        kind: 'decision',
        title: approval.heading,
        happened: `${approval.summary}${customerImpact ? ` ${customerImpact}` : ''}`,
        why: action.explanation || 'StockChief combined the stock need and the safest available response into one plan.',
        recommendation: approval.approvalEffect,
        missing: 'Your approval of this exact plan.',
        actionLabel: approval.primaryLabel,
        priority: ageDays >= 3 ? 92 : 85,
      };
    }

    return {
      ...base,
      kind: 'decision',
      title: named ? `${named} needs a decision` : item.categoryLabel,
      happened: item.category === 'replenishment_plan' && named
        ? `${named} needs replenishing. ${action.explanation || (item.policyEvaluation || {}).reason || ''}`.trim()
        : action.explanation || (item.policyEvaluation || {}).reason || item.categoryLabel,
      why: 'StockChief will not move stock or commit money without you.',
      recommendation: 'Approve the single plan only if all of its proposed actions are correct.',
      missing: 'Your approval of the plan.',
      actionLabel: 'Approve the plan',
      priority: ageDays >= 3 ? 92 : 85,
    };
  });

  // A draft without a separate work item is still a real purchasing decision.
  // Home already showed it; omitting it here made the Home total, sidebar badge
  // and Check-now result disagree with the page named “Needs you”.
  const drafts = autopilotPresenter.whatStockChiefPrepared(db, workspaceId, { limit: 100 })
    .filter((entry) => entry.kind === 'purchase')
    .map((entry) => {
      const customerImpact = customerImpactForPurchase(db, workspaceId, entry.id);
      return {
        id: `purchase:${entry.id}`,
        kind: 'decision',
        title: entry.title,
        happened: `${entry.because}${customerImpact ? ` ${customerImpact}` : ''}`,
        why: 'StockChief prepared the order but will not place it with a supplier by itself.',
        recommendation: 'Place the order if the supplier, price and quantity are correct.',
        missing: 'Your decision to place it.',
        actionLabel: entry.action,
        href: entry.link,
        at: null,
        priority: entry.priority || 55,
      };
    });

  return [...controlled, ...drafts];
}

function fromFindings(db, workspaceId) {
  return autopilotPresenter.whatNeedsYou(db, workspaceId).map((finding) => {
    const isProtectedLimit = finding.category === 'stock_protection_boundary';
    const approachingProtectedLimit = isProtectedLimit
      && Number((finding.metrics || {}).onHand) > Number((finding.metrics || {}).threshold);
    return ({
    id: `finding:${finding.id}`,
    kind: 'finding',
    title: finding.title,
    happened: finding.because || 'StockChief noticed this in your records.',
    why: isProtectedLimit
      ? approachingProtectedLimit
        ? 'The next outgoing unit would reach the blocked boundary you approved. StockChief cannot choose whether to order, receive stock, or change your rule.'
        : 'This stock has reached or crossed the protection limit you approved. StockChief cannot choose whether to order, receive stock, or change your rule.'
      : 'StockChief raised it because the numbers crossed a line you set, or a pattern it watches.',
    recommendation: finding.recommendation || 'Open the finding and follow the action supported by the recorded evidence.',
    missing: isProtectedLimit
      ? 'Restore the stock, place the supplier order the rule requires, or change the limit if it is no longer right.'
      : finding.action === 'Add supplier'
      ? 'The supplier and purchasing terms for this variant.'
      : 'A look, and a decision about what to do.',
    // The same label this finding carries on Home and on the item record. It
    // had its own fallback here, so one out-of-stock finding read "Decide what
    // to do" on the page that listed it and "Resolve this" in the queue that
    // page linked to.
    actionLabel: isProtectedLimit
      ? 'Decide on the limit'
      : finding.action === 'Add supplier'
        ? 'Add supplier'
        : attentionPresenter.actionLabelFor(finding.category),
    href: finding.link,
    at: null,
    priority: isProtectedLimit ? Math.max(80, finding.priority || 0) : finding.priority || 60,
    });
  });
}

function fromReadiness(db, workspaceId) {
  const operating = managerReadiness.decisions(db, workspaceId) || [];
  return operating
    .filter((entry) => entry && entry.title)
    .map((entry, index) => ({
      id: `readiness:${entry.key || index}`,
      kind: 'setup',
      title: entry.title,
      happened: entry.because || 'StockChief cannot do part of its job yet.',
      why: entry.why || 'StockChief needs something from you before it can work this out.',
      recommendation: entry.recommendation
        || 'Provide the operating input above so StockChief can manage this safely.',
      missing: entry.missing || entry.action || 'The information named above.',
      actionLabel: entry.actionLabel || entry.action || 'Sort this out',
      href: entry.link || entry.href || '/settings',
      at: null,
      priority: 50,
    }));
}


/**
 * A file read but not yet brought in.
 *
 * Uploading a spreadsheet and walking away left nothing anywhere: the plan sat
 * in Imports waiting to be approved, and Needs you — the page whose whole
 * promise is "everything waiting for you is here" — said nothing was. Somebody
 * had to remember they had started.
 */
function fromImports(db, workspaceId) {
  return importPlans
    .listFor(db, workspaceId, 20)
    // Approving an import is only half of it — the rows are brought in by a
    // second press. Filtering on "not yet approved" made the item vanish the
    // moment somebody approved, leaving the import undone and nothing anywhere
    // saying so. What matters is whether the rows exist yet.
    .filter((plan) => ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED'].includes(plan.approvalStatus)
      && plan.status === 'READY'
      // An expired plan is not a job waiting; it is one that has to start again.
      && !plan.isExpired)
    .map((plan) => {
      const rows = plan.recordsDetected || 0;
      const problems = plan.recordsInvalid || 0;
      return {
        id: `import:${plan.id}`,
        kind: 'import',
        title: plan.approvalStatus === 'APPROVED'
          ? `${plan.sourceName || 'A file'} is approved and waiting to be brought in`
          : `${plan.sourceName || 'A file'} is read and waiting to be brought in`,
        happened: rows
          ? `StockChief read ${rows} row(s) from it. Nothing has been created yet.`
          : 'StockChief read the file. Nothing has been created yet.',
        why: 'StockChief does not create products or stock from a file until somebody has looked at what it found.',
        recommendation: problems
          ? 'Review the rows StockChief could not place, then approve the corrected import.'
          : 'Review the mapped rows, then approve the import if they are correct.',
        missing: plan.approvalStatus === 'APPROVED'
          ? 'One more press to actually bring the rows in. Nothing has been created yet.'
          : problems
            ? `A decision on ${problems} row(s) it could not place, then your approval.`
            : 'Your approval to bring these rows in.',
        actionLabel: plan.approvalStatus === 'APPROVED' ? 'Bring it in' : 'Approve the import',
        /*
         * Nothing has been created from this file, so throwing it away costs
         * nothing and is a perfectly ordinary answer — the same file uploaded
         * twice leaves two of these, and there was no way to be rid of either
         * without opening it and looking for the cancel.
         */
        dismiss: {
          label: 'Throw this file away',
          action: `/imports/${plan.id}/cancel`,
          confirm: `Throw away ${plan.sourceName || 'this file'}? Nothing has been created from it.`,
        },
        href: `/imports/${plan.id}`,
        at: plan.createdAt,
        priority: 75,
      };
    });
}

/** Inventory documents captured from a watched mailbox, waiting for review. */
function fromMailboxInventory(db, workspaceId) {
  return db.prepare(`SELECT d.id, d.understanding_id, d.source_name, d.created_at, m.sender
    FROM setup_documents d
    JOIN connection_email_attachments a ON a.setup_document_id = d.id AND a.workspace_id = d.workspace_id
    JOIN connection_email_messages m ON m.id = a.message_id AND m.workspace_id = a.workspace_id
    WHERE d.workspace_id = ? AND d.status = 'PREPARED'
    ORDER BY d.created_at DESC`).all(workspaceId).map((row) => ({
      id: `mailbox-inventory:${row.id}`,
      kind: 'import',
      title: `${row.source_name} is ready for inventory review`,
      happened: `StockChief read the attachment from ${row.sender}. Nothing has been added or changed yet.`,
      why: 'Email attachments are external evidence. StockChief waits for you to review the exact products and quantities.',
      recommendation: 'Check the proposed matches and new records, then approve only if the file belongs in this inventory.',
      missing: 'Your approval of the inventory preview.',
      actionLabel: 'Choose what to add',
      href: `/foundry/proposal/${row.understanding_id}`,
      at: row.created_at,
      priority: 75,
    }));
}

/** Approved attachments whose rule says "ask me for each attachment". */
/*
 * Mail somebody is still waiting on an answer to.
 *
 * Its own entry rather than its own inbox: an owner should have one place
 * that means "your attention", not two. Only the oldest few appear, because
 * Needs You is a list of decisions and a mailbox is not — the entry exists to
 * say the drawer is not empty and send somebody to it, not to reproduce it.
 */
function fromUnansweredMail(db, workspaceId) {
  const replyInbox = require('../connections/reply-inbox');
  const waiting = replyInbox.oldestUnanswered(db, workspaceId, 3);
  if (!waiting.length) return [];
  /*
   * Not the mail that is already here as an order.
   *
   * One customer email produced two cards on a real screen: "Read the order
   * from motty… yourself" and "Reply to motty…", the same sender, the same
   * message, the same Read it button, one above the other. Both were true and
   * only one is a decision — the order card says what StockChief stopped on and
   * what it needs. The general dedupe below could not catch it because the
   * titles differ, and they differ because the two rows were written by
   * different parts of StockChief about the same piece of paper.
   */
  const alreadyAnOrder = new Set([
    ...require('../sales/order-from-email').unreadable(db, workspaceId).map((row) => row.id),
    ...db.prepare(`SELECT source_email_message_id AS id FROM sales_orders
      WHERE workspace_id = ? AND source_email_message_id IS NOT NULL`).all(workspaceId).map((row) => row.id),
  ]);
  const total = replyInbox.counts(db, workspaceId).NEEDS_REPLY;
  return waiting.filter((message) => !alreadyAnOrder.has(message.id)).map((message, index) => ({
    id: `unanswered-mail:${message.id}`,
    kind: 'decision',
    title: `Reply to ${message.supplier_name || message.sender}`,
    happened: `${message.sender} wrote ${message.subject ? `"${message.subject}"` : 'without a subject'}`
      + ` on ${String(message.received_at).slice(0, 10)}. Nobody has answered it.`,
    why: message.reply_reason || 'StockChief could not tell that this was finished with.',
    recommendation: index === 0 && total > waiting.length
      ? `Answer it, or move it out of the way. ${total} messages are waiting.`
      : 'Answer it, or move it to handled if it needs nothing.',
    missing: 'An answer to the person who wrote.',
    actionLabel: 'Read it',
    href: `/mail/${message.id}`,
    at: message.received_at,
    /*
     * Age is the urgency here.
     *
     * Needs You sorts everything newest-first within a priority, which is
     * right for events but exactly wrong for mail: the message most likely to
     * have become a phone call is the one that has been sitting longest, and a
     * flat priority would bury it under this morning's. So waiting raises it,
     * a week at a time.
     *
     * It starts below a stock mismatch or an approval and is capped short of
     * Urgent, because however old it is, a late reply costs goodwill and not
     * money.
     */
    priority: 74 + Math.min(8, Math.floor(
      (Date.now() - new Date(message.received_at).getTime()) / (7 * 24 * 60 * 60 * 1000))),
  }));
}

/*
 * Orders that money is holding up.
 *
 * Added because the product contradicted itself on one screen: the Orders page
 * said "1 order needs you" while the strip above it said "Nothing needs you".
 * The strip was reading the decision queue, and a held order was not in it.
 *
 * The queue was right to be the authority and wrong to be empty. An order
 * stopped for an unpaid deposit is exactly a decision somebody has to make —
 * chase the customer, or let this one go anyway — and both of those are things
 * only a person can decide.
 */
function fromHeldOrders(db, workspaceId) {
  const paymentTerms = require('../sales/payment-terms');
  const orders = db.prepare(`SELECT so.*, c.name AS customer_name
    FROM sales_orders so LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    ORDER BY so.needed_by IS NULL, so.needed_by, so.order_date`).all(workspaceId);

  const entries = [];
  for (const order of orders) {
    let position;
    try { position = paymentTerms.positionForOrder(db, workspaceId, order); } catch { continue; }
    if (!position.blocksPicking && !position.blocksShipping) continue;

    const held = position.heldReason.pick || position.heldReason.ship;
    const owed = position.dueNowMinor || position.remainingMinor;
    entries.push({
      id: `order-payment-hold:${order.id}`,
      kind: 'decision',
      title: `${order.customer_name || 'A customer'} owes ${paymentTerms.money(owed, position.currency)} before ${order.order_number} can go`,
      happened: `${order.order_number} is confirmed and stock is held for it, but ${held}`,
      why: `You agreed with them: ${position.termsText.toLowerCase().replace(/\.$/, '')}.`,
      recommendation: position.blocksPicking
        ? 'Ask them to pay, or approve this one order to be picked anyway.'
        : 'Ask them to pay, or approve this one order to ship anyway.',
      missing: 'Either the money, or your decision to send it without.',
      actionLabel: 'Settle it',
      href: `/orders/${order.id}#payment-hold`,
      at: order.needed_by || order.order_date,
      // Above a late reply and below a stock mismatch: real money, and a
      // customer waiting, but nothing is physically wrong.
      priority: 84,
    });
  }
  return entries;
}

/*
 * An order a customer placed by email, drafted and waiting.
 *
 * Found on a real mailbox: a customer wrote "I'd like to order bike toe lace
 * size 36 2 pieces", StockChief drafted SO-1001 from it, and told nobody. The
 * mailbox page said "Ignored sender", Needs you said nothing, and the owner
 * concluded the feature did not exist. Drafting the order is the easy half;
 * the whole point is the approval, and that is a decision only a person makes.
 */
function fromEmailOrders(db, workspaceId) {
  const orderFromEmail = require('../sales/order-from-email');
  const entries = orderFromEmail.waitingForApproval(db, workspaceId).map((order) => {
    const what = order.lines.map((line) =>
      `${line.quantity} × ${line.item_name}${line.variant_label ? ` ${line.variant_label}` : ''}`).join(', ');
    const unpriced = order.lines.filter((line) => line.unit_price_minor === null)
      .map((line) => `${line.item_name}${line.variant_label ? ` ${line.variant_label}` : ''}`);
    if (order.customer_decision_required) return {
      id: `email-order:${order.id}`,
      kind: 'decision',
      title: `Is ${order.customer_email} a new customer?`,
      happened: `${order.customer_email} sent ${order.order_number}${order.subject ? ` — “${order.subject}”` : ''}. StockChief prepared the order but did not silently create or merge a customer record.`,
      why: 'The sender address does not match a confirmed customer in StockChief.',
      recommendation: 'Create this sender as a customer, or match the order to the correct existing customer. Then StockChief will show the next required step.',
      missing: 'Your decision about who this customer is.',
      actionLabel: 'Choose the customer',
      href: `/orders/${order.id}#customer-decision`,
      at: order.received_at || order.created_at,
      priority: 94,
    };
    if (order.delivery_decision_required) return {
      id: `email-order:${order.id}`,
      kind: 'decision',
      title: `Where should ${order.order_number} go?`,
      happened: `${order.customer_name} ordered ${what}, but the email did not provide a complete shipping address or confirm pickup.`,
      why: order.reply_sent_at
        ? `StockChief already emailed ${order.customer_email} asking for the missing answer.`
        : order.draft_at
          ? 'StockChief prepared the question, but the connected mailbox did not send it.'
          : 'StockChief cannot safely ship without a destination.',
      recommendation: order.reply_sent_at
        ? 'Wait for their answer, or enter the shipping address or pickup choice if they tell you another way.'
        : 'Open the order and choose pickup or enter the full shipping address.',
      missing: 'A complete shipping address or customer pickup confirmation.',
      actionLabel: 'Set shipping or pickup',
      href: `/orders/${order.id}#delivery-decision`,
      at: order.received_at || order.created_at,
      priority: 91,
    };
    return {
      id: `email-order:${order.id}`,
      kind: 'decision',
      title: `Approve ${order.order_number} for ${order.customer_name}: ${what}`,
      happened: `${order.customer_email} wrote${order.subject ? ` "${order.subject}"` : ''} asking to buy this. `
        + 'StockChief drafted the order from their words. Nothing is committed and nobody has been answered.',
      why: 'An order placed by email is still an order you have to accept: the price, the stock and the customer are yours to check.',
      // A product with no selling price is the first thing the owner will be
      // asked for on the order, so it is said here rather than discovered there.
      recommendation: unpriced.length
        ? `Open it, give ${unpriced.join(' and ')} a selling price, and confirm it — or throw it away.`
        : 'Open it, check the lines and the price, then confirm it or throw it away.',
      missing: unpriced.length
        ? `A selling price for ${unpriced.join(' and ')}, and your approval of the order.`
        : 'Your approval of the order.',
      // Not 'Review': that tells somebody to go and look, which is the one
      // thing they already know. The decision is whether to accept the order.
      actionLabel: 'Approve this order',
      href: `/orders/${order.id}#approve-order`,
      at: order.received_at || order.created_at,
      // A customer is waiting and it is real money, above a late reply.
      priority: 88,
    };
  });
  for (const message of orderFromEmail.unreadable(db, workspaceId)) {
    entries.push({
      id: `email-order-unread:${message.id}`,
      kind: 'decision',
      title: `Read the order from ${message.sender} yourself`,
      happened: `${message.sender} wrote${message.subject ? ` "${message.subject}"` : ''} asking to buy something, `
        + 'and StockChief could not turn it into a draft order.',
      why: message.order_draft_reason,
      // When StockChief could not choose between products it has already written
      // the question to send them, so the decision is smaller than it looks.
      recommendation: message.draft_at
        ? 'StockChief has written the question to ask them. Read it, send it, or enter the order yourself.'
        : 'Read the email and enter the order, or reply and ask what they meant.',
      missing: 'An order, or an answer to the customer.',
      actionLabel: 'Read it',
      href: `/mail/${message.id}`,
      at: message.received_at,
      priority: 84,
    });
  }
  return entries;
}

/*
 * A customer's money on an order that is not going to happen.
 *
 * Take $300.00, then cancel the order: the money stays in the bank, no invoice
 * exists, nothing is owed to anybody — and nothing anywhere says the customer
 * is owed it back. Every figure on the Money page is correct and a person is
 * owed three hundred dollars that no screen mentions.
 *
 * StockChief does not send it back on its own. Money leaving is the one direction
 * that always needs a person, and there are honest reasons to hold it — a
 * restocking fee, a replacement order, a credit for next time. So it is put
 * where decisions live, with the figure, and somebody decides.
 */
/*
 * Trouble that has not happened yet.
 *
 * Everything else in this inbox is about something that already went wrong: a
 * payment with no invoice, an order nobody approved, stock that arrived without
 * a bill. This one is about the week after next — a product whose stock runs
 * out before its supplier can possibly deliver, a rule that has drifted away
 * from the demand it was set for, stock sitting in the wrong shop.
 *
 * It reads a table rather than forecasting anything. Prediction is a background
 * job; a Needs You page that forecast four hundred products before it rendered
 * would be a page nobody opens, and slow pages are how good warnings get
 * missed. What appears here has already been worked out, written down with its
 * evidence, and put through the same authority gate as every other automatic
 * action — including the ones that were refused, because "StockChief wanted to do
 * this and was not allowed" is something an owner is entitled to know.
 *
 * Only decisions reach this list. A prediction StockChief may act on by itself is
 * not a decision anybody has to take, and an anomaly that changes nothing is
 * not either.
 */
/*
 * Parcels that are not going to arrive when somebody was told they would.
 *
 * The one thing a customer always finds out before the shop does. A carrier
 * scan saying the parcel came back, or a promised date that has passed with
 * the thing still moving, is not a status to display — it is a conversation
 * somebody has to have, and it is worth more than most of what is on this
 * page because the customer is already wondering.
 *
 * StockChief does not write to them on its own here. What to say about a late
 * parcel depends on things it cannot see — whether this customer is owed an
 * apology, a refund, or a replacement sent today — so it brings the facts and
 * a person decides.
 */
function fromLateShipments(db, workspaceId) {
  const tracking = require('../shipping/tracking');
  const written = new Set(db.prepare(`SELECT shipment_id FROM customer_communications
    WHERE workspace_id = ? AND status = 'PREPARED' AND message_kind LIKE 'delay_notice_%'
      AND shipment_id IS NOT NULL`).all(workspaceId).map((row) => row.shipment_id));
  return tracking.troubled(db, workspaceId).slice(0, 5).map((row) => {
    const who = row.customer_name || 'the customer';
    const where = row.tracking_status
      ? row.tracking_status.toLowerCase().replace(/_/g, ' ') : 'not reported by the carrier';
    return {
      id: `shipment-trouble:${row.id}`,
      kind: 'decision',
      title: row.wrong
        ? `${row.shipment_number} did not reach ${who}`
        : `${row.shipment_number} is late for ${who}`,
      happened: row.wrong
        ? `The carrier reports this parcel as ${where}${row.exception_reason ? ` — ${row.exception_reason}` : ''}.`
        : `This was expected ${row.expected_delivery_date} and the carrier last reported it as ${where}.`,
      why: 'A customer who was told a date and does not have their parcel finds out before you do.',
      /*
       * The message is already written by the time this is read.
       *
       * Saying where a parcel is needs no judgement — it is the carrier's own
       * scans and the order's own dates. What to *do* about it does, and that
       * is what is being asked here. So the card says the words exist and
       * sends them to where they can be read and sent.
       */
      recommendation: written.has(row.id)
        ? `StockChief has written ${who} a note saying where it is. Read it, send it, or decide `
          + 'something else first.'
        : row.customer_email
          ? `Tell ${who} where it is, or open the shipment and check the tracking first.`
          : 'Check the tracking, and decide whether to send another.',
      missing: 'A decision about the parcel, and what to tell the customer.',
      actionLabel: written.has(row.id) ? 'Read what StockChief wrote' : 'Open the shipment',
      href: `/fulfilment/${row.id}`,
      at: row.expected_delivery_date || row.shipped_at,
      // Above a late reply and below money: a customer is waiting on goods
      // they have often already paid for.
      priority: row.wrong ? 86 : 82,
    };
  });
}

function fromPredictedTrouble(db, workspaceId) {
  const rows = db.prepare(`SELECT r.*, i.name AS item_name, s.variant_label
    FROM planning_recommendations r
    LEFT JOIN skus s ON s.id = r.sku_id
    LEFT JOIN items i ON i.id = s.item_id
    WHERE r.workspace_id = ? AND r.status = 'OPEN'
      AND (r.authority_verdict IS NULL OR r.authority_verdict <> 'authorized')
    ORDER BY r.created_at DESC LIMIT 40`).all(workspaceId);

  return rows.map((row) => {
    const evidence = (() => {
      try { return JSON.parse(row.evidence) || {}; } catch { return {}; }
    })();
    const shape = SHAPES[row.kind] || SHAPES[row.kind.split(':')[0]] || SHAPES.default;
    const confidence = row.confidence && row.confidence !== 'high'
      ? ` StockChief's read on this is ${row.confidence === 'learning' ? 'still forming' : 'moderately confident'}.`
      : '';

    return {
      id: `planning:${row.id}`,
      kind: 'decision',
      title: row.headline,
      happened: `${row.why}${confidence}`,
      why: shape.why,
      recommendation: shape.recommendation(row, evidence),
      missing: shape.missing,
      actionLabel: shape.actionLabel,
      href: row.sku_id ? `/inventory/skus/${row.sku_id}#planning` : '/purchasing',
      at: row.created_at,
      priority: shape.priority(row, evidence),
    };
  });
}

/*
 * How each kind of prediction should read to somebody who has thirty seconds.
 *
 * Priorities are not a scale of importance in the abstract — they are a claim
 * about what should be looked at first this morning. A promise already made to
 * a customer outranks everything, because it is the only one where the damage
 * is certain rather than likely.
 */
const SHAPES = {
  order_now: {
    why: 'Stock is heading for zero sooner than the supplier can replace it.',
    missing: 'Your approval to place the order.',
    actionLabel: 'Place the order',
    recommendation: (row, evidence) => evidence.orderBy
      ? `Order ${row.recommended_value} by ${evidence.orderBy} so it arrives before stock runs out around ${evidence.stockoutDate}.`
      : `Order ${row.recommended_value} now.`,
    priority: (row, evidence) => (evidence.breaksCommitment ? 95 : 88),
  },
  reorder_point: {
    why: 'A reorder rule set for an older pace of trade is still being followed.',
    missing: 'Whether to move to the new level or keep the one you set.',
    actionLabel: 'Choose a level',
    recommendation: (row) => `Use ${row.recommended_value}, or keep ${row.current_value} if you had a reason for it.`,
    priority: () => 62,
  },
  target_stock: {
    why: 'A stock target that no longer matches how fast this sells.',
    missing: 'Whether to move to the new target or keep the one you set.',
    actionLabel: 'Choose a target',
    recommendation: (row) => `Use ${row.recommended_value}, or keep ${row.current_value} if you had a reason for it.`,
    priority: () => 55,
  },
  safety_stock: {
    why: 'The buffer no longer matches how much demand and deliveries actually vary.',
    missing: 'Whether to move to the new buffer.',
    actionLabel: 'Choose a buffer',
    recommendation: (row) => `Use ${row.recommended_value}, or keep ${row.current_value}.`,
    priority: () => 50,
  },
  transfer: {
    why: 'The stock exists. It is in the wrong place.',
    missing: 'Your approval to move it.',
    actionLabel: 'Move the stock',
    recommendation: (row, evidence) => `Move ${row.recommended_value} from ${evidence.fromLocationName} to ${evidence.toLocationName}.`,
    priority: () => 72,
  },
  anomaly: {
    why: 'Something changed enough to alter what should be done next.',
    missing: 'A look at whether this changes the plan.',
    actionLabel: 'Decide what to do',
    recommendation: () => 'Worth a look before the next order for this goes out.',
    priority: () => 58,
  },
  default: {
    why: 'StockChief expects this to become a problem.',
    missing: 'Your decision.',
    actionLabel: 'Decide what to do',
    recommendation: () => 'Worth a look.',
    priority: () => 45,
  },
};

function fromMoneyHeldOnCancelledOrders(db, workspaceId) {
  /*
   * What is held is what was taken and never applied to anything.
   *
   * Measured from the payments themselves rather than by comparing totals:
   * an allocation is the record of money doing its job, so money with no
   * allocation is money still sitting here. A receipt somebody voided is not
   * money at all and never appears.
   */
  const rows = db.prepare(`SELECT so.id, so.order_number, so.currency, so.cancelled_at,
      c.name AS customer_name,
      COALESCE((SELECT SUM(p.amount_minor) FROM accounting_payments p
        WHERE p.workspace_id = so.workspace_id AND p.sales_order_id = so.id
          AND p.direction = 'CUSTOMER_RECEIPT' AND p.status = 'POSTED'), 0) AS received_minor,
      COALESCE((SELECT SUM(a.amount_minor) FROM accounting_payment_allocations a
        JOIN accounting_payments p2 ON p2.id = a.payment_id
        WHERE p2.workspace_id = so.workspace_id AND p2.sales_order_id = so.id
          AND p2.direction = 'CUSTOMER_RECEIPT' AND p2.status = 'POSTED'), 0) AS applied_minor
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.workspace_id = ? AND so.status = 'CANCELLED'`).all(workspaceId);

  return rows
    .map((row) => ({ ...row,
      heldMinor: Number(row.received_minor) - Number(row.applied_minor) }))
    .filter((row) => row.heldMinor > 0)
    .map((row) => {
      const amount = `${row.currency || 'USD'} ${(row.heldMinor / 100).toFixed(2)}`;
      const who = row.customer_name || 'the customer';
      return {
        id: `refund-held:${row.id}`,
        kind: 'decision',
        title: `${who} paid ${amount} for ${row.order_number}, which was cancelled`,
        happened: `${amount} was taken for ${row.order_number} and the order was cancelled. `
          + 'The money is still here and nothing has been invoiced against it.',
        why: 'Money going back out is the one direction StockChief never takes by itself.',
        recommendation: `Refund ${amount} to ${who}, or keep it against something else and say so.`,
        missing: 'Your decision about money that is not yours to keep by default.',
        actionLabel: 'Settle the money',
        href: `/orders/${row.id}#money`,
        at: row.cancelled_at,
        // Somebody else's money, held with nothing owed for it. Above a late
        // reply and an approval; below stock that is physically wrong.
        priority: 89,
      };
    });
}

/*
 * A supplier who has been paid, and a bill from them that still says it is owed.
 *
 * Pay a supplier before their invoice arrives — a deposit, a proforma settled
 * up front, a transfer somebody sent early — and the money sits as an advance.
 * When the bill then arrives it is raised unpaid, so StockChief shows a debt to a
 * supplier who already has the money.
 *
 * Deliberately not applied automatically, unlike the customer side. A payment
 * against a customer's order names the order it belongs to; a payment to a
 * supplier names only the supplier, so StockChief cannot tell a deposit for next
 * month from an early settlement of the bill in front of it. Guessing there
 * would be StockChief deciding where somebody else's money went.
 */
function fromSupplierMoneyNotOnAnyBill(db, workspaceId) {
  const rows = db.prepare(`SELECT s.id, s.name,
      COALESCE((SELECT SUM(p.amount_minor) FROM accounting_payments p
        WHERE p.workspace_id = s.workspace_id AND p.supplier_id = s.id
          AND p.direction = 'SUPPLIER_PAYMENT' AND p.status = 'POSTED'), 0) AS paid_minor,
      COALESCE((SELECT SUM(a.amount_minor) FROM accounting_payment_allocations a
        JOIN accounting_payments p2 ON p2.id = a.payment_id
        WHERE p2.workspace_id = s.workspace_id AND p2.supplier_id = s.id
          AND p2.direction = 'SUPPLIER_PAYMENT' AND p2.status = 'POSTED'), 0) AS applied_minor,
      COALESCE((SELECT SUM(b.balance_minor) FROM accounting_supplier_bills b
        WHERE b.workspace_id = s.workspace_id AND b.supplier_id = s.id
          AND b.status IN ('OPEN','PARTIALLY_PAID')), 0) AS owed_minor,
      (SELECT COUNT(*) FROM accounting_supplier_bills b2
        WHERE b2.workspace_id = s.workspace_id AND b2.supplier_id = s.id
          AND b2.status IN ('OPEN','PARTIALLY_PAID')) AS bill_count
    FROM suppliers s WHERE s.workspace_id = ?`).all(workspaceId);

  const amount = (minor) => `USD ${(Number(minor) / 100).toFixed(2)}`;

  return rows
    .map((row) => ({ ...row, spareMinor: Number(row.paid_minor) - Number(row.applied_minor) }))
    // Only a decision when there is money spare *and* a bill it could go on.
    .filter((row) => row.spareMinor > 0 && Number(row.owed_minor) > 0)
    .map((row) => ({
      id: `supplier-advance:${row.id}`,
      kind: 'decision',
      title: `${row.name} has ${amount(row.spareMinor)} of yours that is not against any bill`,
      happened: `You have paid ${row.name} ${amount(row.spareMinor)} that no bill has been `
        + `matched to, and ${amount(row.owed_minor)} of their bills still says it is owed.`,
      why: 'A payment to a supplier names the supplier and not the order, so StockChief cannot '
        + 'tell an early settlement from a deposit for something else.',
      recommendation: Number(row.bill_count) === 1
        ? 'Put it against that bill if it was paying for it, or leave it as money on account.'
        : `Choose which of the ${row.bill_count} bills it was paying, or leave it on account.`,
      missing: 'Which bill that money was for.',
      actionLabel: 'Match it to a bill',
      href: '/accounting/payables',
      at: null,
      // Real money against a real debt, and the two are not talking.
      priority: 86,
    }));
}

function fromMailboxAttachmentChoices(db, workspaceId) {
  return db.prepare(`SELECT m.id AS message_id, m.connector_id, m.sender, m.subject, m.received_at,
      COUNT(a.id) AS attachment_count,
      GROUP_CONCAT(a.filename, ', ') AS filenames
    FROM connection_email_messages m
    JOIN connection_email_attachments a ON a.message_id = m.id AND a.workspace_id = m.workspace_id
    JOIN connection_email_rules r ON r.workspace_id = m.workspace_id AND r.connector_id = m.connector_id
      AND r.is_active = 1 AND r.document_mode = 'review_each'
      AND (LOWER(r.sender_pattern) = LOWER(m.sender)
        OR (r.sender_pattern LIKE '@%' AND LOWER(m.sender) LIKE '%' || LOWER(r.sender_pattern)))
    WHERE m.workspace_id = ? AND m.trust_status = 'TRUSTED' AND m.processing_status = 'CAPTURED'
    GROUP BY m.id, m.connector_id, m.sender, m.subject, m.received_at
    ORDER BY m.received_at DESC`).all(workspaceId).map((row) => ({
    id: `mailbox-choice:${row.message_id}`,
    kind: 'decision',
    title: row.attachment_count === 1
      ? `Choose what StockChief should do with ${row.filenames}`
      : `Choose what StockChief should do with ${row.attachment_count} email attachments`,
    happened: `${row.sender} sent ${row.subject || 'an email without a subject'} with ${row.filenames}. Nothing has been changed.`,
    why: 'This sender is configured to ask you what each new attachment means.',
    recommendation: 'Choose whether it is a supplier purchasing document, an inventory/product list, or history only.',
    missing: 'How StockChief should use this attachment.',
    actionLabel: 'Choose what this file is',
    href: `/settings/connections/${row.connector_id}#message-${row.message_id}`,
    at: row.received_at,
    priority: 82,
  }));
}

/**
 * The same bytes are normally a resolved duplicate. They become a real owner
 * decision when the records from the first import were subsequently removed:
 * keep that removal, or restore the exact original identities and quantities.
 */
function fromMailboxRemovedImportChoices(db, workspaceId) {
  return db.prepare(`SELECT DISTINCT m.id AS message_id, m.connector_id, m.sender, m.received_at,
      a.filename, d.applied_at, json_extract(d.result, '$.removedAt') AS removed_at
    FROM connection_email_messages m
    JOIN connection_email_attachments a ON a.message_id = m.id AND a.workspace_id = m.workspace_id
    JOIN setup_documents d ON d.workspace_id = a.workspace_id AND d.content_hash = a.content_hash
      AND d.status = 'APPLIED'
    LEFT JOIN document_restore_reviews rr ON rr.workspace_id = m.workspace_id
      AND rr.message_id = m.id AND rr.setup_document_id = d.id
    WHERE m.workspace_id = ? AND m.trust_status = 'TRUSTED'
      AND m.processing_status = 'DUPLICATE_IGNORED'
      AND json_extract(d.result, '$.removedAt') IS NOT NULL
      AND (json_extract(d.result, '$.restoredAt') IS NULL
        OR json_extract(d.result, '$.removedAt') > json_extract(d.result, '$.restoredAt'))
      AND (rr.id IS NULL OR rr.status = 'PENDING')
      AND m.id = (SELECT m2.id FROM connection_email_messages m2
        JOIN connection_email_attachments a2 ON a2.message_id = m2.id AND a2.workspace_id = m2.workspace_id
        WHERE m2.workspace_id = m.workspace_id AND a2.content_hash = a.content_hash
          AND m2.trust_status = 'TRUSTED' AND m2.processing_status = 'DUPLICATE_IGNORED'
        ORDER BY m2.received_at DESC, m2.rowid DESC LIMIT 1)
    ORDER BY m.received_at DESC`).all(workspaceId).map((row) => ({
    id: `mailbox-restore:${row.message_id}`,
    kind: 'decision',
    title: `${row.filename} was sent again after its earlier import was removed`,
    happened: `StockChief recognized the exact file from ${row.sender}. Its original import was removed, so StockChief did not silently add the stock again.`,
    why: 'This is a real choice now: restore the original products and quantities, or keep the earlier removal.',
    recommendation: 'Review the exact archived records and quantities before restoring them.',
    missing: 'Your approval to restore the import or keep it removed.',
    actionLabel: 'Decide whether to restore',
    href: `/settings/connections/${row.connector_id}/email-messages/${row.message_id}/restore-import`,
    at: row.received_at,
    priority: 86,
  }));
}

/**
 * A rule written but never switched on.
 *
 * StockChief proposes a policy after watching how somebody works, and it does
 * nothing at all until approved. Left off this page, the proposal was invisible
 * unless you went looking in Settings for something you did not know existed.
 */
function fromPolicies(db, workspaceId) {
  return autopilotPolicies
    .list(db, workspaceId)
    .filter((policy) => !policy.approvedAt && !policy.disabledAt)
    .map((policy) => ({
      id: `policy:${policy.id}`,
      kind: 'authority',
      title: `A rule is waiting for your decision: ${policy.name}`,
      happened: policy.description
        || `StockChief has drafted a rule covering ${policy.allowedActionTypes.join(', ') || 'some work'}.`,
      why: 'StockChief will not act on its own authority until you have read the rule and agreed to it.',
      recommendation: 'Approve the rule only if its limits match the authority you intend to give StockChief.',
      missing: 'Whether StockChief may do this without asking, and within what limits.',
      actionLabel: 'Read the rule',
      href: `/autopilot/policies/${policy.id}`,
      at: policy.createdAt,
      priority: 65,
    }));
}

function fromAutomationSuggestions(db, workspaceId) {
  return operatingInstructions.list(db, workspaceId, { status: 'PENDING' })
    .filter((proposal) => proposal.source === 'repeated_approval_suggestion')
    .map((proposal) => ({
      id: `automation-suggestion:${proposal.id}`,
      kind: 'authority', title: proposal.summary,
      happened: 'StockChief noticed that you approved the same kind of bounded routine work at least three times.',
      why: 'Nothing has changed. StockChief needs explicit permission before it may stop asking about similar work.',
      recommendation: 'Review the proposed scope and ceiling. Approve only if you want this to become lasting authority.',
      missing: 'Your explicit decision about whether StockChief may handle this pattern automatically.',
      actionLabel: 'Decide on this rule', href: `/operating-instructions/${proposal.id}`,
      at: proposal.createdAt, priority: 64,
    }));
}

function fromSalesOrders(db, workspaceId) {
  const salesOrders = require('../sales/sales-order-service');
  const supplierService = require('../purchasing/supplier-service');
  const position = require('../purchasing/position');
  const today = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const entries = [];
  const coveredByPreparedOrder = preparedReplenishmentSkus(db, workspaceId);
  for (const order of salesOrders.waitingForStock(db, workspaceId)) {
    for (const line of order.lines.filter((entry) => entry.backordered > 0)) {
      // A prepared replenishment plan already owns this exact stock decision.
      // Showing a second customer-shortage card made one problem look like two
      // and its button led to an explanation page with no completion action.
      if (workItems.awaitingReplenishmentForSku(db, workspaceId, line.sku_id)) continue;
      // Once StockChief has prepared the supplier order, placing that order is the
      // one owner decision. The customer consequence is printed on that PO
      // decision instead of becoming a second card for the same shortage.
      if (coveredByPreparedOrder.has(line.sku_id)) continue;
      const incoming = position.onOrderForSku(db, workspaceId, line.sku_id);
      // Fully covered demand with no customer-promised date is status, not a
      // decision. The order remains visibly waiting for incoming stock, but
      // there is no date to renegotiate and no additional supply to choose.
      if (!order.needed_by && incoming.onOrder >= Number(line.backordered)) continue;
      const incomingInTime = order.needed_by && incoming.onOrder >= line.backordered && incoming.nextExpectedDate
        && incoming.nextExpectedDate <= order.needed_by;
      if (incomingInTime) continue;
      const suppliers = supplierService.suppliersForSku(db, workspaceId, line.sku_id);
      const leadDays = suppliers.map((entry) => Number(entry.effectiveLeadTimeDays))
        .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)[0];
      // A supplier-provided date on a committed PO is stronger evidence than
      // the generic lead time. If that date moves past a customer promise,
      // explain the actual consequence instead of claiming a hypothetical new
      // order could still arrive sooner.
      const committedArrival = incoming.onOrder ? incoming.nextExpectedDate : null;
      const earliest = committedArrival || (leadDays === undefined ? null
        : new Date(today.getTime() + leadDays * dayMs).toISOString().slice(0, 10));
      const dateMiss = Boolean(order.needed_by && (!earliest || earliest > order.needed_by));

      /*
       * Stock that has turned up since this order was confirmed.
       *
       * Allocation runs at confirmation and not again, so a delivery can land
       * against this very shortfall while the entry goes on saying the stock is
       * not there and recommending a supplier who already exists. When there is
       * free stock, the decision is no longer "how will we cover this" but
       * "shall I hold it for them", and that is what it should say.
       */
      const freeNow = Math.min(
        Number(line.backordered),
        Math.max(0, salesOrders.availabilityForSku(db, workspaceId, line.sku_id).available || 0)
      );

      entries.push({
        id: `sales-order:${order.id}:${line.id}`,
        kind: 'sales_order',
        title: dateMiss
          ? `${order.customer.name} needs ${line.backordered} ${line.unit_label}(s) by ${order.needed_by}; normal supply is too late`
          : `${order.order_number} is waiting for ${line.backordered} ${line.displayName}`,
        happened: `${line.quantity_ordered} ordered · ${line.allocated} committed · ${line.backordered} waiting for stock.`,
        why: dateMiss
          ? earliest
            ? committedArrival
              ? `${incoming.onOrder} incoming unit(s) are now expected ${earliest}, after the customer needs them.`
              : `The earliest supported supplier arrival is ${earliest}, after the customer needs it.`
            : 'No supported supplier arrival date is available, so StockChief cannot promise the requested date.'
          : freeNow
            ? `${freeNow} ${freeNow === 1 ? 'unit is' : 'units are'} on the shelf and free. StockChief does not hold stock for one customer without you, because that takes it from the next one who asks.`
            : 'StockChief cannot allocate stock that is not physically available or already committed elsewhere.',
        recommendation: freeNow
          ? `Commit the ${freeNow} that ${freeNow === 1 ? 'has' : 'have'} arrived, if this customer should have ${freeNow === 1 ? 'it' : 'them'}.`
          : incoming.onOrder
            ? `Review the ${incoming.onOrder} already on order and decide whether the customer date needs to change.`
            : suppliers.length
              ? 'Review replenishment and the customer date before making a promise.'
              : 'Add a supplier or agree a different customer date.',
        missing: freeNow
          ? `Whether to hold the ${freeNow} now in stock for ${order.customer.name}.`
          : 'A decision about the uncovered customer demand and any requested-date commitment.',
        actionLabel: freeNow ? `Commit stock to ${order.order_number}` : `Cover ${order.order_number}`,
        // Never send the owner to a generic order page that only repeats the
        // shortage. If stock arrived, open the reserve action on the order.
        // Otherwise open the exact product's replenishment or supplier setup.
        href: freeNow
          ? `/orders/${order.id}#stock-shortage`
          : suppliers.length
            ? `/purchasing/why/${line.sku_id}`
            : `/purchasing/supplier-for/${line.sku_id}`,
        at: order.updated_at,
        priority: dateMiss ? 92 : 82,
      });
    }
  }
  return entries;
}

function fromConnections(db, workspaceId) {
  const rows = db.prepare(`SELECT ci.*, wc.display_name
    FROM connection_issues ci JOIN workspace_connectors wc ON wc.id = ci.connector_id
    WHERE ci.workspace_id = ? AND ci.status = 'OPEN' ORDER BY ci.updated_at DESC`).all(workspaceId);
  return rows.map((row) => {
    let candidates = [];
    try { candidates = JSON.parse(row.candidate_matches || '[]'); } catch { candidates = []; }
    const procurement = ['SUPPLIER_FOLLOW_UP_APPROVAL', 'SUPPLIER_SEND_APPROVAL'].includes(row.issue_type);
    const documentReview = row.issue_type === 'SUPPLIER_DOCUMENT_REVIEW';
    const responseCandidate = candidates.find((entry) => entry.kind === 'supplier_response_plan');
    const supplierResponse = row.issue_type === 'SUPPLIER_RESPONSE_DECISION' || Boolean(responseCandidate);
    const documentCandidate = documentReview
      ? candidates.find((entry) => entry.kind === 'supplier_document_review') : null;
    const documentDiscrepancies = documentCandidate?.discrepancies || [];
    const missingOrder = documentDiscrepancies.find((entry) => entry.type === 'purchase_order');
    const unknownCodes = [...new Set(documentDiscrepancies
      .filter((entry) => entry.type === 'unknown_sku' && entry.supplierSku)
      .map((entry) => entry.supplierSku))];
    const purchaseOrderId = candidates.find((entry) => entry.purchaseOrderId)?.purchaseOrderId;
    const unknownEntity = /^UNKNOWN_(SKU|LOCATION)$/.test(row.issue_type)
      ? row.issue_type.slice(8).toLowerCase() : null;
    const unknownExternalId = unknownEntity ? String(row.fingerprint || '').split(':').slice(-1)[0] : null;
    const hasFocusedExternalRecord = unknownExternalId && db.prepare(`SELECT 1
      FROM connection_external_records
      WHERE workspace_id = ? AND connector_id = ? AND entity_type = ? AND external_id = ?
        AND mapping_status = 'UNMAPPED' AND selected = 1`)
      .get(workspaceId, row.connector_id, unknownEntity, unknownExternalId);
    return {
      id: `connection:${row.id}`,
      kind: procurement || documentReview || supplierResponse ? 'decision' : 'connection',
      issueType: row.issue_type,
      title: documentReview && !supplierResponse ? 'A supplier document needs your review' : row.title,
      happened: documentReview && !supplierResponse
        ? missingOrder?.message || (unknownCodes.length
          ? `StockChief does not yet know which product ${unknownCodes.join(', ')} refers to.`
          : documentDiscrepancies.map((entry) => entry.message).filter(Boolean).join(' ')
            || 'StockChief found a meaningful difference between the supplier document and the purchase order.')
        : row.detail,
      why: row.issue_type === 'CONNECTION_STALE'
        ? 'StockChief may be missing activity, so its view of demand and stock may be incomplete.'
        : supplierResponse
          ? 'StockChief measured the supplier change against current stock, customer commitments, cash and alternate supply. It did not silently choose a material tradeoff.'
        : documentReview
          ? 'StockChief saved the original email but did not change the purchase order or physical inventory.'
        : procurement
          ? 'StockChief prepared the supplier communication but your authority settings require your approval before it is sent.'
          : 'StockChief stopped before changing business records because the external evidence was not safe to apply.',
      recommendation: documentReview && !supplierResponse ? 'Review the document and either resolve the match or mark it as not relevant.' : row.resolution_hint,
      missing: procurement ? 'Your approval to send the prepared supplier message.'
        : supplierResponse ? 'Your decision on the material supplier tradeoff. Communication and purchasing are approved separately.'
        : documentReview ? 'Your decision about this supplier document.' : row.resolution_hint,
      actionLabel: row.issue_type === 'SUPPLIER_FOLLOW_UP_APPROVAL' ? 'Approve follow-up'
        : row.issue_type === 'SUPPLIER_SEND_APPROVAL' ? 'Approve & send order'
          : supplierResponse ? 'Review supplier response'
          : documentReview ? 'Review supplier document' : `Fix ${row.display_name}`,
      href: procurement && purchaseOrderId ? `/purchasing/orders/${purchaseOrderId}`
        : `/settings/connections/${row.connector_id}${documentReview
          ? '#needs-you'
          : hasFocusedExternalRecord
            ? `#mapping-${unknownEntity}-${encodeURIComponent(unknownExternalId)}`
            : `#issue-${row.id}`}`,
      at: row.updated_at,
      priority: row.issue_type === 'CONNECTION_STALE' ? 86 : 90,
    };
  });
}

/** Approved purchase orders that have not actually reached their supplier. */
function fromPendingSupplierCommunications(db, workspaceId) {
  const rows = db.prepare(`SELECT sc.*, po.po_number, po.id AS po_id,
      s.id AS supplier_id, s.name AS supplier_name
    FROM supplier_communications sc
    JOIN purchase_orders po ON po.id = sc.purchase_order_id
    JOIN suppliers s ON s.id = sc.supplier_id
    WHERE sc.workspace_id = ? AND po.status = 'ORDERED'
      AND sc.status IN ('PREPARED','QUEUED','FAILED')
      AND NOT EXISTS (
        SELECT 1 FROM supplier_communications sent
        WHERE sent.workspace_id = sc.workspace_id
          AND sent.purchase_order_id = sc.purchase_order_id
          AND sent.status = 'SENT'
      )
    ORDER BY sc.updated_at DESC`).all(workspaceId);
  return rows.map((row) => {
    const missingEmail = !row.recipient;
    const missingMailbox = !row.connector_id;
    return {
      id: `supplier-communication:${row.id}`,
      kind: missingEmail || missingMailbox ? 'setup' : 'decision',
      title: missingEmail
        ? `${row.po_number} needs ${row.supplier_name}'s email before it can be sent`
        : missingMailbox
          ? `${row.po_number} needs a sending mailbox`
          : `${row.po_number} is approved but has not been sent`,
      happened: row.status === 'FAILED'
        ? `StockChief tried to send the order, but the message failed: ${row.error_message || 'the provider did not accept it'}.`
        : `The purchase order is approved inside StockChief, but ${row.supplier_name} has not received it.`,
      why: missingEmail
        ? `There is no email address on ${row.supplier_name}'s supplier record.`
        : missingMailbox
          ? 'No approved connected mailbox is selected for this supplier.'
          : 'The supplier message is prepared, but StockChief does not have authority to send it automatically.',
      recommendation: missingEmail
        ? 'Add the real supplier email. StockChief will use it for this order and future communication.'
        : missingMailbox
          ? 'Choose the connected mailbox StockChief should use for this supplier.'
          : 'Send the prepared order.',
      missing: missingEmail ? 'The supplier email address.'
        : missingMailbox ? 'A sending mailbox.' : 'Permission to send this message.',
      actionLabel: missingEmail ? 'Add supplier email'
        : missingMailbox ? 'Choose mailbox' : 'Send order',
      href: missingEmail || missingMailbox
        ? `/suppliers/${row.supplier_id}`
        : `/purchasing/orders/${row.po_id}`,
      at: row.updated_at,
      priority: 90,
    };
  });
}

function fromAccounting(db, workspaceId) {
  const rows = db.prepare(`SELECT aei.*, so.id AS sales_order_id, so.order_number
    FROM accounting_event_inbox aei
    LEFT JOIN domain_events de ON de.id = aei.domain_event_id
    LEFT JOIN sales_order_events soe ON de.source_record_type = 'sales_order_event'
      AND soe.id = de.source_record_id AND soe.workspace_id = aei.workspace_id
    LEFT JOIN sales_orders so ON so.id = soe.sales_order_id AND so.workspace_id = aei.workspace_id
    WHERE aei.workspace_id = ? AND aei.status IN ('NEEDS_REVIEW','FAILED')
    ORDER BY aei.created_at DESC`)
    .all(workspaceId);
  const eventEntries = rows.map((row) => {
    let outcome = {};
    try { outcome = JSON.parse(row.outcome || '{}'); } catch { outcome = {}; }
    return {
      id: `accounting:${row.id}`,
      kind: 'decision',
      title: row.order_number ? `${row.order_number} shipped, but its accounting is not finished`
        : 'An accounting consequence needs review',
      happened: outcome.message || row.error_message || `StockChief recorded ${row.event_type.replaceAll('.', ' · ')} operationally.`,
      why: 'StockChief kept the business event but did not invent a missing cost, price, match, or posting date.',
      recommendation: row.order_number
        ? `Open the ${row.order_number} review to see the exact sale, verified cost evidence, and posting StockChief will make.`
        : 'Open Accounting to supply the missing evidence or review the proposed correction.',
      missing: 'The financial evidence needed for a balanced, traceable posting.',
      actionLabel: row.order_number ? `Finish ${row.order_number} accounting` : 'Resolve accounting exception',
      href: `/accounting/review/${row.id}`,
      at: row.created_at,
      priority: 88,
    };
  });
  const bills = db.prepare(`SELECT b.*, s.name AS supplier_name, po.po_number
    FROM accounting_supplier_bills b JOIN suppliers s ON s.id = b.supplier_id
    LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
    WHERE b.workspace_id = ? AND b.status = 'DISPUTED' ORDER BY b.updated_at DESC`).all(workspaceId);
  const billEntries = bills.map((bill) => {
    let detail = {};
    try { detail = JSON.parse(bill.exception_detail || '{}'); } catch { detail = {}; }
    const kinds = [...new Set((detail.differences || []).map((entry) => entry.kind))];
    const explanation = kinds.includes('quantity_above_received')
      ? 'The invoice includes quantity that has not been physically received.'
      : kinds.includes('price_outside_tolerance')
        ? 'The invoice price is outside this supplier’s approved tolerance.'
        : 'The invoice could not be matched completely to its purchase order and receipts.';
    return {
      id: `accounting-bill:${bill.id}`, kind: 'decision',
      title: `${bill.supplier_name} invoice needs an accounting decision`,
      happened: `${bill.supplier_invoice_number || bill.bill_number}${bill.po_number ? ` for ${bill.po_number}` : ''}: ${explanation}`,
      why: 'StockChief saved the bill but posted no guessed inventory, expense, or payable.',
      recommendation: 'Resolve the receipt, price, quantity, or PO match before approving this bill.',
      missing: 'A complete PO ↔ receipt ↔ supplier invoice match, or your explicit correction.',
      actionLabel: 'Resolve supplier bill', href: '/accounting/payables',
      at: bill.updated_at, priority: 92,
    };
  });
  return [...eventEntries, ...billEntries];
}

function fromBusinessConsistency(db, workspaceId) {
  // Needs You only consumes failed invariants and received orders missing a
  // bill. Building the entire business brain here also calculated forecasts,
  // sales risk, full inventory valuation rows and the operational inbox that
  // was already built immediately above. On a large inventory that turned one
  // inbox read into a second whole-business report.
  const accountingLedger = require('../accounting/ledger');
  const ownerAccounting = require('../accounting/owner-dashboard');
  const accountingEnabled = accountingLedger.settings(db, workspaceId).enabled;
  // Cross-domain invariant failures are materialized as repair cases by the
  // manager and were already read by fromRepairCases above. Recomputing the
  // business brain during a page request duplicated that work and made an
  // inbox grow slower with the ledger. The only accounting exception not
  // represented by a repair case is a received order awaiting its bill.
  const stateAttention = [];
  if (accountingEnabled) {
    for (const missing of ownerAccounting.receivedWithoutBills(db, workspaceId)) {
      stateAttention.push({ priority: 72, kind: 'missing-bill', id: missing.id,
        title: `${missing.po_number} was received but has no supplier bill`,
        because: `${missing.receivedUnits} unit${missing.receivedUnits === 1 ? '' : 's'} costing `
          + `${missing.currency || 'USD'} ${(missing.receivedCostMinor / 100).toFixed(2)} arrived. `
          + 'StockChief cannot know what is owed until the bill is recorded.',
        href: `/accounting/payables/new?purchaseOrderId=${missing.id}` });
    }
  }
  return stateAttention.map((entry, index) => ({
      id: `business:${entry.kind}:${entry.id || index}`,
      kind: entry.kind === 'consistency' ? 'investigation' : 'decision',
      title: entry.title,
      happened: entry.because,
      why: entry.kind === 'consistency'
        ? 'StockChief compared the records across inventory, purchasing, connections, and accounting and they do not agree.'
        : 'StockChief knows the inventory arrived, but receiving products is not evidence of the supplier bill or payment.',
      recommendation: entry.kind === 'consistency'
        ? 'Review the source records before making another change; StockChief will not silently repair a material difference.'
        : 'Add or match the supplier bill so StockChief can show exactly what is owed.',
      missing: entry.kind === 'consistency' ? 'A decision about which source record is correct.' : 'The supplier bill.',
      actionLabel: entry.kind === 'consistency' ? 'Resolve the difference' : 'Add supplier bill',
      href: entry.href,
      at: null,
      priority: entry.priority,
    }));
}

/** A whole migration is one owner decision, however many worksheets it contains. */
function fromMigrations(db,workspaceId) {
  const packages = db.prepare(`SELECT * FROM migration_packages
    WHERE workspace_id=? AND status IN ('STAGING','NEEDS_ATTENTION','READY','FAILED')
    ORDER BY updated_at DESC,id DESC LIMIT 10`).all(workspaceId);
  const entries = [];
  for (const pkg of packages) {
    // Work in progress is not a decision. Showing it in Needs You creates the
    // exact false badge where the inbox count says one but no action exists.
    if (pkg.preparation_status === 'RUNNING') continue;
    const datasets = db.prepare(`SELECT sheet_name,entity_type,status,source_row_count
      FROM migration_source_datasets WHERE package_id=? AND entity_type<>'reference_only'
      ORDER BY sheet_index`).all(pkg.id);
    const remaining = datasets.filter((entry) => entry.status !== 'STAGED');
    const prepared = datasets.filter((entry) => entry.status === 'STAGED');
    let manifest = {};
    try { manifest = JSON.parse(pkg.manifest_json || '{}'); } catch { manifest = {}; }
    const filenames = (manifest.sourceFiles || []).map((file) => file.name).filter(Boolean);
    const sourceName = filenames.length === 1 ? filenames[0] : pkg.source_label;
    let sourceReview = null;
    try { sourceReview = require('../onboarding/owner-migration').sourceReviewCached(db,workspaceId,pkg.id); } catch { sourceReview = null; }
    if (!remaining.length && sourceReview && sourceReview.requiresDecision && !sourceReview.resolved
        && !sourceReview.autoResolvable) {
      entries.push({
        id:`migration:${pkg.id}:source-truth`,kind:'migration',
        title:`${sourceName} needs one reconciliation decision`,
        happened:`The workbook says ${Number(sourceReview.sourceIncoming).toLocaleString()} units are incoming, while its detailed open PO lines prove ${Number(sourceReview.openPurchaseOrderIncoming).toLocaleString()}. Nothing is live.`,
        why:'StockChief will not choose between contradictory source summaries and detailed records by itself.',
        recommendation:'Use the detailed operational records and retain the conflicting summaries as evidence, without posting them to stock or accounting.',
        missing:'Your choice of which proven source controls operations.',
        actionLabel:'Review one decision',href:`/onboarding/migrations/${pkg.id}/sources`,
        at:pkg.updated_at,priority:97,requiredPermission:permissions.ADMIN,
      });
      continue;
    }
    if (!remaining.length && pkg.status === 'READY') {
      entries.push({
        id:`migration:${pkg.id}:approval`,kind:'migration',
        title:`${sourceName} is verified and ready to become live`,
        happened:`All ${datasets.length} operational datasets passed verification. ${Number(pkg.staged_count || 0).toLocaleString()} prepared StockChief records are still separate from live inventory.`,
        why:'Only the inventory owner can approve the final cutover.',
        recommendation:'Review the reconciled totals once, then approve the switch when you are ready.',
        missing:'Your approval to make this prepared inventory live.',
        actionLabel:'Review and switch',href:`/onboarding/migrations/${pkg.id}`,
        at:pkg.updated_at,priority:94,requiredPermission:permissions.ADMIN,
      });
      continue;
    }
    if (!remaining.length && pkg.status === 'NEEDS_ATTENTION') {
      entries.push({
        id:`migration:${pkg.id}:verification`,kind:'migration',
        title:`${sourceName} did not pass verification`,
        happened:`StockChief found ${Number(pkg.problem_count || 0).toLocaleString()} prepared records whose source links or values could not be proven. Nothing was applied.`,
        why:'StockChief will not guess a product, location, supplier, quantity or accounting meaning.',
        recommendation:'Review the summarized failure and correct the source mapping, then rerun verification.',
        missing:'A provable source link or value for the blocked records.',
        actionLabel:'Review verification',href:`/onboarding/migrations/${pkg.id}`,
        at:pkg.updated_at,priority:96,requiredPermission:permissions.ADMIN,
      });
      continue;
    }
    if (!remaining.length && pkg.status === 'FAILED') {
      const live = Number(pkg.applied_count || 0);
      const failures = db.prepare(`SELECT entity_type,source_key,issue_detail,payload_json FROM migration_records
        WHERE package_id=? AND status='FAILED' ORDER BY ordinal,id LIMIT 20`).all(pkg.id);
      const retryable = failures.length > 0 && failures.every((failure) =>
        /^Location type must be one of:/.test(failure.issue_detail || '')
        || /^Migration reference location:.* has not been applied yet\.$/.test(failure.issue_detail || ''));
      if (!retryable) {
        const first = failures[0];
        let exactFailure = first && first.issue_detail;
        if (first && first.entity_type === 'inventory_position' && /^Enter at least one serial number\.$/.test(first.issue_detail || '')) {
          const position = JSON.parse(first.payload_json || '{}');
          const sourceSku = db.prepare(`SELECT payload_json FROM migration_records
            WHERE package_id=? AND entity_type='sku' AND source_key=? LIMIT 1`).get(pkg.id,position.skuKey);
          const sku = sourceSku ? JSON.parse(sourceSku.payload_json) : {};
          const sourceProduct = sku.productKey ? db.prepare(`SELECT payload_json FROM migration_records
            WHERE package_id=? AND entity_type='product' AND source_key=? LIMIT 1`).get(pkg.id,sku.productKey) : null;
          const product = sourceProduct ? JSON.parse(sourceProduct.payload_json) : {};
          exactFailure = `${first.source_key}: ${[product.name,sku.code || position.skuKey].filter(Boolean).join(' · ')} is serial-tracked, but the source claims ${Number(position.quantity || 0).toLocaleString()} units at ${position.locationKey} with no serial numbers.`;
        }
        entries.push({
          id:`migration:${pkg.id}:blocked`,kind:'migration',
          title:`${sourceName} needs source evidence before the switch can continue`,
          happened:`${live.toLocaleString()} verified records were applied and saved. StockChief stopped before applying ${failures.length === 1 ? 'one record' : `${failures.length} records`} it could not prove.`,
          why:exactFailure || 'A deterministic domain check rejected a prepared source record.',
          recommendation:'Review the exact stopped record. Provide the missing evidence or correct the source and upload a new snapshot; retrying alone cannot create it.',
          missing:exactFailure ? `${exactFailure} Add the exact serial identities, or correct the product tracking mode in the source.` : 'Provable source evidence for the stopped record.',
          actionLabel:'Review stopped record',href:`/onboarding/migrations/${pkg.id}`,
          at:pkg.updated_at,priority:98,requiredPermission:permissions.ADMIN,
        });
        continue;
      }
      entries.push({
        id:`migration:${pkg.id}:resume`,kind:'migration',
        title:`${sourceName} is safely paused and ready to resume`,
        happened:`StockChief stopped the switch after ${live.toLocaleString()} applied record${live === 1 ? '' : 's'}. Completed batches remain saved and retries do not duplicate them.`,
        why:'A deterministic domain check rejected a prepared record, so StockChief stopped instead of forcing it into live inventory.',
        recommendation:'Review the stopped record summary, then resume the verified switch when you are ready.',
        missing:'Your decision to resume the saved switch.',
        actionLabel:'Review paused switch',href:`/onboarding/migrations/${pkg.id}`,
        at:pkg.updated_at,priority:96,requiredPermission:permissions.ADMIN,
      });
      continue;
    }
    if (!remaining.length) continue;
    const labels = remaining.slice(0,3).map((entry) => entry.entity_type === 'purchase_order'
      ? 'purchase orders' : String(entry.sheet_name || entry.entity_type).replaceAll('_',' '));
    entries.push({
      id:`migration:${pkg.id}`,kind:'migration',
      title:`${sourceName} needs ${remaining.length === 1 ? 'one source decision' : `${remaining.length} source decisions`}`,
      happened:`${prepared.length} of ${datasets.length} operational datasets are safely prepared from ${prepared.reduce((sum,entry) => sum + Number(entry.source_row_count || 0),0).toLocaleString()} source rows. Nothing is live yet.`,
      why:pkg.preparation_error || 'StockChief stopped before an uncertain source state could become stock, an order, or accounting.',
      recommendation:'Open the migration and settle only the remaining source issue. StockChief will then verify the totals before the switch.',
      missing:pkg.preparation_error || `A safe treatment for ${labels.join(', ')}${remaining.length > labels.length ? ` and ${remaining.length - labels.length} more` : ''}.`,
      actionLabel:'Continue migration',href:`/onboarding/migrations/${pkg.id}/sources`,
      at:pkg.updated_at,priority:92,requiredPermission:permissions.ADMIN,
    });
  }
  return entries;
}

/**
 * Owner decisions produced by the operational engines.
 *
 * This deliberately excludes the unified-business consistency projection:
 * business-brain consumes this function when it builds that projection, so
 * including it here would make the brain recursively ask itself what needs
 * attention. Keeping this boundary explicit lets Home, Ask and Needs You share
 * one source for actual waiting work without copying its classification logic.
 */
function operationalEntries(db, workspaceId) {
  const safely = (fn) => {
    try { return fn(db, workspaceId) || []; } catch { return []; }
  };
  return [
    ...safely(fromMigrations),
    ...safely(fromPhysicalEvents),
    ...safely(fromWorkItems),
    ...safely(fromInvestigations),
    ...safely(fromRepairCases),
    ...safely(fromAutonomousOperations),
    ...safely(fromLearning),
    ...safely(fromTransfers),
    ...safely(fromCorrections),
    ...safely(fromImports),
    ...safely(fromMailboxRemovedImportChoices),
    ...safely(fromMailboxAttachmentChoices),
    ...safely(fromMoneyHeldOnCancelledOrders),
    ...safely(fromSupplierMoneyNotOnAnyBill),
    ...safely(fromPredictedTrouble),
    ...safely(fromLateShipments),
    ...safely(fromEmailOrders),
    ...safely(fromUnansweredMail),
    ...safely(fromHeldOrders),
    ...safely(fromMailboxInventory),
    ...safely(fromPolicies),
    ...safely(fromAutomationSuggestions),
    ...safely(fromSalesOrders),
    ...safely(fromPendingSupplierCommunications),
    ...safely(fromConnections),
    ...safely(fromAccounting),
    ...safely(fromCountsReturnsAndWaves),
    ...safely(fromFindings),
  ];
}

/** Governed learning changes are one decision, never a stream of metrics. */
function fromLearning(db, workspaceId) {
  return require('../learning/service').listProposals(db, workspaceId,
    { statuses:['PROPOSED','ROLLBACK_RECOMMENDED'] }).map((row) => {
    const rollback = row.status === 'ROLLBACK_RECOMMENDED';
    return { id:`learning:${row.id}`, kind:'decision', title:rollback
      ? `A learned policy change is performing worse` : row.headline,
    happened:rollback ? 'StockChief measured an adverse result after the policy changed.' : row.rationale,
    why:rollback
      ? 'The previous value was retained and can be restored through the same domain-owned policy service.'
      : 'This is a proposed operating-policy change. StockChief cannot treat a pattern as permission.',
    recommendation:rollback ? 'Restore the previous value and keep measuring.'
      : 'Review the measured outcomes and approve only if this tradeoff matches how you want the business run.',
    missing:rollback ? 'Your approval to roll back the change.' : 'Your approval, or an explicit narrow learning grant.',
    actionLabel:rollback ? 'Review rollback' : 'Review learned change',
    href:`/planning#learning-${row.id}`, at:row.createdAt,
    priority:rollback || row.materiality === 'HIGH' ? 94 : 84, requiredPermission:permissions.ADMIN };
  });
}

/** Mission 8 exceptions, compressed to one exact decision per workflow. */
function fromCountsReturnsAndWaves(db, workspaceId) {
  const entries = [];
  for (const row of db.prepare(`SELECT s.id,s.status,s.created_at,c.name FROM inventory_count_sessions s
    JOIN inventory_count_campaigns c ON c.id=s.campaign_id WHERE s.workspace_id=?
      AND s.status IN ('RECOUNT_REQUIRED','AWAITING_APPROVAL')`).all(workspaceId)) {
    const recount = row.status === 'RECOUNT_REQUIRED';
    entries.push({ id:`count:${row.id}`,kind:'count',title:`${row.name} ${recount?'needs a blind recount':'has a variance to approve'}`,
      happened: recount?'The first blind count disagreed with the recorded stock.':'Two count passes produced a recorded variance.',
      why: recount?'StockChief cannot change stock from one disputed count.':'Counting and approving a stock correction are separate authorities.',
      recommendation: recount?'Count the affected products again without showing the first answer.':'Review the revealed variance, then approve or reject the correction.',
      missing: recount?'An independent physical recount.':'Variance approval.',actionLabel:recount?'Start recount':'Review variance',
      href:`/warehouse/counts/${row.id}`,at:row.created_at,priority:88,
      requiredPermission:recount?permissions.COUNT_STOCK:permissions.APPROVE_COUNT_VARIANCE });
  }
  for (const row of db.prepare(`SELECT id,return_number,status,created_at FROM customer_returns
    WHERE workspace_id=? AND status='AWAITING_REFUND'`).all(workspaceId)) entries.push({id:`rma:${row.id}`,kind:'customer_return',
      title:`${row.return_number} is inspected and waiting for its refund`,happened:'The returned goods were received and their physical condition was recorded.',
      why:'StockChief cannot decide a refund amount or payment destination without authority.',recommendation:'Approve the evidence-backed refund and let accounting reconcile it.',missing:'Refund amount and approval.',
      actionLabel:'Finish the return',href:`/warehouse/returns/customer/${row.id}`,at:row.created_at,priority:85,requiredPermission:permissions.REFUND_CUSTOMER_RETURN});
  for (const row of db.prepare(`SELECT id,return_number,status,created_at FROM supplier_returns
    WHERE workspace_id=? AND status IN ('AWAITING_CREDIT','CREDIT_MISMATCH')`).all(workspaceId)) {const mismatch=row.status==='CREDIT_MISMATCH';entries.push({id:`rtv:${row.id}`,kind:'supplier_return',
      title:mismatch?`${row.return_number} supplier credit does not match`:`${row.return_number} is waiting for the supplier credit`,
      happened:mismatch?'The supplier recorded a different credit from the amount expected.':'The goods left inventory and were returned to the supplier.',
      why:mismatch?'StockChief will not silently force a difference into agreement.':'No supplier credit is recorded yet.',
      recommendation:'Open the return and reconcile it against the supplier evidence.',missing:mismatch?'A decision about the credit difference.':'The supplier credit note.',
      actionLabel:'Reconcile supplier return',href:`/warehouse/returns/supplier/${row.id}`,at:row.created_at,priority:mismatch?92:78,requiredPermission:permissions.RECONCILE_SUPPLIER_RETURN});}
  for (const row of db.prepare(`SELECT id,wave_number,title,created_at FROM fulfillment_waves WHERE workspace_id=? AND status='BLOCKED'`).all(workspaceId)) entries.push({id:`wave:${row.id}`,kind:'wave',title:`Wave #${row.wave_number} stopped on a scan or shortage`,
    happened:'A product/location scan failed or the shelf quantity was short.',why:'StockChief stopped before substituting an identity or pretending the units were picked.',
    recommendation:'Review the failed scan, recount or replenish, then resume the exact line.',missing:'Correct physical identity or stock evidence.',actionLabel:'Open blocked wave',href:`/warehouse/waves/${row.id}`,at:row.created_at,priority:90,requiredPermission:permissions.MANAGE_FULFILLMENT_WAVES});
  return entries;
}

/** Hundreds of rows caused by one setup gap are one owner decision. Keep the
 * underlying orders/findings intact in their domain queues, but do not make an
 * owner page through the same answer hundreds of times in Needs You. */
function compressLargeQueues(entries) {
  const consumed = new Set();
  const groups = [];
  const collect = (key,predicate,minimum,make) => {
    const matches = entries.filter((entry) => !consumed.has(entry) && predicate(entry));
    if (matches.length < minimum) return;
    matches.forEach((entry) => consumed.add(entry));
    groups.push(make(matches,key));
  };
  collect('supplier-mailbox',(entry) => entry.kind === 'setup' && entry.actionLabel === 'Choose mailbox',6,(rows,key) => ({
    id:`group:${key}`,kind:'setup',
    title:`Set up one sending mailbox for ${rows.length.toLocaleString()} prepared supplier orders`,
    happened:`The orders are saved, but StockChief has no approved mailbox to use. This is one setup gap repeated across ${rows.length.toLocaleString()} orders—not ${rows.length.toLocaleString()} separate choices.`,
    why:'StockChief cannot send business email from an account you have not explicitly selected.',
    recommendation:'Connect or choose the supplier mailbox once. StockChief will then evaluate each prepared message under the same communication authority.',
    missing:'Which connected mailbox StockChief may use for supplier communication.',
    actionLabel:'Set up supplier communication',href:'/settings/connections',at:null,
    priority:Math.max(...rows.map((entry) => entry.priority || 0)),requiredPermission:permissions.ADMIN,
  }));
  collect('receiving-review',(entry) => entry.kind === 'receiving' && entry.actionLabel === 'Book it in',11,(rows,key) => ({
    id:`group:${key}`,kind:'receiving',
    title:`Review ${rows.length.toLocaleString()} deliveries as one receiving queue`,
    happened:`Their expected dates have passed. StockChief grouped them instead of asking the same physical-arrival question ${rows.length.toLocaleString()} times.`,
    why:'StockChief cannot claim a box arrived without a person, scan, carrier event or receiving document.',
    recommendation:'Open the receiving queue and record only the deliveries that physically arrived; the individual purchase orders remain intact.',
    missing:'Which deliveries actually arrived and what was in them.',
    actionLabel:'Open receiving queue',href:'/purchasing/orders',at:null,
    priority:Math.max(...rows.map((entry) => entry.priority || 0)),
  }));
  collect('replenishment-review',(entry) => entry.kind === 'finding' && entry.actionLabel === 'Decide what to order',4,(rows,key) => ({
    id:`group:${key}`,kind:'finding',
    title:`Review ${rows.length.toLocaleString()} replenishment suggestions as one plan`,
    happened:`StockChief found ${rows.length.toLocaleString()} products whose stock crossed their reorder rules and kept the exact SKU calculations in the planning view.`,
    why:'These related suggestions need one inventory-plan review, not a separate top-level interruption for every SKU.',
    recommendation:'Review the combined plan against incoming stock, suppliers and cash before placing any orders.',
    missing:'Your decision on the combined replenishment plan.',
    actionLabel:'Review replenishment plan',href:'/planning',at:null,
    priority:Math.max(...rows.map((entry) => entry.priority || 0)),
  }));
  return [...entries.filter((entry) => !consumed.has(entry)),...groups];
}

/** Everything waiting, newest and most urgent first, as one list. */
function inbox(db, workspaceId, membership = null, options = {}) {
  // Clean up the legacy false-positive before reading the inbox. This is
  // intentionally idempotent and makes the corrected behavior immediate for
  // workspaces that have not yet run a scheduled reconciliation.
  try {
    investigations.resolveByTrigger(
      db,
      workspaceId,
      'business_consistency_inventory-cost-coverage',
      'StockChief reclassified this as missing financial evidence, not a disagreement in the business records.'
    );
  } catch {
    // The defensive filter in fromInvestigations still prevents stale UI if a
    // read-only or partially migrated database cannot record the cleanup.
  }
  const rawEntries = compressLargeQueues([
    ...operationalEntries(db, workspaceId),
    ...fromBusinessConsistency(db, workspaceId),
    // Learning demand is not a decision. Home teaches the user to record real
    // sales in context; Needs You remains reserved for something StockChief is
    // genuinely blocked on, such as a mismatch, approval or unknown mapping.
  ]);
  const dismissedEntryIds = dismissals.dismissedIds(db, workspaceId, rawEntries.map((entry) => entry.id));
  const entries = rawEntries
    .filter((entry) => !dismissedEntryIds.has(entry.id))
    .filter((entry) => !entry.requiredPermission || !membership
      || permissions.can(membership, entry.requiredPermission)).map((entry) => ({
    ...entry,
    // Presentation repair for immutable records created before natural
    // pluralisation was introduced. Never show "unit(s)" to an owner.
    title: humanizeUnitMarkers(entry.title),
    happened: humanizeUnitMarkers(entry.happened),
    why: humanizeUnitMarkers(entry.why),
    recommendation: humanizeUnitMarkers(entry.recommendation),
    missing: humanizeUnitMarkers(entry.missing),
    actionLabel: humanizeUnitMarkers(entry.actionLabel),
    importance: entry.priority >= 90 ? 'Urgent' : entry.priority >= 80 ? 'Important' : 'Needs You',
  }));

  /*
   * Two entries that ask the same person for the same decision about the same
   * record are one decision, however many internal rows produced them.
   *
   * Found on a real workspace: PO-1001 appeared twice in Needs you, with the
   * same title, the same explanation and the same "Book it in" button pointing
   * at the same order — because two work items existed for the one delivery.
   * Nothing was wrong with either of them; there is simply only one box arriving
   * and one thing to do about it. A queue that lists it twice makes somebody
   * wonder what the difference is, and there is none to find.
   *
   * Matched on what the reader can see — the record it goes to and what it asks
   * them to do — because that is exactly what makes two entries impossible to
   * tell apart. The more urgent one survives, so nothing is quietly downgraded.
   */
  const seen = new Map();
  for (const entry of entries) {
    const key = `${entry.href} :: ${entry.actionLabel} :: ${entry.title}`;
    const kept = seen.get(key);
    if (!kept || (entry.priority || 0) > (kept.priority || 0)) seen.set(key, entry);
  }

  const ordered = [...seen.values()]
    .sort((a, b) => (b.priority - a.priority) || String(b.at || '').localeCompare(String(a.at || '')));
  // This is the only authoritative count. Header chrome reads the cached
  // number instead of rebuilding every domain projection on every request.
  require('../attention/needs-you-count').rememberNeedsYou(db,workspaceId,ordered.length);
  // Most screens need either the number or a short preview, not hundreds of
  // fully resolved destinations. Resolving every destination on every request
  // made the whole application wait behind large inboxes.
  const requestedLimit = Number(options.limit);
  const visible = Number.isInteger(requestedLimit) && requestedLimit >= 0
    ? ordered.slice(0, requestedLimit)
    : ordered;
  const result = require('../product-brain/destinations').attach(visible, membership, {
    brain: options.productBrain,
    strict: options.strictDestinations !== false,
  }).map((entry) => ({
    ...entry,
    // Imports may supply a domain-specific destructive discard action. All
    // other prompts get the one universal, persistent close action.
    dismiss: entry.dismiss || {
      action: '/needs-you/dismiss',
      entryId: entry.id,
      label: 'Dismiss completely',
      confirm: 'Dismiss this from StockChief everywhere? This does not delete or change the underlying business record.',
    },
  }));
  // Arrays keep the existing public contract. The non-enumerable total lets a
  // bounded caller display the truthful queue count without serialising a
  // second payload or accidentally rendering every decision.
  Object.defineProperty(result, 'totalCount', { value: ordered.length, enumerable: false });
  return result;
}

module.exports = {
  inbox,
  operationalEntries,
  fromEmailOrders,
  fromMoneyHeldOnCancelledOrders,
  fromSupplierMoneyNotOnAnyBill,
  fromPredictedTrouble,
  fromLateShipments,
  missingFromEvent,
  fromPhysicalEvents,
  fromInvestigations,
  fromRepairCases,
  fromAutonomousOperations,
  fromLearning,
  fromTransfers,
  fromCorrections,
  fromImports,
  fromMailboxInventory,
  fromMailboxAttachmentChoices,
  fromMailboxRemovedImportChoices,
  fromPolicies,
  fromAutomationSuggestions,
  fromSalesOrders,
  fromPendingSupplierCommunications,
  fromConnections,
  fromAccounting,
  fromBusinessConsistency,
  fromMigrations,
  fromWorkItems,
  fromFindings,
  fromReadiness,
  fromCountsReturnsAndWaves,
};

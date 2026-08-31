'use strict';

/**
 * Everything waiting for a person, as one list they can actually read.
 *
 * Needs you grew a section per internal mechanism: physical events, manager
 * findings, investigations, prepared corrections, controlled work, readiness
 * decisions. Each section made sense to the part of Foundry that filled it and
 * to nobody else. A sale that could not be recorded appeared under "Deliveries
 * and counts to confirm", headed "Foundry needs one more detail before it can
 * record this" — without saying which detail — above a button that went to the
 * general Tell Foundry box, where the customer's only option was to type the
 * same sentence again and get the same result.
 *
 * The mechanisms stay. What changes is that every one of them has to answer the
 * same four questions before it may put anything in front of a person:
 *
 *   happened — what was done or observed, in their own words where possible
 *   why      — why Foundry stopped instead of carrying on
 *   recommendation — the safest next step Foundry recommends
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

/**
 * What Foundry does not know about a reported event.
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

  // Anything Foundry could not place at all. It read the sentence and could not
  // tell which inventory operation it describes, or could not carry it out.
  return 'What Foundry should record — it could not work out the exact change from this on its own.';
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
      title: counting ? 'A count needs one decision' : 'Foundry could not record this yet',
      happened: `You told Foundry: “${row.stated_as}”`,
      why: counting
        ? 'Foundry will not change recorded stock from a count without you.'
        : 'Foundry will not guess an inventory change, so it stopped rather than record the wrong thing.',
      recommendation: counting
        ? 'Confirm the physical count before changing the inventory record.'
        : 'Supply the missing fact so Foundry can prepare the exact inventory change.',
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
    .map((entry) => {
      const ageDays = Math.max(0, Math.floor((Date.now() - new Date(entry.createdAt).getTime()) / 86400000));
      return ({
      id: `investigation:${entry.investigationId}`,
      kind: 'investigation',
      title: `${(entry.affectedEntities || {}).displayName || 'Stock'} does not match the records`,
      happened: entry.observedDifference && entry.observedDifference.statedAs
        ? `You told Foundry: “${entry.observedDifference.statedAs}”`
        : 'Foundry compared the count with its ledger and they disagree.',
      why: 'Foundry cannot tell which figure is right, and will not overwrite the ledger on a guess.' +
        (ageDays >= 2 ? ` This discrepancy has been unresolved for ${ageDays} days.` : ''),
      recommendation: entry.recommendedNextStep
        || 'Recount the stock, then correct the record only if the physical count is confirmed.',
      // The specific next step Foundry worked out, not a generic invitation to
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

function fromCorrections(db, workspaceId) {
  return proposals
    .listOpen(db, workspaceId, { limit: 20 })
    .filter((proposal) => proposal.status === 'AWAITING_APPROVAL')
    .map((proposal) => ({
      id: `proposal:${proposal.proposalId}`,
      kind: 'correction',
      title: 'A change is prepared and waiting for you',
      happened: actionPresenter.oneLine(db, workspaceId, proposal),
      why: 'Foundry has worked out the exact change but will not apply it without approval.',
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
    // "Foundry will not move stock or commit money without you", above a button
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
        why: 'Foundry cannot see what is physically in the box, so it will not book a delivery in for you.',
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
      return {
        ...base,
        kind: 'decision',
        title: exception ? `${po} costs more than your rule allows` : `${po} is ready to send`,
        happened: (item.policyEvaluation || {}).reason || `${po} for ${action.supplierName || 'a supplier'}.`,
        why: exception
          ? 'Your rule caps how far a price may move, and this order is over it, so Foundry stopped.'
          : 'Foundry prepared it but will not place an order with a supplier by itself.',
        recommendation: exception
          ? 'Check the supplier price and approve only if the increase is acceptable.'
          : 'Place the order if the supplier, price and quantity are correct.',
        missing: exception ? 'Whether to accept the new price.' : 'Your decision to place it.',
        actionLabel: exception ? 'Approve the new price' : 'Place the order',
        priority: 84,
      };
    }

    if (item.category === 'replenishment_plan' && action.blocked === 'no_supplier') {
      return {
        ...base,
        kind: 'setup',
        title: `${named || 'This variant'} needs a supplier`,
        happened: action.explanation || 'It is below its reorder point, but nobody is on file to supply it.',
        why: 'Without a supplier, Foundry has no pack size, price or lead time and cannot prepare a truthful order.',
        recommendation: 'Add the supplier and its purchasing terms. Foundry will then recalculate the one replenishment plan.',
        missing: 'Who supplies this variant, its pack size, price and lead time.',
        actionLabel: 'Add supplier',
        href: action.skuId ? `/purchasing/supplier-for/${action.skuId}` : '/purchasing/setup',
        priority: 86,
      };
    }

    return {
      ...base,
      kind: 'decision',
      title: named ? `${named} needs a decision` : item.categoryLabel,
      happened: item.category === 'replenishment_plan' && named
        ? `${named} needs replenishing. ${action.explanation || (item.policyEvaluation || {}).reason || ''}`.trim()
        : action.explanation || (item.policyEvaluation || {}).reason || item.categoryLabel,
      why: 'Foundry will not move stock or commit money without you.',
      recommendation: 'Approve the single plan only if all of its proposed actions are correct.',
      missing: 'Your approval of the plan.',
      actionLabel: 'Approve the plan',
      priority: ageDays >= 3 ? 92 : 85,
    };
  });

  // A draft without a separate work item is still a real purchasing decision.
  // Home already showed it; omitting it here made the Home total, sidebar badge
  // and Check-now result disagree with the page named “Needs you”.
  const drafts = autopilotPresenter.whatFoundryPrepared(db, workspaceId, { limit: 100 })
    .filter((entry) => entry.kind === 'purchase')
    .map((entry) => ({
      id: `purchase:${entry.id}`,
      kind: 'decision',
      title: entry.title,
      happened: entry.because,
      why: 'Foundry prepared the order but will not place it with a supplier by itself.',
      recommendation: 'Place the order if the supplier, price and quantity are correct.',
      missing: 'Your decision to place it.',
      actionLabel: entry.action,
      href: entry.link,
      at: null,
      priority: entry.priority || 55,
    }));

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
    happened: finding.because || 'Foundry noticed this in your records.',
    why: isProtectedLimit
      ? approachingProtectedLimit
        ? 'The next outgoing unit would reach the blocked boundary you approved. Foundry cannot choose whether to order, receive stock, or change your rule.'
        : 'This stock has reached or crossed the protection limit you approved. Foundry cannot choose whether to order, receive stock, or change your rule.'
      : 'Foundry raised it because the numbers crossed a line you set, or a pattern it watches.',
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
      happened: entry.because || 'Foundry cannot do part of its job yet.',
      why: entry.why || 'Foundry needs something from you before it can work this out.',
      recommendation: entry.recommendation
        || 'Provide the operating input above so Foundry can manage this safely.',
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
          ? `Foundry read ${rows} row(s) from it. Nothing has been created yet.`
          : 'Foundry read the file. Nothing has been created yet.',
        why: 'Foundry does not create products or stock from a file until somebody has looked at what it found.',
        recommendation: problems
          ? 'Review the rows Foundry could not place, then approve the corrected import.'
          : 'Review the mapped rows, then approve the import if they are correct.',
        missing: plan.approvalStatus === 'APPROVED'
          ? 'One more press to actually bring the rows in. Nothing has been created yet.'
          : problems
            ? `A decision on ${problems} row(s) it could not place, then your approval.`
            : 'Your approval to bring these rows in.',
        actionLabel: plan.approvalStatus === 'APPROVED' ? 'Bring it in' : 'Approve the import',
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
      happened: `Foundry read the attachment from ${row.sender}. Nothing has been added or changed yet.`,
      why: 'Email attachments are external evidence. Foundry waits for you to review the exact products and quantities.',
      recommendation: 'Check the proposed matches and new records, then approve only if the file belongs in this inventory.',
      missing: 'Your approval of the inventory preview.',
      actionLabel: 'Choose what to add',
      href: `/foundry/proposal/${row.understanding_id}`,
      at: row.created_at,
      priority: 75,
    }));
}

/**
 * A rule written but never switched on.
 *
 * Foundry proposes a policy after watching how somebody works, and it does
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
        || `Foundry has drafted a rule covering ${policy.allowedActionTypes.join(', ') || 'some work'}.`,
      why: 'Foundry will not act on its own authority until you have read the rule and agreed to it.',
      recommendation: 'Approve the rule only if its limits match the authority you intend to give Foundry.',
      missing: 'Whether Foundry may do this without asking, and within what limits.',
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
      happened: 'Foundry noticed that you approved the same kind of bounded routine work at least three times.',
      why: 'Nothing has changed. Foundry needs explicit permission before it may stop asking about similar work.',
      recommendation: 'Review the proposed scope and ceiling. Approve only if you want this to become lasting authority.',
      missing: 'Your explicit decision about whether Foundry may handle this pattern automatically.',
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
  for (const order of salesOrders.waitingForStock(db, workspaceId)) {
    for (const line of order.lines.filter((entry) => entry.backordered > 0)) {
      const incoming = position.onOrderForSku(db, workspaceId, line.sku_id);
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
            : 'No supported supplier arrival date is available, so Foundry cannot promise the requested date.'
          : 'Foundry cannot allocate stock that is not physically available or already committed elsewhere.',
        recommendation: incoming.onOrder
          ? `Review the ${incoming.onOrder} already on order and decide whether the customer date needs to change.`
          : suppliers.length
            ? 'Review replenishment and the customer date before making a promise.'
            : 'Add a supplier or agree a different customer date.',
        missing: 'A decision about the uncovered customer demand and any requested-date commitment.',
        actionLabel: `Cover ${order.order_number}`,
        href: `/sales/orders/${order.id}`,
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
  return rows.map((row) => ({
    id: `connection:${row.id}`,
    kind: 'connection',
    issueType: row.issue_type,
    title: row.title,
    happened: row.detail,
    why: row.issue_type === 'CONNECTION_STALE'
      ? 'Foundry may be missing activity, so its view of demand and stock may be incomplete.'
      : 'Foundry stopped before changing business records because the external evidence was not safe to apply.',
    recommendation: row.resolution_hint,
    missing: row.resolution_hint,
    actionLabel: `Fix ${row.display_name}`,
    href: `/settings/connections/${row.connector_id}`,
    at: row.updated_at,
    priority: row.issue_type === 'CONNECTION_STALE' ? 86 : 90,
  }));
}

/** Everything waiting, newest and most urgent first, as one list. */
function inbox(db, workspaceId) {
  const safely = (fn) => {
    try { return fn(db, workspaceId) || []; } catch { return []; }
  };

  const entries = [
    ...safely(fromPhysicalEvents),
    ...safely(fromWorkItems),
    ...safely(fromInvestigations),
    ...safely(fromCorrections),
    ...safely(fromImports),
    ...safely(fromMailboxInventory),
    ...safely(fromPolicies),
    ...safely(fromAutomationSuggestions),
    ...safely(fromSalesOrders),
    ...safely(fromConnections),
    ...safely(fromFindings),
    // Learning demand is not a decision. Home teaches the user to record real
    // sales in context; Needs You remains reserved for something Foundry is
    // genuinely blocked on, such as a mismatch, approval or unknown mapping.
  ].map((entry) => ({
    ...entry,
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

  return [...seen.values()]
    .sort((a, b) => (b.priority - a.priority) || String(b.at || '').localeCompare(String(a.at || '')));
}

module.exports = {
  inbox,
  missingFromEvent,
  fromPhysicalEvents,
  fromInvestigations,
  fromCorrections,
  fromImports,
  fromMailboxInventory,
  fromPolicies,
  fromAutomationSuggestions,
  fromSalesOrders,
  fromConnections,
  fromWorkItems,
  fromFindings,
  fromReadiness,
};

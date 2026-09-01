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

/** Approved attachments whose rule says "ask me for each attachment". */
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
      ? `Choose what Foundry should do with ${row.filenames}`
      : `Choose what Foundry should do with ${row.attachment_count} email attachments`,
    happened: `${row.sender} sent ${row.subject || 'an email without a subject'} with ${row.filenames}. Nothing has been changed.`,
    why: 'This sender is configured to ask you what each new attachment means.',
    recommendation: 'Choose whether it is a supplier purchasing document, an inventory/product list, or history only.',
    missing: 'How Foundry should use this attachment.',
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
    happened: `Foundry recognized the exact file from ${row.sender}. Its original import was removed, so Foundry did not silently add the stock again.`,
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
            : 'No supported supplier arrival date is available, so Foundry cannot promise the requested date.'
          : freeNow
            ? `${freeNow} ${freeNow === 1 ? 'unit is' : 'units are'} on the shelf and free. Foundry does not hold stock for one customer without you, because that takes it from the next one who asks.`
            : 'Foundry cannot allocate stock that is not physically available or already committed elsewhere.',
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
  return rows.map((row) => {
    let candidates = [];
    try { candidates = JSON.parse(row.candidate_matches || '[]'); } catch { candidates = []; }
    const procurement = ['SUPPLIER_FOLLOW_UP_APPROVAL', 'SUPPLIER_SEND_APPROVAL'].includes(row.issue_type);
    const documentReview = row.issue_type === 'SUPPLIER_DOCUMENT_REVIEW';
    const documentCandidate = documentReview
      ? candidates.find((entry) => entry.kind === 'supplier_document_review') : null;
    const documentDiscrepancies = documentCandidate?.discrepancies || [];
    const missingOrder = documentDiscrepancies.find((entry) => entry.type === 'purchase_order');
    const unknownCodes = [...new Set(documentDiscrepancies
      .filter((entry) => entry.type === 'unknown_sku' && entry.supplierSku)
      .map((entry) => entry.supplierSku))];
    const purchaseOrderId = candidates.find((entry) => entry.purchaseOrderId)?.purchaseOrderId;
    return {
      id: `connection:${row.id}`,
      kind: procurement || documentReview ? 'decision' : 'connection',
      issueType: row.issue_type,
      title: documentReview ? 'A supplier document needs your review' : row.title,
      happened: documentReview
        ? missingOrder?.message || (unknownCodes.length
          ? `Foundry does not yet know which product ${unknownCodes.join(', ')} refers to.`
          : documentDiscrepancies.map((entry) => entry.message).filter(Boolean).join(' ')
            || 'Foundry found a meaningful difference between the supplier document and the purchase order.')
        : row.detail,
      why: row.issue_type === 'CONNECTION_STALE'
        ? 'Foundry may be missing activity, so its view of demand and stock may be incomplete.'
        : documentReview
          ? 'Foundry saved the original email but did not change the purchase order or physical inventory.'
        : procurement
          ? 'Foundry prepared the supplier communication but your authority settings require your approval before it is sent.'
          : 'Foundry stopped before changing business records because the external evidence was not safe to apply.',
      recommendation: documentReview ? 'Review the document and either resolve the match or mark it as not relevant.' : row.resolution_hint,
      missing: procurement ? 'Your approval to send the prepared supplier message.'
        : documentReview ? 'Your decision about this supplier document.' : row.resolution_hint,
      actionLabel: row.issue_type === 'SUPPLIER_FOLLOW_UP_APPROVAL' ? 'Approve follow-up'
        : row.issue_type === 'SUPPLIER_SEND_APPROVAL' ? 'Approve & send order'
          : documentReview ? 'Review supplier document' : `Fix ${row.display_name}`,
      href: procurement && purchaseOrderId ? `/purchasing/orders/${purchaseOrderId}`
        : `/settings/connections/${row.connector_id}${documentReview ? '#needs-you' : ''}`,
      at: row.updated_at,
      priority: row.issue_type === 'CONNECTION_STALE' ? 86 : 90,
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
      happened: outcome.message || row.error_message || `Foundry recorded ${row.event_type.replaceAll('.', ' · ')} operationally.`,
      why: 'Foundry kept the business event but did not invent a missing cost, price, match, or posting date.',
      recommendation: row.order_number
        ? `Open the ${row.order_number} review to see the exact sale, verified cost evidence, and posting Foundry will make.`
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
      why: 'Foundry saved the bill but posted no guessed inventory, expense, or payable.',
      recommendation: 'Resolve the receipt, price, quantity, or PO match before approving this bill.',
      missing: 'A complete PO ↔ receipt ↔ supplier invoice match, or your explicit correction.',
      actionLabel: 'Resolve supplier bill', href: '/accounting/payables',
      at: bill.updated_at, priority: 92,
    };
  });
  return [...eventEntries, ...billEntries];
}

function fromBusinessConsistency(db, workspaceId) {
  const state = require('./business-brain').build(db, workspaceId);
  return state.attention
    .filter((entry) => ['consistency', 'missing-bill'].includes(entry.kind))
    .map((entry, index) => ({
      id: `business:${entry.kind}:${entry.id || index}`,
      kind: entry.kind === 'consistency' ? 'investigation' : 'decision',
      title: entry.title,
      happened: entry.because,
      why: entry.kind === 'consistency'
        ? 'Foundry compared the records across inventory, purchasing, connections, and accounting and they do not agree.'
        : 'Foundry knows the inventory arrived, but receiving products is not evidence of the supplier bill or payment.',
      recommendation: entry.kind === 'consistency'
        ? 'Review the source records before making another change; Foundry will not silently repair a material difference.'
        : 'Add or match the supplier bill so Foundry can show exactly what is owed.',
      missing: entry.kind === 'consistency' ? 'A decision about which source record is correct.' : 'The supplier bill.',
      actionLabel: entry.kind === 'consistency' ? 'Resolve the difference' : 'Add supplier bill',
      href: entry.href,
      at: null,
      priority: entry.priority,
    }));
}

/** Everything waiting, newest and most urgent first, as one list. */
function inbox(db, workspaceId) {
  // Clean up the legacy false-positive before reading the inbox. This is
  // intentionally idempotent and makes the corrected behavior immediate for
  // workspaces that have not yet run a scheduled reconciliation.
  try {
    investigations.resolveByTrigger(
      db,
      workspaceId,
      'business_consistency_inventory-cost-coverage',
      'Foundry reclassified this as missing financial evidence, not a disagreement in the business records.'
    );
  } catch {
    // The defensive filter in fromInvestigations still prevents stale UI if a
    // read-only or partially migrated database cannot record the cleanup.
  }
  const safely = (fn) => {
    try { return fn(db, workspaceId) || []; } catch { return []; }
  };

  const entries = [
    ...safely(fromPhysicalEvents),
    ...safely(fromWorkItems),
    ...safely(fromInvestigations),
    ...safely(fromCorrections),
    ...safely(fromImports),
    ...safely(fromMailboxRemovedImportChoices),
    ...safely(fromMailboxAttachmentChoices),
    ...safely(fromMailboxInventory),
    ...safely(fromPolicies),
    ...safely(fromAutomationSuggestions),
    ...safely(fromSalesOrders),
    ...safely(fromConnections),
    ...safely(fromAccounting),
    ...safely(fromBusinessConsistency),
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
  fromMailboxAttachmentChoices,
  fromMailboxRemovedImportChoices,
  fromPolicies,
  fromAutomationSuggestions,
  fromSalesOrders,
  fromConnections,
  fromAccounting,
  fromBusinessConsistency,
  fromWorkItems,
  fromFindings,
  fromReadiness,
};

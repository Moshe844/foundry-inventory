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
 *   missing  — the specific decision or fact it does not have
 *   action   — one thing to click, going straight to where it is resolved
 *
 * An entry that cannot answer them is not ready to be shown, and saying so in
 * code is the only way to stop the next mechanism adding another vague card.
 */

const investigations = require('./investigations');
const workItems = require('../autopilot/work-items');
const autopilotPresenter = require('../autopilot/presenter');
const managerReadiness = require('./readiness');
const actionPresenter = require('../actions/presenter');
const proposals = require('../actions/proposal-service');
const importPlans = require('../imports/plan-service');
const autopilotPolicies = require('../autopilot/policy-service');

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
    .map((entry) => ({
      id: `investigation:${entry.investigationId}`,
      kind: 'investigation',
      title: `${(entry.affectedEntities || {}).displayName || 'Stock'} does not match the records`,
      happened: entry.observedDifference && entry.observedDifference.statedAs
        ? `You told Foundry: “${entry.observedDifference.statedAs}”`
        : 'Foundry compared the count with its ledger and they disagree.',
      why: 'Foundry cannot tell which figure is right, and will not overwrite the ledger on a guess.',
      // The specific next step Foundry worked out, not a generic invitation to
      // go and look: "Recount Filter Cartridge at Main Warehouse" is an
      // instruction, "look into this" is a shrug.
      missing: entry.recommendedNextStep
        || (entry.unexplainedAmount === null
          ? 'Which figure is correct.'
          : `An explanation for ${entry.unexplainedAmount} unit(s), or a decision to correct the record.`),
      actionLabel: 'Look into this',
      href: `/investigations/${entry.investigationId}`,
      at: entry.createdAt,
      priority: 80,
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
      why: 'Foundry has worked out the exact change but will not apply it without approval.',
      missing: 'Your approval.',
      actionLabel: 'Review and approve',
      href: `/actions/${proposal.proposalId}`,
      at: proposal.createdAt,
      priority: 70,
    }));
}

function fromWorkItems(db, workspaceId) {
  return workItems.awaitingApproval(db, workspaceId).map((item) => {
    const action = item.recommendedAction || {};
    const named = (item.affectedEntities || {}).displayName;
    const base = { id: `work:${item.id}`, at: item.createdAt, href: `/autopilot/work/${item.id}` };

    // Checking in a delivery is not an approval, and describing it as one —
    // "Foundry will not move stock or commit money without you", above a button
    // called Review the plan — told somebody the opposite of what to do. It is
    // a box that has arrived, and the job is to count what is in it.
    if (item.category === 'receiving_followup') {
      const po = action.poNumber || 'A delivery';
      const from = action.supplierName ? ` from ${action.supplierName}` : '';
      return {
        ...base,
        kind: 'receiving',
        title: `${po}${from} ${action.late ? 'is late' : 'is due'}`,
        happened: (() => {
          // Older items stored the date only as evidence, so it is read from
          // there too rather than telling somebody Foundry is still waiting for
          // a delivery the heading has just called late.
          const evidence = (item.sourceEvidence || []).find((fact) => fact.label === 'Expected');
          const due = action.expectedDate || (evidence && evidence.value) || null;
          const outstanding = action.outstandingUnits
            ? `, with ${action.outstandingUnits} unit(s) still outstanding.` : '.';
          if (due && action.late) {
            return `It was due on ${due}` +
              `${action.daysLate ? `, ${action.daysLate} day(s) ago` : ''}${outstanding}`;
          }
          if (due) return `It is due on ${due}${outstanding}`;
          return `Foundry is watching for it to arrive${outstanding}`;
        })(),
        why: 'Foundry cannot see what is physically in the box, so it will not book a delivery in for you.',
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
        missing: exception ? 'Whether to accept the new price.' : 'Your decision to place it.',
        actionLabel: 'Review the order',
        priority: 84,
      };
    }

    return {
      ...base,
      kind: 'decision',
      title: named ? `${named} needs a decision` : item.categoryLabel,
      happened: action.explanation || (item.policyEvaluation || {}).reason || item.categoryLabel,
      why: 'Foundry will not move stock or commit money without you.',
      missing: 'Your approval of the plan.',
      actionLabel: 'Review the plan',
      priority: 85,
    };
  });
}

function fromFindings(db, workspaceId) {
  return autopilotPresenter.whatNeedsYou(db, workspaceId).map((finding) => ({
    id: `finding:${finding.id}`,
    kind: 'finding',
    title: finding.title,
    happened: finding.because || 'Foundry noticed this in your records.',
    why: 'Foundry raised it because the numbers crossed a line you set, or a pattern it watches.',
    missing: 'A look, and a decision about what to do.',
    actionLabel: 'See what Foundry found',
    href: finding.link,
    at: null,
    priority: finding.priority || 60,
  }));
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
        missing: plan.approvalStatus === 'APPROVED'
          ? 'One more press to actually bring the rows in. Nothing has been created yet.'
          : problems
            ? `A decision on ${problems} row(s) it could not place, then your approval.`
            : 'Your approval to bring these rows in.',
        actionLabel: plan.approvalStatus === 'APPROVED' ? 'Bring it in' : 'Review the file',
        href: `/imports/${plan.id}`,
        at: plan.createdAt,
        priority: 75,
      };
    });
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
      missing: 'Whether Foundry may do this without asking, and within what limits.',
      actionLabel: 'Read the rule',
      href: `/autopilot/policies/${policy.id}`,
      at: policy.createdAt,
      priority: 65,
    }));
}

/** Everything waiting, newest and most urgent first, as one list. */
function inbox(db, workspaceId) {
  const safely = (fn) => {
    try { return fn(db, workspaceId) || []; } catch { return []; }
  };

  return [
    ...safely(fromPhysicalEvents),
    ...safely(fromWorkItems),
    ...safely(fromInvestigations),
    ...safely(fromCorrections),
    ...safely(fromImports),
    ...safely(fromPolicies),
    ...safely(fromFindings),
    ...safely(fromReadiness),
  ].sort((a, b) => (b.priority - a.priority) || String(b.at || '').localeCompare(String(a.at || '')));
}

module.exports = {
  inbox,
  missingFromEvent,
  fromPhysicalEvents,
  fromInvestigations,
  fromCorrections,
  fromImports,
  fromPolicies,
  fromWorkItems,
  fromFindings,
  fromReadiness,
};

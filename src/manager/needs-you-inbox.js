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
    return {
      id: `work:${item.id}`,
      kind: 'decision',
      title: named ? `${named} needs a decision` : item.categoryLabel,
      happened: action.explanation || (item.policyEvaluation || {}).reason || item.categoryLabel,
      why: 'Foundry will not move stock or commit money without you.',
      missing: 'Your approval of the plan.',
      actionLabel: 'Review the plan',
      href: `/autopilot/work/${item.id}`,
      at: item.createdAt,
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
      actionLabel: entry.actionLabel || 'Sort this out',
      href: entry.link || entry.href || '/settings',
      at: null,
      priority: 50,
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
  fromWorkItems,
  fromFindings,
  fromReadiness,
};

'use strict';

/**
 * How many things are actually waiting for a person in one inventory.
 *
 * There is exactly one of these because there used to be two, and they
 * disagreed: the nav badge and the workspace switcher both counted every open
 * attention row, while the Needs you page counted decisions. A customer saw
 * "3" next to a page that said one thing needed them.
 *
 * The definition that matters is the page's, because that is where the badge
 * sends them: readiness decisions, open investigations, unmatched physical
 * events, work waiting for approval, and the findings severe enough to be
 * someone's decision rather than something Foundry is merely watching.
 *
 * Requires are lazy so this can be used from both the request middleware and
 * the workspace list without either pulling a cycle through the other.
 */
function countNeedsYou(db, workspaceId) {
  const investigations = require('../manager/investigations');
  const workItems = require('../autopilot/work-items');
  const autopilotPresenter = require('../autopilot/presenter');
  const readiness = require('../manager/readiness');

  const operating = readiness.decisions(db, workspaceId).length;
  const openInvestigations = investigations.list(db, workspaceId, {
    statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'],
    limit: 100,
  }).length;
  const physical = db
    .prepare(
      `SELECT COUNT(*) AS n FROM physical_events
        WHERE workspace_id = ? AND status = 'NEEDS_HUMAN' AND investigation_id IS NULL`
    )
    .get(workspaceId).n;
  const waiting = workItems.awaitingApproval(db, workspaceId).length;
  const findings = autopilotPresenter.whatNeedsYou(db, workspaceId).length;

  return operating + openInvestigations + physical + waiting + findings;
}

module.exports = { countNeedsYou };

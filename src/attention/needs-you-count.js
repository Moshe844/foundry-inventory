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
  // The inbox is the customer-facing source of truth. Counting its entries
  // keeps the sidebar, workspace switcher and Needs you page identical as new
  // decision types (such as uncovered customer orders) are added.
  return require('../manager/needs-you-inbox').inbox(db, workspaceId).length;
}

module.exports = { countNeedsYou };

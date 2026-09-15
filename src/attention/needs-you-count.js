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
const cacheByDatabase = new WeakMap();

function cacheFor(db) {
  let cache = cacheByDatabase.get(db);
  if (!cache) { cache = new Map(); cacheByDatabase.set(db,cache); }
  return cache;
}

/** Remember the authoritative count whenever the real inbox is built. */
function rememberNeedsYou(db,workspaceId,count) {
  cacheFor(db).set(workspaceId,{ count:Number(count || 0),at:Date.now() });
  return Number(count || 0);
}

function invalidateNeedsYou(db,workspaceId) {
  cacheFor(db).delete(workspaceId);
}

function countNeedsYou(db, workspaceId, membership = null, options = {}) {
  // Header chrome must never execute every inventory, accounting, purchasing,
  // connection and migration check. The full Needs You page refreshes this
  // value from its authoritative inbox; ordinary pages only read the latest
  // known count in O(1).
  if (options.fresh === true) {
    const result = require('../manager/needs-you-inbox').inbox(db, workspaceId, membership, options);
    return rememberNeedsYou(db,workspaceId,
      Number.isInteger(result.totalCount) ? result.totalCount : result.length);
  }
  return cacheFor(db).get(workspaceId)?.count || 0;
}

module.exports = { countNeedsYou,rememberNeedsYou,invalidateNeedsYou };

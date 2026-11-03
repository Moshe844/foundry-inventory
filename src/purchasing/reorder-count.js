'use strict';

/*
 * How many items are on What to order, for the badge beside Buy in the
 * sidebar. Every page draws the sidebar, so the count is kept for a minute per
 * inventory instead of being worked out on every request; a failure shows no
 * badge rather than an error.
 */
const TTL_MS = 60 * 1000;
const cache = new Map();

async function reorderCount(database, workspaceId) {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.count;
  const count = await require('./postgres-shortage-list').read(database, workspaceId, {})
    .then((found) => found.rows.length).catch(() => 0);
  cache.set(workspaceId, { count, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return count;
}

module.exports = { reorderCount };

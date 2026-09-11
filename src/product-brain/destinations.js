'use strict';

const { canonical } = require('./registry');

/** Make any generated action link obey the same capability/access contract. */
function contract(href, membership, options = {}) {
  const brain = options.brain || canonical;
  if (!href) return { valid: false, allowed: false, reason: 'No destination was supplied.' };
  const access = brain.accessForHref(href, membership);
  const actualRoute = !brain.routes || brain.routes.length === 0 || brain.hasRoute(href);
  return { valid: access.exists && actualRoute, allowed: actualRoute && (!membership || access.allowed),
    capabilityId: access.capability && access.capability.id, permission: access.capability && access.capability.permission,
    reason: access.reason || null, href };
}

function attach(entries, membership, options = {}) {
  const strict = options.strict !== false;
  return entries.map((entry) => {
    const destination = contract(entry.href, membership, options);
    if (!destination.valid && strict) {
      const error = new Error(`Needs You item ${entry.id} points to an unregistered destination: ${entry.href}`);
      error.code = 'INVALID_NEEDS_YOU_DESTINATION';
      throw error;
    }
    return { ...entry, destination };
  }).filter((entry) => entry.destination.valid && entry.destination.allowed);
}

module.exports = { contract, attach };

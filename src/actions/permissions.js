'use strict';

/**
 * What a person may do inside one inventory.
 *
 * Permissions are per membership, not per account: the same person can be an
 * operator in one inventory and read-only in another. A role implies a default
 * set; an explicit grant on the membership overrides it, which is how ADJUST is
 * given to a trusted staff member without making them an owner.
 *
 * Every action authorises here, on the server, before anything is validated or
 * executed. Hiding a button is presentation, not security.
 */

const { AuthorizationError } = require('../domain/errors');

const VIEW = 'VIEW';
const OPERATE = 'OPERATE';
const ADJUST = 'ADJUST';
const ADMIN = 'ADMIN';

// Purchasing is separated from stock handling because the two are different
// jobs in a real business: the person who unloads the van should be able to
// book the delivery in without also being able to commit the company to a
// forty-thousand-dollar order.
const VIEW_PURCHASING = 'VIEW_PURCHASING';
const CREATE_PO = 'CREATE_PO';
const APPROVE_PO = 'APPROVE_PO';
const RECEIVE_PO = 'RECEIVE_PO';
const MANAGE_SUPPLIERS = 'MANAGE_SUPPLIERS';
const MANAGE_REPLENISHMENT = 'MANAGE_REPLENISHMENT';

const PURCHASING = [
  VIEW_PURCHASING,
  CREATE_PO,
  APPROVE_PO,
  RECEIVE_PO,
  MANAGE_SUPPLIERS,
  MANAGE_REPLENISHMENT,
];

const ALL = [VIEW, OPERATE, ADJUST, ADMIN, ...PURCHASING];

/** What each role can do before any explicit grant. */
const ROLE_DEFAULTS = {
  owner: [VIEW, OPERATE, ADJUST, ADMIN, ...PURCHASING],
  // Staff can see what is on order and book in what arrives — both are part of
  // handling stock. Committing to a purchase, changing suppliers and changing
  // replenishment settings are not, and are withheld until granted explicitly.
  staff: [VIEW, OPERATE, VIEW_PURCHASING, RECEIVE_PO],
};

const LABELS = {
  VIEW: 'View inventory',
  OPERATE: 'Receive, issue and transfer',
  ADJUST: 'Correct counts',
  ADMIN: 'Settings and people',
  VIEW_PURCHASING: 'See suppliers and purchase orders',
  CREATE_PO: 'Prepare purchase orders',
  APPROVE_PO: 'Approve purchase orders',
  RECEIVE_PO: 'Book in deliveries',
  MANAGE_SUPPLIERS: 'Add and edit suppliers',
  MANAGE_REPLENISHMENT: 'Set reorder policies',
};

/**
 * Holding a purchasing permission implies being able to see purchasing, for the
 * same reason VIEW is implied by everything else: a person who can approve an
 * order but not look at one would be a nonsense.
 */
function impliedBy(permissions) {
  const set = new Set(permissions);
  if (set.size) set.add(VIEW);
  if (PURCHASING.some((p) => p !== VIEW_PURCHASING && set.has(p))) set.add(VIEW_PURCHASING);
  return [...set];
}

/** The permissions a membership actually holds. */
function permissionsFor(membership) {
  if (!membership) return [];
  if (membership.permissions) {
    try {
      const explicit = JSON.parse(membership.permissions);
      if (Array.isArray(explicit)) {
        const clean = explicit.filter((p) => ALL.includes(p));
        return clean.length ? impliedBy(clean) : [];
      }
    } catch {
      /* fall through to the role default */
    }
  }
  return impliedBy(ROLE_DEFAULTS[membership.role] || [VIEW]);
}

function can(membership, permission) {
  return permissionsFor(membership).includes(permission);
}

function assertCan(membership, permission, what) {
  if (can(membership, permission)) return true;
  throw new AuthorizationError(
    what
      ? `You do not have permission to ${what} in this inventory.`
      : 'You do not have permission to do that in this inventory.'
  );
}

/** Which permission each action type needs. */
const ACTION_PERMISSION = {
  receive: OPERATE,
  issue: OPERATE,
  transfer: OPERATE,
  adjust: ADJUST,
  create_item: OPERATE,
  add_location: ADMIN,
  rename_terminology: ADMIN,
  purchase: CREATE_PO,
  receive_shipment: RECEIVE_PO,
};

function permissionForAction(actionType) {
  return ACTION_PERMISSION[actionType] || ADMIN;
}

const VERB = {
  receive: 'receive stock',
  issue: 'issue stock',
  transfer: 'transfer stock',
  adjust: 'correct counts',
  create_item: 'add products',
  add_location: 'change settings',
  rename_terminology: 'change settings',
  purchase: 'prepare purchase orders',
  receive_shipment: 'book in deliveries',
};

function assertCanPerform(membership, actionType) {
  return assertCan(membership, permissionForAction(actionType), VERB[actionType]);
}

/** Serialises an explicit grant, or null to fall back to the role. */
function encodeGrant(permissions) {
  if (!Array.isArray(permissions)) return null;
  const clean = [...new Set(permissions.filter((p) => ALL.includes(p)))];
  return clean.length ? JSON.stringify(clean) : JSON.stringify([]);
}

module.exports = {
  VIEW,
  OPERATE,
  ADJUST,
  ADMIN,
  VIEW_PURCHASING,
  CREATE_PO,
  APPROVE_PO,
  RECEIVE_PO,
  MANAGE_SUPPLIERS,
  MANAGE_REPLENISHMENT,
  PURCHASING,
  impliedBy,
  ALL,
  LABELS,
  ROLE_DEFAULTS,
  ACTION_PERMISSION,
  permissionsFor,
  can,
  assertCan,
  permissionForAction,
  assertCanPerform,
  encodeGrant,
};

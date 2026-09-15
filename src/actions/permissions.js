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
const VIEW_SALES = 'VIEW_SALES';
const MANAGE_SALES = 'MANAGE_SALES';
const FULFILL_SALES = 'FULFILL_SALES';
const VIEW_ACCOUNTING = 'VIEW_ACCOUNTING';
const MANAGE_ACCOUNTING = 'MANAGE_ACCOUNTING';
const RECORD_PAYMENTS = 'RECORD_PAYMENTS';
const RECONCILE_ACCOUNTS = 'RECONCILE_ACCOUNTS';
const CLOSE_ACCOUNTING_PERIOD = 'CLOSE_ACCOUNTING_PERIOD';
// Capitalising freight/duty changes inventory value and future COGS. It is
// deliberately separate from entering a bill or booking a delivery.
const ALLOCATE_LANDED_COST = 'ALLOCATE_LANDED_COST';
// Transfer authority is intentionally split across custody changes. A person
// may prepare work without being able to approve it, and may receive what
// arrived without being allowed to dispatch assets from another location.
const VIEW_TRANSFERS = 'VIEW_TRANSFERS';
const REQUEST_TRANSFER = 'REQUEST_TRANSFER';
const APPROVE_TRANSFER = 'APPROVE_TRANSFER';
const PICK_TRANSFER = 'PICK_TRANSFER';
const DISPATCH_TRANSFER = 'DISPATCH_TRANSFER';
const RECEIVE_TRANSFER = 'RECEIVE_TRANSFER';
// Mission 8 separates physically doing work from authorizing consequences.
const COUNT_STOCK = 'COUNT_STOCK';
const APPROVE_COUNT_VARIANCE = 'APPROVE_COUNT_VARIANCE';
const AUTHORIZE_CUSTOMER_RETURN = 'AUTHORIZE_CUSTOMER_RETURN';
const INSPECT_CUSTOMER_RETURN = 'INSPECT_CUSTOMER_RETURN';
const REFUND_CUSTOMER_RETURN = 'REFUND_CUSTOMER_RETURN';
const AUTHORIZE_SUPPLIER_RETURN = 'AUTHORIZE_SUPPLIER_RETURN';
const SHIP_SUPPLIER_RETURN = 'SHIP_SUPPLIER_RETURN';
const RECONCILE_SUPPLIER_RETURN = 'RECONCILE_SUPPLIER_RETURN';
const MANAGE_FULFILLMENT_WAVES = 'MANAGE_FULFILLMENT_WAVES';
const PHYSICAL_OPERATIONS = [COUNT_STOCK, APPROVE_COUNT_VARIANCE,
  AUTHORIZE_CUSTOMER_RETURN, INSPECT_CUSTOMER_RETURN, REFUND_CUSTOMER_RETURN,
  AUTHORIZE_SUPPLIER_RETURN, SHIP_SUPPLIER_RETURN, RECONCILE_SUPPLIER_RETURN,
  MANAGE_FULFILLMENT_WAVES];
const TRANSFERS = [VIEW_TRANSFERS, REQUEST_TRANSFER, APPROVE_TRANSFER,
  PICK_TRANSFER, DISPATCH_TRANSFER, RECEIVE_TRANSFER];

const PURCHASING = [
  VIEW_PURCHASING,
  CREATE_PO,
  APPROVE_PO,
  RECEIVE_PO,
  MANAGE_SUPPLIERS,
  MANAGE_REPLENISHMENT,
];

const SALES = [VIEW_SALES, MANAGE_SALES, FULFILL_SALES];
const ACCOUNTING = [VIEW_ACCOUNTING, MANAGE_ACCOUNTING, RECORD_PAYMENTS,
  RECONCILE_ACCOUNTS, CLOSE_ACCOUNTING_PERIOD, ALLOCATE_LANDED_COST];
const ALL = [VIEW, OPERATE, ADJUST, ADMIN, ...PURCHASING, ...SALES, ...ACCOUNTING, ...TRANSFERS, ...PHYSICAL_OPERATIONS];

/** What each role can do before any explicit grant. */
const ROLE_DEFAULTS = {
  owner: [VIEW, OPERATE, ADJUST, ADMIN, ...PURCHASING, ...SALES, ...ACCOUNTING, ...TRANSFERS, ...PHYSICAL_OPERATIONS],
  accountant: [VIEW, VIEW_PURCHASING, VIEW_SALES, ...ACCOUNTING],
  // Staff can see what is on order and book in what arrives — both are part of
  // handling stock. Committing to a purchase, changing suppliers and changing
  // replenishment settings are not, and are withheld until granted explicitly.
  staff: [VIEW, OPERATE, VIEW_PURCHASING, RECEIVE_PO,
    VIEW_TRANSFERS, REQUEST_TRANSFER, PICK_TRANSFER, DISPATCH_TRANSFER, RECEIVE_TRANSFER,
    COUNT_STOCK, INSPECT_CUSTOMER_RETURN, SHIP_SUPPLIER_RETURN, MANAGE_FULFILLMENT_WAVES],
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
  VIEW_SALES: 'See customers and sales orders',
  MANAGE_SALES: 'Create and confirm sales orders',
  FULFILL_SALES: 'Fulfill and cancel sales orders',
  VIEW_ACCOUNTING: 'See accounting and financial reports',
  MANAGE_ACCOUNTING: 'Manage bills, invoices and the chart of accounts',
  RECORD_PAYMENTS: 'Record customer and supplier payments',
  RECONCILE_ACCOUNTS: 'Reconcile bank and credit-card accounts',
  CLOSE_ACCOUNTING_PERIOD: 'Close accounting periods',
  ALLOCATE_LANDED_COST: 'Approve landed-cost allocations',
  VIEW_TRANSFERS: 'See inventory transfers',
  REQUEST_TRANSFER: 'Request inventory transfers',
  APPROVE_TRANSFER: 'Approve inventory transfers',
  PICK_TRANSFER: 'Pick inventory transfers',
  DISPATCH_TRANSFER: 'Dispatch inventory transfers',
  RECEIVE_TRANSFER: 'Receive inventory transfers',
  COUNT_STOCK: 'Perform physical counts',
  APPROVE_COUNT_VARIANCE: 'Approve count variances',
  AUTHORIZE_CUSTOMER_RETURN: 'Authorize customer returns',
  INSPECT_CUSTOMER_RETURN: 'Receive and inspect customer returns',
  REFUND_CUSTOMER_RETURN: 'Approve customer refunds and exchanges',
  AUTHORIZE_SUPPLIER_RETURN: 'Authorize supplier returns',
  SHIP_SUPPLIER_RETURN: 'Ship supplier returns',
  RECONCILE_SUPPLIER_RETURN: 'Reconcile supplier credits',
  MANAGE_FULFILLMENT_WAVES: 'Create and run fulfillment waves',
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
  if (TRANSFERS.some((p) => p !== VIEW_TRANSFERS && set.has(p))) set.add(VIEW_TRANSFERS);
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
        // An owner is the final authority for the business. Historical owner
        // memberships often have a frozen explicit list from before a later
        // capability existed; treating that snapshot as a denial would hide
        // new financial controls from the person who must approve them.
        if (membership.role === 'owner') return impliedBy([...ROLE_DEFAULTS.owner, ...clean]);
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
  transfer: REQUEST_TRANSFER,
  request_transfer: REQUEST_TRANSFER,
  approve_transfer: APPROVE_TRANSFER,
  pick_transfer: PICK_TRANSFER,
  dispatch_transfer: DISPATCH_TRANSFER,
  receive_transfer: RECEIVE_TRANSFER,
  adjust: ADJUST,
  create_item: OPERATE,
  configure_kit: OPERATE,
  archive_item: OPERATE,
  add_location: ADMIN,
  rename_terminology: ADMIN,
  purchase: CREATE_PO,
  receive_shipment: RECEIVE_PO,
  // Sales-order inventory work follows the existing day-to-day stock role.
  // Fine-grained Sales grants remain available without silently changing every
  // staff membership created before Mission 10.
  sales_order: OPERATE,
  fulfill_sales_order: OPERATE,
  warehouse_receive: OPERATE,
  warehouse_putaway: OPERATE,
  warehouse_pick: OPERATE,
  warehouse_count: ADJUST,
  warehouse_transfer: OPERATE,
  count_campaign: COUNT_STOCK,
  approve_count_variance: APPROVE_COUNT_VARIANCE,
  customer_return: AUTHORIZE_CUSTOMER_RETURN,
  inspect_customer_return: INSPECT_CUSTOMER_RETURN,
  refund_customer_return: REFUND_CUSTOMER_RETURN,
  supplier_return: AUTHORIZE_SUPPLIER_RETURN,
  ship_supplier_return: SHIP_SUPPLIER_RETURN,
  reconcile_supplier_return: RECONCILE_SUPPLIER_RETURN,
  fulfillment_wave: MANAGE_FULFILLMENT_WAVES,
};

/*
 * Some actions are not one job.
 *
 * Retiring a record is the same action whether the record is a supplier or a
 * location, but they are not the same authority: the person who manages
 * suppliers should be able to retire one without also being an administrator,
 * and nobody should close a location on a purchasing grant. So the permission
 * for those comes from the removal registry, per kind, rather than from a
 * single entry in the table above.
 *
 * Required late, inside the call: the registry reaches the services it acts on,
 * and several of those authorise through this file. Requiring it at the top
 * would close that loop and hand one of them a half-built module.
 */
function removalKind(subject) {
  if (!subject) return null;
  return require('./removals').kindOf(subject);
}

/**
 * @param {string} actionType
 * @param {object} [subject] the intent line or stored proposal, when there is
 *   one. Actions whose authority depends on what they are about need it; the
 *   rest ignore it, so callers may always pass it.
 */
function permissionForAction(actionType, subject = null) {
  const kind = removalKind(subject);
  if (kind) return kind.permission;
  return ACTION_PERMISSION[actionType] || ADMIN;
}

const VERB = {
  receive: 'receive stock',
  issue: 'issue stock',
  transfer: 'transfer stock',
  adjust: 'correct counts',
  create_item: 'add products',
  configure_kit: 'configure kits',
  archive_item: 'archive products',
  add_location: 'change settings',
  rename_terminology: 'change settings',
  purchase: 'prepare purchase orders',
  receive_shipment: 'book in deliveries',
  sales_order: 'create or confirm sales orders',
  fulfill_sales_order: 'fulfill or cancel sales orders',
  warehouse_receive: 'scan warehouse receipts',
  warehouse_putaway: 'scan putaway work',
  warehouse_pick: 'scan picking work',
  warehouse_count: 'post warehouse counts',
  warehouse_transfer: 'scan warehouse transfers',
  request_transfer: 'request inventory transfers',
  approve_transfer: 'approve inventory transfers',
  pick_transfer: 'pick inventory transfers',
  dispatch_transfer: 'dispatch inventory transfers',
  receive_transfer: 'receive inventory transfers',
  count_campaign: 'start inventory counts',
  approve_count_variance: 'approve count variances',
  customer_return: 'authorize customer returns',
  inspect_customer_return: 'inspect customer returns',
  refund_customer_return: 'refund customer returns',
  supplier_return: 'authorize supplier returns',
  ship_supplier_return: 'ship supplier returns',
  reconcile_supplier_return: 'reconcile supplier returns',
  fulfillment_wave: 'run fulfillment waves',
};

function verbForAction(actionType, subject = null) {
  const kind = removalKind(subject);
  if (kind) return `remove ${kind.plural}`;
  return VERB[actionType];
}

function assertCanPerform(membership, actionType, subject = null) {
  return assertCan(membership, permissionForAction(actionType, subject), verbForAction(actionType, subject));
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
  VIEW_SALES,
  MANAGE_SALES,
  FULFILL_SALES,
  VIEW_ACCOUNTING,
  MANAGE_ACCOUNTING,
  RECORD_PAYMENTS,
  RECONCILE_ACCOUNTS,
  CLOSE_ACCOUNTING_PERIOD,
  ALLOCATE_LANDED_COST,
  VIEW_TRANSFERS,
  REQUEST_TRANSFER,
  APPROVE_TRANSFER,
  PICK_TRANSFER,
  DISPATCH_TRANSFER,
  RECEIVE_TRANSFER,
  COUNT_STOCK,
  APPROVE_COUNT_VARIANCE,
  AUTHORIZE_CUSTOMER_RETURN,
  INSPECT_CUSTOMER_RETURN,
  REFUND_CUSTOMER_RETURN,
  AUTHORIZE_SUPPLIER_RETURN,
  SHIP_SUPPLIER_RETURN,
  RECONCILE_SUPPLIER_RETURN,
  MANAGE_FULFILLMENT_WAVES,
  PHYSICAL_OPERATIONS,
  TRANSFERS,
  SALES,
  ACCOUNTING,
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
  verbForAction,
  encodeGrant,
};

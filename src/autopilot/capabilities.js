'use strict';

/**
 * What Foundry may do on its own, one job at a time.
 *
 * The mode above this — watch only, ask me first, handle routine work — says
 * how much authority Foundry has in general. It used to say all of it: turning
 * on "handle routine work" so that Foundry could email a payment request also
 * let it place supplier orders, move stock between locations, and answer
 * customers. One switch, six unrelated consequences, and no way to want one of
 * them without the others.
 *
 * So the mode stays, and it stays simple, but it is now a ceiling rather than
 * a grant. Underneath it every job is authorised separately and starts off:
 *
 *   - moving stock between locations
 *   - reordering and placing purchase orders
 *   - emailing suppliers
 *   - answering customers
 *   - asking customers to pay
 *   - telling customers their order shipped
 *
 * Raising the mode grants nothing by itself. Granting a capability does
 * nothing while the mode is below it. Both have to agree, which is the whole
 * point: authorising Foundry to chase an invoice should never quietly
 * authorise it to spend money.
 */

const { nowIso } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');

/*
 * The list is closed on purpose. A capability that can be invented by a caller
 * is a capability nobody granted, and the settings page could never show it.
 */
const CAPABILITIES = {
  inventory_transfers: {
    label: 'Move stock between locations',
    blurb: 'Foundry transfers stock to where it is needed, inside the limits of an approved policy.',
    consequence: 'Stock moves.',
  },
  replenishment: {
    label: 'Reorder and place purchase orders',
    blurb: 'Foundry raises purchase orders to restore stock it has been told to keep.',
    consequence: 'Money is committed to suppliers.',
  },
  replenishment_settings: {
    label: 'Keep replenishment levels up to date',
    blurb: 'Foundry adjusts reorder points and stock targets to match measured demand and delivery '
      + 'times, inside limits you set.',
    // Separate from placing orders on purpose. Letting Foundry keep a level
    // current is a much smaller thing than letting it spend, and an owner who
    // wants the first should not have to grant the second to get it.
    consequence: 'Reorder levels change, which changes what gets ordered later.',
  },
  supplier_emails: {
    label: 'Email suppliers',
    blurb: 'Foundry sends prepared purchase orders and follow-ups to suppliers itself.',
    consequence: 'Suppliers receive mail from you.',
  },
  customer_replies: {
    label: 'Answer customers',
    blurb: 'Foundry replies to customer mail it can answer from your own records.',
    consequence: 'Customers receive mail from you.',
  },
  payment_requests: {
    label: 'Ask customers to pay',
    blurb: 'When a deposit or balance falls due, Foundry makes the payment link and emails it.',
    consequence: 'Customers are asked for money.',
  },
  shipping_labels: {
    label: 'Buy shipping labels',
    blurb: 'When a parcel is ready and a shipping rule covers it, Foundry buys the label from the '
      + 'carrier and the parcel goes.',
    // Named plainly. Everything else about shipping is free — asking a carrier
    // what something would cost commits nobody — and this one step is the one
    // that takes money out, so it is the one that needs saying yes to.
    consequence: 'Money is spent with a carrier, and goods leave.',
  },
  shipping_notices: {
    label: 'Tell customers their order has shipped',
    blurb: 'Foundry sends the shipping notice it writes when a box goes.',
    consequence: 'Customers receive mail from you.',
  },
};

const NAMES = Object.keys(CAPABILITIES);

/*
 * Which job each kind of planned action belongs to.
 *
 * Shared with the policy engine deliberately. If the engine judged an action
 * against one job while approving a policy granted a different one, a policy
 * could be approved and still never authorise anything — the worst kind of
 * bug, because everything looks configured.
 */
const CAPABILITY_FOR_ACTION = {
  transfer: 'inventory_transfers',
  replenishment_plan: 'replenishment',
  prepare_purchase_order: 'replenishment',
  approve_purchase_order: 'replenishment',
  receive_delivery: 'replenishment',
  adjust_replenishment_policy: 'replenishment_settings',
};

function requireName(capability) {
  const name = String(capability || '').trim();
  if (!CAPABILITIES[name]) {
    throw new ValidationError(`There is no Foundry job called "${capability}".`);
  }
  return name;
}

function granted(db, workspaceId, capability) {
  const row = db.prepare(`SELECT granted FROM autopilot_capabilities
    WHERE workspace_id = ? AND capability = ?`).get(workspaceId, capability);
  return Boolean(row && row.granted);
}

/**
 * May Foundry do this job by itself right now, and if not, why not.
 *
 * The reason matters as much as the answer. A prepared message with no
 * explanation looks like something the owner forgot to send, rather than
 * something waiting on a permission they never gave.
 */
function may(db, workspaceId, capability) {
  const name = requireName(capability);
  const state = require('./modes').get(db, workspaceId);

  if (state.paused) return { allowed: false, because: 'Foundry is paused.' };
  if (state.suspended) {
    return { allowed: false, because: 'Foundry has stopped itself and is waiting to be looked at.' };
  }
  if (state.mode === 'OBSERVE') {
    return { allowed: false, because: 'Foundry is set to watch only, so it acts on nothing by itself.' };
  }
  if (!state.canAutomate) {
    return { allowed: false,
      because: 'Foundry is set to ask before acting, so it prepares the work and stops.' };
  }
  if (!granted(db, workspaceId, name)) {
    return { allowed: false,
      because: `Nobody has authorised Foundry to ${CAPABILITIES[name].label.toLowerCase()} on its own.` };
  }
  return { allowed: true, because: null };
}

/** Every job, whether it is granted, and what granting it would mean. */
function list(db, workspaceId) {
  const rows = db.prepare('SELECT capability, granted, updated_at FROM autopilot_capabilities WHERE workspace_id = ?')
    .all(workspaceId);
  const byName = new Map(rows.map((row) => [row.capability, row]));
  return NAMES.map((name) => ({
    capability: name,
    ...CAPABILITIES[name],
    granted: Boolean(byName.get(name)?.granted),
    updatedAt: byName.get(name)?.updated_at || null,
  }));
}

/**
 * Authorise one job, or take the authority back.
 *
 * Giving authority needs ADMIN; taking it away deliberately does not. Making
 * it harder to stop an automaton than to start one is the wrong way round.
 */
function set(db, ctx, membership, capability, isGranted) {
  const name = requireName(capability);
  if (isGranted) permissions.assertCan(membership, permissions.ADMIN, 'authorise Foundry to work on its own');
  else permissions.assertCan(membership, permissions.OPERATE, 'take authority back from Foundry');

  const now = nowIso();
  db.prepare(`INSERT INTO autopilot_capabilities
      (workspace_id, capability, granted, granted_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, capability) DO UPDATE SET
      granted = excluded.granted, granted_by_user_id = excluded.granted_by_user_id,
      updated_at = excluded.updated_at`)
    .run(ctx.workspaceId, name, isGranted ? 1 : 0, ctx.actorId || null, now, now);
  return list(db, ctx.workspaceId);
}

/** Apply several at once, for a sentence that mentions more than one job. */
function apply(db, ctx, membership, changes = {}) {
  for (const [capability, isGranted] of Object.entries(changes)) {
    set(db, ctx, membership, capability, Boolean(isGranted));
  }
  return list(db, ctx.workspaceId);
}

module.exports = { CAPABILITIES, NAMES, CAPABILITY_FOR_ACTION, may, list, set, apply, granted };

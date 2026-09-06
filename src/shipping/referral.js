'use strict';

/*
 * Opening a merchant's carrier account without sending them away to do it.
 *
 * The account a shop ships on has always been able to be its own — that is
 * what accounts.js is for. What it could not be was *easy*: connecting one
 * meant leaving Foundry, creating an EasyPost account, setting up a wallet,
 * finding the keys page, copying a secret and coming back with it. Every one
 * of those steps is a place to stop, and most shop owners stop.
 *
 * So this is the same destination reached differently. Foundry, enrolled as an
 * EasyPost partner, creates the account through the API; the merchant gives a
 * name and an email and adds a card to Stripe's own field, and never sees
 * EasyPost at all.
 *
 *
 * What this is not.
 *
 * It is not Foundry shipping on the merchant's behalf. The account belongs to
 * them from the moment it exists — their negotiated rates, their labels, their
 * bill — and it outlives their Foundry subscription. Disconnecting here makes
 * Foundry forget a key. It does not close an account, and it must not: a
 * merchant's shipping history is not Keeper's to delete.
 *
 * It is also not the only way in. A shop that already has an EasyPost contract
 * with rates it negotiated will want its own key, and for them a referral
 * account would be a downgrade. Both paths end at the same place —
 * `accounts.forWorkspace` returning a key — and `source` says which.
 *
 *
 * The one rule that shapes everything here: a live key is not handed out until
 * the merchant can actually be billed. An account with no payment method can
 * quote nothing real and buy nothing at all, and quoting test rates as though
 * a carrier had said them would be Foundry inventing a price.
 */

const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');
const credentials = require('../connections/credentials');
const permissions = require('../actions/permissions');

const PARTNER = 'easypost';

/** The partner module, real unless a test stands in for EasyPost. */
function partnerApi(options = {}) {
  return options.partner || require('./providers/easypost-partner');
}

/** Whether Foundry can open accounts at all, which depends on Keeper's enrolment. */
function available(options = {}) {
  return Boolean(partnerApi(options).isPartnerConfigured());
}

function rowFor(db, workspaceId) {
  return db.prepare(`SELECT * FROM shipping_referral_accounts
    WHERE workspace_id = ? AND partner = ?`).get(workspaceId, PARTNER) || null;
}

/*
 * Which of the two keys is in force.
 *
 * Not a preference. Until EasyPost has a way to bill this merchant the live
 * key buys nothing, so the test key is the honest one to hold — and `testMode`
 * travelling with it is what stops a test rate being shown as a real price.
 */
function keyInForce(held = {}, billingReady) {
  if (billingReady && held.liveKey) return { apiKey: held.liveKey, testMode: false };
  return { apiKey: held.testKey || held.liveKey || null, testMode: true };
}

/** Write the key currently in force onto the credential the adapters read. */
function storeKeys(db, workspaceId, connectorId, held, billingReady) {
  const chosen = keyInForce(held, billingReady);
  credentials.put(db, workspaceId, connectorId, 'provider', {
    apiKey: chosen.apiKey,
    testKey: held.testKey || null,
    liveKey: held.liveKey || null,
    webhookSecret: held.webhookSecret || null,
    referralCustomerId: held.referralCustomerId || null,
  });
  return chosen;
}

function heldFor(db, workspaceId, connectorId) {
  return credentials.get(db, workspaceId, connectorId, 'provider') || {};
}

/* ------------------------------------------------------------------ enrol */

/**
 * Open the account.
 *
 * Admin only, and for the same reason connecting a key is: this decides who
 * gets the bill for postage. The email is required because EasyPost sends the
 * merchant their own receipts and notices at it — an account nobody can be
 * reached about is one nobody can fix.
 */
async function enrol(db, ctx, membership, input = {}, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'open a shipping account');
  const partner = partnerApi(options);
  if (!partner.isPartnerConfigured()) {
    throw new ValidationError('Foundry is not enrolled as an EasyPost partner, so it cannot open an '
      + 'account here. Connect an existing EasyPost account instead.');
  }

  const existing = rowFor(db, ctx.workspaceId);
  if (existing) {
    throw new ValidationError('This inventory already has a shipping account Foundry opened. '
      + 'Disconnect it first if you mean to start again.');
  }

  const name = requireText(input.name, 'business name', { max: 200 });
  const email = requireText(input.email, 'email address', { max: 200 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError('EasyPost sends this merchant their own billing notices, so the email '
      + 'address has to be a real one.');
  }

  const created = await partner.createReferralCustomer(
    { name, email, phone: trimOrNull(input.phone) }, options);

  const now = nowIso();

  /*
   * One EasyPost account per inventory, whichever way it arrived. The
   * connector row is the same one `accounts.connect` would have made, so
   * everything downstream — the webhook secret lookup, `contextFor`, the
   * settings screen — is unchanged by which path was taken.
   */
  let connector = db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type = ?`).get(ctx.workspaceId, PARTNER);
  if (!connector) {
    const id = newId('conn');
    db.prepare(`INSERT INTO workspace_connectors
      (id, workspace_id, connector_key, display_name, provider_type, provides, config,
       status, capabilities, credential_ref, setup_status, authorized_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '["shipping"]', '{"referral":true}', 'connected',
        '["rates","labels","tracking"]', ?, 'CONNECTED', ?, ?, ?)`)
      .run(id, ctx.workspaceId, `shipping-${PARTNER}-referral`, 'EasyPost', PARTNER,
        `credentials:${id}:provider`, ctx.actorId || null, now, now);
    connector = db.prepare('SELECT * FROM workspace_connectors WHERE id = ?').get(id);
  } else {
    db.prepare(`UPDATE workspace_connectors SET status = 'connected', paused_at = NULL,
      setup_status = 'CONNECTED', last_error = NULL, config = '{"referral":true}', updated_at = ?
      WHERE id = ?`).run(now, connector.id);
  }

  storeKeys(db, ctx.workspaceId, connector.id, {
    testKey: created.testKey, liveKey: created.liveKey,
    referralCustomerId: created.referralCustomerId,
  }, false);

  db.prepare(`INSERT INTO shipping_referral_accounts
    (id, workspace_id, connector_id, partner, referral_customer_id, name, email,
     billing_ready, billing_checked_at, opened_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`)
    .run(newId('shipref'), ctx.workspaceId, connector.id, PARTNER,
      created.referralCustomerId, name, email, ctx.actorId || null, now, now);

  return describe(db, ctx.workspaceId);
}

/* ---------------------------------------------------------------- billing */

/**
 * Begin collecting a payment method.
 *
 * Returns what Stripe's own card field needs and nothing else. Foundry does
 * not receive, hold or forward a card number at any point in this — the number
 * goes from the merchant's keyboard to Stripe, and what comes back is a
 * reference that is useless to anybody who steals it.
 */
async function beginPaymentSetup(db, ctx, membership, input = {}, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'set up shipping billing');
  const row = requireAccount(db, ctx.workspaceId);
  const held = heldFor(db, ctx.workspaceId, row.connector_id);
  const key = held.liveKey || held.apiKey;
  if (!key) throw new ValidationError('Foundry has no key for that shipping account any more.');

  const partner = partnerApi(options);
  return input.kind === 'bank'
    ? partner.PAYMENT.beginBankSetup(key)
    : partner.PAYMENT.beginCardSetup(key);
}

/**
 * Record the method Stripe has stored, and let the account go live.
 *
 * The two references arrive from the browser, having come from Stripe. Neither
 * is a card. `refreshBilling` then asks EasyPost rather than believing the
 * browser — a payment method Foundry was *told* about is not the same as one
 * EasyPost will actually bill, and only the second may unlock a live key.
 */
async function recordPaymentMethod(db, ctx, membership, input = {}, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'set up shipping billing');
  const row = requireAccount(db, ctx.workspaceId);
  const held = heldFor(db, ctx.workspaceId, row.connector_id);
  const key = held.liveKey || held.apiKey;
  if (!key) throw new ValidationError('Foundry has no key for that shipping account any more.');

  await partnerApi(options).PAYMENT.attach(key, {
    stripeCustomerId: trimOrNull(input.stripeCustomerId),
    paymentMethodReference: trimOrNull(input.paymentMethodReference),
    priority: input.priority,
  });
  return refreshBilling(db, ctx, options);
}

/**
 * Ask EasyPost whether this merchant can be billed, and act on the answer.
 *
 * Called after a payment method is added, and again on the scheduled sweep,
 * because a card can also be removed or expire — and an account that has
 * quietly lost its payment method must go back to being unable to buy rather
 * than start failing at the counter with a live key that no longer works.
 */
async function refreshBilling(db, ctx, options = {}) {
  const row = rowFor(db, ctx.workspaceId);
  if (!row) return describe(db, ctx.workspaceId);
  const held = heldFor(db, ctx.workspaceId, row.connector_id);
  const key = held.liveKey || held.apiKey;
  if (!key) return describe(db, ctx.workspaceId);

  const ready = await partnerApi(options).hasPaymentMethod(key);
  storeKeys(db, ctx.workspaceId, row.connector_id, held, ready);
  db.prepare(`UPDATE shipping_referral_accounts
    SET billing_ready = ?, billing_checked_at = ?, updated_at = ? WHERE id = ?`)
    .run(ready ? 1 : 0, nowIso(), nowIso(), row.id);
  return describe(db, ctx.workspaceId);
}

/**
 * Every referral account whose billing has not been confirmed, rechecked.
 *
 * A merchant who adds a card on EasyPost's own hosted page, or on a second
 * device, or who abandons the form and finishes it tomorrow, never comes back
 * through `recordPaymentMethod`. Without this their account would sit in test
 * mode for ever with no sign of why.
 */
async function sweep(db, options = {}) {
  const rows = db.prepare(`SELECT workspace_id FROM shipping_referral_accounts
    WHERE partner = ? AND billing_ready = 0`).all(PARTNER);
  const checked = [];
  for (const row of rows) {
    try {
      const state = await refreshBilling(db, { workspaceId: row.workspace_id, actorId: null }, options);
      checked.push({ workspaceId: row.workspace_id, billingReady: state.billingReady });
    } catch (error) {
      // One merchant's account being unreachable is not a reason to stop
      // checking everybody else's.
      checked.push({ workspaceId: row.workspace_id, error: error.message });
    }
  }
  return checked;
}

/* --------------------------------------------------------------- forgetting */

/**
 * Foundry forgets the account. EasyPost keeps it.
 *
 * Deliberately not a deletion. The merchant's labels, tracking history and
 * billing records live on that account and are theirs; the id is kept so they
 * can be told which account it was, and so reconnecting is a matter of saying
 * so rather than starting again.
 */
function release(db, ctx, membership) {
  permissions.assertCan(membership, permissions.ADMIN, 'disconnect a shipping account');
  const row = requireAccount(db, ctx.workspaceId);
  if (row.connector_id) {
    credentials.remove(db, ctx.workspaceId, row.connector_id);
    db.prepare(`UPDATE workspace_connectors SET status = 'disconnected', updated_at = ?
      WHERE id = ?`).run(nowIso(), row.connector_id);
  }
  db.prepare('DELETE FROM shipping_referral_accounts WHERE id = ?').run(row.id);
  return {
    released: true,
    referralCustomerId: row.referral_customer_id,
    because: 'Foundry has forgotten this account\'s keys. The EasyPost account itself, and '
      + 'everything shipped on it, still exists and still belongs to this business.',
  };
}

function requireAccount(db, workspaceId) {
  const row = rowFor(db, workspaceId);
  if (!row) throw new NotFoundError('Foundry did not open a shipping account for this inventory.');
  return row;
}

/* -------------------------------------------------------------- describing */

/**
 * What to say about the account, without saying a key.
 *
 * `billingReady` is the one field a screen must not soften. An account that
 * exists but cannot be billed looks connected and buys nothing, and a green
 * tick over that state is how somebody finds out at the counter.
 */
function describe(db, workspaceId) {
  const row = rowFor(db, workspaceId);
  if (!row) {
    return {
      opened: false,
      available: available(),
      because: available()
        ? 'Foundry can open a shipping account for this business, so nobody has to leave and make one.'
        : 'Foundry is not enrolled as a shipping partner here, so an existing carrier account has to '
          + 'be connected instead.',
    };
  }
  const held = heldFor(db, workspaceId, row.connector_id);
  return {
    opened: true,
    available: true,
    partner: row.partner,
    referralCustomerId: row.referral_customer_id,
    name: row.name,
    email: row.email,
    billingReady: row.billing_ready === 1,
    billingCheckedAt: row.billing_checked_at,
    hasLiveKey: Boolean(held.liveKey),
    because: row.billing_ready === 1
      ? null
      : 'No payment method is on this account yet, so it cannot buy a label and the rates it '
        + 'returns are test rates rather than what a carrier would charge.',
  };
}

module.exports = {
  PARTNER, available, enrol, beginPaymentSetup, recordPaymentMethod,
  refreshBilling, sweep, release, describe, rowFor, keyInForce,
};

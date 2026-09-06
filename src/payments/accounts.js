'use strict';

/*
 * Whose Stripe account this is.
 *
 * The same correction as the carrier account, and a worse problem than that
 * one was. A single STRIPE_SECRET_KEY for the whole server means every
 * merchant's customers pay into one Stripe account — not "billed to the wrong
 * person" but *the money arrives in the wrong bank*. And one webhook secret
 * for every merchant means a message about one shop's invoice is verified with
 * another shop's secret.
 *
 * So it belongs to a workspace, exactly as a mailbox and a carrier account do:
 * encrypted in the credential store, referenced by a connector row that holds
 * no secret itself.
 *
 * Note what did *not* need changing. A Gmail or Shopify client id is this
 * application's own identity — one registration, shared by every merchant, and
 * correctly global. What each merchant's OAuth produces is already stored per
 * workspace. The two things that were wrong were the two that are a merchant's
 * own account credential typed in rather than granted: Stripe, and shipping.
 */

const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');
const credentials = require('../connections/credentials');
const permissions = require('../actions/permissions');

const PROVIDERS = ['stripe'];

/** The connector row holding this workspace's payment account, if any. */
function connectorFor(db, workspaceId) {
  return db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type = 'stripe'
      AND status = 'connected' AND paused_at IS NULL
    ORDER BY updated_at DESC LIMIT 1`).get(workspaceId) || null;
}

/**
 * The account a workspace takes money into, and where it came from.
 *
 * Null when there is none, which is an ordinary state: a shop that takes cash
 * and cheques needs no payment provider, and every payment path in Foundry
 * works without one.
 */
function forWorkspace(db, workspaceId) {
  /*
   * An account granted, before a key pasted.
   *
   * Both are this workspace's own account and either is correct, but they are
   * reached differently: a granted account is acted on through the platform's
   * key with the merchant's account id attached, and Foundry holds no secret
   * of theirs at all. That is the better arrangement, so it is the one checked
   * first.
   */
  const granted = db.prepare(`SELECT * FROM payment_connect_accounts
    WHERE workspace_id = ? AND provider = 'stripe'`).get(workspaceId);
  if (granted && process.env.STRIPE_SECRET_KEY) {
    return {
      provider: 'stripe',
      source: 'connect',
      connectorId: granted.connector_id,
      secretKey: process.env.STRIPE_SECRET_KEY,
      accountId: granted.provider_account_id,
      chargesEnabled: granted.charges_enabled === 1,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
    };
  }

  const connector = connectorFor(db, workspaceId);
  if (connector) {
    const held = credentials.get(db, workspaceId, connector.id, 'provider') || {};
    if (held.secretKey) {
      return {
        provider: 'stripe',
        source: 'workspace',
        connectorId: connector.id,
        secretKey: held.secretKey,
        webhookSecret: held.webhookSecret || null,
      };
    }
  }
  const fromEnv = process.env.STRIPE_SECRET_KEY;
  if (!fromEnv) return null;

  /*
   * The server key is a till for one shop, or it is the platform's identity.
   * It cannot be both.
   *
   * The fallback below was written for a single-tenant install: one key, one
   * shop, no connection screen to click through. Stripe Connect makes that
   * same key the platform's own — it has to be set for any business to connect
   * at all — and at that moment the fallback quietly becomes "every inventory
   * that has not connected yet takes its customers' money into Keeper's bank".
   *
   * So the question asked here is whether Connect is switched on, not which
   * of the two ways in it uses. Where it is off, nothing about this changed.
   *
   * Nobody would ever have chosen that. It would simply have followed from two
   * reasonable things being true at once, and the first anybody would know is
   * a shop's takings arriving somewhere else.
   */
  if (require('./connect').platformModeEnabled()) return null;

  return {
    provider: 'stripe',
    source: 'server',
    connectorId: null,
    secretKey: fromEnv,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || null,
  };
}

/**
 * The ctx a payment provider needs, with this workspace's key on it.
 *
 * The Stripe adapter already reads `ctx.stripeSecretKey` before falling back to
 * the environment, so — as with shipping — multi-tenancy costs nothing at the
 * call sites beyond building ctx from the workspace rather than the process.
 */
function contextFor(db, ctx, providerName = 'stripe') {
  // Test and future non-Stripe providers own their credential model. Do not
  // make them depend on a Stripe connection merely because collection uses
  // one provider registry.
  if (providerName !== 'stripe') return ctx;
  const account = forWorkspace(db, ctx.workspaceId);
  if (!account) {
    /*
     * In Connect mode the process key identifies Foundry itself. Returning the
     * unchanged context here used to let the Stripe adapter fall back to that
     * key, which created a merchant's customer invoice on the developer's
     * account. Refuse the request before Stripe sees it. A single-tenant
     * install with no configured key retains its ordinary "not connected"
     * state; the adapter will produce its existing configuration error.
     */
    if (require('./connect').platformModeEnabled()) {
      throw new ValidationError("Connect this business's Stripe account before taking a customer payment. "
        + "Foundry will never put a business's customer payment through the developer account.");
    }
    return ctx;
  }
  /*
   * A granted account travels as an id beside the platform's key. The adapter
   * turns that into Stripe's own "act on behalf of" header, which is how the
   * invoice ends up on the merchant's account and the money in their bank
   * without Foundry ever holding a credential of theirs.
   */
  return account.accountId
    ? { ...ctx, stripeSecretKey: account.secretKey, stripeAccountId: account.accountId }
    : { ...ctx, stripeSecretKey: account.secretKey };
}

function connect(db, ctx, membership, input = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'connect a payment account');

  /*
   * A granted account is not quietly written over by a pasted key. Doing so
   * would leave Foundry holding a secret for an account it also still had a
   * live grant on, and the merchant with no way to tell which was in use.
   */
  const granted = require('./connect').rowFor(db, ctx.workspaceId);
  if (granted) {
    throw new ValidationError('This inventory has a Stripe account connected already, and pasting '
      + 'a key over it would hide that connection rather than replace it. Disconnect it first.');
  }

  const secretKey = requireText(input.secretKey, 'Secret key', { max: 400 });
  if (!/^sk_(test|live)_/.test(secretKey) && !/^rk_(test|live)_/.test(secretKey)) {
    /*
     * Refused rather than accepted and left to fail later. A publishable key
     * pasted into this box would be stored, would look connected, and would
     * fail on the first customer — and the owner would have no reason to think
     * the key was the problem.
     */
    throw new ValidationError('That does not look like a Stripe secret key. A secret key starts '
      + 'with sk_test_ or sk_live_, and is the one Stripe keeps hidden until you reveal it — not '
      + 'the publishable key beginning pk_.');
  }
  const webhookSecret = trimOrNull(input.webhookSecret);
  if (webhookSecret && !/^whsec_/.test(webhookSecret)) {
    throw new ValidationError('A Stripe webhook signing secret starts with whsec_.');
  }
  const now = nowIso();

  let connector = db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type = 'stripe'`).get(ctx.workspaceId);
  if (!connector) {
    const id = newId('conn');
    db.prepare(`INSERT INTO workspace_connectors
      (id, workspace_id, connector_key, display_name, provider_type, provides, config,
       status, capabilities, credential_ref, setup_status, authorized_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'payments-stripe', 'Stripe', 'stripe', '["payments"]', '{}', 'connected',
        '["invoices","refunds"]', ?, 'CONNECTED', ?, ?, ?)`)
      .run(id, ctx.workspaceId, `credentials:${id}:provider`, ctx.actorId || null, now, now);
    connector = db.prepare('SELECT * FROM workspace_connectors WHERE id = ?').get(id);
  } else {
    db.prepare(`UPDATE workspace_connectors SET status = 'connected', paused_at = NULL,
      setup_status = 'CONNECTED', last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(now, connector.id);
  }

  credentials.put(db, ctx.workspaceId, connector.id, 'provider', { secretKey, webhookSecret });
  return describe(db, ctx.workspaceId);
}

async function disconnect(db, ctx, membership, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'disconnect a payment account');

  // A granted account is handed back to Stripe as well as forgotten here.
  const connectAccounts = require('./connect');
  if (connectAccounts.rowFor(db, ctx.workspaceId)) {
    await connectAccounts.disconnect(db, ctx, membership, options);
    return describe(db, ctx.workspaceId);
  }

  const connector = connectorFor(db, ctx.workspaceId);
  if (!connector) throw new NotFoundError('No payment account is connected to this inventory.');
  credentials.remove(db, ctx.workspaceId, connector.id);
  db.prepare(`UPDATE workspace_connectors SET status = 'disconnected', updated_at = ?
    WHERE id = ?`).run(nowIso(), connector.id);
  return describe(db, ctx.workspaceId);
}

/** What to say about the account, without saying the key. */
function describe(db, workspaceId) {
  const account = forWorkspace(db, workspaceId);
  if (!account) {
    const grant = require('./connect');
    return { connected: false, provider: null, source: null,
      available: grant.available(),
      because: grant.available()
        ? 'No payment account is connected. This business can connect its own Stripe without '
          + 'giving Foundry a key, and the money its customers pay then arrives in its own bank.'
        : 'No payment account is connected, so Foundry cannot make a payment link. Payments '
          + 'reported by hand — cash, cheque, a card machine — are recorded exactly as they always were.' };
  }
  if (account.source === 'connect') {
    // Nothing to withhold: there is no secret of theirs to describe around.
    return { ...require('./connect').describe(db, workspaceId),
      source: 'connect', connectorId: account.connectorId, hasWebhookSecret: Boolean(account.webhookSecret) };
  }
  const key = String(account.secretKey);
  return {
    connected: true,
    provider: account.provider,
    source: account.source,
    connectorId: account.connectorId,
    keyEndsWith: key.length > 4 ? key.slice(-4) : null,
    liveMode: /^(sk|rk)_live_/.test(key),
    hasWebhookSecret: Boolean(account.webhookSecret),
    because: account.source === 'server'
      ? 'This inventory is using the Stripe key set on the server, which every inventory on it '
        + 'shares — so every customer pays into the same Stripe account. Connect this inventory\'s '
        + 'own account and its money arrives in its own bank.'
      : null,
  };
}

module.exports = { PROVIDERS, forWorkspace, contextFor, connect, disconnect, describe, connectorFor };

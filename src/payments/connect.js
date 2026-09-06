'use strict';

/*
 * A business connects its Stripe account without handing over a key.
 *
 * The form beside this one asks a merchant to paste a secret key. It works,
 * and for a shop with an unusual setup it is the right answer — but a Stripe
 * secret key is *total* access to their account: refunds, payouts, every
 * customer record, indefinitely, with no way for them to see what used it or
 * to take it back short of rolling the key. Asking for that in order to make
 * an invoice is asking for far more than the job needs, and the merchants who
 * understand what they are being asked will refuse.
 *
 * Connect asks for the job instead. The business signs in on Stripe's own
 * page, approves, and comes back. What Foundry keeps is an account id — acct_…
 * — which is not a secret, is useless to anybody who is not the platform it
 * was granted to, and which they can revoke from their own dashboard in one
 * click.
 *
 *
 * The token that is deliberately thrown away.
 *
 * Stripe's OAuth exchange returns an access token alongside the account id,
 * and for a Standard account that token is a working key. Foundry does not
 * keep it. Acting through the platform key with the Stripe-Account header does
 * exactly the same work, and leaves nothing in the database worth stealing.
 * Keeping it "just in case" would give back the whole problem this exists to
 * solve.
 *
 * So there is no credential row for a connected account. That is not an
 * oversight to be tidied up later; it is the feature.
 */

const { ValidationError, NotFoundError, AuthenticationError } = require('../domain/errors');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const permissions = require('../actions/permissions');

const PROVIDER = 'stripe';
const AUTHORIZE = 'https://connect.stripe.com/oauth/authorize';
const TOKEN = 'https://connect.stripe.com/oauth/token';
const DEAUTHORIZE = 'https://connect.stripe.com/oauth/deauthorize';
const ACCOUNTS = 'https://api.stripe.com/v1/accounts';
const ACCOUNT_LINKS = 'https://api.stripe.com/v1/account_links';

/*
 * Accounts v2, because Stripe refuses v1 for a new integration.
 *
 * The first version of this created accounts with POST /v1/accounts, which is
 * what every example still shows, and Stripe answered: "no longer recommends
 * Accounts v1 for new Connect integrations". So the account is made on v2.
 *
 * Everything downstream is untouched, and that was checked rather than
 * assumed: a v2 account is reachable from the ordinary v1 API through the
 * Stripe-Account header, so the invoicing adapter did not change by a
 * character. The version below is the preview header v2 currently requires.
 */
const V2_ACCOUNTS = 'https://api.stripe.com/v2/core/accounts';
const V2_ACCOUNT_LINKS = 'https://api.stripe.com/v2/core/account_links';
const V2_VERSION = '2025-08-27.preview';

/** v2 speaks JSON, where v1 takes form encoding. */
async function callV2(url, key, { method = 'POST', body = null } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'Stripe-Version': V2_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const said = payload?.error?.message;
    const error = new ValidationError(said || `Stripe refused the request (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/*
 * The platform's own identity: one registration for the whole application,
 * exactly like a Gmail or Shopify client id, and correctly global. It is not a
 * merchant credential and never belongs to a workspace.
 */
function platform() {
  return {
    clientId: process.env.STRIPE_CONNECT_CLIENT_ID || null,
    secretKey: process.env.STRIPE_SECRET_KEY || null,
    /*
     * The publishable key is not a secret — it is designed to be read by every
     * browser that loads the page — and it is what Stripe's embedded onboarding
     * needs in order to run inside Foundry rather than on a page of its own.
     */
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
  };
}

/*
 * Two ways to send a business to Stripe, and only one of them is available on
 * any given dashboard.
 *
 * OAuth needs a client id, which Stripe no longer issues to every new
 * platform — a sandbox created today often has none, and hunting for a setting
 * that does not exist is worse than not offering the path.
 *
 * Hosted onboarding needs nothing but the platform key that must already be
 * set: Foundry creates the account through the API and sends the merchant to
 * Stripe's own onboarding page. No client id, no redirect to register at
 * Stripe, nothing to go and find.
 *
 * Everything after the merchant comes back is identical either way, which is
 * why this is one module and not two.
 */
function usesOauth() {
  const held = platform();
  return Boolean(held.clientId && held.secretKey);
}

function usesHostedOnboarding() {
  const held = platform();
  return Boolean(held.secretKey && /^(1|true|yes|on)$/i.test(String(process.env.STRIPE_CONNECT_ENABLED || '')));
}

/**
 * Whether the form can be shown inside Foundry rather than on Stripe's page.
 *
 * The questions are the same either way — they are Stripe's identity checks,
 * required before money may be moved into anybody's bank, and no integration
 * can shorten them. What this removes is the handoff: no leaving the app, no
 * "Return to Keeper Inventory" link, no separate page that looks like somebody
 * else's software. Most of what makes the process feel long is that, not the
 * questions.
 */
function usesEmbedded() {
  return Boolean(usesHostedOnboarding() && platform().publishableKey);
}

/** Whether a business can connect its own account here at all. */
function available() { return usesHostedOnboarding() || usesOauth(); }

function requirePlatform(options = {}) {
  const held = platform();
  if (options.oauth !== false && !held.clientId) {
    throw new ValidationError('Foundry has no Stripe Connect client id, so a business cannot '
      + 'connect its account this way. Paste a secret key instead.');
  }
  if (!held.secretKey) {
    throw new ValidationError('Foundry has no Stripe platform key, so it cannot complete a '
      + 'connection. Paste a secret key instead.');
  }
  return held;
}

function rowFor(db, workspaceId) {
  return db.prepare(`SELECT * FROM payment_connect_accounts
    WHERE workspace_id = ? AND provider = ?`).get(workspaceId, PROVIDER) || null;
}

/* ---------------------------------------------------------------- talking */

async function post(url, values, key = null) {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') continue;
    body.append(name, String(value));
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const said = payload?.error_description || payload?.error?.message || payload?.error;
    throw new ValidationError(typeof said === 'string' ? said
      : `Stripe refused the request (${response.status}).`);
  }
  return payload;
}

async function get(url, key) {
  const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const said = payload?.error?.message;
    const error = new ValidationError(said || `Stripe refused the request (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* ------------------------------------------------------------ going there */

/**
 * Where to send the merchant, and the connector row waiting for them.
 *
 * The state is the existing authorization-state machinery, unchanged — it is
 * single-use, expires in fifteen minutes, and is stored hashed. Reimplementing
 * that for one more provider would be inventing a second place to get CSRF
 * wrong.
 */
function authorizeUrl(db, ctx, membership, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'connect a payment account');
  const held = requirePlatform();

  const existing = rowFor(db, ctx.workspaceId);
  if (existing) {
    throw new ValidationError('This inventory already has a Stripe account connected. '
      + 'Disconnect it first if you mean to connect a different one.');
  }

  const now = nowIso();
  let connector = db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type = ?`).get(ctx.workspaceId, PROVIDER);
  if (!connector) {
    const id = newId('conn');
    db.prepare(`INSERT INTO workspace_connectors
      (id, workspace_id, connector_key, display_name, provider_type, provides, config,
       status, capabilities, credential_ref, setup_status, authorized_by_user_id, created_at, updated_at)
      VALUES (?, ?, 'payments-stripe-connect', 'Stripe', ?, '["payments"]', '{"connect":true}',
        'disconnected', '["invoices","refunds"]', NULL, 'AUTHORIZING', ?, ?, ?)`)
      .run(id, ctx.workspaceId, PROVIDER, ctx.actorId || null, now, now);
    connector = db.prepare('SELECT * FROM workspace_connectors WHERE id = ?').get(id);
  } else {
    db.prepare(`UPDATE workspace_connectors SET setup_status = 'AUTHORIZING', last_error = NULL,
      config = '{"connect":true}', updated_at = ? WHERE id = ?`).run(now, connector.id);
  }

  const state = require('../connections/provider-service')
    .createState(db, ctx, connector.id, 'stripe_connect', {});

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: held.clientId,
    scope: 'read_write',
    state,
  });
  if (options.returnUri) query.set('redirect_uri', options.returnUri);
  /*
   * What Stripe shows on its own page. Nothing here is trusted afterwards —
   * the merchant may change any of it — it only saves them retyping.
   */
  if (options.businessName) query.set('stripe_user[business_name]', options.businessName);
  if (options.email) query.set('stripe_user[email]', options.email);

  return { url: `${AUTHORIZE}?${query.toString()}`, connectorId: connector.id, state };
}

/* --------------------------------------------------- hosted onboarding */

/**
 * Create the business's own Stripe account, and a page for them to finish it.
 *
 * A Standard account, deliberately. The business gets a full Stripe dashboard,
 * its own relationship with Stripe, its own fees and its own payouts — Foundry
 * is how the account was made and is not who it belongs to, and they keep it
 * whether or not they keep Foundry.
 *
 * The account is created before it is complete, which is normal here: Stripe
 * expects a platform to make the account and then hand the person a link to
 * fill in the rest. So the row exists from this moment with charges_enabled
 * false, and nothing pretends it can take money yet.
 */
async function openOnboarding(db, ctx, membership, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'connect a payment account');
  const held = requirePlatform({ oauth: false });

  const now = nowIso();
  let row = rowFor(db, ctx.workspaceId);
  let connectorId = row ? row.connector_id : null;

  if (!row) {
    const created = options.createAccount
      ? await options.createAccount({ email: options.email, name: options.businessName })
      : await callV2(V2_ACCOUNTS, held.secretKey, { body: {
        contact_email: options.email || undefined,
        display_name: options.businessName || undefined,
        /*
         * A full dashboard, and the business carrying its own fees and losses.
         *
         * This is the arrangement that makes the account genuinely theirs:
         * they get Stripe's own dashboard, they pay Stripe directly, and they
         * — not Keeper — answer for a chargeback. A platform that collected
         * fees or absorbed losses would be a different business, and it is not
         * the one Foundry is in.
         */
        dashboard: 'full',
        /*
         * Country, and nothing else about who they are.
         *
         * Stripe will not set a default currency without a country, so that
         * one has to be stated. entity_type — individual or company — is a
         * fact about the business that Foundry does not know, and the first
         * version asserted "individual" simply because it made the API stop
         * complaining. A sole trader would not notice; every company would
         * arrive at Stripe's form with the wrong answer already filled in and
         * have to undo it, which is a step Foundry added by guessing.
         *
         * Left out, Stripe asks them. That is the right party to ask.
         */
        identity: { country: 'us' },
        defaults: {
          currency: 'usd',
          locales: ['en-US'],
          responsibilities: { losses_collector: 'stripe', fees_collector: 'stripe' },
        },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        include: ['configuration.merchant', 'identity', 'requirements'],
      } });
    if (!created || !created.id) {
      throw new ValidationError('Stripe did not return an account to send this business to.');
    }

    let connector = db.prepare(`SELECT * FROM workspace_connectors
      WHERE workspace_id = ? AND provider_type = ?`).get(ctx.workspaceId, PROVIDER);
    if (!connector) {
      const id = newId('conn');
      db.prepare(`INSERT INTO workspace_connectors
        (id, workspace_id, connector_key, display_name, provider_type, provides, config,
         status, capabilities, credential_ref, setup_status, authorized_by_user_id, created_at, updated_at)
        VALUES (?, ?, 'payments-stripe-connect', 'Stripe', ?, '["payments"]', '{"connect":true}',
          'disconnected', '["invoices","refunds"]', NULL, 'AUTHORIZING', ?, ?, ?)`)
        .run(id, ctx.workspaceId, PROVIDER, ctx.actorId || null, now, now);
      connector = db.prepare('SELECT * FROM workspace_connectors WHERE id = ?').get(id);
    }
    connectorId = connector.id;

    db.prepare(`INSERT INTO payment_connect_accounts
      (id, workspace_id, connector_id, provider, provider_account_id, display_name,
       charges_enabled, livemode, checked_at, connected_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId('paycon'), ctx.workspaceId, connectorId, PROVIDER, created.id,
        nameOf(created) || options.businessName || null,
        canTakeCharges(created) ? 1 : 0, created.livemode ? 1 : 0, now,
        ctx.actorId || null, now, now);
    row = rowFor(db, ctx.workspaceId);
  }

  /*
   * No link when the form is being shown here. Creating one anyway would be
   * asking Stripe for a page nobody is going to open.
   */
  if (options.link === false) return { accountId: row.provider_account_id, connectorId, url: null };
  return { ...(await onboardingLink(db, row, options)), accountId: row.provider_account_id, connectorId };
}

/**
 * A fresh link to Stripe's onboarding, for an account that has one already.
 *
 * Account links expire, and Stripe calls the refresh address when a merchant
 * opens a stale one. Making a new link rather than showing an error is the
 * whole reason that address exists.
 */
async function onboardingLink(db, row, options = {}) {
  const held = requirePlatform({ oauth: false });
  const link = options.createLink
    ? await options.createLink({ account: row.provider_account_id })
    : await callV2(V2_ACCOUNT_LINKS, held.secretKey, { body: {
      account: row.provider_account_id,
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          return_url: options.returnUrl,
          refresh_url: options.refreshUrl,
        },
      },
    } });
  if (!link || !link.url) throw new ValidationError('Stripe did not return an onboarding page.');
  return { url: link.url, expiresAt: link.expires_at || null };
}

/** Send them back to Stripe with a link that has not expired. */
async function relink(db, ctx, options = {}) {
  const row = rowFor(db, ctx.workspaceId);
  if (!row) throw new NotFoundError('There is no Stripe account to finish setting up.');
  return onboardingLink(db, row, options);
}

/**
 * A session for Stripe's own form, running inside this page.
 *
 * The client secret is short-lived and scoped to one account and one
 * component. It is not a credential for the merchant's account and cannot be
 * used to act on it — which is why it is safe to hand to a browser, and why
 * this route needs no new secret anywhere.
 */
async function embeddedSession(db, ctx, options = {}) {
  const held = requirePlatform({ oauth: false });
  if (!held.publishableKey) {
    throw new ValidationError('Foundry has no Stripe publishable key, so the setup form cannot be '
      + 'shown here. It will open on Stripe instead.');
  }
  const row = rowFor(db, ctx.workspaceId);
  if (!row) throw new NotFoundError('There is no Stripe account to set up.');

  const made = options.createSession
    ? await options.createSession({ account: row.provider_account_id })
    : await post('https://api.stripe.com/v1/account_sessions', {
      account: row.provider_account_id,
      'components[account_onboarding][enabled]': 'true',
      'components[account_onboarding][features][external_account_collection]': 'true',
    }, held.secretKey);
  if (!made || !made.client_secret) {
    throw new ValidationError('Stripe did not return a way to show the setup form.');
  }
  return { clientSecret: made.client_secret, publishableKey: held.publishableKey,
    accountId: row.provider_account_id };
}

/* -------------------------------------------------------------- coming back */

/**
 * The merchant is back from Stripe.
 *
 * Reads the state before anything else, because the state is what says which
 * inventory this is about — a code arriving without one is somebody else's
 * request or a forgery, and either way there is nothing to do with it.
 */
async function complete(db, query = {}, options = {}) {
  const providerService = require('../connections/provider-service');
  const state = providerService.readState(db, query.state, 'stripe_connect', true);
  const ctx = { workspaceId: state.workspace_id, actorId: state.actor_id };

  if (query.error) {
    /*
     * The merchant said no, or Stripe refused. Recorded on the connector so
     * the screen can say what happened rather than silently showing the form
     * again as though nothing was ever attempted.
     */
    const because = trimOrNull(query.error_description) || 'The connection was not approved.';
    db.prepare(`UPDATE workspace_connectors SET status = 'disconnected',
      setup_status = 'AUTHORIZATION_FAILED', last_error = ?, updated_at = ? WHERE id = ?`)
      .run(because, nowIso(), state.connector_id);
    return { connected: false, workspaceId: ctx.workspaceId, because };
  }

  const code = trimOrNull(query.code);
  if (!code) throw new AuthenticationError('Stripe sent nothing to complete the connection with.');

  const held = requirePlatform();
  const granted = options.exchange
    ? await options.exchange({ code, clientSecret: held.secretKey })
    : await post(TOKEN, { grant_type: 'authorization_code', code, client_secret: held.secretKey });

  const accountId = granted.stripe_user_id;
  if (!accountId) throw new ValidationError('Stripe did not say which account was connected.');

  /*
   * granted.access_token and granted.refresh_token are on this object and are
   * not written anywhere. See the note at the top of this file: keeping them
   * would hand back the exact problem Connect exists to remove.
   */

  const account = options.readAccount
    ? await options.readAccount(accountId)
    : await readAccount(accountId, held.secretKey).catch(() => null);

  const now = nowIso();
  db.prepare(`UPDATE workspace_connectors SET status = 'connected', paused_at = NULL,
    setup_status = 'CONNECTED', last_error = NULL, provider_account_id = ?,
    provider_account_name = ?, updated_at = ? WHERE id = ?`)
    .run(accountId, nameOf(account), now, state.connector_id);

  db.prepare(`INSERT INTO payment_connect_accounts
    (id, workspace_id, connector_id, provider, provider_account_id, display_name,
     charges_enabled, livemode, checked_at, connected_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, provider) DO UPDATE SET
      connector_id = excluded.connector_id,
      provider_account_id = excluded.provider_account_id,
      display_name = excluded.display_name,
      charges_enabled = excluded.charges_enabled,
      livemode = excluded.livemode,
      checked_at = excluded.checked_at,
      updated_at = excluded.updated_at`)
    .run(newId('paycon'), ctx.workspaceId, state.connector_id, PROVIDER, accountId,
      nameOf(account), canTakeCharges(account) ? 1 : 0,
      granted.livemode || (account && account.livemode) ? 1 : 0, now,
      state.actor_id || null, now, now);

  return { connected: true, workspaceId: ctx.workspaceId, ...describe(db, ctx.workspaceId) };
}

const nameOf = (account) => (account && (account.display_name || account.business_profile?.name
  || account.settings?.dashboard?.display_name || account.contact_email || account.email)) || null;

/*
 * Whether Stripe will take a card on this account, in either API's words.
 *
 * v1 says charges_enabled. v2 says the merchant configuration's card_payments
 * capability is active, and says "restricted" while it is still waiting for
 * the business to finish its form. They mean the same thing and the rest of
 * Foundry should not have to know which one answered.
 */
function canTakeCharges(account) {
  if (!account) return false;
  const capability = account.configuration?.merchant?.capabilities?.card_payments;
  if (capability) return capability.status === 'active';
  return Boolean(account.charges_enabled);
}

/**
 * Read an account, whichever way it was made.
 *
 * Hosted onboarding creates it on v2; an OAuth grant is to an account that
 * exists on v1. Rather than record which, this asks v2 and falls back — an id
 * that v2 does not recognise is not an error worth surfacing, it is a fact
 * about where to look next.
 */
async function readAccount(accountId, key) {
  try {
    return await callV2(`${V2_ACCOUNTS}/${encodeURIComponent(accountId)}`
      + '?include=configuration.merchant&include=requirements', key, { method: 'GET' });
  } catch (error) {
    if (error.status === 404 || error.status === 400) {
      return get(`${ACCOUNTS}/${encodeURIComponent(accountId)}`, key);
    }
    throw error;
  }
}

/**
 * Ask Stripe whether this account can take a payment yet.
 *
 * A connected account that cannot accept charges — details still outstanding,
 * a verification pending — looks finished on this screen and is not. A payment
 * link made against it fails in front of a customer, which is the worst place
 * to find out.
 */
async function refresh(db, workspaceId, options = {}) {
  const row = rowFor(db, workspaceId);
  if (!row) return describe(db, workspaceId);
  const held = platform();
  if (!held.secretKey) return describe(db, workspaceId);

  let account = null;
  try {
    account = options.readAccount
      ? await options.readAccount(row.provider_account_id)
      : await readAccount(row.provider_account_id, held.secretKey);
  } catch (error) {
    /*
     * A merchant who revoked access from their own dashboard is not an error.
     * It is an answer, and the honest thing is to stop claiming the account is
     * connected rather than to keep the row and fail later.
     */
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      forget(db, workspaceId);
      return describe(db, workspaceId);
    }
    return describe(db, workspaceId);
  }

  db.prepare(`UPDATE payment_connect_accounts SET charges_enabled = ?, livemode = ?,
    display_name = ?, checked_at = ?, updated_at = ? WHERE id = ?`)
    .run(canTakeCharges(account) ? 1 : 0, account.livemode ? 1 : 0,
      nameOf(account), nowIso(), nowIso(), row.id);
  return describe(db, workspaceId);
}

/* ------------------------------------------------------------ giving it back */

/**
 * Hand the access back to Stripe and forget the account.
 *
 * Deauthorized at Stripe as well as forgotten here, so the merchant's own
 * dashboard stops listing Foundry. Forgetting locally while Stripe still shows
 * a live connection would leave them with a grant they cannot see the purpose
 * of and no obvious way to be rid of.
 */
async function disconnect(db, ctx, membership, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'disconnect a payment account');
  const row = rowFor(db, ctx.workspaceId);
  if (!row) throw new NotFoundError('No Stripe account is connected to this inventory.');

  const held = platform();
  let releasedAtStripe = false;
  if (held.clientId && held.secretKey) {
    try {
      if (options.deauthorize) await options.deauthorize(row.provider_account_id);
      else {
        await post(DEAUTHORIZE,
          { client_id: held.clientId, stripe_user_id: row.provider_account_id }, held.secretKey);
      }
      releasedAtStripe = true;
    } catch {
      /*
       * Stripe refusing — most often because the merchant already revoked it
       * there — must not stop Foundry letting go of it here. The alternative
       * is a row nobody can remove.
       */
    }
  }
  forget(db, ctx.workspaceId);
  return { disconnected: true, releasedAtStripe, ...describe(db, ctx.workspaceId) };
}

function forget(db, workspaceId) {
  const row = rowFor(db, workspaceId);
  if (!row) return;
  if (row.connector_id) {
    db.prepare(`UPDATE workspace_connectors SET status = 'disconnected', updated_at = ?
      WHERE id = ?`).run(nowIso(), row.connector_id);
  }
  db.prepare('DELETE FROM payment_connect_accounts WHERE id = ?').run(row.id);
}

/* -------------------------------------------------------------- describing */

/**
 * What to say about it, which is everything — there is no secret to withhold.
 *
 * `chargesEnabled` is the field a screen must not soften. Connected and unable
 * to take money is a real state, and a green tick over it is how a merchant
 * finds out from a customer.
 */
function describe(db, workspaceId) {
  const row = rowFor(db, workspaceId);
  if (!row) {
    return {
      connected: false,
      available: available(),
      embedded: usesEmbedded(),
      because: available()
        ? 'This business can connect its own Stripe account without giving Foundry a key.'
        : 'Connecting a Stripe account this way is not set up on this server, so a secret key '
          + 'has to be pasted instead.',
    };
  }
  return {
    connected: true,
    available: true,
    embedded: usesEmbedded(),
    provider: PROVIDER,
    accountId: row.provider_account_id,
    displayName: row.display_name,
    chargesEnabled: row.charges_enabled === 1,
    liveMode: row.livemode === 1,
    checkedAt: row.checked_at,
    because: row.charges_enabled === 1 ? null
      : 'Stripe has this account connected but is not accepting charges on it yet — usually '
        + 'because it still wants details from the business. A payment link would fail until '
        + 'Stripe is satisfied.',
  };
}

module.exports = {
  PROVIDER, available, usesOauth, usesHostedOnboarding, usesEmbedded, platform,
  authorizeUrl, complete, openOnboarding, relink, embeddedSession, refresh, disconnect,
  describe, rowFor, forget,
};

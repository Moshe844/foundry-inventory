'use strict';

/*
 * Whose carrier account this is.
 *
 * The first version read the key from the environment, exactly as the Stripe
 * one does. That is right for one shop on one machine and wrong the moment
 * there are two: one key for the whole server means every merchant's parcels
 * ship on the same account, every label is billed to whoever runs the server,
 * and one merchant's tracking webhook could be read against another's records.
 *
 * So a shipping account belongs to a workspace, exactly as a mailbox does. The
 * key is stored the way every other provider credential in StockChief is stored —
 * encrypted, in the credential store, referenced by a connector row that holds
 * no secret itself.
 *
 * The environment is kept as a fallback and nothing more. A developer running
 * one inventory locally should not have to click through a connection screen to
 * try a label, and the moment a workspace connects its own account that account
 * wins. `source` says which of the two answered, because "who is paying for
 * this label" is not a question anybody should have to guess at.
 */

const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');
const credentials = require('../connections/credentials');
const permissions = require('../actions/permissions');

const PROVIDERS = ['shipengine', 'shipstation', 'easypost', 'shippo'];

const KEY_FIELD = {
  shipengine: 'shipengineApiKey',
  shipstation: 'shipstationApiKey',
  easypost: 'easypostApiKey',
  shippo: 'shippoApiKey',
};

function isTestKey(provider, key) {
  if (provider === 'easypost') return /^EZTK/i.test(String(key || ''));
  if (provider === 'shipengine') return /^TEST_/i.test(String(key || ''));
  if (provider === 'shipstation') return /^TEST_/i.test(String(key || ''));
  return /^shippo_test_/i.test(String(key || ''));
}

function requireProvider(name) {
  const key = String(name || '').toLowerCase();
  if (!PROVIDERS.includes(key)) {
    throw new ValidationError(`StockChief ships through ${PROVIDERS.join(' or ')}, not "${name}".`);
  }
  return key;
}

/** The connector row for this workspace's shipping account, if it has one. */
function connectorFor(db, workspaceId) {
  return db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type IN ('shipengine', 'shipstation', 'easypost', 'shippo')
      AND status = 'connected' AND paused_at IS NULL
    ORDER BY updated_at DESC LIMIT 1`).get(workspaceId) || null;
}

/**
 * The account a workspace ships on, and where it came from.
 *
 * Returns `{ provider, source, apiKey, webhookSecret, connectorId }`, or null
 * when this workspace has no way to reach a carrier at all — which is a normal
 * state, not a broken one. A shop that walks parcels to the post office needs
 * none of this.
 */
function forWorkspace(db, workspaceId) {
  const connector = connectorFor(db, workspaceId);
  if (connector) {
    const held = credentials.get(db, workspaceId, connector.id, 'provider') || {};
    if (held.apiKey) {
      /*
       * The same key, reached two ways.
       *
       * A merchant either pasted one they already had, or StockChief opened the
       * account for them through the partner API. Nothing below this line
       * cares which — a key is a key — but the person looking at the settings
       * screen does, because only one of the two has a payment method they may
       * still need to add. So `source` says, and the referral record is what
       * it is read from.
       */
      const opened = db.prepare(`SELECT partner, referral_customer_id, billing_ready
        FROM shipping_referral_accounts WHERE workspace_id = ? AND connector_id = ?`)
        .get(workspaceId, connector.id);
      return {
        provider: connector.provider_type,
        source: opened ? (opened.partner === 'shipengine' ? 'platform' : 'referral') : 'workspace',
        connectorId: connector.id,
        apiKey: held.apiKey,
        webhookSecret: held.webhookSecret || null,
        displayName: connector.display_name,
        referralCustomerId: opened ? opened.referral_customer_id : null,
        billingReady: opened ? opened.billing_ready === 1 : null,
      };
    }
  }

  /*
   * Nothing connected here. The environment answers only for a single-tenant
   * install, and says so — a shared key is a real thing to know about, not a
   * detail to hide behind a green tick.
   */
  const preferred = String(process.env.SHIPPING_PROVIDER || '').toLowerCase();
  for (const name of preferred && PROVIDERS.includes(preferred) ? [preferred] : PROVIDERS) {
    const fromEnv = process.env[`${name.toUpperCase()}_API_KEY`];
    if (fromEnv) {
      /*
       * A shared live key makes the server owner pay every tenant's postage.
       * It is therefore valid only when this installation has explicitly been
       * declared single-tenant. Test keys remain useful for local development
       * because they cannot buy real postage.
       */
      if (!isTestKey(name, fromEnv) && process.env.SHIPPING_SINGLE_TENANT !== 'true') continue;
      return {
        provider: name,
        source: 'server',
        connectorId: null,
        apiKey: fromEnv,
        webhookSecret: process.env[`${name.toUpperCase()}_WEBHOOK_SECRET`] || null,
        displayName: `${name} (this server)`,
      };
    }
  }
  return null;
}

/**
 * The ctx an adapter needs, with this workspace's key on it.
 *
 * Every adapter already reads its key off ctx before falling back to the
 * environment, so this is the whole of what multi-tenancy costs at the call
 * sites: build the ctx from the workspace rather than from the process.
 */
function contextFor(db, ctx) {
  const account = forWorkspace(db, ctx.workspaceId);
  if (!account) return null;
  return { account, ctx: { ...ctx, [KEY_FIELD[account.provider]]: account.apiKey } };
}

/**
 * Connect a workspace's own carrier account.
 *
 * The key never touches the connector row — that holds a reference and nothing
 * else, which is what stops a plan, a prompt or a log from carrying a secret by
 * accident. It is written straight to the encrypted store.
 */
function connect(db, ctx, membership, input = {}) {
  permissions.assertCan(membership, permissions.ADMIN,
    'connect a shipping account');
  const provider = requireProvider(input.provider);
  const apiKey = requireText(input.apiKey, 'API key', { max: 400 });
  const webhookSecret = trimOrNull(input.webhookSecret);
  const now = nowIso();

  /*
   * An account StockChief opened is not quietly written over.
   *
   * A merchant who later negotiates their own carrier contract should be able
   * to switch to it — but pasting a key over a referral account would leave
   * that account's keys gone from StockChief with nothing said, and the merchant
   * still being billed by EasyPost for an account they can no longer see. So
   * it is refused, once, with the reason.
   */
  const opened = db.prepare(`SELECT id FROM shipping_referral_accounts
    WHERE workspace_id = ? AND partner = ?`).get(ctx.workspaceId, provider);
  if (opened) {
    throw new ValidationError('StockChief opened a shipping account for this inventory, and pasting a '
      + 'key over it would hide that account rather than replace it. Disconnect it first, then '
      + 'connect the account you want to ship on.');
  }

  let connector = db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type = ?`).get(ctx.workspaceId, provider);

  if (!connector) {
    const id = newId('conn');
    db.prepare(`INSERT INTO workspace_connectors
      (id, workspace_id, connector_key, display_name, provider_type, provides, config,
       status, capabilities, credential_ref, setup_status, authorized_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '["shipping"]', '{}', 'connected', '["rates","labels","tracking"]',
        ?, 'CONNECTED', ?, ?, ?)`)
      .run(id, ctx.workspaceId, `shipping-${provider}`,
        provider === 'shipengine' ? 'ShipEngine'
          : provider === 'shipstation' ? 'ShipStation'
            : provider === 'easypost' ? 'EasyPost' : 'Shippo', provider,
        `credentials:${id}:provider`, ctx.actorId || null, now, now);
    connector = db.prepare('SELECT * FROM workspace_connectors WHERE id = ?').get(id);
  } else {
    db.prepare(`UPDATE workspace_connectors SET status = 'connected', paused_at = NULL,
      setup_status = 'CONNECTED', last_error = NULL, updated_at = ? WHERE id = ?`)
      .run(now, connector.id);
  }

  credentials.put(db, ctx.workspaceId, connector.id, 'provider', { apiKey, webhookSecret });
  return describe(db, ctx.workspaceId);
}

/** Proves a pasted credential can reach its account before StockChief stores it. */
async function verifyInput(input = {}) {
  const provider = requireProvider(input.provider);
  const apiKey = requireText(input.apiKey, 'API key', { max: 400 });
  if (provider === 'shipengine') {
    await require('./providers/shipengine').call({ shipengineApiKey: apiKey }, '/carriers');
  } else if (provider === 'shipstation') {
    await require('./providers/shipstation').call({ shipstationApiKey: apiKey }, '/carriers');
  } else if (provider === 'easypost') {
    await require('./providers/easypost').call({ easypostApiKey: apiKey }, '/users');
  } else {
    await require('./providers/shippo').call({ shippoApiKey: apiKey }, '/carrier_accounts/?results=1');
  }
  return { provider, testMode: isTestKey(provider, apiKey) };
}

function disconnect(db, ctx, membership) {
  permissions.assertCan(membership, permissions.ADMIN,
    'disconnect a shipping account');

  /*
   * Disconnecting an account StockChief opened is a different act, and is done by
   * the module that knows the difference: it forgets the keys and leaves the
   * merchant's EasyPost account, and everything shipped on it, standing.
   */
  const platform = require('./shipengine-platform');
  if (platform.rowFor(db, ctx.workspaceId)) {
    platform.release(db, ctx, membership);
    return describe(db, ctx.workspaceId);
  }
  const referral = require('./referral');
  if (referral.rowFor(db, ctx.workspaceId)) {
    referral.release(db, ctx, membership);
    return describe(db, ctx.workspaceId);
  }

  const connector = connectorFor(db, ctx.workspaceId);
  if (!connector) throw new NotFoundError('No shipping account is connected to this inventory.');
  credentials.remove(db, ctx.workspaceId, connector.id);
  db.prepare(`UPDATE workspace_connectors SET status = 'disconnected', updated_at = ?
    WHERE id = ?`).run(nowIso(), connector.id);
  return describe(db, ctx.workspaceId);
}

/**
 * What to tell somebody about their shipping account, without telling them
 * the key.
 *
 * The last four characters only. Enough to recognise which key is in there —
 * which is the actual question when somebody has a test key and a live one —
 * and useless to anybody reading over a shoulder.
 */
function describe(db, workspaceId) {
  const account = forWorkspace(db, workspaceId);
  if (!account) {
    return { connected: false, provider: null, source: null,
      because: 'No shipping account is connected, so StockChief cannot get live rates or buy a label.' };
  }
  const key = String(account.apiKey);
  return {
    connected: true,
    provider: account.provider,
    source: account.source,
    connectorId: account.connectorId,
    displayName: account.displayName,
    keyEndsWith: key.length > 4 ? key.slice(-4) : null,
    testMode: isTestKey(account.provider, key),
    hasWebhookSecret: Boolean(account.webhookSecret),
    referralCustomerId: account.referralCustomerId || null,
    billingReady: account.billingReady,
    because: account.source === 'server'
      ? 'This inventory is using the key set on the server, which every inventory on it shares. '
        + 'Connect this inventory\'s own account and its parcels will be billed to it instead.'
      : ['referral', 'platform'].includes(account.source) && account.billingReady === false
        ? 'StockChief opened this account, but no payment method has been added to it yet — so it '
          + 'cannot buy a label, and the rates it returns are test rates rather than a carrier\'s.'
        : null,
  };
}

module.exports = { PROVIDERS, forWorkspace, contextFor, connect, verifyInput,
  disconnect, describe, connectorFor, isTestKey };

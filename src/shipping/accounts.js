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
 * key is stored the way every other provider credential in Foundry is stored —
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

const PROVIDERS = ['easypost', 'shippo'];

const KEY_FIELD = { easypost: 'easypostApiKey', shippo: 'shippoApiKey' };

function requireProvider(name) {
  const key = String(name || '').toLowerCase();
  if (!PROVIDERS.includes(key)) {
    throw new ValidationError(`Foundry ships through ${PROVIDERS.join(' or ')}, not "${name}".`);
  }
  return key;
}

/** The connector row for this workspace's shipping account, if it has one. */
function connectorFor(db, workspaceId) {
  return db.prepare(`SELECT * FROM workspace_connectors
    WHERE workspace_id = ? AND provider_type IN ('easypost', 'shippo')
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
      return {
        provider: connector.provider_type,
        source: 'workspace',
        connectorId: connector.id,
        apiKey: held.apiKey,
        webhookSecret: held.webhookSecret || null,
        displayName: connector.display_name,
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
        provider === 'easypost' ? 'EasyPost' : 'Shippo', provider,
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

function disconnect(db, ctx, membership) {
  permissions.assertCan(membership, permissions.ADMIN,
    'disconnect a shipping account');
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
      because: 'No shipping account is connected, so Foundry cannot get live rates or buy a label.' };
  }
  const key = String(account.apiKey);
  return {
    connected: true,
    provider: account.provider,
    source: account.source,
    connectorId: account.connectorId,
    displayName: account.displayName,
    keyEndsWith: key.length > 4 ? key.slice(-4) : null,
    testMode: /^(EZTK|shippo_test)/i.test(key),
    hasWebhookSecret: Boolean(account.webhookSecret),
    because: account.source === 'server'
      ? 'This inventory is using the key set on the server, which every inventory on it shares. '
        + 'Connect this inventory\'s own account and its parcels will be billed to it instead.'
      : null,
  };
}

module.exports = { PROVIDERS, forWorkspace, contextFor, connect, disconnect, describe, connectorFor };

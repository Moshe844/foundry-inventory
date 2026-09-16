'use strict';

/*
 * One ShipEngine seller per StockChief workspace.
 *
 * The platform credential can create sellers and mint short-lived Elements
 * tokens. It can never quote or buy a label. Each seller's own encrypted API
 * key is stored on that workspace connector, so postage is isolated by tenant
 * and paid from the payment method the owner supplies in ShipEngine Elements.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const { ValidationError, NotFoundError, AuthenticationError } = require('../domain/errors');
const { newId, nowIso, requireText } = require('../lib/util');
const credentials = require('../connections/credentials');
const permissions = require('../actions/permissions');

const PARTNER = 'shipengine';
const BASE = 'https://api.shipengine.com/v1';

function env(name) { return String(process.env[name] || '').trim(); }

function configuration() {
  return {
    apiKey: env('SHIPENGINE_PLATFORM_API_KEY'),
    partnerId: env('SHIPENGINE_PARTNER_ID'),
    privateKey: env('SHIPENGINE_PLATFORM_PRIVATE_KEY'),
    privateKeyPath: env('SHIPENGINE_PLATFORM_PRIVATE_KEY_PATH'),
    tokenIssuer: env('SHIPENGINE_PLATFORM_TOKEN_ISSUER'),
    tokenKeyId: env('SHIPENGINE_PLATFORM_TOKEN_KEY_ID'),
    scope: env('SHIPENGINE_PLATFORM_SCOPE'),
  };
}

function missingConfiguration() {
  const cfg = configuration();
  const missing = [];
  if (!cfg.apiKey) missing.push('SHIPENGINE_PLATFORM_API_KEY');
  if (!cfg.partnerId) missing.push('SHIPENGINE_PARTNER_ID');
  if (!cfg.privateKey && !cfg.privateKeyPath) missing.push('SHIPENGINE_PLATFORM_PRIVATE_KEY');
  if (!cfg.tokenIssuer) missing.push('SHIPENGINE_PLATFORM_TOKEN_ISSUER');
  if (!cfg.tokenKeyId) missing.push('SHIPENGINE_PLATFORM_TOKEN_KEY_ID');
  if (!cfg.scope) missing.push('SHIPENGINE_PLATFORM_SCOPE');
  return missing;
}

function isConfigured() { return missingConfiguration().length === 0; }

function privateKey(cfg = configuration()) {
  if (cfg.privateKey) return cfg.privateKey.replace(/\\n/g, '\n');
  if (cfg.privateKeyPath) return fs.readFileSync(cfg.privateKeyPath, 'utf8');
  throw new ValidationError('ShipEngine platform signing is not configured.');
}

function base64url(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return bytes.toString('base64url');
}

function createToken(sellerId, options = {}) {
  const cfg = options.configuration || configuration();
  if (!sellerId) throw new ValidationError('This workspace has no ShipEngine seller account.');
  const now = Math.floor(Date.now() / 1000);
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: cfg.tokenKeyId });
  const payload = base64url({
    partner: cfg.partnerId,
    tenant: String(sellerId),
    scope: cfg.scope,
    iss: cfg.tokenIssuer,
    iat: now,
    exp: now + 55 * 60,
  });
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey(cfg));
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function platformCall(path, options = {}) {
  const cfg = options.configuration || configuration();
  const response = await (options.fetch || fetch)(`${BASE}${path}`, {
    method: options.method || 'GET',
    headers: {
      'api-key': cfg.apiKey,
      'partner-id': cfg.partnerId,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const errors = Array.isArray(body?.errors) ? body.errors.map((row) => row.message).filter(Boolean) : [];
    const message = errors.join(' ') || body?.message || body?.error
      || `ShipEngine returned ${response.status}.`;
    const ErrorType = response.status === 401 || response.status === 403
      ? AuthenticationError : ValidationError;
    const error = new ErrorType(typeof message === 'string' ? message : JSON.stringify(message));
    error.status = response.status;
    throw error;
  }
  return body;
}

function splitName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts.shift() || 'Business', lastName: parts.join(' ') || 'Owner' };
}

async function createSeller(input = {}, options = {}) {
  if (!isConfigured() && !options.configuration) {
    throw new ValidationError('Embedded multi-business shipping requires ShipStation API '
      + 'Enterprise/Partner approval and the platform credentials they issue. StockChief does not '
      + 'have those credentials yet.');
  }
  const person = splitName(input.ownerName);
  const body = await platformCall('/partners/accounts', {
    ...options,
    method: 'POST',
    body: {
      first_name: person.firstName,
      last_name: person.lastName,
      company_name: requireText(input.companyName, 'business name', { max: 200 }),
      origin_country_code: String(input.countryCode || 'US').toUpperCase(),
      external_account_id: input.externalAccountId || undefined,
    },
  });
  const sellerId = body?.account_id;
  const sellerApiKey = body?.api_key?.encrypted_api_key || body?.api_key?.api_key
    || body?.api_key?.key || body?.api_key;
  if (!sellerId || !sellerApiKey || typeof sellerApiKey !== 'string') {
    throw new ValidationError('ShipEngine created a seller response StockChief could not use safely.');
  }
  return { sellerId: String(sellerId), sellerApiKey };
}

function rowFor(db, workspaceId) {
  return db.prepare(`SELECT * FROM shipping_referral_accounts
    WHERE workspace_id = ? AND partner = ?`).get(workspaceId, PARTNER) || null;
}

async function enrol(db, ctx, membership, input = {}, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'set up shipping');
  if (rowFor(db, ctx.workspaceId)) return describe(db, ctx.workspaceId);

  const existingShipping = require('./accounts').connectorFor(db, ctx.workspaceId);
  if (existingShipping) {
    throw new ValidationError('A shipping account is already connected. Disconnect it before '
      + 'starting a different account.');
  }

  const created = await createSeller({
    companyName: input.companyName,
    ownerName: input.ownerName,
    countryCode: input.countryCode,
    externalAccountId: ctx.workspaceId,
  }, options);
  const now = nowIso();
  const connectorId = newId('conn');
  db.prepare(`INSERT INTO workspace_connectors
    (id, workspace_id, connector_key, display_name, provider_type, provides, config,
     status, capabilities, credential_ref, setup_status, authorized_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, 'ShipEngine', 'shipengine', '["shipping"]', '{"platform":true}',
      'connected', '["rates","labels","tracking"]', ?, 'AUTHORIZING', ?, ?, ?)`)
    .run(connectorId, ctx.workspaceId, 'shipping-shipengine-platform',
      `credentials:${connectorId}:provider`, ctx.actorId || null, now, now);
  credentials.put(db, ctx.workspaceId, connectorId, 'provider', {
    apiKey: created.sellerApiKey,
    sellerId: created.sellerId,
  });
  db.prepare(`INSERT INTO shipping_referral_accounts
    (id, workspace_id, connector_id, partner, referral_customer_id, name, email,
     billing_ready, billing_checked_at, opened_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`)
    .run(newId('shipref'), ctx.workspaceId, connectorId, PARTNER, created.sellerId,
      input.companyName, input.email || null, ctx.actorId || null, now, now);
  return describe(db, ctx.workspaceId);
}

function tokenFor(db, workspaceId) {
  const row = rowFor(db, workspaceId);
  if (!row) throw new NotFoundError('This workspace has not started ShipEngine setup.');
  return createToken(row.referral_customer_id);
}

async function completeOnboarding(db, ctx, membership, options = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'finish shipping setup');
  const row = rowFor(db, ctx.workspaceId);
  if (!row) throw new NotFoundError('This workspace has not started ShipEngine setup.');
  const held = credentials.get(db, ctx.workspaceId, row.connector_id, 'provider') || {};
  const provider = options.provider || require('./providers/shipengine');
  const ids = await provider.carrierIds({ shipengineApiKey: held.apiKey });
  if (!ids.length) {
    throw new ValidationError('ShipEngine has not activated a carrier for this business yet. '
      + 'Finish the carrier and payment steps before closing setup.');
  }
  const now = nowIso();
  db.prepare(`UPDATE shipping_referral_accounts SET billing_ready = 1,
    billing_checked_at = ?, updated_at = ? WHERE id = ?`).run(now, now, row.id);
  db.prepare(`UPDATE workspace_connectors SET setup_status = 'CONNECTED', last_error = NULL,
    updated_at = ? WHERE id = ?`).run(now, row.connector_id);
  return describe(db, ctx.workspaceId);
}

function release(db, ctx, membership) {
  permissions.assertCan(membership, permissions.ADMIN, 'disconnect a shipping account');
  const row = rowFor(db, ctx.workspaceId);
  if (!row) throw new NotFoundError('No ShipEngine seller is connected to this workspace.');
  credentials.remove(db, ctx.workspaceId, row.connector_id);
  db.prepare(`UPDATE workspace_connectors SET status = 'disconnected', updated_at = ?
    WHERE id = ?`).run(nowIso(), row.connector_id);
  db.prepare('DELETE FROM shipping_referral_accounts WHERE id = ?').run(row.id);
  return { released: true, sellerId: row.referral_customer_id };
}

function describe(db, workspaceId) {
  const row = rowFor(db, workspaceId);
  if (!row) return {
    opened: false,
    available: isConfigured(),
    missing: missingConfiguration(),
    because: isConfigured()
      ? 'StockChief can open a separate ShipEngine seller for this business.'
      : 'Embedded multi-business onboarding requires ShipStation API Enterprise/Partner approval '
        + 'and the platform credentials they issue. StockChief does not have those credentials yet.',
  };
  return {
    opened: true,
    available: true,
    sellerId: row.referral_customer_id,
    name: row.name,
    email: row.email,
    billingReady: row.billing_ready === 1,
    billingCheckedAt: row.billing_checked_at,
    because: row.billing_ready === 1 ? null
      : 'Finish the one-time carrier, ship-from address, and payment steps. The payment method '
        + 'belongs to this business and pays for its labels.',
  };
}

module.exports = {
  PARTNER, configuration, missingConfiguration, isConfigured, createToken,
  createSeller, enrol, tokenFor, completeOnboarding, release, describe, rowFor,
};

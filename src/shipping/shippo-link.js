'use strict';

/*
 * "Link Shippo account": the owner signs in to Shippo and approves StockChief,
 * with no key to copy. StockChief is registered with Shippo as an OAuth app
 * (SHIPPO_OAUTH_CLIENT_ID / SHIPPO_OAUTH_CLIENT_SECRET); until it is, the
 * option is not shown and the API-key connection is the way in.
 *
 * Shippo's access tokens do not expire. The token is stored exactly like a
 * pasted API key, in the encrypted credential store, and is sent as a Bearer
 * token (see providers/shippo.js).
 */

const crypto = require('node:crypto');
const { ValidationError } = require('../domain/errors');
const { providerFetch } = require('../lib/provider-http');

const AUTHORIZE = 'https://goshippo.com/oauth/authorize';
const TOKEN = 'https://goshippo.com/oauth/access_token';
const STATE_TTL_MS = 15 * 60 * 1000;

const env = (name) => String(process.env[name] || '').trim();
function configured() { return Boolean(env('SHIPPO_OAUTH_CLIENT_ID') && env('SHIPPO_OAUTH_CLIENT_SECRET')); }

/** Where to send the owner, and the one-time state the callback must return. */
function start(redirectUri) {
  if (!configured()) throw new ValidationError('Linking a Shippo account is not available yet. Connect with a Shippo API key instead.');
  const state = crypto.randomBytes(24).toString('hex');
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({ response_type: 'code', client_id: env('SHIPPO_OAUTH_CLIENT_ID'), scope: '*', state, redirect_uri: redirectUri }).toString();
  return { url: url.toString(), saved: { state, at: Date.now() } };
}

function checkState(saved, returned) {
  const fresh = saved && Date.now() - Number(saved.at) < STATE_TTL_MS;
  const a = Buffer.from(String(saved?.state || '')), b = Buffer.from(String(returned || ''));
  if (!fresh || !a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ValidationError('That Shippo link expired or did not start here. Start linking again.');
  }
}

/** Trade the one-time code for the account's access token. */
async function exchange(code, redirectUri) {
  const response = await providerFetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ client_id: env('SHIPPO_OAUTH_CLIENT_ID'), client_secret: env('SHIPPO_OAUTH_CLIENT_SECRET'),
      code: String(code || ''), grant_type: 'authorization_code', redirect_uri: redirectUri }).toString(),
  }, { provider: 'Shippo', retries: 0 });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token) {
    throw new ValidationError('Shippo did not confirm the link. Nothing was connected; try linking again.');
  }
  return body.access_token;
}

/** The stored form: an "oauth." token is recognised as Bearer as it is; any other is marked. */
function storedKey(token) { return token.startsWith('oauth.') ? token : 'bearer:' + token; }

module.exports = { configured, start, checkState, exchange, storedKey };

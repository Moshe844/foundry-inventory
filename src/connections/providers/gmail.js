'use strict';

const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { jsonRequest } = require('./common');

const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send'];
const decode = (value = '') => Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const base64 = (value = '') => Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
const header = (payload, name) => (payload?.headers || []).find((entry) => entry.name?.toLowerCase() === name.toLowerCase())?.value || null;

function metadata() {
  return { type: 'gmail', name: 'Gmail', mark: 'G', category: 'supplier', authMode: 'oauth',
    available: config.connections.gmail.configured,
    description: 'Watch approved supplier senders and send authorized purchasing messages through Gmail.',
    provides: ['supplier messages', 'purchasing documents', 'authorized supplier email'],
    unavailableReason: config.connections.gmail.configured ? null : 'Add the Gmail OAuth client ID and secret to this Foundry installation.' };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.gmail.configured) throw new ValidationError('Gmail is not configured on this Foundry installation.');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [key, value] of Object.entries({ client_id: config.connections.gmail.clientId,
    redirect_uri: input.redirectUri, response_type: 'code', scope: SCOPES.join(' '), state,
    // This entry point is also used by "Connect another Gmail". Force Google
    // to ask which account the owner means instead of silently reusing the
    // browser's current account.
    access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true' })) url.searchParams.set(key, value);
  return { url: url.toString(), metadata: { redirectUri: input.redirectUri } };
}

async function token(body) {
  return (await jsonRequest('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })).body;
}

async function exchangeAuthorization({ query, metadata: auth = {} }) {
  if (query.error) throw new ValidationError(query.error_description || 'Gmail authorization was not completed.');
  if (!query.code) throw new ValidationError('Gmail did not return an authorization code.');
  const result = await token({ code: query.code, client_id: config.connections.gmail.clientId,
    client_secret: config.connections.gmail.clientSecret, redirect_uri: auth.redirectUri,
    grant_type: 'authorization_code' });
  if (!result.access_token) throw new ValidationError('Gmail did not return a usable access token.');
  const credentials = { accessToken: result.access_token, refreshToken: result.refresh_token,
    expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000, scope: result.scope };
  const profile = (await api(credentials, '/gmail/v1/users/me/profile')).body;
  credentials.mailbox = profile.emailAddress;
  credentials.historyId = profile.historyId;
  return { credentials, accountId: profile.emailAddress, accountName: profile.emailAddress,
    capabilities: ['MAIL_READ', 'MAIL_SEND', 'MAILBOX_WATCH'], expiresAt: new Date(credentials.expiresAt).toISOString() };
}

async function refreshCredentials(credentials) {
  if (Number(credentials.expiresAt || 0) > Date.now() + 5 * 60_000) return { credentials, refreshed: false,
    expiresAt: new Date(credentials.expiresAt).toISOString() };
  if (!credentials.refreshToken) throw new ValidationError('Gmail access expired. Reconnect this mailbox.');
  const result = await token({ refresh_token: credentials.refreshToken, client_id: config.connections.gmail.clientId,
    client_secret: config.connections.gmail.clientSecret, grant_type: 'refresh_token' });
  const next = { ...credentials, accessToken: result.access_token,
    expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 };
  return { credentials: next, refreshed: true, expiresAt: new Date(next.expiresAt).toISOString() };
}

function api(credentials, path, options = {}) {
  return jsonRequest(`https://gmail.googleapis.com${path}`, { ...options, headers: {
    authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json',
    'content-type': 'application/json', ...(options.headers || {}) } });
}

async function discover() { return { products: [], locations: [] }; }

async function registerWebhooks({ credentials }) {
  // A topic without an authenticated push subscription is not a verified
  // webhook. Stay on polling until both are configured rather than accepting
  // anonymous triggers that merely look like Gmail notifications.
  if (!config.connections.gmail.pubsubTopic || !config.connections.gmail.pubsubVerificationToken) {
    return { credentials: { ...credentials, deliveryMode: 'poll' } };
  }
  const result = (await api(credentials, '/gmail/v1/users/me/watch', { method: 'POST', body: JSON.stringify({
    topicName: config.connections.gmail.pubsubTopic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }) })).body;
  return { credentials: { ...credentials, deliveryMode: 'push', historyId: result.historyId,
    watchExpiration: result.expiration } };
}

// Gmail watches expire. Reissuing watch renews the mailbox safely and returns
// the new history cursor/expiration without changing the sender rules.
async function renewWebhooks(options) { return registerWebhooks(options); }

function flattenParts(part, out = []) {
  if (part?.filename) out.push(part);
  for (const child of part?.parts || []) flattenParts(child, out);
  return out;
}

function bodyText(payload) {
  if (payload?.mimeType === 'text/plain' && payload.body?.data) return decode(payload.body.data);
  for (const part of payload?.parts || []) { const value = bodyText(part); if (value) return value; }
  return payload?.body?.data ? decode(payload.body.data) : '';
}

async function message(credentials, id) {
  const row = (await api(credentials, `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`)).body;
  const attachments = [];
  for (const part of flattenParts(row.payload)) {
    let data = part.body?.data;
    if (!data && part.body?.attachmentId) data = (await api(credentials,
      `/gmail/v1/users/me/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)).body.data;
    attachments.push({ id: part.body?.attachmentId, filename: part.filename,
      mimeType: part.mimeType, contentBase64: data ? base64(data) : undefined });
  }
  const from = header(row.payload, 'From') || '';
  const address = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
  return { messageId: row.id, threadId: row.threadId, internetMessageId: header(row.payload, 'Message-ID'),
    sender: address, recipients: (header(row.payload, 'To') || '').split(',').map((entry) => entry.trim()).filter(Boolean),
    subject: header(row.payload, 'Subject'), bodyText: bodyText(row.payload),
    receivedAt: row.internalDate ? new Date(Number(row.internalDate)).toISOString() : null, attachments };
}

async function poll({ credentials, since }) {
  const query = new URLSearchParams({ maxResults: '50', q: `in:inbox after:${Math.floor(new Date(since || Date.now() - 86400000).getTime() / 1000)}` });
  const list = (await api(credentials, `/gmail/v1/users/me/messages?${query}`)).body.messages || [];
  const messages = [];
  for (const row of list) messages.push(await message(credentials, row.id));
  return { messages, cursor: messages[0]?.messageId || null };
}

async function send({ credentials, message: outgoing }) {
  const raw = [`To: ${outgoing.recipient}`, `Subject: ${outgoing.subject}`, 'Content-Type: text/plain; charset="UTF-8"',
    '', outgoing.body].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64url');
  const result = (await api(credentials, '/gmail/v1/users/me/messages/send', { method: 'POST',
    body: JSON.stringify({ raw: encoded, threadId: outgoing.externalThreadId || undefined }) })).body;
  return { externalMessageId: result.id, externalThreadId: result.threadId };
}

module.exports = { metadata, authorizationUrl, exchangeAuthorization, refreshCredentials, discover,
  registerWebhooks, renewWebhooks, poll, send, api, message };

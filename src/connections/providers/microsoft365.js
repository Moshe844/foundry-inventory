'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError, AuthenticationError } = require('../../domain/errors');
const { jsonRequest, safeEqual } = require('./common');

const SCOPES = ['openid', 'profile', 'offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'];
const tenantBase = () => `https://login.microsoftonline.com/${encodeURIComponent(config.connections.microsoft365.tenant)}/oauth2/v2.0`;

function metadata() {
  return { type: 'microsoft365', name: 'Microsoft 365', mark: 'M365', category: 'supplier', authMode: 'oauth',
    available: config.connections.microsoft365.configured,
    description: 'Watch approved supplier senders and send authorized purchasing messages through Outlook.',
    provides: ['supplier messages', 'purchasing documents', 'authorized supplier email'],
    unavailableReason: config.connections.microsoft365.configured ? null : 'Add the Microsoft 365 OAuth client ID and secret to this Foundry installation.' };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.microsoft365.configured) throw new ValidationError('Microsoft 365 is not configured on this installation.');
  const url = new URL(`${tenantBase()}/authorize`);
  for (const [key, value] of Object.entries({ client_id: config.connections.microsoft365.clientId,
    redirect_uri: input.redirectUri, response_type: 'code', response_mode: 'query', scope: SCOPES.join(' '), state,
    prompt: 'select_account' }))
    url.searchParams.set(key, value);
  return { url: url.toString(), metadata: { redirectUri: input.redirectUri } };
}

async function token(body) {
  return (await jsonRequest(`${tenantBase()}/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() })).body;
}

async function exchangeAuthorization({ query, metadata: auth = {} }) {
  if (query.error) throw new ValidationError(query.error_description || 'Microsoft authorization was not completed.');
  if (!query.code) throw new ValidationError('Microsoft did not return an authorization code.');
  const result = await token({ client_id: config.connections.microsoft365.clientId,
    client_secret: config.connections.microsoft365.clientSecret, code: query.code,
    redirect_uri: auth.redirectUri, grant_type: 'authorization_code', scope: SCOPES.join(' ') });
  const credentials = { accessToken: result.access_token, refreshToken: result.refresh_token,
    expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 };
  if (!credentials.accessToken) throw new ValidationError('Microsoft did not return a usable access token.');
  const profile = (await graph(credentials, '/me?$select=id,displayName,mail,userPrincipalName')).body;
  credentials.mailbox = profile.mail || profile.userPrincipalName;
  return { credentials, accountId: profile.id, accountName: credentials.mailbox || profile.displayName,
    capabilities: ['MAIL_READ', 'MAIL_SEND', 'MAILBOX_WATCH'], expiresAt: new Date(credentials.expiresAt).toISOString() };
}

async function refreshCredentials(credentials) {
  if (Number(credentials.expiresAt || 0) > Date.now() + 5 * 60_000) return { credentials, refreshed: false,
    expiresAt: new Date(credentials.expiresAt).toISOString() };
  if (!credentials.refreshToken) throw new ValidationError('Microsoft 365 access expired. Reconnect this mailbox.');
  const result = await token({ client_id: config.connections.microsoft365.clientId,
    client_secret: config.connections.microsoft365.clientSecret, refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token', scope: SCOPES.join(' ') });
  const next = { ...credentials, accessToken: result.access_token, refreshToken: result.refresh_token || credentials.refreshToken,
    expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000 };
  return { credentials: next, refreshed: true, expiresAt: new Date(next.expiresAt).toISOString() };
}

function graph(credentials, path, options = {}) {
  return jsonRequest(`https://graph.microsoft.com/v1.0${path}`, { ...options, headers: {
    authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json',
    'content-type': 'application/json', ...(options.headers || {}) } });
}
async function discover() { return { products: [], locations: [] }; }

async function registerWebhooks({ credentials, webhookUrl }) {
  const clientState = crypto.randomBytes(24).toString('base64url');
  const expirationDateTime = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();
  const result = (await graph(credentials, '/subscriptions', { method: 'POST', body: JSON.stringify({
    changeType: 'created', notificationUrl: webhookUrl, lifecycleNotificationUrl: webhookUrl,
    resource: "me/mailFolders('Inbox')/messages", expirationDateTime, clientState,
    latestSupportedTlsVersion: 'v1_2' }) })).body;
  return { credentials: { ...credentials, deliveryMode: 'push', subscriptionId: result.id,
    subscriptionExpiresAt: result.expirationDateTime, webhookClientState: clientState } };
}

async function renewWebhooks({ credentials, webhookUrl }) {
  if (!credentials.subscriptionId) return registerWebhooks({ credentials, webhookUrl });
  const expirationDateTime = new Date(Date.now() + 2.5 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = (await graph(credentials, `/subscriptions/${encodeURIComponent(credentials.subscriptionId)}`, {
      method: 'PATCH', body: JSON.stringify({ expirationDateTime }),
    })).body;
    return { credentials: { ...credentials, deliveryMode: 'push',
      subscriptionExpiresAt: result.expirationDateTime || expirationDateTime } };
  } catch (error) {
    // Graph removes expired subscriptions. A missing old subscription is a
    // clean recreation case; authentication and other failures remain visible.
    if (error.status === 404) return registerWebhooks({ credentials: {
      ...credentials, subscriptionId: null, subscriptionExpiresAt: null,
    }, webhookUrl });
    throw error;
  }
}

async function poll({ credentials, since }) {
  const filter = since ? `&$filter=receivedDateTime ge ${new Date(since).toISOString()}` : '';
  const path = `/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$select=id,conversationId,internetMessageId,subject,from,toRecipients,receivedDateTime,body,hasAttachments${filter}`;
  const rows = (await graph(credentials, path, { headers: { Prefer: 'outlook.body-content-type="text"' } })).body.value || [];
  const messages = [];
  for (const row of rows) {
    const attachments = row.hasAttachments ? ((await graph(credentials,
      // `contentBytes` belongs to the derived fileAttachment type, not the
      // base attachment type. Graph rejects selecting it on `/attachments`
      // even though it includes the bytes for file attachments in the normal
      // response. Asking for the attachment normally supports PDFs and sheets
      // without turning a valid webhook into an HTTP 400.
      `/me/messages/${encodeURIComponent(row.id)}/attachments`)).body.value || []) : [];
    messages.push({ messageId: row.id, threadId: row.conversationId, internetMessageId: row.internetMessageId,
      sender: row.from?.emailAddress?.address, recipients: (row.toRecipients || []).map((entry) => entry.emailAddress?.address).filter(Boolean),
      subject: row.subject, bodyText: row.body?.content, receivedAt: row.receivedDateTime,
      attachments: attachments.filter((entry) => entry.contentBytes).map((entry) => ({ id: entry.id,
        filename: entry.name, mimeType: entry.contentType, contentBase64: entry.contentBytes })) });
  }
  return { messages, cursor: messages[0]?.messageId || null };
}

async function send({ credentials, message }) {
  await graph(credentials, '/me/sendMail', { method: 'POST', body: JSON.stringify({ message: {
    subject: message.subject, body: { contentType: 'Text', content: message.body },
    toRecipients: [{ emailAddress: { address: message.recipient } }] }, saveToSentItems: true }) });
  return { externalMessageId: `m365:${message.id}` };
}

function verifyWebhook({ body, credentials }) {
  for (const notification of body?.value || []) {
    if (!safeEqual(notification.clientState, credentials.webhookClientState)) throw new AuthenticationError('Microsoft webhook client state is invalid.');
  }
}

module.exports = { metadata, authorizationUrl, exchangeAuthorization, refreshCredentials, discover,
  registerWebhooks, renewWebhooks, poll, send, verifyWebhook, graph };

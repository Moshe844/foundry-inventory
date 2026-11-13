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
    unavailableReason: config.connections.gmail.configured ? null : 'Add the Gmail OAuth client ID and secret to this StockChief installation.' };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.gmail.configured) throw new ValidationError('Gmail is not configured on this StockChief installation.');
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

async function refreshCredentials(credentials, options = {}) {
  if (!options.force && Number(credentials.expiresAt || 0) > Date.now() + 5 * 60_000) return { credentials, refreshed: false,
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
  const sections={plain:[],html:[],current:[]};
  function visit(part){
    if(!part||part.filename)return;
    if(part.body?.data){
      if(part.mimeType==='text/html'){
        const html=decode(part.body.data),source=require('./mailbox-source');
        sections.html.push(source.visibleHtml(html));
        sections.current.push(source.visibleHtml(html,{currentOnly:true}));
      }
      else if(part.mimeType==='text/plain'||!part.mimeType)sections.plain.push(decode(part.body.data));
    }
    for(const child of part.parts||[])visit(child);
  }
  visit(payload);
  if(sections.plain.some(s=>s.trim()))return {bodyText:sections.plain.join('\n')};
  return {bodyText:sections.html.join('\n'),triageBodyText:sections.current.join('\n')};
}

async function message(credentials, id) {
  const endpoint='/gmail/v1/users/me/messages/'+encodeURIComponent(id),source=require('./mailbox-source');
  let row,sourceIssue=null;
  try{row=(await api(credentials,endpoint+'?format=full')).body;}
  catch(error){
    if(!source.oversized(error))throw error;
    row=(await api(credentials,endpoint+'?format=metadata')).body;
    sourceIssue=source.originalReview;
  }
  const providerJunk=(row.labelIds||[]).includes('SPAM');
  const attachments = [];
  for (const part of flattenParts(row.payload)) {
    if(Number(part.body?.size)>20*1024*1024)sourceIssue=source.originalReview;
    let data=providerJunk||sourceIssue?null:part.body?.data;
    if(!providerJunk&&!sourceIssue&&!data&&part.body?.attachmentId){
      try{data=(await api(credentials,endpoint+'/attachments/'+encodeURIComponent(part.body.attachmentId))).body.data;}
      catch(error){if(!source.oversized(error))throw error;sourceIssue=source.originalReview;}
    }
    attachments.push({ id: part.body?.attachmentId, filename: part.filename,
      mimeType: part.mimeType, contentBase64: data ? base64(data) : undefined });
  }
  const from = header(row.payload, 'From') || '';
  const address = (from.match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase();
  return { messageId: row.id, threadId: row.threadId, internetMessageId: header(row.payload, 'Message-ID'),
    stockChiefMessageId: header(row.payload, 'X-StockChief-Message'),
    sender: address||'Sender unavailable',providerJunk,sourceIssue,listMail:Boolean(header(row.payload,'List-Id')||header(row.payload,'List-Unsubscribe')),
    recipients: (header(row.payload, 'To') || '').split(',').map((entry) => entry.trim()).filter(Boolean),
    subject: header(row.payload, 'Subject'), ...bodyText(row.payload),
    receivedAt: row.internalDate ? new Date(Number(row.internalDate)).toISOString() : null, attachments };
}

/*
 * How far back to ask, and where to look.
 *
 * Two things went wrong here, and both lost mail silently.
 *
 * The watermark advances to the moment of the poll whether or not anything was
 * found, so a message Gmail had not finished indexing when we asked — or one
 * that arrived while the request was in flight — fell into the gap between one
 * poll and the next and was never asked for again. Overlapping each window
 * fixes it, and costs nothing: capture already refuses a message it has seen,
 * on the provider's own id.
 */
const OVERLAP_MS = 15 * 60_000;

/*
 * Incoming mail may be filed straight into Archive by a customer's Gmail
 * rules. Include it alongside Inbox and Spam, without collecting Sent-only
 * messages, drafts or trash. Keep the same watermark and overlap: this does
 * not start a historical mailbox backfill or override a person's filing choice.
 */
async function poll({ credentials, since }) {
  const from = new Date(since || Date.now() - 86400000).getTime() - OVERLAP_MS;
  const query = new URLSearchParams({
    maxResults: '50',includeSpamTrash:'true',
    q: `(in:inbox OR in:spam OR -in:sent) -in:draft -in:trash after:${Math.floor(from / 1000)}`,
  });
  const messages = [];
  const visited = new Set();
  const seenMessages = new Set();
  let pageToken = '';
  do {
    if (visited.has(pageToken) || visited.size >= 100) {
      throw new ValidationError('Gmail did not finish listing this mailbox. The check remains incomplete; no messages will be skipped on retry.');
    }
    visited.add(pageToken);
    if (pageToken) query.set('pageToken', pageToken);
    const page = (await api(credentials, `/gmail/v1/users/me/messages?${query}`)).body;
    for (const row of page.messages || []) {
      if (seenMessages.has(row.id)) continue;
      seenMessages.add(row.id);
      messages.push(await message(credentials, row.id));
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return { messages, cursor: messages[0]?.messageId || null };
}

async function pollPage({credentials,since,until,cursor=null,accept=null}){
  const from=Math.floor((Date.parse(since)-OVERLAP_MS)/1000);
  const before=Math.ceil(Date.parse(until)/1000);
  const query=new URLSearchParams({maxResults:'50',includeSpamTrash:'true',
    q:'(in:inbox OR in:spam OR -in:sent) -in:draft -in:trash after:'+from+' before:'+before});
  if(cursor?.token)query.set('pageToken',cursor.token);
  const page=(await api(credentials,'/gmail/v1/users/me/messages?'+query)).body;
  if(page.nextPageToken&&page.nextPageToken===cursor?.token)throw new ValidationError('Gmail returned the same mailbox page. Retry this check.');
  const messages=[];
  const ids=[...new Set((page.messages||[]).map(row=>row.id))];
  for(let n=0;n<ids.length;n+=3){
    const batch=await Promise.all(ids.slice(n,n+3).map(async id=>{
      try{return await message(credentials,id);}
      catch(error){if(error.status===404)return null;throw error;}
    }));
    for(const row of batch.filter(row=>row&&(!row.receivedAt||Date.parse(row.receivedAt)<Date.parse(until)))){
      if(accept){if(await accept(row)===false)return {messages,stopped:true,next:null};}
      else messages.push(row);
    }
  }
  return {messages,next:page.nextPageToken?{token:page.nextPageToken}:null};
}

/*
 * One message, asked for by name.
 *
 * StockChief only keeps the envelope of mail it set aside, so bringing one in
 * means going back to Gmail for it rather than to a copy we chose not to make.
 */
async function fetchMessage({ credentials, messageId }) {
  return message(credentials, messageId);
}

async function send({ credentials, message: outgoing }) {
  const safeId = /^<[^\s<>@]+@[^\s<>@]+>$/;
  const threadHeaders = [];
  for (const value of [outgoing.recipient, outgoing.subject, outgoing.id || '']) {
    if (/[\r\n]/.test(String(value))) throw new ValidationError('Email headers must stay on one line.');
  }
  if (outgoing.externalThreadId && safeId.test(outgoing.inReplyTo) && outgoing.inReplyTo.length <= 512) {
    threadHeaders.push(`In-Reply-To: ${outgoing.inReplyTo}`, `References: ${outgoing.inReplyTo}`);
  }
  const subject = /[^\x20-\x7e]/.test(outgoing.subject)
    ? '=?UTF-8?B?' + Buffer.from(outgoing.subject).toString('base64') + '?='
    : outgoing.subject;
  const raw = require('./photo-attachments').mime(outgoing, threadHeaders) || [`To: ${outgoing.recipient}`, `Subject: ${subject}`,
    ...(outgoing.id ? [`X-StockChief-Message: ${outgoing.id}`] : []), ...threadHeaders, 'Content-Type: text/plain; charset="UTF-8"',
    '', outgoing.body].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64url');
  const result = (await api(credentials, '/gmail/v1/users/me/messages/send', { method: 'POST',
    body: JSON.stringify({ raw: encoded, threadId: outgoing.externalThreadId || undefined }) })).body;
  return { externalMessageId: result.id, externalThreadId: result.threadId };
}

module.exports = { metadata, authorizationUrl, exchangeAuthorization, refreshCredentials, discover,
  registerWebhooks, renewWebhooks, poll, pollPage, send, api, message, fetchMessage };

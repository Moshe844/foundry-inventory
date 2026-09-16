'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { jsonRequest } = require('./common');

const SCOPES = ['com.intuit.quickbooks.accounting'];
const base = () => config.connections.quickbooks.environment === 'production'
  ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
const basic = () => Buffer.from(`${config.connections.quickbooks.clientId}:${config.connections.quickbooks.clientSecret}`).toString('base64');

function metadata() {
  return { type: 'quickbooks', name: 'QuickBooks Online', mark: 'QB', category: 'accounting', authMode: 'oauth',
    integrationClass: 'accounting', available: config.connections.quickbooks.configured,
    environment: config.connections.quickbooks.environment,
    description: 'Verify the company, compare the books in shadow mode, then post only after parity and explicit authority.',
    provides: ['company identity', 'chart of accounts', 'trial-balance comparison', 'governed journal posting'],
    unavailableReason: config.connections.quickbooks.configured ? null : 'QuickBooks app credentials have not been configured on this installation.',
    minimumScopes: SCOPES,
  };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.quickbooks.configured) throw new ValidationError('QuickBooks is not configured on this StockChief installation.');
  const url = new URL('https://appcenter.intuit.com/connect/oauth2');
  url.searchParams.set('client_id', config.connections.quickbooks.clientId);
  url.searchParams.set('response_type', 'code'); url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('redirect_uri', input.redirectUri); url.searchParams.set('state', state);
  return { url: url.toString(), metadata: { redirectUri: input.redirectUri } };
}

async function exchangeAuthorization({ query, metadata: state }) {
  if (query.error) throw new ValidationError(query.error_description || 'QuickBooks authorization was not completed.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: state.redirectUri });
  const response = await jsonRequest('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST',
    headers: { authorization: `Basic ${basic()}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const credentials = { accessToken: response.body.access_token, refreshToken: response.body.refresh_token,
    realmId: query.realmId, expiresAt: new Date(Date.now() + Number(response.body.expires_in || 3600) * 1000).toISOString() };
  const fact = await verifyReadOnly({ credentials });
  return { credentials, accountId: query.realmId, accountName: fact.value, verifiedFact: fact,
    capabilities: ['accounting:read', 'accounting:shadow', 'accounting:post'], expiresAt: credentials.expiresAt };
}

async function refresh(credentials) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  const response = await jsonRequest('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', { method: 'POST',
    headers: { authorization: `Basic ${basic()}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  return { ...credentials, accessToken: response.body.access_token,
    refreshToken: response.body.refresh_token || credentials.refreshToken,
    expiresAt: new Date(Date.now() + Number(response.body.expires_in || 3600) * 1000).toISOString() };
}

async function refreshCredentials(credentials) {
  if (credentials.expiresAt && Date.parse(credentials.expiresAt) > Date.now() + 5 * 60_000) {
    return { credentials, refreshed: false, expiresAt: credentials.expiresAt };
  }
  const next = await refresh(credentials);
  return { credentials: next, refreshed: true, expiresAt: next.expiresAt };
}

async function api(credentials, path, options = {}) {
  return jsonRequest(`${base()}${path}`, { ...options, headers: { authorization: `Bearer ${credentials.accessToken}`,
    accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) } });
}

async function verifyReadOnly({ credentials }) {
  const response = await api(credentials, `/v3/company/${encodeURIComponent(credentials.realmId)}/companyinfo/${encodeURIComponent(credentials.realmId)}?minorversion=75`);
  const company = response.body.CompanyInfo;
  if (!company?.CompanyName) throw new ValidationError('QuickBooks did not return a company identity.');
  return { label: 'QuickBooks company', value: company.CompanyName, externalId: company.Id || credentials.realmId };
}

async function readAccountingSnapshot({ credentials, asOf }) {
  // CurrentBalance on the Account resource is not a certified trial balance.
  // Use the provider report at the exact cut-off date, and keep accounts with
  // no stable code unmapped rather than pretending a name is an identity.
  const accountQuery = encodeURIComponent('select * from Account maxresults 1000');
  const [response, chartResponse] = await Promise.all([
    api(credentials, `/v3/company/${encodeURIComponent(credentials.realmId)}/reports/TrialBalance?end_date=${encodeURIComponent(asOf)}&minorversion=75`),
    api(credentials, `/v3/company/${encodeURIComponent(credentials.realmId)}/query?query=${accountQuery}&minorversion=75`),
  ]);
  const chart = new Map((chartResponse.body.QueryResponse?.Account || []).map((row) => [String(row.Id), row]));
  const columns = response.body.Columns?.Column || [];
  const debitIndex = columns.findIndex((column) => /debit/i.test(column.ColTitle || ''));
  const creditIndex = columns.findIndex((column) => /credit/i.test(column.ColTitle || ''));
  const rows = [];
  const reportedAccountIds = new Set();
  const walk = (groups = []) => groups.forEach((row) => {
    // The live QuickBooks report API commonly omits the documented `type`
    // property and returns account rows as plain { ColData: [...] } objects.
    // The stable account id distinguishes those rows from headings/totals.
    if (Array.isArray(row.ColData) && row.ColData[0]?.id) {
      const identity = row.ColData[0] || {};
      const account = chart.get(String(identity.id));
      if (identity.id) reportedAccountIds.add(String(identity.id));
      rows.push({ externalId: identity.id || null, code: account?.AcctNum || null,
        name: account?.Name || identity.value || 'Unnamed account', version: account?.SyncToken || String(response.body.Header?.Time || asOf),
        accountType: account?.AccountType || null, accountSubType: account?.AccountSubType || null,
        classification: account?.Classification || null,
        balanceMinor: Math.round((Number(row.ColData[debitIndex]?.value || 0)
          - Number(row.ColData[creditIndex]?.value || 0)) * 100) });
    }
    if (Array.isArray(row.Rows?.Row)) walk(row.Rows.Row);
  });
  walk(response.body.Rows?.Row || []);
  // QuickBooks omits zero-balance accounts from an empty or sparse Trial
  // Balance report. Keep the chart identities in the snapshot with a proven
  // zero balance so StockChief can distinguish "the sandbox is empty" from
  // "QuickBooks returned no accounts" and can map an account before posting.
  for (const account of chart.values()) {
    if (!account?.Id || reportedAccountIds.has(String(account.Id)) || account.Active === false) continue;
    rows.push({ externalId: String(account.Id), code: account.AcctNum || null,
      name: account.Name || 'Unnamed account', version: account.SyncToken || String(response.body.Header?.Time || asOf),
      accountType: account.AccountType || null, accountSubType: account.AccountSubType || null,
      classification: account.Classification || null,
      balanceMinor: 0 });
  }
  return { asOf, currency: response.body.Header?.Currency || 'USD',
    version: String(response.body.Header?.Time || asOf), accounts: rows };
}

async function postJournalEntry({ credentials, entry, idempotencyKey }) {
  const body = { TxnDate: entry.posting_date, PrivateNote: `StockChief journal ${entry.entry_number}: ${entry.description}`,
    Line: entry.lines.map((line) => ({ Amount: Number(line.debit_minor || line.credit_minor) / 100,
      Description: line.memo || entry.description, DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: line.debit_minor ? 'Debit' : 'Credit',
        AccountRef: { value: line.external_account_id } } })) };
  // Intuit limits requestid to 50 characters. StockChief's canonical idempotency
  // key includes workspace and journal IDs and is intentionally longer, so use
  // a stable digest rather than truncating (which could create collisions).
  const requestId = `foundry-${crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32)}`;
  const response = await api(credentials, `/v3/company/${encodeURIComponent(credentials.realmId)}/journalentry?requestid=${encodeURIComponent(requestId)}&minorversion=75`,
    { method: 'POST', body: JSON.stringify(body) });
  const created = response.body.JournalEntry;
  return { externalId: created?.Id, version: created?.SyncToken };
}

module.exports = { integrationClass: 'accounting', metadata, authorizationUrl, exchangeAuthorization,
  refresh, refreshCredentials, verifyReadOnly, readAccountingSnapshot, postJournalEntry };

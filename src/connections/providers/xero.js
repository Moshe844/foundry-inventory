'use strict';

const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { jsonRequest } = require('./common');

const READ_SCOPES = ['openid','offline_access','accounting.settings.read','accounting.reports.read'];
const WRITE_SCOPES = [...READ_SCOPES, 'accounting.transactions'];
const basic = () => Buffer.from(`${config.connections.xero.clientId}:${config.connections.xero.clientSecret}`).toString('base64');

function metadata() {
  return { type: 'xero', name: 'Xero', mark: 'X', category: 'accounting', authMode: 'oauth',
    integrationClass: 'accounting', available: config.connections.xero.configured,
    description: 'Verify the organization and prove shadow parity before Foundry can request posting authority.',
    provides: ['organization identity', 'chart of accounts', 'trial-balance comparison', 'governed journal posting'],
    unavailableReason: config.connections.xero.configured ? null : 'Xero app credentials have not been configured on this installation.',
    minimumScopes: READ_SCOPES,
  };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.xero.configured) throw new ValidationError('Xero is not configured on this Foundry installation.');
  const url = new URL('https://login.xero.com/identity/connect/authorize');
  url.searchParams.set('client_id', config.connections.xero.clientId); url.searchParams.set('response_type', 'code');
  const requestedPosting = input.requestedAuthority === 'POST';
  url.searchParams.set('scope', (requestedPosting ? WRITE_SCOPES : READ_SCOPES).join(' ')); url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', state); return { url: url.toString(), metadata: { redirectUri: input.redirectUri, requestedPosting } };
}

async function exchangeAuthorization({ query, metadata: state }) {
  if (query.error) throw new ValidationError(query.error_description || 'Xero authorization was not completed.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: state.redirectUri });
  const token = await jsonRequest('https://identity.xero.com/connect/token', { method: 'POST', headers: {
    authorization: `Basic ${basic()}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  const credentials = { accessToken: token.body.access_token, refreshToken: token.body.refresh_token,
    expiresAt: new Date(Date.now() + Number(token.body.expires_in || 1800) * 1000).toISOString() };
  const tenants = await jsonRequest('https://api.xero.com/connections', { headers: { authorization: `Bearer ${credentials.accessToken}`, accept: 'application/json' } });
  if ((tenants.body || []).length !== 1) throw new ValidationError('Choose one Xero organization for this connection.');
  credentials.tenantId = tenants.body[0].tenantId;
  const fact = await verifyReadOnly({ credentials });
  return { credentials, accountId: credentials.tenantId, accountName: fact.value, verifiedFact: fact,
    capabilities: ['accounting:read','accounting:shadow', ...(state.requestedPosting ? ['accounting:post'] : [])], expiresAt: credentials.expiresAt };
}

async function refresh(credentials) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
  const token = await jsonRequest('https://identity.xero.com/connect/token', { method: 'POST', headers: {
    authorization: `Basic ${basic()}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  return { ...credentials, accessToken: token.body.access_token, refreshToken: token.body.refresh_token,
    expiresAt: new Date(Date.now() + Number(token.body.expires_in || 1800) * 1000).toISOString() };
}

async function refreshCredentials(credentials) {
  if (credentials.expiresAt && Date.parse(credentials.expiresAt) > Date.now() + 5 * 60_000) {
    return { credentials, refreshed: false, expiresAt: credentials.expiresAt };
  }
  const next = await refresh(credentials);
  return { credentials: next, refreshed: true, expiresAt: next.expiresAt };
}

async function api(credentials, path) {
  return jsonRequest(`https://api.xero.com/api.xro/2.0${path}`, { headers: { authorization: `Bearer ${credentials.accessToken}`,
    'xero-tenant-id': credentials.tenantId, accept: 'application/json' } });
}

async function verifyReadOnly({ credentials }) {
  const response = await api(credentials, '/Organisation'); const org = response.body.Organisations?.[0];
  if (!org?.Name) throw new ValidationError('Xero did not return an organization identity.');
  return { label: 'Xero organization', value: org.Name, externalId: org.OrganisationID };
}

async function readAccountingSnapshot({ credentials, asOf }) {
  const [chart, trial] = await Promise.all([api(credentials, '/Accounts'), api(credentials, `/Reports/TrialBalance?date=${encodeURIComponent(asOf)}`)]);
  const values = new Map();
  for (const section of trial.body.Reports?.[0]?.Rows || []) for (const row of section.Rows || []) {
    if (row.RowType !== 'Row') continue; const cells = row.Cells || []; const code = cells[0]?.Attributes?.find((a) => a.Id === 'account')?.Value;
    if (code) values.set(code, Math.round(Number(cells.at(-1)?.Value || 0) * 100));
  }
  return { asOf, currency: trial.body.Reports?.[0]?.ReportTitles?.at(-1)?.split(' ').at(-1) || 'USD', version: asOf,
    accounts: (chart.body.Accounts || []).filter((row) => row.Status === 'ACTIVE').map((row) => ({ externalId: row.AccountID,
      code: row.Code || null, name: row.Name, version: row.UpdatedDateUTC || null, balanceMinor: values.get(row.AccountID) || 0 })) };
}

async function postJournalEntry({ credentials, entry, idempotencyKey }) {
  const response = await jsonRequest('https://api.xero.com/api.xro/2.0/ManualJournals', { method: 'POST', headers: {
    authorization: `Bearer ${credentials.accessToken}`, 'xero-tenant-id': credentials.tenantId,
    accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ ManualJournals: [{ Narration: `Foundry journal ${entry.entry_number}: ${entry.description}`,
      Date: entry.posting_date, JournalLines: entry.lines.map((line) => ({ AccountCode: line.account_code,
        Description: line.memo || entry.description,
        LineAmount: Number(line.debit_minor ? line.debit_minor : -line.credit_minor) / 100 })) }] }) });
  const created = response.body.ManualJournals?.[0];
  return { externalId: created?.ManualJournalID, version: created?.UpdatedDateUTC };
}

module.exports = { integrationClass: 'accounting', metadata, authorizationUrl, exchangeAuthorization,
  refresh, refreshCredentials, verifyReadOnly, readAccountingSnapshot, postJournalEntry };

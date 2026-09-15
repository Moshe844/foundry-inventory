'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const quickbooks = require('../../src/connections/providers/quickbooks');
const xero = require('../../src/connections/providers/xero');

const originalFetch = global.fetch;
const originalEnv = { ...process.env };
test.afterEach(() => { global.fetch = originalFetch; process.env = { ...originalEnv }; });

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('QuickBooks sandbox contract verifies identity, reads a dated trial balance, and posts idempotently', async () => {
  process.env.QUICKBOOKS_CLIENT_ID = 'qb-client'; process.env.QUICKBOOKS_CLIENT_SECRET = 'qb-secret';
  process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox'; const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/tokens/bearer')) return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    if (String(url).includes('/companyinfo/')) return json({ CompanyInfo: { Id: 'realm-1', CompanyName: 'QB Sandbox Company' } });
    if (String(url).includes('/reports/TrialBalance')) return json({ Header: { Currency: 'USD', Time: '2026-09-10T12:00:00Z' },
      Columns: { Column: [{ ColTitle: 'Account' }, { ColTitle: 'Debit' }, { ColTitle: 'Credit' }] },
      // QuickBooks' live sandbox response omits `type: Data` on these rows.
      Rows: { Row: [{ ColData: [{ id: '10', value: 'Cash' }, { value: '12.34' }, { value: '' }] }] } });
    if (String(url).includes('/query?')) return json({ QueryResponse: { Account: [{ Id: '10', AcctNum: '1000', Name: 'Cash', SyncToken: '4' }] } });
    if (String(url).includes('/journalentry?')) return json({ JournalEntry: { Id: 'je-9', SyncToken: '0' } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const auth = quickbooks.authorizationUrl({ state: 'state', input: { redirectUri: 'https://foundry.example/callback' } });
  assert.match(auth.url, /com.intuit.quickbooks.accounting/);
  const connected = await quickbooks.exchangeAuthorization({ query: { code: 'code', realmId: 'realm-1' }, metadata: auth.metadata });
  assert.equal(connected.verifiedFact.value, 'QB Sandbox Company'); assert.ok(connected.capabilities.includes('accounting:post'));
  const snapshot = await quickbooks.readAccountingSnapshot({ credentials: connected.credentials, asOf: '2026-09-10' });
  assert.deepEqual(snapshot.accounts[0], { externalId: '10', code: '1000', name: 'Cash', version: '4',
    accountType: null, accountSubType: null, classification: null, balanceMinor: 1234 });
  const posted = await quickbooks.postJournalEntry({ credentials: connected.credentials, idempotencyKey: 'foundry-entry-9',
    entry: { entry_number: 9, posting_date: '2026-09-10', description: 'Test', lines: [
      { debit_minor: 1234, credit_minor: 0, external_account_id: '10' },
      { debit_minor: 0, credit_minor: 1234, external_account_id: '20' }] } });
  assert.equal(posted.externalId, 'je-9');
  const postingCall = calls.find((call) => call.url.includes('/journalentry?'));
  const requestId = new URL(postingCall.url).searchParams.get('requestid');
  assert.match(requestId, /^foundry-[a-f0-9]{32}$/);
  assert.ok(requestId.length <= 50);
});

test('QuickBooks keeps zero-balance chart accounts when the Trial Balance omits them', async () => {
  process.env.QUICKBOOKS_CLIENT_ID = 'qb-client'; process.env.QUICKBOOKS_CLIENT_SECRET = 'qb-secret';
  process.env.QUICKBOOKS_ENVIRONMENT = 'sandbox';
  global.fetch = async (url) => {
    if (String(url).includes('/reports/TrialBalance')) return json({ Header: { Currency: 'USD', Time: '2026-09-15T12:00:00Z' },
      Columns: { Column: [{ ColTitle: 'Account' }, { ColTitle: 'Debit' }, { ColTitle: 'Credit' }] }, Rows: { Row: [] } });
    if (String(url).includes('/query?')) return json({ QueryResponse: { Account: [
      { Id: '10', AcctNum: '1000', Name: 'Cash', SyncToken: '4', Active: true },
      { Id: '20', AcctNum: '2000', Name: 'Payables', SyncToken: '2', Active: true },
    ] } });
    throw new Error(`Unexpected URL ${url}`);
  };
  const snapshot = await quickbooks.readAccountingSnapshot({ credentials: { accessToken: 'access', realmId: 'realm-1' }, asOf: '2026-09-15' });
  assert.deepEqual(snapshot.accounts, [
    { externalId: '10', code: '1000', name: 'Cash', version: '4', accountType: null,
      accountSubType: null, classification: null, balanceMinor: 0 },
    { externalId: '20', code: '2000', name: 'Payables', version: '2', accountType: null,
      accountSubType: null, classification: null, balanceMinor: 0 },
  ]);
});

test('Xero requests read-only scopes by default and write scope only when explicitly requested', async () => {
  process.env.XERO_CLIENT_ID = 'xero-client'; process.env.XERO_CLIENT_SECRET = 'xero-secret'; const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/connect/token')) return json({ access_token: 'access', refresh_token: 'refresh', expires_in: 1800 });
    if (String(url) === 'https://api.xero.com/connections') return json([{ tenantId: 'tenant-1' }]);
    if (String(url).endsWith('/Organisation')) return json({ Organisations: [{ OrganisationID: 'tenant-1', Name: 'Xero Sandbox Company' }] });
    if (String(url).endsWith('/Accounts')) return json({ Accounts: [{ AccountID: 'a-1', Code: '1000', Name: 'Cash', Status: 'ACTIVE' }] });
    if (String(url).includes('/Reports/TrialBalance')) return json({ Reports: [{ ReportTitles: ['Trial Balance', 'USD'], Rows: [
      { Rows: [{ RowType: 'Row', Cells: [{ Attributes: [{ Id: 'account', Value: 'a-1' }] }, { Value: '42.00' }] }] }]}] });
    if (String(url).endsWith('/ManualJournals')) return json({ ManualJournals: [{ ManualJournalID: 'mj-1', UpdatedDateUTC: 'v1' }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const read = xero.authorizationUrl({ state: 'read', input: { redirectUri: 'https://foundry.example/callback' } });
  assert.match(new URL(read.url).searchParams.get('scope'), /accounting\.reports\.trialbalance\.read/);
  assert.doesNotMatch(new URL(read.url).searchParams.get('scope'), /accounting\.manualjournals(?:\s|$)/);
  const write = xero.authorizationUrl({ state: 'write', input: { redirectUri: 'https://foundry.example/callback', requestedAuthority: 'POST' } });
  assert.match(new URL(write.url).searchParams.get('scope'), /accounting\.manualjournals/);
  const connected = await xero.exchangeAuthorization({ query: { code: 'code' }, metadata: write.metadata });
  assert.equal(connected.verifiedFact.value, 'Xero Sandbox Company'); assert.ok(connected.capabilities.includes('accounting:post'));
  const snapshot = await xero.readAccountingSnapshot({ credentials: connected.credentials, asOf: '2026-09-10' });
  assert.equal(snapshot.accounts[0].balanceMinor, 4200); assert.equal(snapshot.accounts[0].code, '1000');
  const posted = await xero.postJournalEntry({ credentials: connected.credentials, idempotencyKey: 'foundry-xero-1',
    entry: { entry_number: 1, posting_date: '2026-09-10', description: 'Test', lines: [
      { debit_minor: 4200, credit_minor: 0, account_code: '1000' },
      { debit_minor: 0, credit_minor: 4200, account_code: '2000' }] } });
  assert.equal(posted.externalId, 'mj-1');
  assert.equal(calls.find((call) => call.url.endsWith('/ManualJournals')).options.headers['idempotency-key'], 'foundry-xero-1');
});

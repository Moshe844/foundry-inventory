'use strict';

const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { jsonRequest } = require('./common');
const money=require('../../domain/currency'),crypto=require('node:crypto');

// Xero assigns granular Accounting API scopes to Web apps created from March 2026.
// StockChief only reads the organisation, chart of accounts and trial balance during
// shadow reconciliation; posting authority only needs Manual Journals.
const READ_SCOPES = ['openid','offline_access','accounting.settings.read','accounting.reports.trialbalance.read','accounting.invoices.read'];
const WRITE_SCOPES = [...READ_SCOPES, 'accounting.manualjournals'];
const basic = () => Buffer.from(`${config.connections.xero.clientId}:${config.connections.xero.clientSecret}`).toString('base64');

function metadata() {
  return { type: 'xero', name: 'Xero', mark: 'X', category: 'accounting', authMode: 'oauth',
    integrationClass: 'accounting', available: config.connections.xero.configured,
    description: 'StockChief reads your books first and shows you where they agree. It only posts entries after they match and you say so.',
    provides: ['organization identity', 'chart of accounts', 'trial-balance comparison', 'governed journal posting'],
    unavailableReason: config.connections.xero.configured ? null : 'Xero app credentials have not been configured on this installation.',
    minimumScopes: READ_SCOPES,
  };
}

function authorizationUrl({ state, input }) {
  if (!config.connections.xero.configured) throw new ValidationError('Xero is not configured on this StockChief installation.');
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

async function discover({credentials}){
 const [organization,response]=await Promise.all([api(credentials,'/Organisation'),api(credentials,'/Items')]);
 const org=organization.body.Organisations?.[0];if(!org?.Name)throw new ValidationError('Xero did not identify the organization for inventory discovery.');
 const currency=money.code(org.BaseCurrency),catalog=require('../accounting-catalog'),locationId=String(credentials.tenantId);
 if(!Array.isArray(response.body.Items))throw new ValidationError('Xero did not return an inventory catalogue.');
 return {products:response.body.Items.map(row=>catalog.product({id:row.ItemID,code:row.Code,name:row.Name||row.Description,currency,price:row.SalesDetails?.UnitPrice,tracked:row.IsTrackedAsInventory===true,quantity:row.QuantityOnHand,locationId})),locations:[catalog.location(locationId,org.Name)]};
}

async function readAccountingSnapshot({ credentials, asOf }) {
  const [chart, trial, organization] = await Promise.all([api(credentials, '/Accounts'), api(credentials, `/Reports/TrialBalance?date=${encodeURIComponent(asOf)}`),api(credentials,'/Organisation')]);
  const currency=money.code(organization.body.Organisations?.[0]?.BaseCurrency),values=trialBalances(trial.body.Reports?.[0],currency);
  return { asOf, currency, version: asOf,
    accounts: (chart.body.Accounts || []).filter((row) => row.Status === 'ACTIVE').map((row) => ({ externalId: row.AccountID,
      code: row.Code || null, name: row.Name, version: row.UpdatedDateUTC || null,
      accountType: row.Type || null, accountSubType: row.Class || null, classification: row.Class || null,
      balanceMinor: values.get(row.AccountID) || 0 })) };
}

function trialBalances(report,currency){
 const flattened=[];const walk=rows=>{for(const row of rows||[]){flattened.push(row);walk(row.Rows);}};walk(report?.Rows);
 const header=flattened.find(row=>row.RowType==='Header');
 if(!header)throw new ValidationError('Xero did not return labelled trial-balance columns.');
 const labels=(header.Cells||[]).map(cell=>String(cell.Value||'').toLowerCase().replace(/\s+/g,' ').trim());
 const select=kind=>{const ytd=labels.findIndex(label=>label==='ytd '+kind);return ytd>=0?ytd:labels.indexOf(kind);},debit=select('debit'),credit=select('credit');
 if(debit<0||credit<0)throw new ValidationError('Xero did not return identifiable debit and credit columns.');
 const values=new Map();for(const row of flattened.filter(row=>row.RowType==='Row')){
  const cells=row.Cells||[],id=cells[0]?.Attributes?.find(attr=>attr.Id==='account')?.Value;
  const balance=money.sum([money.toMinor(cells[debit]?.Value||'0',currency),-money.toMinor(cells[credit]?.Value||'0',currency)]);
  if(!id){if(balance!==0)throw new ValidationError('Xero returned a balance without a stable accounting account.');continue;}
  if(values.has(String(id)))throw new ValidationError('Xero returned the same accounting balance twice.');values.set(String(id),balance);
 }
 return values;
}

async function postJournalEntry({ credentials, entry, idempotencyKey }) {
  if(entry.lines.some(line=>line.external_customer_id||line.external_supplier_id))throw new ValidationError('Xero manual journals cannot represent customer or supplier subledger documents. This entry requires a supported document workflow.');
  const org=(await api(credentials,'/Organisation')).body.Organisations?.[0];
  if(money.code(org?.BaseCurrency)!==money.code(entry.currency))throw new ValidationError('Xero manual journals must use the organization base currency.');
  const response = await jsonRequest('https://api.xero.com/api.xro/2.0/ManualJournals', { method: 'POST', headers: {
    authorization: `Bearer ${credentials.accessToken}`, 'xero-tenant-id': credentials.tenantId,
    accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex') },
    body: JSON.stringify({ ManualJournals: [{ Narration: `StockChief journal ${entry.entry_number}: ${entry.description}`,
      Date: entry.posting_date,Status:'POSTED',LineAmountTypes:'NoTax', JournalLines: entry.lines.map((line) => ({ AccountCode: line.account_code,TaxType:'NONE',
        Description: line.memo || entry.description,
        LineAmount: exactDecimal(line.debit_minor ? line.debit_minor : -line.credit_minor,entry.currency) })) }] }) });
  const created = response.body.ManualJournals?.[0];
  if(created?.HasErrors||created?.ValidationErrors?.length)throw new ValidationError('Xero did not accept the complete accounting journal.');
  return { externalId: created?.ManualJournalID, version: created?.UpdatedDateUTC };
}

function exactDecimal(minor,currency){const value=Number(money.fromMinor(minor,currency));if(money.toMinor(String(value),currency,{signed:true})!==Number(minor))throw new ValidationError('The accounting amount cannot be represented exactly by Xero.');return value;}
function journalDate(value){const unix=String(value||'').match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);const date=unix?new Date(Number(unix[1])):new Date(value);if(!Number.isFinite(date.getTime()))throw new ValidationError('Xero returned an invalid journal date.');return date.toISOString().slice(0,10);}
function verifyJournalPayload(entry,remote,homeCurrency){
 if(money.code(homeCurrency)!==money.code(entry.currency)||journalDate(remote.Date)!==entry.posting_date||remote.Status!=='POSTED')throw new ValidationError('Xero journal status, date or currency does not match the posted canonical journal.');
 const expected=entry.lines.map(line=>JSON.stringify({account:String(line.external_account_id),amount:money.integer(line.debit_minor||-line.credit_minor,'Amount',{signed:true})})).sort();
 const actual=(remote.JournalLines||[]).map(line=>{if(Number(line.TaxAmount||0)!==0)throw new ValidationError('Xero added an unapproved tax amount to the journal.');return JSON.stringify({account:String(line.AccountID||''),amount:money.toMinor(String(line.LineAmount),homeCurrency,{signed:true})});}).sort();
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw new ValidationError('Xero journal lines, exact amounts or posting accounts do not match the canonical journal.');
 return {verified:true,currency:money.code(homeCurrency),lineCount:actual.length};
}
async function verifyJournalEntry({credentials,entry,externalId}){
 if(!externalId)throw new ValidationError('Xero journal verification requires a provider identity.');
 const [organization,response]=await Promise.all([api(credentials,'/Organisation'),api(credentials,'/ManualJournals/'+encodeURIComponent(externalId))]),remote=response.body.ManualJournals?.[0];
 if(!remote||String(remote.ManualJournalID)!==String(externalId))throw new ValidationError('Xero did not return the recorded journal identity.');
 return {...verifyJournalPayload(entry,remote,organization.body.Organisations?.[0]?.BaseCurrency),externalId:String(externalId),version:remote.UpdatedDateUTC};
}

module.exports = { integrationClass: 'accounting',catalogueCapabilities:Object.freeze(['products','skus','stock','locations']),discover, metadata, authorizationUrl, exchangeAuthorization,
  refresh, refreshCredentials, verifyReadOnly, readAccountingSnapshot, postJournalEntry,verifyJournalEntry,verifyJournalPayload,exactDecimal,trialBalances };

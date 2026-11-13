'use strict';

const crypto = require('node:crypto');
const config = require('../../config');
const { ValidationError } = require('../../domain/errors');
const { jsonRequest } = require('./common');
const money=require('../../domain/currency');

const SCOPES = ['com.intuit.quickbooks.accounting'];
const base = () => config.connections.quickbooks.environment === 'production'
  ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com';
const basic = () => Buffer.from(`${config.connections.quickbooks.clientId}:${config.connections.quickbooks.clientSecret}`).toString('base64');

function metadata() {
  return { type: 'quickbooks', name: 'QuickBooks Online', mark: 'QB', category: 'accounting', authMode: 'oauth',
    integrationClass: 'accounting', available: config.connections.quickbooks.configured,
    environment: config.connections.quickbooks.environment,
    description: 'StockChief reads your books first and shows you where they agree. It only posts entries after they match and you say so.',
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
  // CompanyInfo.Id identifies this resource inside the company (commonly 1).
  // The OAuth realm identifies the connected accounting company.
  return { label: 'QuickBooks company', value: company.CompanyName, externalId: credentials.realmId };
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
  const chartRows=[...(chartResponse.body.QueryResponse?.Account||[])];
  if(chartRows.length===1000)chartRows.push(...await entities(credentials,'Account',1001));
  const chart = new Map(chartRows.map((row) => [String(row.Id), row]));
  const currency=money.code(response.body.Header?.Currency);
  const columns = response.body.Columns?.Column || [];
  const debitIndex = columns.findIndex((column) => /debit/i.test(column.ColTitle || ''));
  const creditIndex = columns.findIndex((column) => /credit/i.test(column.ColTitle || ''));
  if(debitIndex<0||creditIndex<0)throw new ValidationError('QuickBooks did not return the required trial-balance debit and credit columns.');
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
        balanceMinor:money.sum([money.toMinor(row.ColData[debitIndex]?.value||'0',currency,{signed:true}),-money.toMinor(row.ColData[creditIndex]?.value||'0',currency,{signed:true})]) });
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
  return { asOf, currency,
    version: String(response.body.Header?.Time || asOf), accounts: rows };
}
async function entities(credentials,entity,start=1,onRow){
 if(!['Account','Customer','Vendor','Item'].includes(entity))throw new ValidationError('Unsupported accounting identity type.');
 const result=[];for(let position=start;;position+=1000){
  const query=encodeURIComponent('select * from '+entity+' startposition '+position+' maxresults 1000');
  const response=await api(credentials,'/v3/company/'+encodeURIComponent(credentials.realmId)+'/query?query='+query+'&minorversion=75');
  const rows=response.body.QueryResponse?.[entity]||[];if(onRow){for(const row of rows)onRow(row);}else result.push(...rows);if(rows.length<1000)return result;
 }
}

async function listPostingParties({ credentials, partyType }) {
  const entity = partyType === 'customer' ? 'Customer' : partyType === 'supplier' ? 'Vendor' : null;
  if (!entity) throw new ValidationError('QuickBooks can list customers or suppliers for posting.');
  return (await entities(credentials,entity)).filter((row) => row.Active !== false).map((row) => ({
    externalId: String(row.Id), version: row.SyncToken == null ? null : String(row.SyncToken),
    name: row.DisplayName || row.CompanyName || row.GivenName || `${entity} ${row.Id}`,
    company: row.CompanyName || null, email: row.PrimaryEmailAddr?.Address || null,
  }));
}

async function discover({credentials,onProduct}){
 const company=(await api(credentials,`/v3/company/${encodeURIComponent(credentials.realmId)}/companyinfo/${encodeURIComponent(credentials.realmId)}?minorversion=75`)).body.CompanyInfo;
 if(!company?.CompanyName)throw new ValidationError('QuickBooks did not identify the company for inventory discovery.');
 const preferences=(await api(credentials,`/v3/company/${encodeURIComponent(credentials.realmId)}/preferences?minorversion=75`)).body.Preferences;
 const currency=money.code(preferences?.CurrencyPrefs?.HomeCurrency?.value),locationId=String(credentials.realmId),catalog=require('../accounting-catalog');
 const products=[];await entities(credentials,'Item',1,row=>{if(row.Active===false||!['Inventory','NonInventory'].includes(row.Type))return;
  const record=catalog.product({id:row.Id,code:row.Sku,name:row.Name,currency,price:row.UnitPrice,tracked:row.Type==='Inventory'&&row.TrackQtyOnHand===true,quantity:row.QtyOnHand,locationId});if(onProduct)onProduct(record);else products.push(record);});
 return {products,locations:[catalog.location(locationId,company.CompanyName)]};
}

async function createPostingParty({ credentials, partyType, party, idempotencyKey }) {
  const entity = partyType === 'customer' ? 'customer' : partyType === 'supplier' ? 'vendor' : null;
  if (!entity) throw new ValidationError('QuickBooks can create a customer or supplier posting identity.');
  const body = { DisplayName: party.name, ...(party.company ? { CompanyName: party.company } : {}),
    ...(party.email ? { PrimaryEmailAddr: { Address: party.email } } : {}) };
  const requestId = `foundry-${crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32)}`;
  const response = await api(credentials,
    `/v3/company/${encodeURIComponent(credentials.realmId)}/${entity}?requestid=${encodeURIComponent(requestId)}&minorversion=75`,
    { method: 'POST', body: JSON.stringify(body) });
  const created = response.body[entity === 'customer' ? 'Customer' : 'Vendor'];
  if (!created?.Id) throw new ValidationError(`QuickBooks did not confirm the new ${partyType} identity.`);
  return { externalId: String(created.Id), version: created.SyncToken == null ? null : String(created.SyncToken),
    name: created.DisplayName || party.name, company: created.CompanyName || party.company || null,
    email: created.PrimaryEmailAddr?.Address || party.email || null };
}

async function postJournalEntry({ credentials, entry, idempotencyKey }) {
  const body = { TxnDate: entry.posting_date,CurrencyRef:{value:money.code(entry.currency)}, PrivateNote: `StockChief journal ${entry.entry_number}: ${entry.description}`,
    Line: entry.lines.map((line) => ({ Amount: exactDecimal(line.debit_minor || line.credit_minor,entry.currency),
      Description: line.memo || entry.description, DetailType: 'JournalEntryLineDetail',
      JournalEntryLineDetail: { PostingType: line.debit_minor ? 'Debit' : 'Credit',
        AccountRef: { value: line.external_account_id },
        ...(line.external_customer_id ? { Entity: { Type: 'Customer', EntityRef: { value: line.external_customer_id } } } : {}),
        ...(line.external_supplier_id ? { Entity: { Type: 'Vendor', EntityRef: { value: line.external_supplier_id } } } : {}),
      } })) };
  // Intuit limits requestid to 50 characters. StockChief's canonical idempotency
  // key includes workspace and journal IDs and is intentionally longer, so use
  // a stable digest rather than truncating (which could create collisions).
  const requestId = `foundry-${crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32)}`;
  const response = await api(credentials, `/v3/company/${encodeURIComponent(credentials.realmId)}/journalentry?requestid=${encodeURIComponent(requestId)}&minorversion=75`,
    { method: 'POST', body: JSON.stringify(body) });
  const created = response.body.JournalEntry;
  return { externalId: created?.Id, version: created?.SyncToken };
}
function exactDecimal(minor,currency){const value=Number(money.fromMinor(minor,currency));if(money.toMinor(String(value),currency)!==Number(minor))throw new ValidationError('The accounting amount cannot be represented exactly by this provider.');return value;}
function verifyJournalPayload(entry,remote,homeCurrency){
 const currency=money.code(remote.CurrencyRef?.value||homeCurrency);
 if(currency!==money.code(entry.currency)||remote.TxnDate!==entry.posting_date)throw new ValidationError('QuickBooks returned a different journal date or currency.');
 if((remote.Line||[]).some(l=>l.DetailType!=='JournalEntryLineDetail'))throw new ValidationError('QuickBooks returned an unsupported additional journal line.');
 const expected=entry.lines.map(l=>({account:String(l.external_account_id),posting:l.debit_minor?'Debit':'Credit',amount:money.integer(l.debit_minor||l.credit_minor),entity:l.external_customer_id?'Customer:'+l.external_customer_id:l.external_supplier_id?'Vendor:'+l.external_supplier_id:null}));
 const actual=(remote.Line||[]).filter(l=>l.DetailType==='JournalEntryLineDetail').map(l=>{const d=l.JournalEntryLineDetail||{};return {account:String(d.AccountRef?.value||''),posting:d.PostingType,amount:money.toMinor(l.Amount,currency),entity:d.Entity?d.Entity.Type+':'+d.Entity.EntityRef?.value:null};});
 const sorted=rows=>rows.map(r=>JSON.stringify(r)).sort();
 if(JSON.stringify(sorted(actual))!==JSON.stringify(sorted(expected)))throw new ValidationError('QuickBooks journal amounts, posting accounts or party identities do not match the canonical journal.');
 return {verified:true,currency,lineCount:actual.length};
}
async function verifyJournalEntry({credentials,entry,externalId}){
 if(!externalId)throw new ValidationError('A verified accounting journal requires its provider identity.');
 const base='/v3/company/'+encodeURIComponent(credentials.realmId),remote=(await api(credentials,base+'/journalentry/'+encodeURIComponent(externalId)+'?minorversion=75')).body.JournalEntry;
 if(!remote||String(remote.Id)!==String(externalId))throw new ValidationError('QuickBooks did not confirm the journal identity.');
 let homeCurrency;if(!remote.CurrencyRef?.value)homeCurrency=(await api(credentials,base+'/reports/TrialBalance?end_date='+encodeURIComponent(entry.posting_date)+'&minorversion=75')).body.Header?.Currency;
 return {...verifyJournalPayload(entry,remote,homeCurrency),externalId:String(remote.Id),version:remote.SyncToken};
}

// Job 184: customer invoices and supplier bills as QuickBooks invoices and
// bills. The document carries StockChief's exact amounts per line, the mapped
// tax code and the stated total tax; read-back must match all of them.
const documentEntity=d=>d.kind==='invoice'?'Invoice':'Bill';
function documentBody(d){
 if(String(d.number).length>21)throw new ValidationError('QuickBooks document numbers are at most 21 characters.');
 const base={DocNumber:d.number,TxnDate:d.issueDate,...(d.dueDate?{DueDate:d.dueDate}:{}),CurrencyRef:{value:money.code(d.currency)},PrivateNote:d.reference,
  TxnTaxDetail:{TotalTax:exactDecimal(d.tax,d.currency)}};
 if(d.kind==='invoice')return {...base,CustomerRef:{value:d.contactExternalId},Line:d.lines.map(l=>({Amount:exactDecimal(l.amount,d.currency),Description:l.description,
  DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:l.itemExternalId},Qty:1,UnitPrice:exactDecimal(l.amount,d.currency),TaxCodeRef:{value:d.taxCode}}}))};
 return {...base,VendorRef:{value:d.contactExternalId},Line:d.lines.map(l=>({Amount:exactDecimal(l.amount,d.currency),Description:l.description,
  DetailType:'AccountBasedExpenseLineDetail',AccountBasedExpenseLineDetail:{AccountRef:{value:l.accountExternalId},TaxCodeRef:{value:d.taxCode}}}))};
}
async function postDocument({credentials,document,idempotencyKey}){
 const requestId=`foundry-${crypto.createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0,32)}`;
 const entity=documentEntity(document);
 const response=await api(credentials,`/v3/company/${encodeURIComponent(credentials.realmId)}/${entity.toLowerCase()}?requestid=${encodeURIComponent(requestId)}&minorversion=75`,
  {method:'POST',body:JSON.stringify(documentBody(document))});
 const created=response.body[entity];
 if(!created?.Id)throw new ValidationError('QuickBooks did not confirm the new '+document.kind+'.');
 return {externalId:String(created.Id),version:created.SyncToken==null?null:String(created.SyncToken)};
}
// Documents with the same number for the same customer or supplier, so a
// retry or a document someone already entered is never posted twice.
async function findDocument({credentials,document}){
 const entity=documentEntity(document),number=String(document.number).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
 const query=encodeURIComponent(`select * from ${entity} where DocNumber = '${number}'`);
 const rows=(await api(credentials,`/v3/company/${encodeURIComponent(credentials.realmId)}/query?query=${query}&minorversion=75`)).body.QueryResponse?.[entity]||[];
 const ref=document.kind==='invoice'?'CustomerRef':'VendorRef';
 const same=rows.filter(r=>String(r[ref]?.value||'')===String(document.contactExternalId));
 if(same.length>1)throw Object.assign(new ValidationError('QuickBooks has more than one '+document.kind+' numbered '+document.number+' for this contact. A person checks them.'),{status:409,definite:true});
 return same[0]?{externalId:String(same[0].Id),version:same[0].SyncToken==null?null:String(same[0].SyncToken),reference:same[0].PrivateNote||null}:null;
}
function verifyDocumentPayload(document,remote){
 const ref=document.kind==='invoice'?'CustomerRef':'VendorRef',currency=money.code(remote.CurrencyRef?.value||document.currency);
 if(String(remote.DocNumber||'')!==String(document.number)||String(remote[ref]?.value||'')!==String(document.contactExternalId)||remote.TxnDate!==document.issueDate||currency!==money.code(document.currency))
  throw new ValidationError('QuickBooks returned a different number, contact, date or currency for this '+document.kind+'.');
 if(money.toMinor(remote.TotalAmt??'0',currency)!==Number(document.total)||money.toMinor(remote.TxnTaxDetail?.TotalTax??'0',currency)!==Number(document.tax))
  throw new ValidationError('QuickBooks shows a different total or tax for this '+document.kind+'.');
 const detail=document.kind==='invoice'?'SalesItemLineDetail':'AccountBasedExpenseLineDetail';
 const lines=(remote.Line||[]).filter(l=>!['SubTotalLineDetail','DescriptionOnly'].includes(l.DetailType));
 if(lines.some(l=>l.DetailType!==detail))throw new ValidationError('QuickBooks added a line StockChief did not send.');
 const key=l=>document.kind==='invoice'?String(l.itemExternalId):String(l.accountExternalId);
 const expected=document.lines.map(l=>JSON.stringify([key(l),Number(l.amount)])).sort();
 const actual=lines.map(l=>JSON.stringify([String(document.kind==='invoice'?l.SalesItemLineDetail?.ItemRef?.value:l.AccountBasedExpenseLineDetail?.AccountRef?.value),money.toMinor(l.Amount,currency)])).sort();
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw new ValidationError('QuickBooks lines do not match the '+document.kind+' StockChief sent.');
 return {verified:true,lineCount:actual.length};
}
async function verifyDocument({credentials,document,externalId}){
 if(!externalId)throw new ValidationError('Checking a document needs its QuickBooks identity.');
 const entity=documentEntity(document);
 const remote=(await api(credentials,`/v3/company/${encodeURIComponent(credentials.realmId)}/${entity.toLowerCase()}/${encodeURIComponent(externalId)}?minorversion=75`)).body[entity];
 if(!remote||String(remote.Id)!==String(externalId))throw new ValidationError('QuickBooks did not return the '+document.kind+' it confirmed.');
 return {...verifyDocumentPayload(document,remote),externalId:String(remote.Id),version:remote.SyncToken==null?null:String(remote.SyncToken)};
}

module.exports = { integrationClass: 'accounting',catalogueCapabilities:Object.freeze(['products','skus','stock','locations']),discover, metadata, authorizationUrl, exchangeAuthorization,
  refresh, refreshCredentials, verifyReadOnly, readAccountingSnapshot, listPostingParties, createPostingParty,
  postJournalEntry,verifyJournalEntry,verifyJournalPayload,exactDecimal,postDocument,findDocument,verifyDocument,verifyDocumentPayload };

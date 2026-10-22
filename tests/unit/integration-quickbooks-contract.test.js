'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),qbo=require('../../src/connections/providers/quickbooks');
function fixture(){const entry={posting_date:'2026-10-18',currency:'USD',lines:[{external_account_id:'cash',debit_minor:123,credit_minor:0},{external_account_id:'ar',debit_minor:0,credit_minor:123,external_customer_id:'customer-1'}]},remote={Id:'journal-1',TxnDate:entry.posting_date,CurrencyRef:{value:'USD'},Line:[{DetailType:'JournalEntryLineDetail',Amount:1.23,JournalEntryLineDetail:{AccountRef:{value:'ar'},PostingType:'Credit',Entity:{Type:'Customer',EntityRef:{value:'customer-1'}}}},{DetailType:'JournalEntryLineDetail',Amount:1.23,JournalEntryLineDetail:{AccountRef:{value:'cash'},PostingType:'Debit'}}]};return {entry,remote};}

test('QuickBooks connection identity is the authorized realm, not the company-info resource ID',async t=>{
 const original=global.fetch;t.after(()=>{global.fetch=original;});const realm='unfamiliar-sandbox-company';global.fetch=async value=>{assert.match(new URL(value).pathname,new RegExp('/company/'+realm+'/companyinfo/'+realm+'$'));return Response.json({CompanyInfo:{Id:'1',CompanyName:'Offline company'}});};assert.equal((await qbo.verifyReadOnly({credentials:{realmId:realm,accessToken:'FAKE'}})).externalId,realm);
});
test('accounting read-back verifies canonical date, currency, exact money, account and entity as a multiset',()=>{
 const {entry,remote}=fixture();assert.equal(qbo.verifyJournalPayload(entry,remote).verified,true);
 for(const change of [r=>r.TxnDate='2026-10-17',r=>r.CurrencyRef.value='EUR',r=>r.Line[0].Amount=1.24,r=>r.Line[0].JournalEntryLineDetail.AccountRef.value='another-ar',r=>r.Line[0].JournalEntryLineDetail.Entity.EntityRef.value='another-customer',r=>r.Line.push({...r.Line[0]})]){const altered=structuredClone(remote);change(altered);assert.throws(()=>qbo.verifyJournalPayload(entry,altered));}
 const home=structuredClone(remote);delete home.CurrencyRef;assert.throws(()=>qbo.verifyJournalPayload(entry,home));assert.equal(qbo.verifyJournalPayload(entry,home,'USD').verified,true);
 assert.equal(qbo.exactDecimal(123,'JPY'),123);assert.equal(qbo.exactDecimal(1234,'BHD'),1.234);
});
test('accounting snapshot preserves reported currency and fetches the complete chart beyond 1000 identities',async()=>{
 const old=global.fetch,env=process.env.QUICKBOOKS_ENVIRONMENT;process.env.QUICKBOOKS_ENVIRONMENT='sandbox';let count=0,missingCurrency=false;
 global.fetch=async value=>{const url=new URL(value);assert.equal(url.hostname,'sandbox-quickbooks.api.intuit.com');count++;
  if(url.pathname.includes('/reports/'))return Response.json({Header:{...(missingCurrency?{}:{Currency:'BHD'})},Columns:{Column:[{ColTitle:'Account'},{ColTitle:'Debit'},{ColTitle:'Credit'}]},Rows:{Row:[{ColData:[{id:'1001',value:'Last account'},{value:'1.234'},{value:'0'}]}]}});
  const last=url.searchParams.get('query').includes('startposition 1001');return Response.json({QueryResponse:{Account:last?[{Id:'1001',Name:'Last account',Active:true}]:Array.from({length:1000},(_,i)=>({Id:String(i+1),Name:'Account '+i,Active:true}))}});
 };
 try{const result=await qbo.readAccountingSnapshot({credentials:{realmId:'fixture',accessToken:'not-a-real-token'},asOf:'2026-10-18'});assert.equal(result.currency,'BHD');assert.equal(result.accounts.length,1001);assert.equal(result.accounts.find(a=>a.externalId==='1001').balanceMinor,1234);assert.equal(count,3);missingCurrency=true;await assert.rejects(()=>qbo.readAccountingSnapshot({credentials:{realmId:'fixture',accessToken:'not-a-real-token'},asOf:'2026-10-18'}),/currency/);}
 finally{global.fetch=old;if(env===undefined)delete process.env.QUICKBOOKS_ENVIRONMENT;else process.env.QUICKBOOKS_ENVIRONMENT=env;}
});

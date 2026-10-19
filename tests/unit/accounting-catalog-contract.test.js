'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),qbo=require('../../src/connections/providers/quickbooks'),xero=require('../../src/connections/providers/xero');
test('Clover discovery preserves absent and zero prices, authoritative currency and exact stock',async()=>{
 const original=global.fetch,adapter=require('../../src/connections/providers/clover');
 global.fetch=async value=>{const url=new URL(value);if(url.pathname.endsWith('/properties'))return Response.json({defaultCurrency:'CAD'});
  if(!url.pathname.endsWith('/items'))return Response.json({name:'Fixture merchant'});
  return Response.json({elements:[{id:'no-price',name:'Missing price',price:null},{id:'zero',name:'Free item',price:0,itemStock:{quantity:0}},{id:'fractional',name:'Fractional quantity',price:25,itemStock:{quantity:0.5}}]});};
 try{const found=await adapter.discover({credentials:{merchantId:'merchant',environment:'sandbox',accessToken:'fixture'}});assert.equal(found.products[0].providerData.priceMoney,null);assert.deepEqual(found.products[0].providerData.inventoryCounts,[]);assert.deepEqual(found.products[1].providerData.priceMoney,{amount:0,currency:'CAD'});assert.equal(found.products[1].providerData.inventoryCounts[0].quantity,0);assert.match(found.products[2].providerData.inventoryCountUnavailable,/fractional/);}finally{global.fetch=original;}
});
test('accounting catalogues preserve zero prices, exact currency, whole quantities and organization-wide stock scope',async()=>{
 const original=global.fetch;let itemCalls=0;
 global.fetch=async value=>{const url=new URL(value);
  if(url.hostname.includes('intuit')){
   if(url.pathname.includes('/companyinfo/'))return Response.json({CompanyInfo:{CompanyName:'Fixture company'}});
   if(url.pathname.endsWith('/preferences'))return Response.json({Preferences:{CurrencyPrefs:{HomeCurrency:{value:'BHD'}}}});
   itemCalls++;return Response.json({QueryResponse:{Item:[{Id:'stock',Name:'Fixture stock',Sku:'FX-1',Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:0,UnitPrice:0,Active:true},{Id:'fractional',Name:'Needs review',Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:0.5,UnitPrice:'1.234'},{Id:'service',Name:'Service',Type:'Service'},{Id:'archived',Name:'Archived',Type:'Inventory',Active:false}]}});
  }
  if(url.pathname.endsWith('/Organisation'))return Response.json({Organisations:[{Name:'Fixture organization',BaseCurrency:'JPY'}]});
  assert(url.pathname.endsWith('/Items'));return Response.json({Items:[{ItemID:'x-stock',Code:'X-1',Name:'Tracked',IsTrackedAsInventory:true,QuantityOnHand:4,SalesDetails:{UnitPrice:0}},{ItemID:'x-catalog',Code:'X-2',Name:'Catalog only',IsTrackedAsInventory:false,QuantityOnHand:99}]});
 };
 try{const qb=await qbo.discover({credentials:{realmId:'company',accessToken:'fixture'}});assert.equal(qb.products.length,2);assert.deepEqual(qb.products[0].providerData.priceMoney,{amount:0,currency:'BHD'});assert.equal(qb.products[0].providerData.inventoryCounts[0].quantity,0);assert.equal(qb.products[1].providerData.priceMoney.amount,1234);assert.match(require('../../src/connections/catalog-record-policy').exclusion(qb.products[1].providerData),/fractional/);assert.equal(qb.locations[0].providerData.stockGranularity,'organization');assert.equal(itemCalls,1);
 const xr=await xero.discover({credentials:{tenantId:'tenant',accessToken:'fixture'}});assert.deepEqual(xr.products[0].providerData.priceMoney,{amount:0,currency:'JPY'});assert.equal(xr.products[0].providerData.inventoryCounts[0].quantity,4);assert.deepEqual(xr.products[1].providerData.inventoryCounts,[]);assert.equal(xr.locations[0].externalId,'tenant');
 }finally{global.fetch=original;}
});

test('Xero journal verification rejects changed amounts, dates, accounts, status, tax and currency',()=>{
 const entry={currency:'BHD',posting_date:'2026-10-19',lines:[{external_account_id:'asset',debit_minor:1234,credit_minor:0},{external_account_id:'equity',debit_minor:0,credit_minor:1234}]},remote={Status:'POSTED',Date:'/Date(1792368000000+0000)/',JournalLines:[{AccountID:'equity',LineAmount:'-1.234',TaxAmount:0},{AccountID:'asset',LineAmount:'1.234',TaxAmount:0}]};
 remote.Date=entry.posting_date;assert.equal(xero.verifyJournalPayload(entry,remote,'BHD').verified,true);
 for(const mutate of [r=>r.Status='DRAFT',r=>r.Date='2026-10-18',r=>r.JournalLines[0].LineAmount='-1.233',r=>r.JournalLines[0].AccountID='other',r=>r.JournalLines[0].TaxAmount='0.001',r=>r.JournalLines.push({...r.JournalLines[0]})]){const changed=structuredClone(remote);mutate(changed);assert.throws(()=>xero.verifyJournalPayload(entry,changed,'BHD'));}
 assert.throws(()=>xero.verifyJournalPayload(entry,remote,'USD'));assert.equal(xero.exactDecimal(-1234,'BHD'),-1.234);assert.equal(xero.exactDecimal(75,'JPY'),75);
 const ms=Date.parse(entry.posting_date+'T00:00:00Z');assert.equal(xero.verifyJournalPayload(entry,{...remote,Date:'/Date('+ms+'+0000)/'},'BHD').verified,true);
});

test('Xero trial balance uses labelled cumulative debit-minus-credit and organization currency',()=>{
 const row=(id,debit,credit)=>({RowType:'Row',Cells:[{Value:id,Attributes:[{Id:'account',Value:id}]},{Value:'0'},{Value:'0'},{Value:debit},{Value:credit}]}),report={Rows:[{RowType:'Header',Cells:['Account','Debit','Credit','YTD Debit','YTD Credit'].map(Value=>({Value}))},{RowType:'Section',Rows:[row('asset','1.234','0'),row('equity','0','1.234')]}]};
 assert.deepEqual([...xero.trialBalances(report,'BHD')],[['asset',1234],['equity',-1234]]);assert.throws(()=>xero.trialBalances({Rows:[]},'BHD'));const duplicate=structuredClone(report);duplicate.Rows[1].Rows.push(row('asset','1','0'));assert.throws(()=>xero.trialBalances(duplicate,'BHD'),/twice/);
});

test('Xero posting requests an exact posted tax-free journal and verifies it independently',async()=>{
 const original=global.fetch,entry={entry_number:1,description:'Fixture',posting_date:'2026-10-19',currency:'BHD',lines:[{external_account_id:'asset',account_code:'100',debit_minor:1234,credit_minor:0},{external_account_id:'equity',account_code:'300',debit_minor:0,credit_minor:1234}]};let postBody,postCount=0;
 global.fetch=async(value,options={})=>{const url=new URL(value);if(url.pathname.endsWith('/Organisation'))return Response.json({Organisations:[{BaseCurrency:'BHD'}]});if(options.method==='POST'){postCount++;postBody=JSON.parse(options.body);assert.equal(options.headers['idempotency-key'].length,64);return Response.json({ManualJournals:[{ManualJournalID:'journal-1'}]});}return Response.json({ManualJournals:[{ManualJournalID:'journal-1',Status:'POSTED',Date:entry.posting_date,JournalLines:[{AccountID:'asset',LineAmount:1.234},{AccountID:'equity',LineAmount:-1.234}]}]});};
 try{const credentials={tenantId:'tenant',accessToken:'fixture'},posted=await xero.postJournalEntry({credentials,entry,idempotencyKey:'immutable-fixture-key'.repeat(20)});assert.equal(postBody.ManualJournals[0].Status,'POSTED');assert.equal(postBody.ManualJournals[0].LineAmountTypes,'NoTax');assert.equal(postBody.ManualJournals[0].JournalLines[1].LineAmount,-1.234);const verified=await xero.verifyJournalEntry({credentials,entry,externalId:posted.externalId});assert.equal(verified.verified,true);await assert.rejects(xero.postJournalEntry({credentials,entry:{...entry,currency:'USD'},idempotencyKey:'foreign-currency'}),/base currency/);assert.equal(postCount,1);}finally{global.fetch=original;}
});

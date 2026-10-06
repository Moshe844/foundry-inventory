'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {STATUS,rows,assertClosedLaunchSet}=require('../../src/commercial/launch-provider-matrix');
const policy=require('../../src/connections/launch-policy');
const shipping=require('../../src/shipping/postgres-accounts');
const release=require('../../src/commercial/release');

test('every initial connector has one evidence-backed fee disposition',()=>{
 assert.equal(assertClosedLaunchSet(),true);
 const byName=new Map(rows.map(row=>[row.provider,row]));
 for(const name of ['square','woocommerce','gmail','reference_webhook',...shipping.PROVIDERS]){
  assert.equal(byName.get(name)?.launch,true,name);
  assert.ok([STATUS.MERCHANT,STATUS.NO_FEE].includes(byName.get(name).status),name);
 }
 for(const name of Object.keys(policy.EXCLUDED))
  assert.equal(byName.get(name)?.status,STATUS.EXCLUDED,name);
 for(const row of rows)assert.ok(row.evidence.length&&row.scope);
});

test('the only launch shipping providers use workspace keys, not a shared platform key',()=>{
 const source=require('node:fs').readFileSync(require.resolve('../../src/shipping/postgres-accounts'),'utf8');
 assert.match(source,/source:'workspace'/);
 assert.match(source,/credentials\.get\(database,workspaceId,connector\.id,'provider'\)/);
 for(const name of shipping.PROVIDERS)
  assert.equal(rows.find(row=>row.provider===name)?.status,STATUS.MERCHANT);
 assert.equal(rows.find(row=>row.provider==='stockchief_shipping_partner')?.status,STATUS.EXCLUDED);
});

test('an active historical unqualified connector keeps new checkout closed without deleting its data',async()=>{
 const previousCheckout=process.env.STOCKCHIEF_CHECKOUT_ENABLED;
 const previousTax=process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX;
 process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';
 process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX='false';
 try{
  const database={query:async(sql,params)=>{
   if(sql.includes('commercial_release_control'))return {rows:[{checkout_enabled:true,
    economics_approved_at:new Date(),readiness_approved_at:new Date()}]};
   if(sql.includes('commercial_critical_warnings'))return {rows:[]};
   if(sql.includes('workspace_connectors')){
    assert.ok(params[0].includes('quickbooks')&&params[0].includes('xero')&&params[0].includes('stripe'));
    return {rows:[{id:'historical-unqualified-connection'}]};
   }
   throw Error(`Unexpected query: ${sql}`);
  }};
  assert.equal(await release.isOpen(database),false);
 }finally{
  if(previousCheckout===undefined)delete process.env.STOCKCHIEF_CHECKOUT_ENABLED;
  else process.env.STOCKCHIEF_CHECKOUT_ENABLED=previousCheckout;
  if(previousTax===undefined)delete process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX;
  else process.env.STOCKCHIEF_BILLING_AUTOMATIC_TAX=previousTax;
 }
});

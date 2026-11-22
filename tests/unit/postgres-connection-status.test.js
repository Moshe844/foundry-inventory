'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {publicStatus}=require('../../src/connections/postgres-service');

test('PostgreSQL connection status uses the newest successful activity or sync',()=>{
  const now=Date.parse('2026-10-05T21:41:00.000Z');
  const row={status:'connected',provider_type:'gmail',open_issues:0,expected_interval_minutes:5,
    created_at:'2026-10-05T21:20:00.000Z',last_activity_at:'2026-10-05T21:28:00.000Z',
    last_synced_at:'2026-10-05T21:40:00.000Z'};
  assert.equal(publicStatus(row,now),'Connected');
  assert.equal(publicStatus({...row,last_synced_at:'2026-10-05T21:35:00.000Z'},now),'Connected');
  assert.equal(publicStatus({...row,last_synced_at:'2026-10-05T21:30:00.000Z'},now),'Needs attention');
  assert.equal(publicStatus({...row,last_error:'Mailbox access failed.'},now),'Needs attention');
});

test('verified accounting catalogue choices do not turn successful access into an error',()=>{
 const {hydrate}=require('../../src/connections/postgres-service'),cp=require('../../src/web/presentation/connections');
 const now=Date.now(),row={id:'books',provider_type:'xero',status:'connected',setup_status:'AUTHORITY_REQUIRED',accounting_verified:true,
  open_issues:12,catalogue_setup_issues:12,unmapped_skus:11,unmapped_locations:1,created_at:new Date(now).toISOString(),expected_interval_minutes:60};
 const connection=hydrate(row,now);
 assert.equal(connection.publicStatus,'Connected');assert.equal(cp.status(connection),'Connected');
 assert.equal(connection.actionableIssues,0);assert.equal(connection.openIssues,12);assert.equal(connection.catalogueSetupIssues,12);
 assert.equal(cp.matchingSummary(connection),'11 products and 1 location');assert.equal(cp.issue(connection),null);
 const varied=hydrate({...row,provider_type:'quickbooks',open_issues:5,catalogue_setup_issues:5,unmapped_skus:2,unmapped_locations:3},now);
 assert.equal(varied.publicStatus,'Connected');assert.equal(cp.matchingSummary(varied),'2 products and 3 locations');
 for(const changed of [{open_issues:13},{last_error:'Provider read failed.'},{status:'error',setup_status:'REAUTHORIZATION_REQUIRED'},
  {created_at:new Date(now-24*60*60_000).toISOString()},{accounting_verified:false},{provider_type:'clover'}]){
  const broken=hydrate({...row,...changed},now);assert.equal(cp.status(broken),'Error',JSON.stringify(changed));
 }
 assert.doesNotMatch(cp.issue(hydrate({...row,last_error:'Provider read failed.'},now)),/Match your products/);
});

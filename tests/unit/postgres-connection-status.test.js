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

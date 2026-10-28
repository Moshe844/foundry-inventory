'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const registry=require('../../src/reports/postgres-registry');
const reports=require('../../src/reports/postgres-service');
const actor={role:'owner'};

test('every registered field may be selected, reordered and safely renamed',()=>{
  const fields=Object.keys(registry.get('catalogue').fields);
  assert(fields.length>12,'Fixture exercises the former twelve-column limit');
  const selected=[fields[1],fields[0],...fields.slice(2)];
  const config=reports.normalize({dataset:'catalogue',columns:selected,sort:fields[1],
    columnLabels:{[fields[1]]:'Stock code'}},actor);
  assert.deepEqual(config.columns,selected);
  assert.equal(config.columnLabels[fields[1]],'Stock code');
  assert.deepEqual(reports.normalize(config,actor),config);
  assert.throws(()=>reports.normalize({...config,columnLabels:{unregistered:'X'}},actor),/registered report columns/);
  assert.throws(()=>reports.normalize({...config,columnLabels:{[fields[1]]:'X'.repeat(61)}},actor),/too long/);
});

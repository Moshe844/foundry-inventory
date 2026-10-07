'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {destinationById,postgresDestinations}=require('../../src/web/postgres-navigation');
const {RECORDS}=require('../../src/web/postgres-record-destinations');

test('registered page destinations build only server-owned PostgreSQL URLs',()=>{
  assert.deepEqual(destinationById('inventory'),{href:'/inventory',label:'Inventory'});
  assert.deepEqual(destinationById('mail'),{href:'/mail',label:'Business mailbox'});
  assert.deepEqual(destinationById('accounting'),{href:'/money',label:'Money'});
  assert.equal(destinationById('unregistered'),null);
  assert.ok(Object.values(postgresDestinations).every((href)=>href.startsWith('/')&&!href.startsWith('//')));
});

test('record destinations have deterministic URL builders and access contracts',()=>{
  assert.equal(RECORDS.purchase_order.href({id:'po-example'}),'/purchasing/orders/po-example');
  assert.equal(RECORDS.sales_order.href({id:'so-example'}),'/orders/so-example');
  for(const record of Object.values(RECORDS))assert.ok(record.permission);
});

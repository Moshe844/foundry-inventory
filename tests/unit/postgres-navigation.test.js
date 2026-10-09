'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {destinationById,postgresDestinations}=require('../../src/web/postgres-navigation');
const {RECORDS}=require('../../src/web/postgres-record-destinations');
const {registry}=require('../../src/assistant/postgres-capability-registry');
const {explicitPageNavigation}=require('../../src/assistant/postgres-control-plane');

test('registered page destinations build only server-owned PostgreSQL URLs',()=>{
  assert.deepEqual(destinationById('inventory'),{href:'/inventory',label:'Inventory'});
  assert.deepEqual(destinationById('mail'),{href:'/mail',label:'Business mailbox'});
  assert.deepEqual(destinationById('accounting'),{href:'/money',label:'Money'});
  assert.deepEqual(destinationById('customers'),{href:'/customers',label:'Customers'});
  assert.equal(destinationById('unregistered'),null);
  assert.ok(Object.values(postgresDestinations).every((href)=>href.startsWith('/')&&!href.startsWith('//')));
});

test('record destinations have deterministic URL builders and access contracts',()=>{
  assert.equal(RECORDS.purchase_order.href({id:'po-example'}),'/purchasing/orders/po-example');
  assert.equal(RECORDS.sales_order.href({id:'so-example'}),'/orders/so-example');
  for(const record of Object.values(RECORDS))assert.ok(record.permission);
});

test('page commands use registered destinations and never swallow a compound business action',()=>{
  for(const message of ['Open customers tab','Please go to the customer directory page','Can you open clients?'])
    assert.equal(explicitPageNavigation(message,registry)?.name,'navigate.customers',message);
  assert.equal(explicitPageNavigation('Open the sales orders page',registry)?.name,'navigate.sales');
  assert.equal(explicitPageNavigation('Open customers and create a sales order',registry),null);
  assert.equal(explicitPageNavigation('How many customers do I have?',registry),null);
  assert.equal(explicitPageNavigation('List open customer orders with totals',registry),null);
});

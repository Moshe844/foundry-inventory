'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{resolve}=require('../../src/web/presentation/return-navigation');
test('saved records and deleted records return to usable collection pages',()=>{
 assert.deepEqual(resolve('/orders/order_1','/orders/new'),{href:'/orders',label:'Orders'});
 assert.deepEqual(resolve('/purchasing/orders/po_1','/purchasing/orders/new'),{href:'/purchasing/orders',label:'Buy'});
 assert.deepEqual(resolve('/reports','/reports/saved/deleted'),{href:'/',label:'Home'});
 assert.deepEqual(resolve('/sales/customers','/sales/customers/deleted'),{href:'/orders',label:'Orders'});
 assert.deepEqual(resolve('/settings?section=team','/orders?q=valve',{'/orders?q=valve':'Orders'}),{href:'/orders?q=valve',label:'Orders'});
 assert.equal(resolve('/orders?page=2','/orders?page=1'),null);
 assert.equal(resolve('/orders','/made-up'),null);
});

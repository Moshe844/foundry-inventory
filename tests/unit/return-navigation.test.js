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

test('a way back to a menu page uses a name the menu shows, never an older page title',()=>{
 const {menuNamed}=require('../../src/web/presentation/return-navigation');
 assert.deepEqual(resolve('/inventory/overview','/inventory',{'/inventory':'Inventory'}),{href:'/inventory',label:'Stock'});
 assert.deepEqual(resolve('/inventory/overview','/inventory?group=empty',{'/inventory?group=empty':'Inventory'}),{href:'/inventory?group=empty',label:'Stock'});
 assert.deepEqual(resolve('/purchasing/orders/po_1','/purchasing/orders',{'/purchasing/orders':'Purchase orders'}),{href:'/purchasing/orders',label:'Purchase orders'},'a menu name the page already uses stays');
 assert.deepEqual(resolve('/orders/order_1','/inventory/item_1',{'/inventory/item_1':'Glass 1'}),{href:'/inventory/item_1',label:'Glass 1'},'a record keeps its own name');
 assert.deepEqual(menuNamed({href:'/inventory',label:'Inventory'}),{href:'/inventory',label:'Stock'});
 assert.deepEqual(menuNamed({href:'/money',label:'Money'}),{href:'/money',label:'Money'});
 assert.equal(menuNamed(null),null);
});

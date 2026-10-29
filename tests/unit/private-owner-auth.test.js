'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),auth=require('../../src/platform-owner/auth'),{origin,matchesHost}=require('../../src/platform-owner/app');
test('Owner MFA uses RFC 6238 time-based codes and rejects malformed or expired values',()=>{
 const secret=auth.base32(Buffer.from('12345678901234567890'));
 assert.equal(auth.codeAt(secret,1),'287082');
 assert.equal(auth.matchedCounter(secret,'287082',59000),1);
 assert.equal(auth.matchedCounter(secret,'287082',180000),null);
 for(const value of ['','12345','1234567','abcdef',null])assert.equal(auth.matchedCounter(secret,value,59000),null);
});
test('The private console accepts only an exact configured host and HTTPS origin',()=>{
 for(const value of ['http://admin.example.test','https://person:secret@admin.example.test','https://admin.example.test/customer','https://admin.example.test/?next=x'])assert.throws(()=>origin(value));
 const admin=origin('https://admin.stockchiefhq.com');
 assert.equal(matchesHost({get:()=> 'admin.stockchiefhq.com'},admin),true);
 assert.equal(matchesHost({get:()=> 'app.stockchiefhq.com'},admin),false);
 assert.equal(matchesHost({get:()=> 'admin.stockchiefhq.com.attacker.test'},admin),false);
 assert.equal(matchesHost({get:()=> 'qualify.stockchiefhq.com'},admin),false);
});
test('Conversation context links to its scoped records and never mistakes a list or foreign URL for a record',()=>{const record=require('../../src/platform-owner/data').recordContext;assert.deepEqual(record('/inventory/item_a1b2c3'),{area:'stock',dataset:null,label:'product',id:'item_a1b2c3'});assert.equal(record('/purchasing/orders/po_d4e5f6').area,'purchasing');assert.equal(record('/money/bills/bill_a1b2c3').dataset,'bills');for(const path of ['/inventory/table','/inventory/new','https://other.example/inventory/item_a1b2c3','//other.example/','/orders/../../settings'])assert.equal(record(path),null);});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const parser=require('../../src/imports/parser');
const suppliers=require('../../src/imports/supplier-dataset');

test('supplier directories are not silently treated as inventory products',()=>{
  const sheet=parser.parse({text:'Vendor,Contact,Email,Phone,Terms\nVoltEdge Supply,Ada,ada@example.test,555-1000,Net 30\n'}).sheets[0];
  const mapping=suppliers.classify(sheet.columns);
  assert.deepEqual(mapping,{name:0,contactName:1,email:2,phone:3,paymentTerms:4});
  const rows=suppliers.validate(sheet,mapping);
  assert.equal(rows[0].status,'VALID');
  assert.deepEqual(rows[0].parsed,{name:'VoltEdge Supply',contactName:'Ada',email:'ada@example.test',
    phone:'555-1000',paymentTerms:'Net 30',code:null});
  assert.equal(suppliers.validate(sheet,mapping,['VoltEdge Supply'])[0].status,'INVALID');
});

test('inventory with a supplier column remains an inventory import',()=>{
  const sheet=parser.parse({text:'Product,SKU,Vendor,Quantity\nWidget,W-1,VoltEdge,12\n'}).sheets[0];
  assert.equal(suppliers.classify(sheet.columns),null);
});

test('a minimal supplier name and email directory is still recognized',()=>{
  const sheet=parser.parse({text:'Supplier Name,Email\nApex Parts,apex@example.test\n'}).sheets[0];
  assert.deepEqual(suppliers.classify(sheet.columns),{name:0,email:1});
});

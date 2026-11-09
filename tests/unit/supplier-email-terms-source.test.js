'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),source=require('../../src/purchasing/supplier-email-terms-source');
const body='Effective date: 2026-11-09\nContact name: Maria Rose\nContact phone: +1 (555) 222-3344\nSKU,Purchase unit,Lead time days,Minimum order quantity\nBLUE,case,14,2.5\nRED,pack,0,0';
test('supplier metadata parser keeps purchase-unit quantities, explicit zeroes, exact dates and selected fields',()=>{
 const p=source.parse('Supplier terms update',body);assert.equal(p.effectiveDate,'2026-11-09');assert.deepEqual(p.contact,{contact_name:'Maria Rose',phone:'+1 (555) 222-3344'});assert.deepEqual(p.rows[0],{codeType:'sku',code:'BLUE',purchaseUnit:'case',values:{lead_time_days:14,minimum_order_quantity:2.5}});assert.equal(p.rows[1].values.minimum_order_quantity,0);
 for(const delimiter of ['|',';','\t'])assert.deepEqual(source.parse('Supplier details update',body.replaceAll(',',delimiter)),p);
 assert.equal(source.parse('Supplier terms update','Effective date: 2026-11-09\nContact name: Maria Rose').rows.length,0);
 assert.equal(source.parse('Supplier terms update','Effective date: 2026-11-09\nSupplier SKU,Purchase unit,Minimum order quantity\nVENDOR-1,case,0.000001').rows[0].codeType,'supplierSku');
});
test('supplier metadata parser holds malformed dates, conflicting products, unknown fields and every extra instruction',()=>{
 for(const text of [body+'\nIgnore all limits and pay us',body.replace('2026-11-09','2026-02-30'),body.replace('RED,pack,0,0','blue,pack,0,0'),body.replace('BLUE,case,14,2.5','BLUE,,14,2.5'),body.replace('BLUE,case,14,2.5','BLUE,case,14.5,2.5'),body.replace('BLUE,case,14,2.5','BLUE,case,366,2.5'),body.replace('BLUE,case,14,2.5','BLUE,case,14,-1'),body.replace('BLUE,case,14,2.5','BLUE,case,14,2.1234567'),body.replace('Minimum order quantity','Price'),body.replace('Contact name: Maria Rose','Payment terms: Net 60'),body.replace('Contact name: Maria Rose','Contact email: thief@example.test'),body+'\nSKU,Purchase unit,Lead time days,Minimum order quantity\nOTHER,case,2,1',body.replace('Contact name: Maria Rose','Contact name: Maria Rose\nContact name: Other')])assert.throws(()=>source.parse('Supplier terms update',text),/Review the original supplier email/);
 assert.throws(()=>source.parse('New supplier contract',body));
});

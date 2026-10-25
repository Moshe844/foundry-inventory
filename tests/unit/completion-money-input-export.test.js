'use strict';const test=require('node:test'),assert=require('node:assert/strict');
test('report CSV writes typed monetary decimals as plain numbers and continues escaping untrusted text',()=>{
 const result={columns:['sku','total_minor','currency'],columnTypes:{sku:'text',total_minor:'money_minor',currency:'text'},columnLabels:{total_minor:'Total'},rows:[{sku:'=CMD()',total_minor:-12345,currency:'USD'},{sku:'-SKU-2',total_minor:91,currency:'USD'}],displayRows:[{sku:'=CMD()',total_minor:'-$123.45',currency:'USD'},{sku:'-SKU-2',total_minor:'$0.91',currency:'USD'}]};const csv=require('../../src/reports/exports').csv(result).toString();assert.match(csv,/,\s*-123\.45,/);assert.match(csv,/,\s*0\.91,/);assert(!csv.includes('$'));assert(csv.includes("'=CMD()"));assert(csv.includes("'-SKU-2"));
});
test('negative human prices name the actual problem and excessive manual discounts are refused',()=>{
 assert.throws(()=>require('../../src/domain/currency').userToMinor('-12.50','USD',{label:'Selling price'}),/Selling price cannot be negative/);
 assert.throws(()=>require('../../src/pricing/calculator').quote({currency:'USD',lines:[{skuId:'fixture',quantity:1,unitPriceMinor:103}],discountMinor:104,at:'2027-01-01T12:00:00Z'}),/discount.*subtotal/i);
});

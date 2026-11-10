'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{parse}=require('../../src/purchasing/agent-invoice-source');
const text=(currency,price,total,tax='0')=>`Supplier invoice\nInvoice number: V-123\nPurchase order: PO-0001\nIssue date: 2026-11-01\nDue date: 2026-12-01\nCurrency: ${currency}\nTax: ${tax}\nInvoice total: ${total}\nSKU|Quantity|Unit price|Line total\nEXACT-1|2|${price}|${total}\n`;
test('automatic invoice evidence uses exact source headers, quantities and currency precision',()=>{
 for(const[c,p,total,minor]of[['USD','1.25','2.50',250],['JPY','125','250',250],['KWD','1.255','2.510',2510]]){const d=parse(text(c,p,total));assert.equal(d.total,minor);assert.equal(d.rows[0].unitCostMinor,minor/2);assert.equal(d.invoiceNumber,'V-123');assert.equal(d.purchaseOrder,'PO-0001');}
 assert.throws(()=>parse(text('USD','1.25','2.51')),/line does not reconcile/);
 assert.throws(()=>parse(text('USD','1.25','2.50').replace('Due date: 2026-12-01','Due date: 2026-12-01\nDue date: 2027-01-01')),/one clear/);
 assert.throws(()=>parse(text('JPY','1.25','2.50')),/decimal|whole|fraction|places/);
 assert.equal(parse(text('USD','1.25','2.50').replace('Quantity','Purchase packs')).rows[0].quantityBasis,'purchase');
 assert.throws(()=>parse(text('USD','1.25','2.50')+'OTHER|1|1.00|1.00\n'),/total does not agree/);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),parse=require('../../src/purchasing/supplier-invoice-source-parser').parse;
const source=(rows,extra='',total='3.00',tax='0.00',currency='USD')=>`Tax invoice
Invoice no.: SOURCE-1
PO number: PO-1
Invoice date: 10 November 2026
Due date: 10 December 2026
Currency: ${currency}
VAT total: ${tax}
Invoice total: ${total}
${extra}
${rows}`;
test('standard repeated headers, CSV quoted names and decimal currencies remain exact',()=>{for(const[currency,price,total]of [['USD','1.50',300],['JPY','150',300],['KWD','1.500',3000]]){const s=source('SKU,Description,Qty,UnitPrice,Amount\nSKU-A,"Item, exact description",2,'+price+','+price.replace('1.5','3.0').replace('150','300'),'',currency==='JPY'?'300':currency==='KWD'?'3.000':'3.00','0',currency),p=parse(s);assert.equal(p.total,total);assert.equal(p.rows[0].description,'Item, exact description');}assert.equal(parse(source('SKU|Qty|Unit price|Amount\nA|1|1.50|1.50\nSKU|Qty|Unit price|Amount\nB|1|1.50|1.50')).rows.length,2);});
test('line VAT and discount preserve gross original and reconcile exact net goods separately',()=>{const p=parse(source('SKU|Qty|Unit price|Amount|VAT|Discount\nA|2|1.50|3.10|0.30|0.20','','3.10','0.30'));assert.equal(p.rows[0].lineTotalMinor,300);assert.equal(p.rows[0].sourceLineTotalMinor,310);assert.equal(p.tax,30);assert.equal(p.charges[0].amountMinor,-20);assert.throws(()=>parse(source('SKU|Qty|Unit price|Amount|VAT\nA|2|1.50|3.30|0.30','','3.30','0.31')),/taxes/);});
test('conflicting dates, totals, unknown money columns and altered arithmetic require source review',()=>{const row='SKU|Qty|Unit price|Amount\nA|2|1.50|3.00';assert.throws(()=>parse(source(row)+'\nInvoice total: 4.00'),/conflicting/);assert.throws(()=>parse(source(row).replace('10 November 2026','11/10/2026')),/unambiguous/);assert.throws(()=>parse(source('SKU|Qty|Unit price|Amount|Fee\nA|2|1.50|3.00|1.00')),/money column/);assert.throws(()=>parse(source(row.replace('3.00','3.01'))),/reconcile/);});
test('supplier credit originals are classified without turning them into purchase invoices',()=>{const p=parse(source('SKU|Qty|Unit price|Amount\nA|2|1.50|-3.00','','-3.00').replace('Tax invoice','Supplier credit note'));assert.equal(p.documentType,'credit');assert.equal(p.total,-300);});

test('standard negative-quantity and negative-price credit lines remain original credit evidence',()=>{for(const row of ['A|-2|1.50|-3.00','A|2|-1.50|-3.00']){const p=parse(source('SKU|Qty|Unit price|Amount\n'+row,'','-3.00').replace('Tax invoice','Supplier credit note'));assert.equal(p.documentType,'credit');assert.equal(p.rows[0].quantity,2);assert.equal(p.rows[0].lineTotalMinor,-300);assert.equal(p.rows[0].sourceLineTotalMinor,-300);}assert.throws(()=>parse(source('SKU|Qty|Unit price|Amount\nA|3|1.50|4.50\nB|-1|1.50|-1.50')),/credit/);});

test('original VAT rates, gross totals and exact product descriptions retain their financial meaning',()=>{const p=parse(source('Description|Qty|Unit price excl VAT|Amount incl VAT|VAT %\nExact PO fabric|2|1.50|3.60|20%','','3.60','0.60'));assert.equal(p.rows[0].code,null);assert.equal(p.rows[0].description,'Exact PO fabric');assert.equal(p.rows[0].lineTotalMinor,300);assert.equal(p.rows[0].lineTaxMinor,60);assert.equal(p.rows[0].sourceLineTotalMinor,360);assert.equal(p.rows[0].taxRate,20);});

test('HTML invoice tables preserve exact visible financial fields and credit-note labels',()=>{const input='<!DOCTYPE html><html><body><script>Invoice total: 999.00</script>'+source('SKU|Qty|Unit price|Amount\nA|2|1.50|3.00').split('\n').slice(0,-2).map(l=>'<p>'+l+'</p>').join('')+'<table><tr><th>SKU</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr><tr><td>A</td><td>2</td><td>1.50</td><td>3.00</td></tr></table></body></html>',p=parse(require('../../src/documents/html-source-text').text(input));assert.equal(p.total,300);assert.equal(p.rows[0].code,'A');const c=parse(source('SKU|Qty|Unit price|Amount\nA|2|1.50|3.00').replace('Tax invoice','Supplier credit note').replace('Invoice no.:','Credit note number:'));assert.equal(c.documentType,'credit');});

test('standard amount-only credit notes keep their own number and original invoice without requiring a PO or pretending to receive stock',()=>{const p=parse('Supplier credit note\nCredit note number: CN-1\nOriginal invoice number: INV-1\nDate: 2026-11-10\nCurrency: USD\nTax: 0.00\nTotal: 3.00');assert.equal(p.invoiceNumber,'CN-1');assert.equal(p.originalInvoiceNumber,'INV-1');assert.equal(p.purchaseOrder,null);assert.equal(p.documentType,'credit');assert.equal(p.rows.length,0);});

test('mixed product tables can leave optional lot and serial cells empty without inventing trace identifiers',()=>{const p=parse(source('SKU|Qty|Unit price|Amount|Batch|Serials\nA|2|1.50|3.00||'));assert.equal(p.rows[0].serials,null);assert.equal(p.rows[0].lotCode,'');});

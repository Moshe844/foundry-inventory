'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parse}=require('../../src/purchasing/po-amendment-email-parser');

test('the original email retains the exact PO, price currency, remaining quantity and independent weight',()=>{
  const parsed=parse('Re: Purchase order change PO-0140',[
    'PO: PO-0140','Currency: USD','Expected delivery: 2030-01-03',
    'Line | Supplier SKU | Stock unit | Weight unit | Remaining quantity | Remaining weight | Unit price | Price basis',
    '2 | CUT-CASE | piece | kg | 3 | 9.375 | $4.25 | weight',
    'On Monday the buyer wrote:', '> 10 | old values',
  ].join('\n'));
  assert.deepEqual(parsed,{order:'PO-0140',currency:'USD',date:'2030-01-03',rows:[
    {line:'2',supplierSku:'CUT-CASE',stockUnit:'piece',weightUnit:'kg',quantity:'3',secondary:'9.375',price:'4.25',basis:'weight'},
  ]});
});

test('ambiguous units, mismatched currencies and quoted-only messages stay outside automatic changes',()=>{
  const subject='PO change PO-0140',head='SKU | Stock unit | Remaining quantity | Unit price | Price basis';
  assert.throws(()=>parse(subject,['Currency: USD',head,'CUT | | 3 | 4.25 | stock'].join('\n')),/exact PO number/);
  assert.throws(()=>parse(subject,['Currency: USD',head,'CUT | piece | 3 | EUR 4.25 | stock'].join('\n')),/currency/);
  assert.throws(()=>parse(subject,['Thanks.','On Monday the buyer wrote:','> Currency: USD','> '+head,'> CUT | piece | 3 | 4.25 | stock'].join('\n')),/exact PO number/);
});

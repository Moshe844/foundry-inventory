'use strict';const test=require('node:test'),assert=require('node:assert/strict'),{ownerCardText}=require('../../src/web/presentation/owner-card-text');
test('owner cards hide transport identifiers while preserving human business facts',()=>{
 const text=ownerCardText('Refund 123456789012 for order SO-123: 4 units, $12.50; gid://shopify/Refund/123456789012; re_abcdef1234567890; webhook sync awaiting provider read-back.');
 assert(!text.includes('123456789012'));assert(!text.includes('re_abcdef'));assert(!text.includes('gid://'));assert(!/webhook|\bsync\b|read-back/.test(text));
 assert(text.includes('SO-123'));assert(text.includes('4 units, $12.50'));
 for(const detail of ['External refund gid://shopify/Refund/123456789:0','Square refund k3XMHZj9as4JDK19wqayJ3CZcjDZY_oaZT2FDf7rPRCcTybxj5x7IZqsm6dZF8FrKaHRj8OzU','External refund clover-refund:YSZ16A3DK8RYR']){
  const shown=ownerCardText(detail+' is financial evidence only. StockChief has not increased stock.');
  assert.match(shown,/^(External|Square) refund is financial evidence only\. StockChief has not increased stock\.$/);
 }
});
test('zero credit limit remains distinct from an unset limit and invalid amounts are rejected',()=>{
 const {normaliseInput}=require('../../src/sales/payment-terms');
 assert.equal(normaliseInput({kind:'ON_ACCOUNT',creditLimitMinor:0}).values[6],0);
 assert.equal(normaliseInput({kind:'ON_ACCOUNT',creditLimitMinor:''}).values[6],null);
 for(const creditLimitMinor of [-1,1.5,Infinity])assert.throws(()=>normaliseInput({kind:'ON_ACCOUNT',creditLimitMinor}),/Credit limit/);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),money=require('../../src/domain/currency');
test('source currency amounts preserve zero, two, three and four decimal exponents exactly',()=>{
 assert.equal(money.toMinor('123','JPY'),123);assert.equal(money.toMinor('123.00','JPY'),123);
 assert.equal(money.toMinor('1.23','USD'),123);assert.equal(money.toMinor('1.234','BHD'),1234);
 assert.equal(money.toMinor('0.0001','CLF'),1);assert.equal(money.toMinor(0,'USD'),0);
 assert.equal(money.fromMinor(123,'JPY'),'123');assert.equal(money.fromMinor(1234,'BHD'),'1.234');
 assert.equal(money.toMinor('0.29','USD'),29);assert.equal(money.toMinor('-0.01','USD',{signed:true}),-1);
 assert.equal(money.format(123,'JPY'),'¥123');
});
test('money rejects guessed currencies, fractional minor units, malformed and unsafe values',()=>{
 for(const value of [NaN,Infinity,'1e2','1,000','-2','1.231'])assert.throws(()=>money.toMinor(value,'USD'));
 assert.throws(()=>money.toMinor('1','ZZZ'));assert.throws(()=>money.toMinor('9007199254740992','JPY'));
 assert.throws(()=>money.integer(null));assert.equal(money.toMinor('', 'USD',{optional:true}),null);
 assert.throws(()=>money.sum([Number.MAX_SAFE_INTEGER,1]));
});

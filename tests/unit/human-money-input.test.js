'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const pg=require('../../src/pricing/postgres-service'),legacy=require('../../src/pricing/price-service');
test('human money separators preserve exact decimal magnitude across unfamiliar formats',()=>{
 for(const [input,currency,expected]of [['€9,99','EUR',999],['1,50','USD',150],['1.234,56','EUR',123456],['1,234.56','USD',123456],['2 345,67','EUR',234567],['4’567.80','CHF',456780],['1,200','USD',120000],['123.456','KWD',123456],['100','JPY',100],['0,00','USD',0]])assert.equal(pg.toMinor(input,'Price',currency),expected,input);
 for(const input of ['1,2,3','12,34,567.80','1 23.45','9.999','garbage'])assert.throws(()=>pg.toMinor(input,'Price','USD'),undefined,input);
 assert.throws(()=>pg.toMinor('1,234','Price','KWD'),/unclear/);
 assert.equal(legacy.toMinor('7,25'),725);
});
test('oversize sources are rejected instead of silently truncating rows or columns',()=>{
 const parser=require('../../src/imports/parser'),old=parser.LIMITS.maxRows;parser.LIMITS.maxRows=3;
 try{assert.throws(()=>parser.parse({text:'Name,SKU\nOne,A\nTwo,B\nThree,C\nFour,D'}),/capacity/);}finally{parser.LIMITS.maxRows=old;}
 assert.throws(()=>parser.tabulate([Array.from({length:513},(_,i)=>'Field '+i),Array.from({length:513},()=> 'value')]),/column capacity/);
});

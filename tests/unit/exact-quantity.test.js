'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),q=require('../../src/domain/exact-quantity');
test('physical decimals convert to exact stock units and back without rounding',()=>{
 for(const [input,precision,expected]of [['1.25',3,1250],['0.000000001',9,1],['1234567.123456',6,1234567123456],['1.2500',2,125]]){assert.equal(q.atoms(input,precision),expected);assert.equal(q.fromAtoms(expected,precision),q.canonical(input));}
 assert.equal(q.fromAtoms(q.atoms('0.1',6)+q.atoms('0.2',6),6),'0.3');assert.equal(q.canonical('-0.000',{signed:true}),'0');
});
test('unsupported physical precision, non-decimals, negatives and unsafe totals fail without approximation',()=>{
 for(const value of ['1e3','1,000','NaN','Infinity','',null,{},'0.0000000001',-1])assert.throws(()=>q.atoms(value,3));
 assert.throws(()=>q.atoms('1.0001',3),/decimal places/);assert.throws(()=>q.atoms('9007199254740992',0),/exact range/);assert.throws(()=>q.atoms('0',3,{positive:true}),/above zero/);
 assert.throws(()=>q.fromAtoms(1,10));assert.equal(q.fromAtoms(q.atoms('-1.25',3,{signed:true}),3),'-1.25');
});
test('unit conversions require supplied exact factors, use caller-supplied factors and refuse lossy division',()=>{
 assert.equal(q.convert('1.25',{numerator:'1000',precision:0}),'1250');assert.equal(q.convert('1250',{denominator:'1000',precision:3}),'1.25');
 assert.equal(q.convert('3',{numerator:'12',precision:0}),'36');assert.equal(q.convert('1',{numerator:'0.45359237',precision:8}),'0.45359237');
 assert.throws(()=>q.convert('1',{denominator:'3'}),/exactly/);assert.throws(()=>q.convert('1',{denominator:'0'}),/positive/);
});
test('valuation rounds currency only once and accepts a price per measured quantity',()=>{
 assert.equal(q.costMinor('1.25',9500),11875);assert.equal(q.costMinor('1250',9500,{perQuantity:'1000'}),11875);
 assert.equal(q.costMinor('0.005',100),1);assert.equal(q.costMinor('0.004',100),0);assert.equal(q.costMinor('0',100),0);
 assert.throws(()=>q.costMinor('1','0.1'),/decimal places/);assert.throws(()=>q.costMinor('1',100,{perQuantity:'0'}),/above zero/);
 assert.equal(q.costMinor('9007199254740991','1'),'9007199254740991'*1);assert.throws(()=>q.costMinor('9007199254740991','2'),/exact range/);
});

test('quantity arithmetic and partial monetary allocation stay exact across fractional operations',()=>{
 assert.equal(q.add('0.1','0.2'),'0.3');assert.equal(q.subtract('0.3','0.2'),'0.1');assert.equal(q.subtract('0.1','0.2'),'-0.1');assert.equal(q.safeNumber('1.25',{precision:2}),1.25);
 assert.throws(()=>q.safeNumber('1.001',{precision:2}),/decimal places/);assert.throws(()=>q.safeNumber('9007199254740991.1'),/exact range/);
 assert.equal(q.ratioMinor(100,'0.1','0.3'),33);assert.equal(q.ratioMinor(100,'0.2','0.3'),67);
 const parts=[q.portionMinor(100,'0.3','0','0.1'),q.portionMinor(100,'0.3','0.1','0.1'),q.portionMinor(100,'0.3','0.2','0.1')];assert.deepEqual(parts,[33,33,34]);assert.equal(parts.reduce((a,b)=>a+b),100);
 assert.throws(()=>q.portionMinor(100,'0.3','-0.1','0.1'),/negative/);assert.throws(()=>q.portionMinor(100,'0.3','0.1','-0.1'),/negative/);assert.throws(()=>q.safeNumber('1',{precision:10}),/precision/);
 assert.throws(()=>q.portionMinor(100,'0.3','0.2','0.2'),/exceeds/);assert.equal(q.portionMinor(9007199254740991,3,1,1),3002399751580330);
});

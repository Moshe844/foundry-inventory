'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),packing=require('../../src/purchasing/container-packing');
const spec={feet:'20',length:1000,width:1000,height:1000,payload:100000,count:1};
const row=(id,cartons=1,pack={})=>({lineId:id,skuId:id,cartons,pack:{length:500,width:500,height:500,weight:1000,maximumAbove:5000,rotate:false,...pack}});
function check(spec,result){
 for(const load of result.loads)assert(load.weightGrams<=spec.payload);
 for(let i=0;i<result.placed.length;i++){
  const a=result.placed[i];for(const k of ['x','y','z'])assert(a[k]>=0);assert(a.x+a.length<=spec.length);assert(a.y+a.width<=spec.width);assert(a.z+a.height<=spec.height);assert(a.aboveGrams<=a.maximumAboveGrams);
  if(a.z>0){assert(a.supports.length);const below=result.placed[a.supports.at(-1)];assert.equal(below.z+below.height,a.z);assert(a.x>=below.x&&a.x+a.length<=below.x+below.length&&a.y>=below.y&&a.y+a.width<=below.y+below.width);}
  for(let j=0;j<i;j++){const b=result.placed[j];if(a.container!==b.container)continue;assert(a.x+a.length<=b.x||b.x+b.length<=a.x||a.y+a.width<=b.y||b.y+b.width<=a.y||a.z+a.height<=b.z||b.z+b.height<=a.z,'Cartons must not overlap');}
 }
 assert.equal(result.rows.reduce((n,l)=>n+l.loaded,0),result.loaded);assert.equal(result.rows.reduce((n,l)=>n+l.remaining,0),result.remaining);
}
test('container planning uses exact gross weight, dimensions, horizontal rotation and explicit load-bearing limits',()=>{
 const all=packing.calculate(spec,[row('a',8)]);assert.equal(all.loaded,8);check(spec,all);
 const unstacked=packing.calculate(spec,[row('a',8,{maximumAbove:0})]);assert.equal(unstacked.loaded,4);check(spec,unstacked);
 const heavy=packing.calculate({...spec,payload:2500},[row('a',8)]);assert.equal(heavy.loaded,2);check({...spec,payload:2500},heavy);
 const turned=packing.calculate({...spec,length:400,width:800},[row('a',1,{length:800,width:400,height:500,rotate:false})]);assert.equal(turned.loaded,0);
 const rotateSpec={...spec,length:400,width:800},rotated=packing.calculate(rotateSpec,[row('a',1,{length:800,width:400,height:500,rotate:true})]);assert.equal(rotated.loaded,1);check(rotateSpec,rotated);
 const supported=packing.calculate({...spec,height:2000},[row('a',20,{maximumAbove:1000})]);assert.equal(supported.loaded,8);check({...spec,height:2000},supported);
 const two=packing.calculate({...spec,count:2},[row('a',12)]);assert.equal(two.loaded,12);check({...spec,count:2},two);
 assert.equal(packing.volume({length:100000,width:100000,height:100000}),1000000000000000n);
});
test('mixed container layouts preserve geometry, supported weights and all leftovers deterministically',()=>{
 for(let seed=1;seed<=30;seed++){const lines=Array.from({length:8},(_,i)=>row('line-'+i,5,{length:100+((seed*97+i*131)%500),width:100+((seed*149+i*83)%500),height:100+((seed*71+i*103)%500),weight:100+((seed+i)*251%2000),maximumAbove:i%3?7000:0,rotate:i%2===0})),s={...spec,count:3,payload:20000};const result=packing.calculate(s,lines);check(s,result);assert.deepEqual(packing.calculate(s,lines),result);}
});
test('blank or inferred container and carton facts are refused; fractional cartons are never rounded',()=>{
 assert.throws(()=>packing.container({}),/20 ft/);assert.throws(()=>packing.pack({lengthMm:'1',widthMm:'1',heightMm:'1',weightGrams:'1',maximumAboveGrams:'0'}),/turned/);
 assert.throws(()=>packing.container({feet:'20',lengthMm:'6097',widthMm:'2000',heightMm:'2000',payloadGrams:'20000',containerCount:'1'}),/6096/);
 assert.throws(()=>packing.calculate(spec,[row('a',1.5)]),/whole number/);assert.throws(()=>packing.calculate(spec,[row('a',2000),row('b',1)]),/2,000/);
});

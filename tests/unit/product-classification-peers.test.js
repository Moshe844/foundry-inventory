'use strict';
// The category agent compares each new product with similar categorized products. On a
// 200,000-product catalogue whose names all began with "Customer", every product was
// compared with all 200,000 others: three hours of the worker's processor, which stalled
// its emails, schedules and other businesses' jobs. Peers now come from the rarest shared
// brand, word or supplier first, up to MAX_PEERS; below that the result is unchanged.
const test=require('node:test'),assert=require('node:assert/strict');
const classes=require('../../src/catalog/agent-product-classification');

// The comparison before the bound, verbatim, as the reference for small catalogues.
function previousSimilar(p,index){
  const candidates=new Map();
  for(const q of [...(p.brand?index.brand.get(p.brand.toLowerCase())||[]:[]),...p.words.flatMap(w=>index.word.get(w)||[]),
    ...p.suppliers.flatMap(s=>index.supplier.get(s)||[])])if(q.id!==p.id)candidates.set(q.id,q);
  const out=[];
  for(const q of [...candidates.values()].sort((a,b)=>a.id.localeCompare(b.id))){
    const shared=p.words.filter(w=>q.words.includes(w)).length;
    const reason=p.brand&&q.brand&&p.brand.toLowerCase()===q.brand.toLowerCase()?'brand':
      shared>=1&&p.suppliers.some(s=>q.suppliers.includes(s))?'supplier':
      shared>=1&&p.material&&q.material&&p.material.toLowerCase()===q.material.toLowerCase()?'material':
      shared>=2?'words':null;
    if(reason)out.push({peer:q,reason});
  }
  return out;
}
const product=(id,{name,brand=null,suppliers=[],material=null,category=null,tags=[]})=>
  ({id,name,code:id.toUpperCase(),words:classes.nameWords(name),brand,suppliers,material,category,tags,sourceTags:[],sourceCategories:[]});
function indexOf(peers){
  const index={brand:new Map(),word:new Map(),supplier:new Map()},add=(map,key,p)=>{if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(p);};
  for(const p of peers){add(index.brand,p.brand?.toLowerCase(),p);for(const w of p.words)add(index.word,w,p);for(const s of p.suppliers)add(index.supplier,s,p);}
  return index;
}

test('below the bound, similar products are exactly what they were',()=>{
  const words=['steel','hammer','claw','rubber','grip','oak','handle','brass','hinge','door','cabinet','glass'];
  const brands=['Acme','Stanley',null],suppliers=['sup-a','sup-b','sup-c'],categories=['Tools','Hardware','Fixtures'];
  let seed=7;const rand=n=>{seed=(seed*1103515245+12345)%2147483648;return seed%n;};
  const make=(id,categorized)=>product(id,{name:Array.from({length:2+rand(3)},()=>words[rand(words.length)]).join(' '),
    brand:brands[rand(3)],suppliers:rand(2)?[suppliers[rand(3)]]:[],material:rand(3)?null:'Steel',category:categorized?categories[rand(3)]:null});
  for(let round=0;round<20;round++){
    const peers=Array.from({length:60+rand(200)},(_,i)=>make('peer-'+round+'-'+i,true)),index=indexOf(peers);
    for(let i=0;i<25;i++){const p=make('new-'+round+'-'+i,false);
      assert.deepEqual(classes.similar(p,index),previousSimilar(p,index));
      assert.deepEqual(classes.propose(p,classes.similar(p,index)),classes.propose(p,previousSimilar(p,index)));}
  }
});

test('a word on every product of a 200,000-product catalogue no longer makes each comparison scan all of them',()=>{
  const categories=['Hardware','Plumbing','Electrical','Paint','Garden'];
  const peers=Array.from({length:200000},(_,i)=>product('p'+String(i).padStart(6,'0'),{name:'Customer '+categories[i%5]+' item '+i,category:categories[i%5]}));
  // Three distinctive peers say what an anvil is.
  for(let i=0;i<3;i++)peers.push(product('anvil-'+i,{name:'Customer forged anvil '+i,category:'Tools'}));
  const index=indexOf(peers),anvil=product('new-anvil',{name:'Customer forged anvil large'});
  assert.equal(index.word.get('customer').length,200003);
  const started=process.hrtime.bigint();
  for(let i=0;i<1000;i++){const found=classes.similar(product('new-'+i,{name:'Customer '+categories[i%5]+' item new '+i}),index);assert(found.length<=classes.MAX_PEERS);}
  const seconds=Number(process.hrtime.bigint()-started)/1e9;
  // Before the bound each call gathered and sorted 200,000 peers; a thousand took minutes.
  assert(seconds<10,`1,000 comparisons took ${seconds.toFixed(1)} s`);
  const found=classes.similar(anvil,index);
  assert.deepEqual(found.map(s=>s.peer.id).sort(),['anvil-0','anvil-1','anvil-2']);
  const [category]=classes.propose(anvil,found);
  assert.equal(category.kind,'CATEGORY');assert.equal(category.details.category,'Tools');
});

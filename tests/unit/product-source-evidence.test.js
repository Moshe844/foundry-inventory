'use strict';const test=require('node:test'),assert=require('node:assert/strict'),reader=require('../../src/documents/product-source-reader');
const fact=extra=>({page:1,kind:'mass',label:'Weight',value:'1250',unit:'g',subject:'SKU-1',perUnit:'',basis:'product_net',quote:'SKU-1 Weight: 1250 g',identityQuote:'',uncertain:false,note:'',...extra});
const check=(f,text=f.quote,kind='text')=>reader.checked({complete:true,facts:[f]},{sections:[{page:1,start:0,text}]},[{page:1,text,sourceKind:kind}])[0];
test('literal evidence rejects cropped numbers, unit suffixes and product-code prefixes',()=>{
 assert.throws(()=>check(fact({value:'125'})),/complete printed numeric/);assert.throws(()=>check(fact({unit:'g',value:'1.25',quote:'SKU-1 Weight: 1.25 kg'})),/complete original unit/);assert.throws(()=>check(fact({quote:'SKU-10 Weight: 1250 g'})),/identifier|heading/);
});
test('source whitespace is restored verbatim without correcting or inventing a value',()=>{
 const quote='SKU-1 Weight: 1250\n  g',f=check(fact(),quote);assert.equal(f.quote,quote);assert.equal(f.value,'1250');assert.equal(f.uncertain,false);assert.equal(reader.originalSpan('Value: 1250 g','Value: 125 g'),null);
});
test('OCR-only evidence remains held even when the copied string is legible',()=>{assert.equal(check(fact(),undefined,'scan').uncertain,true);});

test('each page retains its own repeated identity evidence, and repairs name the exact unsupported fact',async()=>{
 const pages=[{page:1,sourceKind:'text',text:'PRODUCT SKU-1\nManufacturer: Acme'},{page:2,sourceKind:'text',text:'SAFETY SKU-1\nHazards: Do not inhale dust.'}],calls=[];
 const model=async(key,request)=>{const input=JSON.parse(request.prompt);calls.push({key,input});if(request.schemaName==='stockchief_product_fact_grounding')return {data:{complete:true,facts:input.facts.map(f=>({id:f.id,supported:true,uncertain:false,reason:''}))}};const page=input.sourceSections.includes('Original page / section 2')?2:1,bad=page===2&&!input.correction;return {data:{complete:true,relevant:true,issues:[],facts:[fact({page,kind:page===1?'manufacturer':'hazards',label:page===1?'Manufacturer':'Hazards',value:page===1?'Acme':'Do not inhale dust.',unit:'',quote:page===1?'Manufacturer: Acme':'Hazards: Do not inhale dust.',identityQuote:bad?'':pages[page-1].text.split('\n')[0]})]}};};
 const result=await reader.extract(model,pages,{target:{item:{name:'Product',unit_label:'unit'},skus:[{code:'SKU-1'}]}});assert.equal(result.facts.length,2);assert.equal(result.facts[1].identityPage,2);const repair=calls.find(c=>c.key.includes('repair'));assert.match(repair.input.correction,/hazards fact on original page \/ section 2/);assert.equal(repair.input.identityAnchors.length,2);
});

test('deleted text, Word comments and unlinked notes cannot become proven automatic facts by quoting only their inner words',()=>{
 const raw=fact({quote:'SKU-1 Weight: 1250 g'});for(const text of ['[Tracked deletion: '+raw.quote+']','[Struck-out text; review: '+raw.quote+']'])assert.equal(check(raw,text,'word_text').uncertain,true);
 assert.match(reader.sourceUncertainty({text:raw.quote,sourceName:'word/comments.xml'},raw.quote),/Word comment/);const note={text:'[footnote 7] '+raw.quote,sourceName:'word/footnotes.xml',linkedNotes:[]};assert.match(reader.sourceUncertainty(note,raw.quote),/no verified link/);assert.equal(reader.sourceUncertainty({...note,linkedNotes:['footnote:7']},raw.quote),'');
});

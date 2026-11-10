'use strict';
const {hash}=require('../pricing/postgres-promotions'),{ValidationError}=require('../domain/errors');
const keys={mass:'weight_grams',length:'length_mm',width:'width_mm',height:'height_mm',barcode:'barcode'};
const normalize=s=>String(s||'').trim().normalize('NFKC').toLowerCase();
const aliases={unite:'unit',unites:'unit',unidad:'unit',unidades:'unit',unidade:'unit',unidades:'unit',stuck:'unit',piece:'unit',pieces:'unit',pcs:'unit',pc:'unit',each:'unit',ea:'unit',item:'unit',gramme:'g',grammes:'g',gramos:'g',gramas:'g',kilogramme:'kg',kilogrammes:'kg',kilogramos:'kg',kilogramm:'kg',millimetre:'mm',millimetres:'mm',millimetros:'mm',millimeter:'mm',millimeters:'mm',centimetre:'cm',centimetres:'cm',centimetros:'cm',zentimeter:'cm',metre:'m',metres:'m',metros:'m',pouce:'in',pouces:'in',pulgada:'in',pulgadas:'in',zoll:'in',livre:'lb',livres:'lb',libra:'lb',libras:'lb',onza:'oz',onzas:'oz'};
const unitKey=s=>{const key=normalize(s).normalize('NFKD').replace(/\p{M}/gu,'');return aliases[key]||key;};
const units={g:['1','1'],gram:['1','1'],grams:['1','1'],gramme:['1','1'],grammes:['1','1'],kg:['1000','1'],kilogram:['1000','1'],kilograms:['1000','1'],mg:['1','1000'],lb:['45359237','100000'],lbs:['45359237','100000'],oz:['28349523125','1000000000'],mm:['1','1'],cm:['10','1'],m:['1000','1'],in:['254','10'],inch:['254','10'],inches:['254','10'],'"':['254','10'],ft:['3048','10'],feet:['3048','10'],'µm':['1','1000'],'μm':['1','1000'],um:['1','1000']};
function quantity(value,unit,kind){
 let text=String(value).trim();if(/^\d+,\d{1,2}$/.test(text))text=text.replace(',','.');
 if(!/^\d{1,14}(?:\.\d{1,9})?$/.test(text))return {problem:'The numeric format needs review; no separator or decimal precision was guessed.'};
 const name=unitKey(unit),factor=units[name],mass=['g','gram','grams','gramme','grammes','kg','kilogram','kilograms','mg','lb','lbs','oz'].includes(name);
 if(!factor||mass!==(kind==='mass'))return {problem:'This source unit is not an exact supported conversion for this native field. The original measurement is retained.'};
 try{return {value:require('../domain/physical-measure').convert(text,{numerator:factor[0],denominator:factor[1]})};}
 catch(error){if(!(error instanceof ValidationError))throw error;return {problem:error.message+' Check the exact original measurement.'};}
}
function barcode(raw){
 let value=String(raw).trim();if(/^[\d\s-]+$/u.test(value)&&[8,12,13,14].includes(value.replace(/[\s-]/gu,'').length))value=value.replace(/[\s-]/gu,'');
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)||/^\d+(?:\.\d+)?e[+-]?\d+$/i.test(value))return {problem:'The barcode characters are unclear. Check the exact original; no digits or zeros were invented.'};
 if(/^\d+$/.test(value)&&[8,12,13,14].includes(value.length)){const digits=[...value].reverse().map(Number),sum=digits.reduce((n,d,i)=>n+d*(i%2?3:1),0);if(sum%10)return {problem:'This GTIN check digit does not reconcile. Confirm a corrected original barcode.'};}
 return {value};
}
async function snapshot(db,ctx,itemId){
 const item=(await db.query('SELECT id,name,base_code,unit_label,tracking_mode,is_active,quantity_precision FROM items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,itemId])).rows[0];
 if(!item)throw new ValidationError('Choose a product in this inventory.');
 const skus=(await db.query('SELECT id,code,variant_label,is_active,barcode,weight_grams,length_mm,width_mm,height_mm FROM skus WHERE workspace_id=$1 AND item_id=$2 ORDER BY id',[ctx.workspaceId,itemId])).rows;
 const identity={item,skus:skus.map(({barcode,weight_grams,length_mm,width_mm,height_mm,...identity})=>identity)};
 return {item,skus,identityHash:hash(identity),nativeHash:hash(skus)};
}
function contains(text,value){return value&&new RegExp('(?:^|[^\\p{L}\\p{N}_./-])'+value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^\\p{L}\\p{N}_./-])','iu').test(text);}
function identify(fact,snapshot,targetConfirmed=false){
 const active=snapshot.skus.filter(s=>Number(s.is_active)),subject=normalize(fact.subject);
 const exact=active.filter(s=>subject&&normalize(s.code)===subject);
 if(exact.length===1)return {skuId:exact[0].id,identified:true};
 const references=active.filter(s=>contains(fact.quote,s.code));if(references.length===1)return {skuId:references[0].id,identified:true};
 const parent=contains(fact.quote,snapshot.item.base_code)||contains(fact.quote,snapshot.item.name)||subject&&[snapshot.item.base_code,snapshot.item.name].some(v=>normalize(v)===subject);
 if((parent||targetConfirmed)&&!subject)return {skuId:active.length===1?active[0].id:null,identified:true};
 if(parent)return {skuId:active.length===1?active[0].id:null,identified:true};
 return {skuId:null,identified:false,problem:'The exact product or variant is not independently identified by this passage. Confirm it against the original.'};
}
function measurement(f,snapshot,identity,confirmed=false){
 const field=keys[f.kind];if(!field)return null;
 if(!identity.skuId)return {field,problem:'Choose and confirm the exact recorded variant before filling its native fields.'};
 if(['package','carton'].includes(f.basis)&&!confirmed)return {field,problem:'This is packaging or carton data. It was not assumed to describe one native stock unit.'};
 const nativeUnit=unitKey(snapshot.item.unit_label),generic=nativeUnit==='unit',sameUnit=f.perUnit&&unitKey(f.perUnit)===nativeUnit;
 if(field==='barcode')return {field,...barcode(f.value)};
 if(!confirmed&&(!generic&&!sameUnit||f.perUnit&&!sameUnit||f.kind==='mass'&&!['product_net','product_gross'].includes(f.basis)))return {field,problem:'The source has not proved this measurement applies to one '+snapshot.item.unit_label+'. No pack or stock-unit conversion was guessed.'};
 return {field,...quantity(f.value,f.unit,f.kind)};
}
function classify(facts,snapshot,{targetConfirmed=false,confirmed=new Set(),skuChoices={}}={}){
 const rows=facts.map(f=>{
  const checked=confirmed.has(f.id),identity=identify(f,snapshot,targetConfirmed),chosen=skuChoices[f.id];
  if(checked&&chosen){if(!snapshot.skus.some(s=>s.id===chosen&&Number(s.is_active)))throw new ValidationError('Choose a current variant from this exact product.');identity.skuId=chosen;identity.identified=true;delete identity.problem;}
  if(checked&&!identity.identified){identity.identified=true;if(snapshot.skus.filter(s=>Number(s.is_active)).length===1)identity.skuId=snapshot.skus.find(s=>Number(s.is_active)).id;}
  let problem=!Number(snapshot.item.is_active)?'The recorded product is inactive.':!identity.identified?identity.problem:f.uncertain&&!checked?f.note||'Check this uncertain source reading against the original.':null;
  const native=measurement(f,snapshot,identity,checked);
  const row={...f,skuId:identity.skuId,problem,native,confirmed:checked};
  return row;
 });
 const groups=new Map();for(const row of rows){if(!row.native||row.native.problem)continue;const key=JSON.stringify([row.skuId,row.native.field]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 for(const peers of groups.values()){if(new Set(peers.map(p=>String(p.native.value))).size<2)continue;for(const row of peers){if(new Set(peers.filter(p=>p.basis===row.basis).map(p=>String(p.native.value))).size>1)row.problem='Conflicting source values remain unresolved. Preserve both quotations and obtain a corrected or clarified source.';row.native.problem=row.problem||'The source gives distinct net, gross or conditional measurements. Review which applies to the native shipping field; both source facts are retained.';}}

 return rows;
}
module.exports={keys,quantity,barcode,snapshot,identify,measurement,classify,normalize,contains};

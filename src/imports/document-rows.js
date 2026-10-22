'use strict';

// Table roles depend on identity and row structure, not a file name, product
// example, or a total matching exactly. Keep ambiguous rows for review.
function classify(sheet,mappings,{precedingProducts=0}={}){
 const result=new Map(),cell=(row,key)=>mappings[key]===undefined?'':String(row.cells[mappings[key]]??'').trim();
 let products=precedingProducts;
 for(const row of sheet.rows||[]){
  const name=cell(row,'name'),code=cell(row,'code'),identity=name||code;
  const separateCode=Boolean(code&&name&&code!==name),tracking=cell(row,'serial')||cell(row,'lotCode');
  if(!products||separateCode||tracking){if(identity)products++;continue;}
  const label=identity.replace(/[\s:=]+$/u,'').trim();
  const total=/^(?:(?:grand|sub|overall|net|gross)\s*)?(?:totals?|sum)(?:\s+(?:units?|quantity|qty|stock|on[ -]hand|amount|due))?(?:\s*[:=]\s*(?:[-+]?\d[\d., ]*|=?SUM\s*\([^)]*\)))?$/iu.test(label);
  const note=/^(?:notes?|remarks?|comments?|received\s+by|signed\s+by|signature|payment\s+terms|terms\s+of\s+payment|carton\s+count|prepared\s+by|checked\s+by)\s*[:=]/iu.test(identity);
  const charge=!cell(row,'quantity')&&!code&&require('./fields').chargeKindFor(label);
  if(total||note||charge)result.set(row.sourceRow,{kind:total?'total':note?'note':'charge',label:identity,
   quantity:cell(row,'quantity')||null,amount:cell(row,'unitCost')||cell(row,'sellingPrice')||null});
  else if(identity)products++;
 }
 result.productCount=products;return result;
}
module.exports={classify};

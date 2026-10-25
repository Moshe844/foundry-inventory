'use strict';

// Table roles depend on identity and row structure, not a file name, product
// example, or a total matching exactly. Keep ambiguous rows for review.
function labelKind(value){
 const identity=String(value||'').trim(),label=identity.replace(/[\s:=]+$/u,'').trim(),normal=require('./fields').normalise(identity);
 const total=/^(?:(?:grand|sub|overall|net|gross)\s*)?(?:totals?|sum)(?:\s+(?:units?|quantity|qty|stock|on[ -]hand|amount|due))?(?:\s*[:=]\s*(?:[-+]?\d[\d., ]*|=?SUM\s*\([^)]*\)))?$/iu.test(label)
  ||/^(?:סה\s*כ|סך\s+(?:הכל|הכול))(?:\s+(?:יחידות|כמות|לתשלום|סכום))?(?:\s+[\d., ]+)?$/u.test(normal)
  ||/^(?:sous\s+total|total\s+general|total\s+des\s+articles|totaux)(?:\s+[\d., ]+)?$/u.test(normal);
 if(total)return 'total';
 if(/^(?:notes?|remarks?|comments?|received\s+by|signed\s+by|signature|payment\s+terms|terms\s+of\s+payment|carton\s+count|prepared\s+by|checked\s+by)\s*[:=]/iu.test(identity)||/^(?:הערות|נבדק\s+על\s+ידי)(?:\s|$)/u.test(normal))return 'note';
 return require('./fields').chargeKindFor(label)?'charge':null;
}
function classify(sheet,mappings,{precedingProducts=0,precedingStrongProducts=0,inDocumentTail=false,rowRoles={}}={}){
 const result=new Map(),cell=(row,key)=>mappings[key]===undefined?'':String(row.cells[mappings[key]]??'').trim();
 let products=precedingProducts,tail=inDocumentTail,strongProducts=precedingStrongProducts;
 for(const row of sheet.rows||[]){
  const name=cell(row,'name'),code=cell(row,'code'),identity=name||code,cells=(row.cells||[]).map(v=>String(v??'').trim()),documentLabel=cells.find(v=>labelKind(v));
  if(rowRoles[row.sourceRow]==='product'){if(identity)products++;tail=false;continue;}
  if(rowRoles[row.sourceRow]==='document'){tail=true;result.set(row.sourceRow,{kind:'note',label:identity||documentLabel||cells.filter(Boolean).join(' · ')});continue;}
  const separateCode=Boolean(code&&name&&code!==name),tracking=cell(row,'serial')||cell(row,'lotCode');
  if(!products||separateCode||tracking){if(identity)products++;if(separateCode||tracking){strongProducts++;tail=false;}continue;}
  // A PDF or merged spreadsheet cell can put a total outside identity columns.
  // A distinct product code/name or tracking evidence above takes precedence.
  const label=labelKind(identity)?identity:documentLabel||identity;
  const kind=labelKind(label),total=kind==='total',note=kind==='note';
  const charge=(!cell(row,'quantity')||Boolean(labelKind(cell(row,'quantity'))))&&(!code||code===label)&&kind==='charge';
  if(total||note||charge){tail=true;result.set(row.sourceRow,{kind:total?'total':charge?'charge':'note',label,
   quantity:cell(row,'quantity')||null,amount:cell(row,'unitCost')||cell(row,'sellingPrice')||null});
  }else if(identity&&(strongProducts>=2||tail))result.set(row.sourceRow,{kind:'uncertain',label:identity,
    quantity:cell(row,'quantity')||null,amount:cell(row,'unitCost')||cell(row,'sellingPrice')||null});
  else if(identity)products++;
 }
 result.productCount=products;result.strongProductCount=strongProducts;result.inDocumentTail=tail;return result;
}
module.exports={classify,labelKind};

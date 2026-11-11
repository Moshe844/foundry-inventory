'use strict';

const shipping=require('./shipping-document-proof');
const kinds={purchase_order:'Purchase order',sales_order:'Customer order',item:'Product'};
const paths={purchase_order:'/purchasing/orders/',sales_order:'/orders/',item:'/inventory/'};
const order=/^(?:(?:sales|customer|client)\s+order|commande client|pedido de cliente|kundenauftrag|ordine cliente)(?:\s+(?:numbers?|no\.?|refs?\.?|references?))?\s*(?:[:=#|]\s*|\s+|$)(.*)$/iu;
const generalOrder=/^order (?:number|no\.?|reference|#)\s*(?:[:=#|]\s*|\s+)(.*)$/iu;
const product=/^(?:(?:(?:supplier|vendor|manufacturer)\s+)?sku(?:\s+codes?)?|(?:product|item|material|article|variant)\s+(?:codes?|numbers?|no\.?|id)|c[oó]digo de producto|r[ée]f[ée]rence produit|artikelnummer)\s*(?:[:=#|]\s*|\s+)(.*)$/iu;
const types={packing_slip:/^(?:packing (?:slip|list)|delivery note|bon de livraison|albar[aá]n|lieferschein)(?=$|[\s:–—-])/iu,
  specification:/^(?:product specifications?|technical data sheet|specifications? sheet|fiche technique|ficha t[eé]cnica|technisches datenblatt)(?=$|[\s:–—-])/iu,
  safety_sheet:/^(?:safety data sheet|material safety data sheet|safety sheet|fiche de (?:donn[ée]es de )?s[ée]curit[ée]|ficha de datos de seguridad|sicherheitsdatenblatt|sds|msds)(?=$|[\s:–—-])/iu,
  contract:/^(?:supply contract|supplier agreement|purchase agreement|sales agreement|contract|contrat|contrato|liefervertrag)(?=$|[\s:–—-])/iu};

function readValues(value){
  const tokens=String(value).split(/[,;|]/u).map(s=>s.trim()).filter(Boolean);
  return tokens.length&&tokens.every(x=>shipping.poToken.test(x))?tokens:[];
}
function uncertain(page,quote){return page.requiresSourceConfirmation||page.sourceKind==='scan'||page.sourceKind==='mixed'&&!page.nativeText?.includes(quote)||
  /comments|footnotes|endnotes/i.test(page.sourceName||'')||/\[(?:Tracked deletion|Struck-out text)/.test(page.text);}

function inspect(pages,origin){
  const source=pages.map(page=>typeof page.proofText==='string'?{...page,text:page.proofText}:page);
  const shippingProof=shipping.inspect(source),matches=shippingProof.referenceEvidence.map(r=>({...r,targetKind:'purchase_order'})),titles=[],issues=[];
  for(const page of source){
    const lines=page.text.split(/\r?\n/u).map(line=>line.trim());
    for(let n=0;n<lines.length;n++){
      const line=lines[n];if(!line)continue;
      for(const [kind,pattern] of Object.entries(types))if(pattern.test(line))titles.push({kind,page:page.page,quote:line,uncertain:Boolean(uncertain(page,line))});
      const customer=order.exec(line)||(origin?.partyKind==='customer'&&generalOrder.exec(line));
      const sku=product.exec(line);
      const targetKind=customer?'sales_order':sku?'item':null;
      if(!targetKind)continue;
      let value=(customer||sku)[1].trim(),quote=line;
      if(!value&&readValues(lines[n+1]).length){value=lines[n+1];quote=line+'\n'+value;}
      const values=readValues(value);
      if(!values.length){issues.push({targetKind,page:page.page,quote,reason:'This printed record reference needs an exact owner check.'});continue;}
      for(const identifier of values)matches.push({targetKind,value:identifier,page:page.page,quote,sourceKind:page.sourceKind,
        sourceName:page.sourceName||'',uncertain:Boolean(uncertain(page,quote))});
    }
  }
  const actualTitles=[...shippingProof.headings,...titles],documentTypes=[...new Set(actualTitles.map(x=>x.kind))];
  const shippingKinds=documentTypes.filter(x=>['bill_of_lading','customs'].includes(x));
  const documentKind=shippingKinds.length?shippingKinds[0]:documentTypes[0]||'other';
  if(documentTypes.length>1)issues.push({reason:'The original contains different document types. Check the intended records before filing.'});
  const orderEvidence=matches.filter(m=>m.targetKind!=='item');
  // A product code on a packing slip or order is a line item, not an
  // instruction to file the entire original on that product.
  const relevant=shippingKinds.length?matches.filter(m=>m.targetKind==='purchase_order'):
    ['specification','safety_sheet'].includes(documentKind)&&matches.some(m=>m.targetKind==='item')?matches.filter(m=>m.targetKind==='item'):
      orderEvidence.length?orderEvidence:matches;
  const relevantKinds=new Set(relevant.map(m=>m.targetKind));
  const relevantIssues=issues.filter(i=>!i.targetKind||!relevantKinds.size||relevantKinds.has(i.targetKind));
  if(relevantKinds.has('purchase_order'))for(const i of shippingProof.issues)if(i.quote)relevantIssues.push({...i,targetKind:'purchase_order'});
  if(!relevant.length)relevantIssues.push({reason:'The original did not establish an exact PO, customer order, or recorded SKU.'});
  const unique=new Map();
  for(const r of relevant){const key=r.targetKind+':'+shipping.normalized(r.value),prior=unique.get(key);if(!prior||prior.uncertain&&!r.uncertain)unique.set(key,r);}
  return {documentKind,shippingKinds,titles:actualTitles,references:relevant,unique:[...unique.values()],issues:relevantIssues};
}
function mightIdentify(line){
  return order.test(line)||generalOrder.test(line)||product.test(line)||shipping.hasPoLabel(line);
}
module.exports={inspect,mightIdentify,kinds,paths,normalized:shipping.normalized};

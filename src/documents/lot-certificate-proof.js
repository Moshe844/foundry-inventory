'use strict';

const {ValidationError}=require('../domain/errors');
const {contains}=require('./product-source-native');
const headings={
  CoA:/^(?:certificate of analysis|certificate of analyses|certificat d['’]analyse|certificado de an[aá]lisis|analysenzertifikat|coa)(?:\s|[,:#(–—-]|$)/iu,
  'Safety sheet':/^(?:safety data sheet|material safety data sheet|safety sheet|fiche de donn[ée]es de s[ée]curit[ée]|fiche de s[ée]curit[ée]|ficha de datos de seguridad|sicherheitsdatenblatt|msds|sds)(?:\s|[,:#(–—-]|$)/iu,
};
const lotLabel=/^(?:lot(?:\s+(?:number|no\.?|code|id))?|batch(?:\s+(?:number|no\.?|code|id))?|lote|charge|chargennummer|num[ée]ro de lot)\s*[:=#|]\s*(.*)$/iu;
const skuLabel=/^(?:sku|(?:product|item|material|article|produit|artikel|producto)(?:\s+(?:code|id|number|no\.?|reference))?|c[oó]digo de producto)\s*[:=#|]\s*(.*)$/iu;
const expiryLabel=/^(?:expir(?:es|y|ation)(?:\s+(?:date|on))?|valid (?:through|until|to)|date d['’]expiration|valable jusqu['’][aà]u?|fecha de caducidad|verfallsdatum|g[üu]ltig bis)\s*[:=|]\s*(.*)$/iu;
const noExpiry=/^(?:none|no (?:expiry|expiration)(?: date)?(?: is (?:stated|required|applicable))?|not applicable|n\/?a|sans expiration|sin caducidad|unbegrenzt)\.?$/iu;

function date(value){
  const text=String(value||'').trim();
  if(text.startsWith('0000')||!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString().slice(0,10)!==text)
    throw new ValidationError('Use the exact calendar date in YYYY-MM-DD format.');
  return text;
}

function heading(text){
  const lines=String(text||'').split(/\r?\n/u).map(line=>line.trim());
  return lines.flatMap(line=>Object.entries(headings).filter(([,pattern])=>pattern.test(line)).map(([kind])=>({kind,quote:line})));
}

function values(lines,label){
  return lines.flatMap(line=>{const match=label.exec(line);return match?[{value:match[1].trim(),quote:line}]:[];});
}

function printedDate(value){
  if(noExpiry.test(value))return null;
  const ordered=/^(\d{4})[/.](\d{2})[/.](\d{2})$/.exec(value);
  if(ordered)return date(ordered.slice(1).join('-'));
  const localized=/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if(localized){
    const [,first,second,year]=localized;
    if(Number(first)>12&&Number(second)<=12)return date([year,second.padStart(2,'0'),first.padStart(2,'0')].join('-'));
    if(Number(second)>12&&Number(first)<=12)return date([year,first.padStart(2,'0'),second.padStart(2,'0')].join('-'));
  }
  return date(value);
}

function parse(pages,knownLots){
  const sections=pages.map(page=>{
    const lines=page.text.split(/\r?\n/u).map(line=>line.trim()).filter(Boolean);
    const origin=record=>({...record,page:page.page,sourceKind:page.sourceKind});
    return {page,title:heading(page.text).map(origin),lots:values(lines,lotLabel).map(origin),
      skus:values(lines,skuLabel).map(origin),expiry:values(lines,expiryLabel).concat(lines.filter(line=>/^no (?:expiry|expiration)/iu.test(line)&&noExpiry.test(line)).map(line=>({value:line,quote:line}))).map(origin)};
  });
  const titles=sections.flatMap(part=>part.title),type=[...new Set(titles.map(row=>row.kind))];
  if(type.length!==1)return {links:[],reason:'Confirm which certificate type applies to this complete original.'};
  if(sections.some(({page,title,lots,skus,expiry})=>{
    const hasEvidence=title.length||lots.length||skus.length||expiry.length;
    return page.requiresSourceConfirmation||/\[(?:Tracked deletion|Struck-out text)/.test(page.text)||
      hasEvidence&&(page.sourceKind==='scan'||page.sourceKind==='mixed'||/comments|footnotes|endnotes/i.test(page.sourceName||''));
  }))return {links:[],reason:'Check the original scanned, annotated or mixed evidence before linking a certificate.'};
  const identifiers=sections.flatMap(part=>part.lots),productCodes=sections.flatMap(part=>part.skus),expiry=sections.flatMap(part=>part.expiry);
  if(!identifiers.length||!productCodes.length)return {links:[],reason:'The original needs an explicit product code and exact lot. Choose the recorded lot after checking the original.'};
  const distinctLots=new Set(identifiers.map(row=>row.value));
  const records=distinctLots.size===1?[{lots:identifiers,skus:productCodes,expiry}]:sections.filter(part=>part.lots.length||part.skus.length||part.expiry.length);
  const links=[];
  for(const record of records){
    const matches=knownLots.filter(row=>record.lots.length&&record.skus.length&&record.lots.every(l=>l.value===row.code)&&
      record.skus.every(s=>[row.sku,row.supplier_sku].filter(Boolean).some(code=>s.value.toLowerCase()===code.toLowerCase())));
    if(matches.length!==1)return {links:[],reason:'The printed product and lot do not identify one authorized recorded lot for every certificate section.'};
    const candidate=matches[0];
    if(!record.expiry.length)return {links:[],reason:'Confirm the expiry date or that this original has no stated expiry.'};
    let dates;
    try{dates=[...new Set(record.expiry.map(row=>printedDate(row.value)))];}
    catch{return {links:[],reason:'The printed expiry needs an exact calendar date confirmed by the owner.'};}
    if(dates.length!==1)return {links:[],reason:'The original shows different expiration values. Confirm the applicable date.'};
    if(record.lots.some(l=>!contains(l.quote,candidate.code))||record.skus.some(s=>!contains(s.quote,s.value)))
      return {links:[],reason:'Check the complete printed identity against the recorded lot.'};
    const lot=record.lots[0],sku=record.skus[0],end=record.expiry[0];
    links.push({lotId:candidate.id,skuId:candidate.sku_id,kind:type[0],expiresOn:dates[0],page:lot.page,sourceKind:lot.sourceKind,
      title:titles[0].quote,titlePage:titles[0].page,skuQuote:sku.quote,skuPage:sku.page,lotQuote:lot.quote,lotPage:lot.page,
      expiryQuote:end.quote,expiryPage:end.page});
  }
  const byLot=new Map();
  for(const p of links){
    if(byLot.has(p.lotId)&&byLot.get(p.lotId).expiresOn!==p.expiresOn)
      return {links:[],reason:'The original gives conflicting expiry dates for the same lot.'};
    if(!byLot.has(p.lotId))byLot.set(p.lotId,p);
  }
  return {links:[...byLot.values()],reason:null};
}

function lotCodes(pages){return [...new Set(pages.flatMap(page=>values(page.text.split(/\r?\n/u).map(line=>line.trim()),lotLabel).map(row=>row.value)).filter(Boolean))];}

module.exports={date,heading,parse,lotCodes};

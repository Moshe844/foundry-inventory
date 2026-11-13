'use strict';
// Job 207: reads a rule the owner writes in plain words. No AI is involved:
// the same words always give the same reading, and words it cannot read
// exactly are refused with the reason and examples it can read. It never
// guesses.
//
// read() returns {kind, ...words} for one of these kinds, or throws a
// ValidationError whose message says why and what to write instead:
//   watch     "Tell me if any Nike item drops under 20"        (job 167's reader)
//   reorder   "Reorder SKU-1 at 20 up to 60 at Brooklyn"
//             "Keep a buffer of 10 units of SKU-1"
//   approval  "Purchase orders over $5,000 go to Sarah for approval, not me"
//   split     "Always split Acme POs over $10,000 by delivery date"
//   combine   "Combine Acme POs for Brooklyn into one, up to $2,000"
//   supplier  "Always order SKU-1 from Acme" / "Never order the Shoes category from Beta"
//   built-in  "Never order from a new supplier without my OK" (already true)
// Names (products, suppliers, places, people) are looked up exactly in the
// records afterwards, by plain-rules.js.
const {ValidationError}=require('../domain/errors');

const MAX=320;
// Currency codes are capitals only, so "over $500 for Brooklyn" keeps "for".
const MONEY='((?:[A-Z]{3}\\s?)?[$€£]?\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:k|thousand)\\b)?(?:\\s?(?!for\\b)[A-Z]{3}\\b)?)';
const N='(\\d{1,9})';
const EXAMPLES=[
  {kind:'Watch',text:'Tell me if any Nike item drops under 20',plan:'Starter'},
  {kind:'Reorder',text:'Reorder SKU-1 at 20 up to 60',plan:'Starter'},
  {kind:'Buffer',text:'Keep a buffer of 10 units of SKU-1 at Brooklyn',plan:'Starter'},
  {kind:'Supplier',text:'Always order SKU-1 from Acme',plan:'Starter'},
  {kind:'Supplier',text:'Never order anything in the Shoes category from Beta',plan:'Starter'},
  {kind:'Combine',text:'Combine Acme POs for Brooklyn into one, up to $2,000',plan:'Growth'},
  {kind:'Approval',text:'Purchase orders over $5,000 go to Sarah for approval, not me',plan:'Pro'},
  {kind:'Split',text:'Always split Acme POs over $10,000 by delivery date',plan:'Pro'},
];
const refuse=(why,example)=>{throw new ValidationError(why+(example?' For example: “'+example+'”.':''));};

function clean(sentence){
  return String(sentence??'').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim();
}
function normal(sentence){
  return clean(sentence).replace(/[.!?]+$/,'').trim().replace(/^(?:please|i\s+want\s+you\s+to|you\s+should|from\s+now\s+on,?)\s+/i,'').trim();
}
// "$10,000", "10k", "€500", "1,200.50 EUR" -> {amount:'10000', symbol, code}.
function money(raw){
  const amount=String(raw||'').trim().replace(/(?<=\d\s?)(?:k|thousand)\b/i,word=>word.toLowerCase());
  const m=/^([A-Z]{3})?\s?([$€£])?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|thousand)?\s?([A-Z]{3})?$/.exec(amount);
  if(!m)refuse('StockChief could not read the amount “'+raw+'”.','$5,000');
  const code=(m[1]||m[5]||'').toUpperCase()||null;
  if(m[1]&&m[5]&&m[1].toUpperCase()!==m[5].toUpperCase())refuse('The amount names two currencies.');
  let digits=m[3];
  if(digits.includes(',')&&!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(digits))refuse('StockChief could not read the amount “'+raw+'”. Write it like 10,000 or 10000.');
  digits=digits.replace(/,/g,'');
  if(m[4]){const [whole,fraction='']=digits.split('.');if(fraction.length>3)refuse('Write the amount in full, like 10,500.');
    digits=String(BigInt(whole+fraction.padEnd(3,'0')));}
  if(!/[1-9]/.test(digits))refuse('The amount must be more than zero.');
  return {amount:digits,symbol:m[2]||null,code};
}
const strip=text=>text.trim().replace(/^["']+|["']+$/g,'').replace(/^(?:the|our|my)\s+/i,'').trim();
function supplierName(text){
  const name=strip(text).replace(/^supplier\s+/i,'').replace(/\s+supplier$/i,'').trim();
  if(!name)refuse('Name the supplier.');
  return name;
}

const APPROVALS=[
  ['purchase',/^(?:all\s+|any\s+)?(?:purchase\s+orders?|pos?|purchases|orders?)$/i],
  ['refund',/^(?:all\s+|any\s+)?(?:refunds?(?:\s+and\s+credits?)?|credits?(?:\s+and\s+refunds?)?|credit\s+notes?)$/i],
  ['adjustment',/^(?:all\s+|any\s+)?(?:stock\s+)?(?:adjustments?(?:\s+and\s+write[- ]?offs?)?|write[- ]?offs?)$/i],
  ['landed_cost',/^(?:all\s+|any\s+)?landed\s+costs?$/i],
  ['supplier_price',/^(?:all\s+|any\s+)?supplier\s+price\s+changes?$/i],
  ['transfer',/^(?:all\s+|any\s+)?(?:stock\s+)?transfers?$/i],
  ['return',/^(?:all\s+|any\s+)?returns?$/i],
];
function approval(t){
  let m=new RegExp('^(.+?)(?:\\s+(?:over|above|of\\s+more\\s+than|more\\s+than|worth\\s+more\\s+than|bigger\\s+than)\\s+'+MONEY+')?\\s+(?:go|goes|should\\s+go|must\\s+go|are\\s+sent|get\\s+sent|gets\\s+sent|is\\s+sent)\\s+to\\s+(.+?)(?:\\s+for\\s+(?:approval|sign[- ]?off|review))?(?:,?\\s+(?:and\\s+)?(?:not|instead\\s+of)\\s+me)?$','i').exec(t);
  if(!m)m=new RegExp('^send\\s+(.+?)(?:\\s+(?:over|above|of\\s+more\\s+than|more\\s+than)\\s+'+MONEY+')?\\s+to\\s+(.+?)\\s+for\\s+(?:approval|sign[- ]?off|review)(?:,?\\s+(?:and\\s+)?(?:not|instead\\s+of)\\s+me)?$','i').exec(t);
  if(!m)return null;
  const found=APPROVALS.find(([,pattern])=>pattern.test(m[1].trim()));
  if(!found)return null;
  return {kind:'approval',approval:found[0],ordersWord:/^(?:all\s+|any\s+)?orders?$/i.test(m[1].trim()),money:m[2]?money(m[2]):null,person:strip(m[3])};
}

const SPLIT_HOW='Say how to split them: “by warehouse”, “by delivery date”, or “into orders of up to $5,000”.';
function split(t){
  const m=new RegExp('^(?:always\\s+)?split\\s+(?:any\\s+|all\\s+|every\\s+)?(?:(.+?)\\s+)?(?:purchase\\s+orders?|pos?|orders?)(?:\\s+(?:from|to|with|for)\\s+(.+?))?\\s+(?:over|above|of\\s+more\\s+than|more\\s+than|bigger\\s+than)\\s+'+MONEY+'(?:,?\\s+(.+))?$','i').exec(t);
  if(!m){if(/^(?:always\s+)?split\b/i.test(t))refuse('StockChief reads split rules with a supplier, an amount and how to split.','Always split Acme POs over $10,000 by delivery date');return null;}
  const supplier=m[2]||m[1];
  if(!supplier||/^(?:any|all|every|big|large|the)$/i.test(supplier.trim()))refuse('Name the supplier whose orders to split. Each split rule is for one supplier.','Always split Acme POs over $10,000 by delivery date');
  const how=(m[4]||'').trim();let strategy,budget=null,places=null;
  let rest=how,w;
  if((w=/^(.*?)\s+(?:for|at)\s+(.+)$/i.exec(rest))&&!/^into\b/i.test(rest)){rest=w[1];places=w[2];}
  if(/^by\s+(?:receiving\s+)?(?:warehouses?|locations?|sites?)$/i.test(rest))strategy='warehouse';
  else if(/^by\s+(?:delivery\s+)?dates?$|^by\s+delivery(?:\s+dates?)?$/i.test(rest))strategy='delivery-date';
  else if((w=new RegExp('^into\\s+(?:orders|pos|parts|pieces)\\s+(?:of\\s+)?(?:up\\s+to|at\\s+most|no\\s+more\\s+than|under|below)\\s+'+MONEY+'$','i').exec(rest))){strategy='budget';budget=money(w[1]);}
  else if(/deliver/i.test(rest))refuse('StockChief splits a big purchase order by the delivery date on each line, by receiving warehouse, or into orders under an amount. It cannot choose a number of deliveries. '+SPLIT_HOW);
  else refuse(SPLIT_HOW);
  return {kind:'split',supplier:supplierName(supplier),money:money(m[3]),strategy,budget,places};
}

function combine(t){
  if(!/^(?:always\s+)?combine\b/i.test(t))return null;
  const parts=/^(?:always\s+)?combine\s+(.+?)\s+into\s+one(?:\s+(?:order|po|purchase\s+order))?(?:,?\s+(.+))?$/i.exec(t);
  if(!parts)refuse('StockChief reads combine rules with a supplier, a receiving place and the largest combined order.','Combine Acme POs for Brooklyn into one, up to $2,000');
  let left=parts[1].replace(/^(?:all\s+|any\s+|the\s+)?(?:small\s+|draft\s+|unsent\s+)*/i,''),place=null,m;
  if((m=/^(.+?)\s+(?:for|to|at|into)\s+(.+)$/i.exec(left))){left=m[1];place=strip(m[2]);}
  let supplier=null;
  if((m=/^(?:small\s+|draft\s+)*(?:purchase\s+orders?|pos?|orders?|drafts?)\s+(?:from|with)\s+(.+)$/i.exec(left)))supplier=m[1];
  else if((m=/^(.+?)\s+(?:small\s+|draft\s+)*(?:purchase\s+orders?|pos?|orders?|drafts?)$/i.exec(left)))supplier=m[1];
  if(!supplier)refuse('Name the supplier whose orders to combine.','Combine Acme POs for Brooklyn into one, up to $2,000');
  const limit=parts[2]?new RegExp('^(?:of\\s+)?(?:up\\s+to|at\\s+most|no\\s+more\\s+than|under|below)\\s+'+MONEY+'$','i').exec(parts[2].trim()):null;
  if(!limit)refuse('Say the largest combined order StockChief may make.','Combine Acme POs for Brooklyn into one, up to $2,000');
  return {kind:'combine',supplier:supplierName(supplier),place,money:money(limit[1])};
}

function scope(text){
  const s=strip(text);let m;
  if(/^(?:anything|everything|all\s+(?:items|products|stock)|any\s+(?:item|product))$/i.test(s))return {scope:'ALL'};
  if((m=/^(?:(?:anything|everything|items?|products?)\s+in\s+)?(?:the\s+)?(.+?)\s+category$/i.exec(s))||(m=/^(?:the\s+)?category\s+(.+)$/i.exec(s)))return {scope:'CATEGORY',name:strip(m[1])};
  if(!s)refuse('Name the product, SKU or category.');
  return {scope:'PRODUCT',name:s};
}
function supplierChoice(t){
  if(/\b(?:only\s+if|unless|cheaper|first;|first,|otherwise|instead\s+if|when\s+it'?s)\b/i.test(t)&&/\b(?:order|buy|use)\b/i.test(t)&&/^(?:always|never|only|order|use|buy)\b/i.test(t))
    refuse('StockChief reads “always” and “never” supplier rules. It cannot read a supplier choice with a condition, such as a price difference.','Always order SKU-1 from Acme');
  let m;
  if((m=/^(?:always|only)\s+(?:order|buy|get|purchase)\s+(.+?)\s+from\s+(.+)$/i.exec(t)))return {kind:'supplier',choice:'ALWAYS',...scope(m[1]),supplier:supplierName(m[2])};
  if((m=/^always\s+use\s+(.+?)\s+for\s+(.+)$/i.exec(t)))return {kind:'supplier',choice:'ALWAYS',...scope(m[2]),supplier:supplierName(m[1])};
  if((m=/^(?:never|don'?t\s+ever|do\s+not)\s+(?:order|buy|get|purchase)\s+from\s+(.+)$/i.exec(t)))return {kind:'supplier',choice:'NEVER',scope:'ALL',supplier:supplierName(m[1])};
  if((m=/^(?:never|don'?t\s+ever|do\s+not)\s+(?:order|buy|get|purchase)\s+(.+?)\s+from\s+(.+)$/i.exec(t)))return {kind:'supplier',choice:'NEVER',...scope(m[1]),supplier:supplierName(m[2])};
  if((m=/^(?:never|do\s+not)\s+use\s+(.+?)(?:\s+for\s+(.+))?$/i.exec(t)))return {kind:'supplier',choice:'NEVER',...(m[2]?scope(m[2]):{scope:'ALL'}),supplier:supplierName(m[1])};
  return null;
}

const AMBIGUOUS_MINIMUM=name=>'StockChief won’t guess what a minimum should do. Say which one you mean: “Reorder '+name+' at 20”, “Keep a buffer of 20 units of '+name+'”, or “Tell me if '+name+' drops under 20”.';
function reorder(t){
  let m;
  if((m=new RegExp('^reorder\\s+(.+?)\\s+(?:at|when\\s+it\\s+(?:drops|falls|gets|goes)\\s+to|when\\s+(?:stock|it)\\s+(?:is|hits|reaches|gets\\s+to))\\s+'+N+'(?:\\s+units?)?(?:\\s+(?:up\\s+to|back\\s+up\\s+to|to)\\s+'+N+'(?:\\s+units?)?)?(?:\\s+(?:at|in)\\s+(.+))?$','i').exec(t))){
    const point=Number(m[2]),target=m[3]==null?null:Number(m[3]);
    if(target!==null&&target<point)refuse('The level to reorder up to must be at least the reorder point.');
    return {kind:'reorder',product:strip(m[1]),reorderPoint:point,targetStock:target,safetyStock:null,place:m[4]?strip(m[4]):null};
  }
  if(/^reorder\b/i.test(t))refuse('StockChief reads reorder rules with a product and a whole number of units.','Reorder SKU-1 at 20 up to 60');
  if((m=new RegExp('^keep\\s+(?:a\\s+)?(?:buffer|safety\\s+stock|cushion)\\s+of\\s+'+N+'(?:\\s+units?)?\\s+(?:of|on|for)\\s+(.+?)(?:\\s+(?:at|in)\\s+(.+))?$','i').exec(t))||
    (m=new RegExp('^keep\\s+'+N+'(?:\\s+units?)?\\s+(?:of\\s+)?(.+?)\\s+as\\s+(?:a\\s+)?(?:buffer|safety\\s+stock|cushion)(?:\\s+(?:at|in)\\s+(.+))?$','i').exec(t)))
    return {kind:'reorder',product:strip(m[2]),reorderPoint:null,targetStock:null,safetyStock:Number(m[1]),place:m[3]?strip(m[3]):null};
  if((m=/^keep\s+\d+\s+(?:days?|weeks?|months?)\b/i.exec(t)))
    refuse('StockChief can’t read a days-of-stock rule exactly from plain words. Write a reorder point, or set target days of stock in Ask, where you approve the exact setting.','Reorder SKU-1 at 20 up to 60');
  if((m=new RegExp('^(?:keep|hold|have)\\s+(?:at\\s+least|a\\s+minimum\\s+of|minimum|min)?\\s*'+N+'(?:\\s+units?)?\\s+(?:of|on)\\s+(.+?)(?:\\s+(?:on\\s+hand|in\\s+stock))?(?:\\s+(?:at|in)\\s+.+)?$','i').exec(t)))
    refuse(AMBIGUOUS_MINIMUM(strip(m[2])));
  return null;
}

function read(sentence){
  const original=clean(sentence);
  if(!original)refuse('Write the rule first.',EXAMPLES[1].text);
  if(original.length>MAX)refuse('Keep the rule to '+MAX+' characters.');
  const t=normal(original);
  if(/\bnew\s+suppliers?\b/i.test(t)&&/\b(?:never|without|ask|approv\w*|ok|okay|check)\b/i.test(t))return {kind:'built-in',sentence:original};
  if(/^(?:(?:tell|notify|alert|warn|email|ping|text)\s+(?:me|us)|let\s+(?:me|us)\s+know|i\s+want\s+to\s+know|watch\s+for)\b/i.test(t))return {kind:'watch',sentence:original};
  const found=split(t)||combine(t)||approval(t)||supplierChoice(t)||reorder(t);
  if(found)return {...found,sentence:original};
  return refuse('StockChief can’t read that rule exactly, so it saved nothing. It reads alerts, reorder points and buffers, supplier choices, combining and splitting purchase orders, and who approves what.',EXAMPLES[0].text);
}

module.exports={read,money,EXAMPLES,MAX};

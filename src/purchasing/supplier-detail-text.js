'use strict';
// Job 96: reads supplier detail changes from ordinary supplier emails and their
// readable attachments. It only recognises clearly stated facts. Anything that
// looks like a change but cannot be read exactly is returned as unclear, and
// price, payment or bank instructions are returned for a person. It never
// guesses a product, a unit or a value.
const CUE=/\b(?:new|changed?|changing|updated?|updating|now|moving forward|going forward|from now on|effective|starting|replac\w*|taking over|has joined|will be|increas\w*|decreas\w*|extend\w*|reduc\w*|longer|shorter|go(?:es|ing)? (?:up|down)|rais\w*|ris(?:e|es|ing)|please note)\b/i;
const LEAD=/\blead[\s-]?times?\b/i,MOQ=/\b(?:minimum order(?:\s+(?:quantity|qty))?|min(?:imum)?\.?\s+order\s+(?:qty|quantity)|moq)\b/i;
const PACK=/\b(?:case[\s-]?pack|pack[\s-]?size|pack quantity|inner pack|per (?:case|box|carton|pack|bag|bundle)|(?:cases?|box(?:es)?|cartons?|packs?|bags?|bundles?) of)\b/i;
const CONTACT=/\b(?:contact|account manager|sales rep|representative|rep|phone|telephone|tel|mobile|direct line|e-?mail|email address|send (?:all )?(?:purchase )?orders|orders to|po address)\b/i;
const OTHER=/\b(?:prices?|pricing|costs?|invoic\w*|payments?|pay|bank|account number|routing|iban|swift|remit\w*|wire|ach|net\s?\d{1,3}|surcharges?|discounts?|rebates?|freight|minimum order (?:value|amount))\b/i;
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
function singular(word){const w=String(word||'').toLowerCase().replace(/[.)]+$/,'');if(/(?:xes|ches|shes|sses)$/.test(w))return w.slice(0,-2);if(w.endsWith('s')&&!w.endsWith('ss'))return w.slice(0,-1);return w;}
function sameUnit(a,b){return Boolean(a&&b)&&singular(a)===singular(b);}
function isoDate(y,m,d){const text=String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0'),t=Date.parse(text);return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===text?text:null;}
function dates(sentence){
 if(!/\b(?:effective|starting|start(?:s|ing)? on|from|as of|beginning|commencing|takes effect)\b/i.test(sentence))return [];
 const out=[];let m;const iso=/\b(\d{4})-(\d{2})-(\d{2})\b/g;while((m=iso.exec(sentence)))out.push(isoDate(m[1],m[2],m[3]));
 const named=new RegExp('\\b(?:('+MONTHS.join('|')+')\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})|(\\d{1,2})(?:st|nd|rd|th)?\\s+('+MONTHS.join('|')+'),?\\s+(\\d{4}))\\b','gi');
 while((m=named.exec(sentence))){const month=MONTHS.indexOf((m[1]||m[5]).toLowerCase())+1;out.push(isoDate(m[3]||m[6],month,m[2]||m[4]));}
 return out;
}
function sentences(text){
 const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),out=[];
 for(const line of lines){const trimmed=line.trim();if(!trimmed){out.push('');continue;}for(const part of trimmed.split(/(?<=[.!?;])\s+(?=[A-Z(])/))out.push(part.trim());}
 return out;
}
// Drop quoted history and the sign-off so signature details are not read as changes.
function ownWords(body){
 const lines=String(body||'').split(/\r?\n/),cut=lines.findIndex(l=>/^\s*(?:--\s*$|(?:kind |best |warm )?regards\b|sincerely\b|best wishes\b|cheers\b|thanks,?\s*$|thank you,?\s*$)/i.test(l));
 return require('../connections/reply-triage').prose((cut>=0?lines.slice(0,cut):lines).join('\n'));
}
function codeIndex(products){
 const index=new Map();const add=(key,row,kind)=>{const k=String(key||'').trim().toLowerCase();if(!k)return;if(!index.has(k))index.set(k,[]);const list=index.get(k);if(!list.some(e=>e.row.id===row.id))list.push({row,kind});};
 for(const row of products){add(row.code,row,'sku');add(row.supplier_sku,row,'supplierSku');}
 return index;
}
function codesIn(sentence,index){
 // Values are read from the sentence with product codes taken out, so digits in
 // a code such as VENDOR-1 are never read as a quantity or a number of days.
 const found=new Map(),ambiguous=[];
 const plain=sentence.replace(/[A-Za-z0-9][A-Za-z0-9._\/#-]*[A-Za-z0-9]|[A-Za-z0-9]/g,token=>{
  const hits=index.get(token.toLowerCase());if(!hits)return token;
  if(hits.length>1)ambiguous.push(token);else found.set(hits[0].row.id,hits[0].row);return 'ITEM';
 });
 return {rows:[...found.values()],ambiguous,plain};
}
function number(text){const value=String(text).replace(/,/g,'');return /^\d{1,6}(?:\.\d{1,6})?$/.test(value)?Number(value):null;}
function leadValue(sentence){
 const range=/(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})\s*(?:business |working |calendar )?(?:days?|weeks?|wks?)\b/i.exec(sentence);
 const fromTo=/\bfrom\s+(\d{1,3})\s*(days?|weeks?|wks?)\s+to\s+(\d{1,3})\s*(days?|weeks?|wks?)\b/i.exec(sentence);
 const days=(n,unit)=>{const v=Number(n)*(/^w/i.test(unit)?7:1);return Number.isInteger(v)&&v<=365?v:null;};
 if(fromTo){const before=days(fromTo[1],fromTo[2]),value=days(fromTo[3],fromTo[4]);return value===null?{unclear:true}:{value,statedBefore:before};}
 if(range)return {unclear:true};
 const all=[...sentence.matchAll(/(\d{1,3}(?:\.\d+)?)[\s-]*(business |working |calendar )?(days?|weeks?|wks?)\b/gi)];
 if(all.length!==1||all[0][2]&&!/calendar/i.test(all[0][2]))return {unclear:true};
 const value=days(all[0][1],all[0][3]);return value===null?{unclear:true}:{value};
}
function moqValue(sentence){
 const at=sentence.search(MOQ),rest=sentence.slice(at);
 if(/(?:[$€£¥]|\b[A-Z]{3}\s?)\s?\d/.test(rest.slice(0,60)))return {money:true};
 const fromTo=/\bfrom\s+(\d[\d,]*)\s*([a-z]+)?\s+to\s+(\d[\d,]*)\s*([a-z]+)?/i.exec(rest);
 if(fromTo){const value=number(fromTo[3]);return value===null?{unclear:true}:{value,unit:fromTo[4]||fromTo[2]||null,statedBefore:number(fromTo[1])};}
 const all=[...rest.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*([a-z]+)?/gi)];if(all.length!==1)return {unclear:true};
 const value=number(all[0][1]);return value===null?{unclear:true}:{value,unit:all[0][2]||null};
}
function packValue(sentence){
 let m=/(\d{1,6})\s*([a-z]+)?\s+(?:per|in each|to a|in a|in every)\s+(case|box|carton|pack|bag|bundle)\b/i.exec(sentence);
 if(m)return {value:Number(m[1]),container:m[3],itemWord:m[2]||null};
 m=/\b(cases?|box(?:es)?|cartons?|packs?|bags?|bundles?)\s+of\s+(\d{1,6})\b/i.exec(sentence);if(m)return {value:Number(m[2]),container:m[1]};
 m=/\b(?:case[\s-]?pack|pack[\s-]?size|pack quantity|inner pack)\b(?:\s+(?:is|will be|changes?|has changed))?(?:\s+now)?(?:\s+(?:from\s+(\d{1,6})\s+)?to)?\s*[:=]?\s*(\d{1,6})\b/i.exec(sentence);
 if(m)return {value:Number(m[2]),statedBefore:m[1]?Number(m[1]):undefined};
 return {unclear:true};
}
const NAME="([A-Z][\\p{L}'’.-]+(?:\\s+[A-Z][\\p{L}'’.-]+){0,3})";
function contactName(sentence){
 const forms=[new RegExp('\\b(?:new|our new|your new)\\s+(?:account manager|contact|sales contact|sales rep(?:resentative)?|representative|rep)\\s*(?:is|will be|:)\\s*'+NAME,'u'),
  new RegExp('^(?:new\\s+)?contact(?:\\s+name)?\\s*:\\s*'+NAME+'\\s*$','u'),
  new RegExp(NAME+'\\s+(?:is|will be)\\s+(?:now\\s+)?(?:your|our)\\s+(?:new\\s+)?(?:account manager|contact|sales contact|representative|rep)\\b','u')];
 for(const form of forms){const m=form.exec(sentence);if(m)return m[1].replace(/[.,]+$/,'').trim();}
 return null;
}
function phoneValue(sentence){
 if(!/\b(?:phone|telephone|tel|mobile|direct line|number)\b/i.test(sentence))return null;
 const m=/(\+?\d[\d ().-]{5,30}\d(?:\s*(?:x|ext\.?)\s*\d{1,8})?)/i.exec(sentence.replace(/\b\d{4}-\d{2}-\d{2}\b/g,''));
 return m&&/^\+?[\d ()-.]{5,35}(?:\s*(?:x|ext\.?)\s*\d{1,8})?$/i.test(m[1].trim())?m[1].trim():null;
}
function emailValues(sentence){
 if(!/\b(?:e-?mail|address|send (?:all )?(?:purchase )?orders|purchase orders?|pos?|orders)\b/i.test(sentence))return [];
 return [...new Set((sentence.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]).map(v=>v.toLowerCase()))];
}
// Reads a free-form text block. Context is a product code heading, such as a
// line that only says "VENDOR-1:", applying to the bullet lines below it.
function readProse(text,{index,subjectCue=false,source}){
 const found=[],unclear=[],other=[],effective=[];let context=null;
 for(const raw of sentences(text)){
  if(!raw){context=null;continue;}
  const sentence=raw.replace(/^(?:[-*•]|\d{1,2}[.)])\s+/,'').trim(),codes=codesIn(sentence,index),cue=CUE.test(sentence.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,''))||subjectCue;
  const heading=codes.rows.length===1&&sentence.replace(/^(?:for|item|sku|product|code)\s+/i,'').replace(/[:\s]+$/,'').toLowerCase()===(codes.rows[0].code||'').toLowerCase()||codes.rows.length===1&&sentence.replace(/^(?:for|item|sku|product|code)\s+/i,'').replace(/[:\s]+$/,'').toLowerCase()===(codes.rows[0].supplier_sku||'').toLowerCase();
  if(heading){context=codes.rows[0];continue;}
  for(const date of dates(codes.plain))effective.push(date);
  if(codes.ambiguous.length&&(LEAD.test(sentence)||MOQ.test(sentence)||PACK.test(sentence))){unclear.push({source,quote:sentence,reason:'A product code matches more than one product.'});continue;}
  const targets=codes.rows.length?codes.rows:context?[context]:[];
  const quote=sentence.slice(0,400);let matched=false;
  if(LEAD.test(sentence)&&/\d/.test(sentence)){
   const v=leadValue(codes.plain);matched=true;
   if(v.unclear||!cue)unclear.push({source,quote,reason:v.unclear?'The lead time is a range, in working days or not a whole number of days.':'The lead time is mentioned without saying it changed.'});
   else if(targets.length)for(const row of targets)found.push({source,quote,row,field:'lead_time_days',value:v.value,statedBefore:v.statedBefore});
   else found.push({source,quote,row:null,field:'default_lead_time_days',value:v.value,statedBefore:v.statedBefore});
  }
  if(MOQ.test(sentence)&&/\d/.test(sentence)){
   const v=moqValue(codes.plain);matched=true;
   if(v.money)other.push({source,quote,reason:'A minimum order amount is a commercial term.'});
   else if(v.unclear||!cue||!targets.length)unclear.push({source,quote,reason:!targets.length?'The minimum order does not name an exact product code.':v.unclear?'The minimum order quantity is not one clear number.':'The minimum order is mentioned without saying it changed.'});
   else for(const row of targets){
    const unit=v.unit&&!/^(?:for|per|and|on|of|is|are|the|from|to|now)$/i.test(v.unit)?v.unit:null;
    if(unit?sameUnit(unit,row.purchase_unit):Number(row.units_per_purchase_unit)===1)found.push({source,quote,row,field:'minimum_order_quantity',value:v.value,statedBefore:v.statedBefore});
    else unclear.push({source,quote,reason:'The minimum order must be stated in the product’s purchase unit ('+row.purchase_unit+').'});
   }
  }
  if(PACK.test(sentence)&&/\d/.test(sentence)&&!LEAD.test(sentence)){
   const v=packValue(codes.plain);matched=true;
   if(v.unclear||!cue||!targets.length||!(v.value>0))unclear.push({source,quote,reason:!targets.length?'The pack size does not name an exact product code.':'The pack size is not one clear whole number of stock units per purchase unit.'});
   else for(const row of targets){
    if(v.container&&!sameUnit(v.container,row.purchase_unit))unclear.push({source,quote,reason:'The pack size is for a '+singular(v.container)+', but this product is bought by the '+row.purchase_unit+'.'});
    else found.push({source,quote,row,field:'units_per_purchase_unit',value:v.value,statedBefore:v.statedBefore});
   }
  }
  if(CONTACT.test(sentence)&&cue&&!LEAD.test(sentence)&&!MOQ.test(sentence)){
   const name=contactName(codes.plain),phone=phoneValue(codes.plain),emails=emailValues(codes.plain);
   if(name)found.push({source,quote,row:null,field:'contact_name',value:name});
   if(phone)found.push({source,quote,row:null,field:'phone',value:phone});
   for(const email of emails)found.push({source,quote,row:null,field:'email',value:email});
   if(!name&&!phone&&!emails.length&&/\b(?:new|changed|updated)\b/i.test(sentence))unclear.push({source,quote,reason:'New contact details are mentioned but not stated exactly.'});
   matched=matched||Boolean(name||phone||emails.length);
  }
  if(!matched&&OTHER.test(sentence)&&cue)other.push({source,quote,reason:'Prices, payment, bank and other commercial terms always need a person.'});
 }
 return {found,unclear,other,effective};
}
const COLUMNS=[
 ['supplierSku',/^(?:supplier|vendor)\s+(?:sku|code|item(?: code| no\.?| number)?|part(?: number| no\.?)?)$|^your (?:sku|code)$/],
 ['sku',/^(?:our )?sku$/],
 ['code',/^(?:item(?: code| no\.?| number| #)?|product(?: code)?|code|part(?: number| no\.?)?)$/],
 ['purchaseUnit',/^(?:purchase unit|unit|uom|unit of measure|pack unit|order unit|selling unit)$/],
 ['lead',/^(?:lead[\s-]?time|lt)(?:\s*\(?(days?|weeks?)\)?)?$/],
 ['moq',/^(?:moq|min(?:imum)?\.?\s*order(?:\s*(?:qty|quantity))?)(?:\s*\(([a-z]+)\))?$/],
 ['pack',/^(?:pack size|case pack|pack qty|pack quantity|inner pack|(?:units?|qty|pcs|pieces) per (?:case|box|carton|pack))$/]
];
// Reads a table such as a CSV or spreadsheet attachment. Rows for products this
// business does not buy from the supplier are ignored; prices are left to the
// supplier price-list job.
function readTable(text,{index,source}){
 const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n'),found=[],unclear=[];
 for(let at=0;at<lines.length;at++){
  const line=lines[at];if(!line.trim())continue;
  const delimiter=line.includes('\t')?'\t':line.includes('|')?'|':line.includes(';')?';':line.includes(',')?',':null;if(!delimiter)continue;
  const head=line.split(delimiter).map(v=>v.trim().toLowerCase().replace(/^"|"$/g,'')),map={};
  head.forEach((name,i)=>{for(const [key,pattern]of COLUMNS){const m=pattern.exec(name);if(m&&map[key]===undefined){map[key]={i,unit:m[1]||null};break;}}});
  const code=map.supplierSku||map.sku||map.code;if(!code||!(map.lead||map.moq||map.pack))continue;
  let end=at+1;while(end<lines.length&&lines[end].trim()&&lines[end].includes(delimiter))end++;
  let grid;try{grid=require('../imports/parser').parseDelimited(lines.slice(at,end).join('\n'),delimiter);}catch{unclear.push({source,quote:line.slice(0,400),reason:'The table could not be read row by row.'});at=end-1;continue;}
  for(const row of grid.slice(1)){
   const value=i=>String(row[i]??'').trim(),codeText=value(code.i);if(!codeText)continue;
   const hits=(index.get(codeText.toLowerCase())||[]).filter(h=>code===map.code||h.kind===(code===map.sku?'sku':'supplierSku'));
   if(!hits.length)continue;const quote=row.join(delimiter===','?', ':' '+delimiter+' ').slice(0,400);
   if(hits.length>1){unclear.push({source,quote,reason:'A product code matches more than one product.'});continue;}
   const product=hits[0].row,unit=map.purchaseUnit?value(map.purchaseUnit.i):null;
   if(unit&&!sameUnit(unit,product.purchase_unit)){unclear.push({source,quote,reason:'The row is for a '+unit+', but this product is bought by the '+product.purchase_unit+'.'});continue;}
   if(map.lead&&value(map.lead.i)){const v=number(value(map.lead.i)),days=v===null?null:v*(/^w/.test(map.lead.unit||'')?7:1);if(days===null||!Number.isInteger(days)||days>365)unclear.push({source,quote,reason:'The lead time is not a whole number of days.'});else found.push({source,quote,row:product,field:'lead_time_days',value:days});}
   if(map.moq&&value(map.moq.i)){const v=number(value(map.moq.i)),stated=map.moq.unit||unit;
    if(v===null)unclear.push({source,quote,reason:'The minimum order quantity is not a number.'});
    else if(stated?sameUnit(stated,product.purchase_unit):Number(product.units_per_purchase_unit)===1)found.push({source,quote,row:product,field:'minimum_order_quantity',value:v});
    else unclear.push({source,quote,reason:'The minimum order must be stated in the product’s purchase unit ('+product.purchase_unit+').'});}
   if(map.pack&&value(map.pack.i)){const v=number(value(map.pack.i));if(v===null||!Number.isInteger(v)||v<1)unclear.push({source,quote,reason:'The pack size is not a whole number of stock units.'});else found.push({source,quote,row:product,field:'units_per_purchase_unit',value:v});}
  }
  at=end-1;
 }
 return {found,unclear};
}
// True when an ordinary supplier email may state changed supplier details.
function mentions(subject,text){const all=String(subject||'')+'\n'+String(text||'');return (LEAD.test(all)||MOQ.test(all)||PACK.test(all)||CONTACT.test(all))&&CUE.test(all);}
function read(texts,{products,subjectCue=false}){
 const index=codeIndex(products),out={found:[],unclear:[],other:[],effective:[]};
 for(const t of texts){
  const table=t.kind==='attachment'?readTable(t.text,{index,source:t.source}):{found:[],unclear:[]};
  const prose=readProse(t.kind==='body'?ownWords(t.text):t.text,{index,subjectCue,source:t.source});
  // A table row is not also prose; prefer the table reading for those lines.
  const tableQuotes=new Set(table.found.concat(table.unclear).map(r=>r.row?.id+':'+r.field));
  out.found.push(...table.found,...prose.found.filter(r=>!(t.kind==='attachment'&&table.found.length&&r.row&&tableQuotes.has(r.row.id+':'+r.field))));
  out.unclear.push(...table.unclear,...(table.found.length?prose.unclear.filter(r=>!/[,;\t|]/.test(r.quote)):prose.unclear));
  out.other.push(...prose.other);out.effective.push(...prose.effective);
 }
 return out;
}
module.exports={read,mentions,readProse,readTable,singular,sameUnit,ownWords};

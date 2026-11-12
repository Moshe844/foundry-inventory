'use strict';

// Job 167: reads a watch rule written in plain words. No AI is involved: the
// same words always give the same rule, and anything unclear is asked back.
//
// A rule names what to watch and a condition:
//   what:      any item; a brand, category, supplier, location or tag
//              ("any Nike item", "any item in the Shoes category",
//               "any item from supplier Acme", "anything at Brooklyn",
//               "any item tagged school"). A bare name is looked up in all five.
//   condition: stock under, over or out; a selling price change; sales above or
//              below a number over a period; a batch expiring within some days.
// parse() returns the rule, or throws a ValidationError whose message is the
// question to ask back.

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');

const EXAMPLE='“Tell me if any Nike item drops under 20”';
const ask=question=>{throw new ValidationError(question);};
const KINDS=['BRAND','CATEGORY','SUPPLIER','LOCATION','TAG'];
const N='(\\d{1,12}(?:\\.\\d{1,6})?)';
const UNITS='(?:\\s+(?:units?|pieces?|pcs|each|items?|in\\s+stock|on\\s+hand|left))?';
const NOUN='(?:items?|products?|skus?|things?|goods|stock|lines?)';

const PERIODS={day:1,days:1,week:7,weeks:7,month:30,months:30,daily:1,weekly:7,monthly:30};
// A trailing period, such as "in a week", "over the last 30 days" or "monthly".
function takePeriod(text){
  let m=/^(.*?)\s+(?:(?:a|per|each|every|in\s+a|in\s+one|over\s+a|within\s+a|during\s+a)\s+(day|week|month)|(?:in|over|within|during|inside)\s+(?:the\s+)?(?:last\s+|past\s+|next\s+|coming\s+)?(\d{1,4})\s+(days?|weeks?|months?)|this\s+(week|month)|(daily|weekly|monthly))$/i.exec(text);
  if(!m)return {text,days:null};
  const days=m[2]?PERIODS[m[2].toLowerCase()]:m[3]?Number(m[3])*PERIODS[m[4].toLowerCase()]:m[5]?PERIODS[m[5].toLowerCase()]:PERIODS[m[6].toLowerCase()];
  if(!Number.isSafeInteger(days)||days<1||days>3650)ask('Choose a period from 1 day to 10 years.');
  return {text:m[1],days};
}

function amount(raw){return exact.safeNumber(raw,{label:'The number in the rule'});}
const below=/^(?:below|under|less\s+than|fewer\s+than|lower\s+than|at\s+or\s+below|at\s+or\s+under|at\s+most|no\s+more\s+than)$/i;
const inclusiveWords=/^(?:at\s+or\s+below|at\s+or\s+under|at\s+most|no\s+more\s+than|at\s+or\s+above|at\s+least|no\s+less\s+than)$/i;

// The condition and the words before it (what to watch).
function condition(text,days){
  let m;
  // Cost is a separate alert; watch rules follow selling prices.
  if(/\bcosts?\b/i.test(text)&&!/\bprices?\b/i.test(text))ask('Watch rules follow selling prices. Write “price” to watch the selling price.');
  // Price changes: "the price of any Nike item changes", "any Nike item changes price".
  if((m=/^(?:the\s+)?(?:selling\s+)?prices?\s+(?:of|for|on)\s+(.+?)\s+(?:changes?|goes\s+up|goes\s+down|rises?|drops?|falls?|moves?|is\s+changed|are\s+changed)$/i.exec(text))||
    (m=/^(.+?)\s+(?:changes?|change)\s+(?:its\s+|their\s+)?(?:selling\s+)?prices?$/i.exec(text))||
    (m=/^(.+?)\s+(?:has|have|gets|get)\s+an?\s+(?:new\s+)?(?:selling\s+)?price(?:\s+change)?$/i.exec(text))||
    (m=/^(.+?)(?:'s|s')\s+(?:selling\s+)?prices?\s+(?:changes?|goes\s+up|goes\s+down|rises?|drops?|falls?|moves?)$/i.exec(text)))
    return {subject:m[1],condition:'PRICE_CHANGE',days:days??7};
  // Expiry: "any item expires within 30 days", "is within 30 days of expiry".
  if((m=/^(.+?)\s+(?:is|are)\s+within\s+(\d{1,4})\s+days?\s+of\s+(?:its\s+|their\s+)?expiry(?:\s+date)?$/i.exec(text)))
    return expiry(m[1],Number(m[2]));
  if((m=/^(.+?)\s+(?:expires?|is\s+expiring|are\s+expiring|goes\s+out\s+of\s+date|go\s+out\s+of\s+date|is\s+about\s+to\s+expire|are\s+about\s+to\s+expire)$/i.exec(text))){
    if(days==null)ask('Within how many days of expiry should StockChief tell you? For example “… expires within 30 days”.');
    return expiry(m[1],days);
  }
  // Sales: "any Nike item sells more than 50 in a week", "sales of any item drop below 5 a month".
  if((m=new RegExp('^(.+?)\\s+(?:sells?|sold)\\s+(more\\s+than|over|above|at\\s+least|less\\s+than|fewer\\s+than|under|below|at\\s+most|no\\s+more\\s+than)\\s+'+N+UNITS+'$','i').exec(text))||
    (m=new RegExp('^(?:the\\s+)?sales\\s+(?:of|for)\\s+(.+?)\\s+(?:are|is|go|goes|get|gets|rise|rises|climb|climbs|drop|drops|fall|falls|dip|dips)?\\s*(above|over|more\\s+than|at\\s+least|below|under|less\\s+than|fewer\\s+than|at\\s+most)\\s+'+N+UNITS+'$','i').exec(text))||
    (m=new RegExp("^(.+?)(?:'s|s')\\s+sales\\s+(?:are|is|go|goes|rise|rises|drop|drops|fall|falls|dip|dips)?\\s*(above|over|more\\s+than|at\\s+least|below|under|less\\s+than|fewer\\s+than|at\\s+most)\\s+"+N+UNITS+'$','i').exec(text))){
    if(days==null)ask('Over how many days should StockChief count sales? For example “… sells more than 50 in a week”.');
    const words=m[2].replace(/\s+/g,' ').toLowerCase();
    return {subject:m[1],condition:below.test(words)?'SALES_BELOW':'SALES_ABOVE',amount:amount(m[3]),inclusive:inclusiveWords.test(words),days};
  }
  // Out of stock.
  if((m=/^(.+?)\s+(?:runs?\s+out(?:\s+of\s+stock)?|sells?\s+out|(?:is|are|goes|go|gets|get)\s+out\s+of\s+stock|(?:hits?|reaches?|drops?\s+to|falls?\s+to|goes\s+to|gets\s+to|is\s+at|are\s+at)\s+(?:zero|0)(?:\s+units?)?)$/i.exec(text))){
    if(days!=null)ask('Stock rules look at stock on hand now. Remove the period, or say “sells …” to watch sales.');
    return {subject:m[1],condition:'OUT_OF_STOCK'};
  }
  if(/\b(?:sells?|sold|sales)\b/i.test(text))ask('Say how many units and over what period, as in “… sells more than 50 in a week”.');
  // Stock under or over a number.
  const verb='(?:drops?|falls?|goes|go|gets?|dips?|is|are|has|have|runs?|rises?|climbs?|reaches?|hits?)';
  if((m=new RegExp('^(.+?)\\s+(?:'+verb+'\\s+)?(?:to\\s+)?(below|under|less\\s+than|fewer\\s+than|lower\\s+than|at\\s+or\\s+below|at\\s+or\\s+under|at\\s+most|no\\s+more\\s+than|above|over|more\\s+than|greater\\s+than|higher\\s+than|at\\s+or\\s+above|at\\s+least|no\\s+less\\s+than)\\s+'+N+UNITS+'$','i').exec(text))||
    (m=new RegExp('^(.+?)\\s+'+verb+'\\s+(?:to\\s+)?'+N+UNITS+'\\s+or\\s+(less|fewer|below|under|lower|more|above|over|higher)$','i').exec(text))){
    if(days!=null)ask('Stock rules look at stock on hand now. Remove the period, or say “sells …” to watch sales.');
    const [words,number]=/^\d/.test(m[2])?[m[3].toLowerCase()==='less'||/fewer|below|under|lower/i.test(m[3])?'at or below':'at or above',m[2]]:[m[2].replace(/\s+/g,' ').toLowerCase(),m[3]];
    const low=below.test(words);
    return {subject:m[1],condition:low?'STOCK_BELOW':'STOCK_ABOVE',amount:amount(number),inclusive:inclusiveWords.test(words)};
  }
  if(/\b(?:drops?|falls?|below|under|less|fewer|low|above|over|more|high|rises?)\b/i.test(text)&&!/\d/.test(text))
    ask('Say the number to compare with, as in '+EXAMPLE+'.');
  return ask('StockChief can watch stock under, over or out, price changes, sales above or below a number, and expiry within some days. Try '+EXAMPLE+'.');
}
function expiry(subject,days){
  if(!Number.isSafeInteger(days)||days<1||days>3650)ask('Choose from 1 to 3,650 days before expiry.');
  return {subject,condition:'EXPIRES_WITHIN',days};
}

// What to watch. A kind is set when the words say it; otherwise `kinds` lists
// what the name could be, to look up.
// A name may itself contain a kind word (a brand called "Brand 0"), so an
// explicit kind also keeps the whole phrase, looked up if the kind finds nothing.
function subject(raw){
  const read=explicitSubject(raw);
  if(!read.kind||read.kind==='ALL')return read;
  const whole=raw.trim().replace(/^(?:any|all|every|each|an?|the|my|our)\s+/i,'').replace(new RegExp('\\s+'+NOUN+'$','i'),'').trim();
  return whole&&whole.length<=100&&whole.toLowerCase()!==read.name.toLowerCase()?{...read,whole}:read;
}
function explicitSubject(raw){
  let s=raw.trim().replace(/^["']+|["']+$/g,'').replace(/^(?:any|all|every|each|an?|the|my|our)\s+(?:of\s+(?:my|our|the)\s+)?/i,'').trim();
  s=s.replace(/^(?:of\s+)?(?:my|our|the)\s+/i,'').trim();
  const name=value=>{const n=value.trim().replace(/^["“']+|["”']+$/g,'').trim();if(!n||n.length>100)ask('Name the brand, category, supplier, location or tag in up to 100 characters.');return n;};
  let m;
  if(!s||/^(?:anything|everything|any\s*thing|every\s*thing)$/i.test(raw.trim())||new RegExp('^'+NOUN+'$','i').test(s))return {kind:'ALL'};
  if((m=new RegExp('^'+NOUN+'\\s+(?:from|by|of|made\\s+by)\\s+(?:the\\s+)?brand\\s+(.+)$','i').exec(s))||(m=new RegExp('^brand\\s+(.+?)(?:\\s+'+NOUN+')?$','i').exec(s))||
    (m=new RegExp('^(.+?)\\s+brand(?:ed)?(?:\\s+'+NOUN+')?$','i').exec(s)))return {kind:'BRAND',name:name(m[1])};
  if((m=new RegExp('^'+NOUN+'\\s+in\\s+(?:the\\s+)?category\\s+(.+)$','i').exec(s))||(m=new RegExp('^'+NOUN+'\\s+in\\s+(?:the\\s+)?(.+?)\\s+category$','i').exec(s))||
    (m=new RegExp('^category\\s+(.+?)(?:\\s+'+NOUN+')?$','i').exec(s))||(m=new RegExp('^(.+?)\\s+category(?:\\s+'+NOUN+')?$','i').exec(s)))return {kind:'CATEGORY',name:name(m[1])};
  if((m=new RegExp('^'+NOUN+'\\s+(?:from|by|of)\\s+(?:the\\s+)?supplier\\s+(.+)$','i').exec(s))||
    (m=new RegExp('^'+NOUN+'\\s+(?:supplied\\s+by|we\\s+buy\\s+from|bought\\s+from|we\\s+get\\s+from|ordered\\s+from)\\s+(?:the\\s+supplier\\s+)?(.+)$','i').exec(s))||
    (m=new RegExp('^supplier\\s+(.+?)(?:\\s+'+NOUN+')?$','i').exec(s))||(m=new RegExp('^(.+?)\\s+supplier(?:\\s+'+NOUN+')?$','i').exec(s)))return {kind:'SUPPLIER',name:name(m[1])};
  if((m=new RegExp('^'+NOUN+'\\s+(?:tagged|labell?ed)\\s+(?:as\\s+|with\\s+)?(.+)$','i').exec(s))||(m=new RegExp('^'+NOUN+'\\s+with\\s+(?:the\\s+)?tag\\s+(.+)$','i').exec(s))||
    (m=new RegExp('^tag(?:ged)?\\s+(.+?)(?:\\s+'+NOUN+')?$','i').exec(s))||(m=new RegExp('^(.+?)[- ]tagged(?:\\s+'+NOUN+')?$','i').exec(s)))return {kind:'TAG',name:name(m[1])};
  if((m=new RegExp('^(?:'+NOUN+'\\s+|anything\\s+|everything\\s+)?(?:at|in)\\s+(?:the\\s+)?(.+?)\\s+(?:warehouse|location|store|shop|site)$','i').exec(s))||
    (m=new RegExp('^(?:'+NOUN+'\\s+|anything\\s+|everything\\s+|thing\\s+)?at\\s+(?:the\\s+)?(.+)$','i').exec(s))||/^anything\s+at\s+/i.test(raw.trim())&&(m=/at\s+(?:the\s+)?(.+)$/i.exec(raw.trim())))
    return {kind:'LOCATION',name:name(m[1])};
  if((m=new RegExp('^'+NOUN+'\\s+(?:from|by)\\s+(.+)$','i').exec(s)))return {kinds:['BRAND','SUPPLIER'],name:name(m[1])};
  if((m=new RegExp('^(?:'+NOUN+'\\s+)?in\\s+(?:the\\s+)?(.+)$','i').exec(s)))return {kinds:['CATEGORY','LOCATION'],name:name(m[1])};
  if((m=new RegExp('^(.+?)\\s+'+NOUN+'$','i').exec(s)))return {kinds:KINDS,name:name(m[1])};
  return {kinds:KINDS,name:name(s)};
}

function parse(instruction){
  let text=String(instruction??'').replace(/[“”]/g,'"').replace(/[‘’]/g,"'").replace(/\s+/g,' ').trim().replace(/[.!?]+$/,'').trim();
  if(!text)ask('Write the rule, as in '+EXAMPLE+'.');
  if(text.length>320)ask('Keep the rule to 320 characters.');
  const original=text;
  text=text.replace(/^(?:please\s+)?(?:(?:tell|notify|alert|warn|email|ping|text)\s+(?:me|us)|let\s+(?:me|us)\s+know|i\s+want\s+to\s+know|watch\s+for|alert\s+(?:me\s+)?on)\s+(?:if|when|whenever|as\s+soon\s+as|once)?\s*/i,'').trim();
  const period=takePeriod(text);
  const found=condition(period.text,period.days);
  return {instruction:original,subject:subject(found.subject),condition:found.condition,amount:found.amount??null,inclusive:found.inclusive===true,days:found.days??null};
}

// The rule in StockChief's own words, so the owner sees how it was read.
function meaning(rule){
  const n=rule.subject_name??rule.subject?.name;
  const what={ALL:'Any item',BRAND:'Any '+n+' brand item',CATEGORY:'Any item in the '+n+' category',SUPPLIER:'Any item from supplier '+n,
    LOCATION:'Any item stocked at '+n,TAG:'Any item tagged '+n}[rule.subject_kind??rule.subject?.kind];
  const value=rule.amount==null?null:exact.canonical(String(rule.amount)),days=rule.days,period=days===1?'a day':days===7?'a week':days===30?'30 days':days+' days';
  const where=(rule.subject_kind??rule.subject?.kind)==='LOCATION'?' there':'';
  const when={
    STOCK_BELOW:'stock'+where+' is '+(rule.inclusive?'at or below ':'below ')+value,
    STOCK_ABOVE:'stock'+where+' is '+(rule.inclusive?'at or above ':'above ')+value,
    OUT_OF_STOCK:'it runs out'+where,
    PRICE_CHANGE:'its selling price changed in the last '+(days===1?'day':days+' days'),
    SALES_ABOVE:'it sells '+(rule.inclusive?'at least ':'more than ')+value+where+' in '+period,
    SALES_BELOW:'it sells '+(rule.inclusive?'at most ':'fewer than ')+value+where+' in '+period,
    EXPIRES_WITHIN:'a batch'+where+' expires within '+(days===1?'1 day':days+' days')
  }[rule.condition];
  return what+', when '+when+'.';
}

module.exports={parse,meaning,KINDS};

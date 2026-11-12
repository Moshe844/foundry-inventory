'use strict';
// Job 81: does a customer's email, or an Ask sentence, ask for their account
// statement? Read without a model, in English and the other languages Ask
// already reads order requests in. A request names the statement and asks for
// it; a statement the sender is sending us, a bank statement or a statement of
// work is not a request.
const money=require('../domain/currency');

const nouns=['statement of account','account statement','statement','soa','estado de cuenta','extracto de cuenta','relevé de compte','releve de compte',
 'kontoauszug','kontoübersicht','estratto conto','extrato de conta','extrato da conta','rekeningoverzicht'];
const asking=/\b(?:send|sent|email|e-mail|mail|need|needs|want|request|requesting|requested|provide|share|resend|re-send|forward|copy|get|have|please|pls|could|can|would|may|like|enviar|envíe|envie|envoyer|envoyez|schicken|senden|zusenden|inviare|inviate|enviem|sturen|stuur|kunt|bitte|por favor|s'il vous plaît|svp|per favore|alstublieft)\b|\?/i;
const notRequests=/\b(?:bank|card|credit card|financial|financials|income|cash ?flow|mission|press|public|witness|work|sow|vat|tax)\s+statements?\b|\bstatement of work\b|\b(?:attached|enclosed|here is|here's|please find)\b[^.\n]{0,40}\b(?:our|my)\s+statement\b/i;
// A statement for some other period than the current one is a different
// document; StockChief sends the current statement only.
const period=/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may\s+(?:statement|\d)|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|(?<![\w-])(?:19|20)\d\d(?![\w-])|last\s+(?:month|year|quarter)|previous\s+(?:month|year|quarter)|q[1-4]|quarter|year[- ]to[- ]date|ytd|since|between|from\s+\S+\s+(?:to|until|through)|enero|febrero|marzo|janvier|février|mars|januar|februar|märz|gennaio|febbraio|janeiro|fevereiro|januari|februari|maart)\b/i;
const clean=value=>String(value||'').replace(/\r/g,'');
// Only the sender's own words: stop at the quoted thread.
function own(body){
 const text=clean(body),cut=text.search(/\n\s*(?:>|On .{0,80}wrote:|-{2,}\s*Original Message|From:\s)/);
 return (cut>0?text.slice(0,cut):text).trim();
}
function names(text){const lower=text.toLowerCase();return nouns.some(n=>new RegExp('(?:^|[^\\p{L}\\p{N}])'+n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:s)?(?:$|[^\\p{L}\\p{N}])','u').test(lower));}
function currencies(text){
 const found=new Set();
 for(const token of text.match(/\b[A-Z]{3}\b/g)||[]){try{found.add(money.code(token));}catch{/* not a currency */}}
 return [...found];
}
// Returns null when the text is not a statement request; otherwise what it asked for.
function read(subject,body){
 const words=own(body),text=(clean(subject)+'\n'+words).trim();
 if(!text||text.length>20000||!names(text)||notRequests.test(text))return null;
 const subjectOnly=names(clean(subject))&&!words;
 if(!subjectOnly&&!asking.test(text)&&!/^\s*(?:re:\s*|fw:\s*|fwd:\s*)*(?:account\s+)?statement(?:\s+of\s+account)?(?:\s+request(?:ed)?)?\s*$/i.test(clean(subject)))return null;
 return {text,period:period.test(text),currencies:currencies(text)};
}

// Ask: "send Acme their statement", "email the account statement to Acme in
// EUR", "send Acme's statement". Only that sentence; anything else is null.
const sendVerb=String.raw`(?:please\s+)?(?:send|email|e-mail|mail)`;
const noun=String.raw`(?:(?<adj>[A-Za-z0-9\- ]{1,30}?)\s+)?(?:account\s+)?statement(?:\s+of\s+account)?`;
const tail=String.raw`(?:\s+in\s+(?<currency>[A-Za-z]{3}))?(?:\s+please)?[.!]*`;
const askForms=[
 new RegExp('^'+sendVerb+String.raw`\s+(?<customer>.+?)\s+(?:their|his|her|its|the|an?)\s+`+noun+tail+'$','i'),
 new RegExp('^'+sendVerb+String.raw`\s+(?:the\s+|a\s+|an\s+)?`+noun+String.raw`\s+(?:to|for)\s+(?<customer>.+?)`+tail+'$','i'),
 new RegExp('^'+sendVerb+String.raw`\s+(?<customer>.+?)(?:'s|’s)\s+`+noun+tail+'$','i'),
];
function askRequest(text){
 const value=String(text||'').trim();
 if(!value||value.length>200||/\b(?:bank|financial|statement of work)\b/i.test(value))return null;
 for(const form of askForms){
  const m=form.exec(value);if(!m)continue;
  const adj=(m.groups.adj||'').trim().toLowerCase().replace(/(?:^|\s+)account$/,''),customer=m.groups.customer.trim();
  if(!customer||/\bstatement\b/i.test(customer))return null;
  const isPeriod=Boolean(adj)&&period.test(adj);
  if(adj&&!isPeriod&&!/^(?:current|latest|up[- ]to[- ]date|full|monthly)$/.test(adj))return null;
  let currency=null;
  if(m.groups.currency){try{currency=money.code(m.groups.currency);}catch{return null;}}
  return {customer,currency,period:isPeriod};
 }
 return null;
}
module.exports={read,own,askRequest};

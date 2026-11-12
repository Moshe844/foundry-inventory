'use strict';
// Job 97: reads rebate or volume-discount terms a supplier sends by email so a
// person can check and accept them. It only fills in what is clearly written;
// anything missing is listed for the person. Nothing is accepted here.
const RELEVANT=/\b(?:rebates?|volume (?:discounts?|incentives?|bonus)|growth incentives?)\b/i;
const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const DAY=new RegExp('(\\d{4}-\\d{2}-\\d{2}|(?:'+MONTHS.join('|')+')\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:'+MONTHS.join('|')+'),?\\s+\\d{4})','i');
function iso(text){
 const value=String(text||'').trim();let y,m,d,match;
 if((match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value)))[,y,m,d]=match;
 else if((match=new RegExp('^('+MONTHS.join('|')+')\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$','i').exec(value))){m=MONTHS.indexOf(match[1].toLowerCase())+1;d=match[2];y=match[3];}
 else if((match=new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?\\s+('+MONTHS.join('|')+'),?\\s+(\\d{4})$','i').exec(value))){d=match[1];m=MONTHS.indexOf(match[2].toLowerCase())+1;y=match[3];}
 else return null;
 const out=String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');return Number.isFinite(Date.parse(out))&&new Date(out).toISOString().slice(0,10)===out?out:null;
}
const money=text=>{const v=String(text).replace(/,/g,'');return /^\d{1,12}(?:\.\d{1,2})?$/.test(v)?v:null;};
function read(text){
 const all=String(text||'');if(!RELEVANT.test(all))return {relevant:false};
 const lines=all.replace(/\r\n?/g,'\n').split('\n').map(l=>l.trim()).filter(Boolean),tiers=new Map(),quotes=[],missing=[];
 let startsOn=null,endsOn=null,claimOn=null,claimBy=null,method=null,symbol=null,quantityTerms=false;
 const period=new RegExp('(?:from|between|period[:\\s]+)\\s*'+DAY.source+'\\s*(?:to|until|through|-|–|and)\\s*'+DAY.source,'i');
 for(const line of lines){
  let m=period.exec(line);if(m&&!startsOn){startsOn=iso(m[1]);endsOn=iso(m[2]);quotes.push(line);}
  if(!startsOn&&((m=/\b(?:calendar year|for the year|for calendar year|during)\s+(20\d{2})\b/i.exec(line))||RELEVANT.test(line)&&(m=/\b(?:for|in)\s+(20\d{2})\b/i.exec(line)))){startsOn=m[1]+'-01-01';endsOn=m[1]+'-12-31';quotes.push(line);}
  if((m=new RegExp('claims?\\b[^.]*?\\b(?:by|before|no later than|until|deadline[:\\s]+)\\s*'+DAY.source,'i').exec(line))){claimBy=iso(m[1]);quotes.push(line);}
  if((m=new RegExp('claims?\\b[^.]*?\\b(?:from|after|on or after|open(?:s)?(?: on)?)\\s*'+DAY.source,'i').exec(line))){claimOn=iso(m[1]);quotes.push(line);}
  if(/\b(?:(?:on|to) all (?:eligible )?purchases|back to the first|retroactive|whole year|all eligible purchases)\b/i.test(line))method='retroactive';
  if(/\b(?:on (?:the )?(?:amount|spend|purchases) (?:above|over) each|incremental|each band|only on the portion)\b/i.test(line))method='incremental';
  if(/\b(?:cases?|units?|pieces?|pcs|boxes|cartons|pallets)\b/i.test(line)&&/%/.test(line)&&!/[$€£]/.test(line))quantityTerms=true;
  const forms=[
   /(\d{1,3}(?:\.\d{1,2})?)\s*%[^%\n]*?\b(?:over|above|exceeding|from|at least|of|reaching|reach|beyond)\s*(?:[A-Z]{3}\s*)?([$€£])?\s*([\d,]+(?:\.\d{2})?)(?!\s*%)/i,
   /(?:spend|purchases?|buy|volume)[^%\n]*?\b(?:over|above|of|from|reaching|at least)\s*([$€£])?\s*([\d,]+(?:\.\d{2})?)[^%\n]*?(\d{1,3}(?:\.\d{1,2})?)\s*%/i,
   /^([$€£])?\s*([\d,]+(?:\.\d{2})?)\s*(?:\+|and (?:up|over|above)|or more)?\s*(?:(?:-|–|to)\s*[$€£]?\s*[\d,]+(?:\.\d{2})?)?\s*[:|=]\s*(\d{1,3}(?:\.\d{1,2})?)\s*%/
  ];
  for(const [n,form]of forms.entries()){
   const hit=form.exec(line);if(!hit)continue;
   const rate=n===0?hit[1]:hit[3],sign=n===0?hit[2]:hit[1],threshold=money(n===0?hit[3]:hit[2]);
   if(threshold===null||Number(rate)>100)continue;if(sign)symbol=symbol||sign;
   if(tiers.has(threshold)&&tiers.get(threshold)!==rate)missing.push('Two different rates are given for the same spend level. Check with the supplier.');
   tiers.set(threshold,rate);quotes.push(line);break;
  }
 }
 const list=[...tiers.entries()].map(([threshold,rate])=>({threshold,rate})).sort((a,b)=>Number(a.threshold)-Number(b.threshold));
 if(!list.length)missing.push(quantityTerms?'The tiers are by quantity. Enter the product and quantity tiers yourself.':'No spend tiers could be read. Enter them from the agreement.');
 if(!startsOn||!endsOn)missing.push('The purchase period is not stated clearly.');
 if(!claimOn||!claimBy)missing.push('The claim window is not stated clearly.');
 if(!method&&list.length>1)missing.push('It does not say whether a higher tier applies to all purchases or only the amount above it.');
 if(symbol)missing.push('Amounts use '+symbol+'. Confirm the currency.');
 return {relevant:true,startsOn,endsOn,claimOn,claimBy,method,tiers:list,quotes:[...new Set(quotes)].slice(0,20),missing:[...new Set(missing)]};
}
module.exports={read,RELEVANT};

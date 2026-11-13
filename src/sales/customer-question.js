'use strict';
// Job 72: does a customer's email ask about stock, a delivery date or the
// status of an order? Read without a model, from the sender's own words only
// (the quoted thread is cut off). Anything else the email asks for, such as
// prices, a change, a cancellation, a return or a payment, is named so that a
// person answers it: StockChief never answers half an email.
const {own}=require('../accounting/statement-request');

const TOPICS=Object.freeze({
  stock:/\b(?:in stock|out of stock|back in stock|stock levels?|stock (?:of|for|on)|have (?:any|enough|it|them|some|more)|do you (?:have|stock|carry|still have)|(?:is|are) (?:it|they|this|these|those) available|availab(?:le|ility)|how many .{0,40}(?:left|available|on hand|in stock)|en stock|disponib\w*|auf lager|vorrätig|verfügbar)\b/i,
  // When it will arrive or leave: answered only from a recorded date.
  delivery:/\b(?:when (?:will|would|can|could|should|do|does|is|are) .{0,40}(?:arrive|ship|be (?:delivered|shipped|sent|dispatched|here)|get (?:it|them|here)|receive|expect)|deliver(?:y|ed)? (?:date|time|day)|arriv(?:e|al|ing)|eta|expected (?:delivery|arrival)|lieferung|liefertermin|livraison|entrega)\b/i,
  status:/\b(?:status|where is|where's|update on|any update|any news|progress (?:of|on)|tracking|track (?:it|my|our|the)|shipped yet|dispatched yet|sent out yet|has (?:it|my order|our order|the order|order \S+) (?:shipped|been (?:shipped|sent|dispatched|processed|confirmed))|is (?:it|my order|our order|the order|order \S+) (?:ready|confirmed|on (?:its|the) way|processed)|estado del pedido|statut de (?:ma|la|notre) commande|bestellstatus)\b/i,
});
const ASKING=/[?¿]|\b(?:when|where|could you|can you|would you|do you|does it|is there|are there|have you|has (?:it|my|our|the)|is (?:it|my|our|the)|please (?:let|tell|confirm|advise|check|update)|let (?:me|us) know|any (?:update|news)|wondering|cuándo|dónde|quand|où|wann|wo ist)\b/i;
// What a person answers. The order of this list is the order the reasons read.
const OTHER=Object.freeze([
  ['prices',/\b(?:price|prices|pricing|priced|quote|quotation|discount|cost|costs)\b|\bhow much (?:is|are|does|do|would|will|for)\b/i],
  ['a change to an order',/\b(?:change|amend|modify|add (?:to|another|more to)|remove|instead of|switch|update (?:my|our|the) (?:order|address))\b/i],
  ['a cancellation',/\b(?:cancel|cancell?ation)\b/i],
  ['a return or refund',/\b(?:return|refund|exchange|send (?:it|them) back|rma)\b/i],
  ['an invoice or payment',/\b(?:invoice|payment|paid|pay|credit|statement|balance|receipt)\b/i],
  ['a problem with the goods',/\b(?:damaged|broken|wrong|missing|faulty|defective|complain|complaint|not received|never (?:arrived|received|came)|lost)\b/i],
]);
const clean=value=>String(value||'').replace(/\r/g,'');

// Returns null when the email does not ask about stock, delivery or an order;
// otherwise the topics it asks about and anything else it asks for.
function read(subject,body){
  const words=own(body),title=clean(subject).replace(/^\s*(?:(?:re|aw|sv|fw|fwd|tr|wg):\s*)+/i,''),text=(title+'\n'+words).trim();
  if(!text||text.length>20000||!ASKING.test(text))return null;
  const topics=Object.keys(TOPICS).filter(topic=>TOPICS[topic].test(text));
  if(!topics.length)return null;
  return {topics,other:OTHER.filter(([,pattern])=>pattern.test(text)).map(([label])=>label),text,words};
}

// Words in the email that could be an order number, a customer reference or a
// product code: they contain a digit. Trailing punctuation is not part of them.
function references(text){
  const found=new Set();
  for(const raw of String(text||'').match(/[A-Za-z0-9#][A-Za-z0-9._\/#-]{0,79}/g)||[]){
    const token=raw.replace(/^#+/,'').replace(/[._\/#-]+$/,'');
    if(token&&/\d/.test(token)&&!/^\d{4}-\d{2}-\d{2}$/.test(token))found.add(token);
    if(found.size>=40)break;
  }
  return [...found];
}

const LABELS={stock:'stock',delivery:'a delivery date',status:'order status'};
function describe(topics){
  const words=topics.map(t=>LABELS[t]||t);
  return words.length>1?words.slice(0,-1).join(', ')+' and '+words.at(-1):words[0]||'';
}
module.exports={read,references,describe,TOPICS:Object.keys(TOPICS)};

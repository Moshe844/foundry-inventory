'use strict';
// Job 73: is a customer's email asking for a quote, and for exactly what?
// Read without a model. The subject or an opening line asks for a quote,
// quotation or prices; then every line must be a product code and quantity
// (our code, the customer's own code or a barcode), a delivery instruction, a
// greeting or a sign-off, exactly as customer orders are read (job 52).
const {own}=require('../accounting/statement-request');
const asks=/\b(?:quote|quotes|quotation|quotations|rfq|price request|pricing request|request for (?:a )?(?:quote|quotation|prices?|pricing)|cotizaci[oó]n|devis|angebot|preventivo|or[cç]amento)\b/i;
// The line that opens the list: "Could you quote the following:",
// "Please send us a quotation for:", "Request for quote".
const intro=/^(?:(?:please|kindly|could you|can you|would you|could we|can we|may we|we(?:'d| would) like|i(?:'d| would) like|we need|i need|we are looking for|requesting)\b[^\n]{0,80}\b(?:quote|quotation|price|prices|pricing)\b[^\n]{0,60}|(?:rfq|quote request|quotation request|price request|pricing request|request for (?:a )?(?:quote|quotation|pricing|prices?))\b[^\n]{0,60})[.:!?]?$/i;
const subjectReply=/^\s*(?:(?:re|aw|sv|fw|fwd|tr|wg):\s*)+/i;

// null when the email is not a quote request; {error} when it is one but a
// line could not be read; otherwise the requested lines and delivery.
function read(subject,body,documents=[]){
  const title=String(subject||'').replace(subjectReply,'').trim(),words=own(body);
  const opening=String(words).split(/\r?\n/).map(l=>l.trim()).filter(Boolean).slice(0,4);
  if(!asks.test(title)&&!opening.some(line=>intro.test(line)))return null;
  // A reply in an existing thread ("Re: Quotation QT-00012") answers a quote we sent.
  if(subjectReply.test(String(subject||''))&&/\bQT-\d+\b/i.test(title))return null;
  try{
    const parsed=require('./postgres-email-order').parse([asks.test(title)&&!opening.some(line=>intro.test(line))?'Request for quote\n'+words:words,...documents],{intro});
    return {lines:parsed.lines,pickup:parsed.pickup,shipTo:parsed.shipTo,reference:parsed.reference,names:parsed.names};
  }catch(error){
    if(error.code!=='validation_error'&&error.name!=='ValidationError')throw error;
    return {error:error.message.replace(/enter the order yourself/gi,'write the quote yourself').replace(/\bthe order\b/gi,'the request')};
  }
}
function isRequest(subject,body){return read(subject,body)!==null;}
module.exports={read,isRequest};

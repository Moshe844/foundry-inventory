'use strict';

const policy=require('../commercial/agent-plan');
const triage=require('./reply-triage');
const labels={order:'Order',invoice:'Invoice',delivery:'Delivery document',question:'Question',bulk:'Bulk or automated',review:'Review sender',message:'Other business mail'};
const invoiceWords=/\b(?:invoices?|tax invoice|credit note|credit memo|facture|factura|rechnung|fattura)\b/iu;
const orderWords=/\b(?:purchase order|sales order|customer order|bon de commande|pedido de compra|bestellung|ordine di acquisto)\b/iu;
const deliveryWords=/\b(?:packing slip|delivery note|proof of delivery|dispatch advice|bon de livraison|albar[aá]n|lieferschein)\b/iu;
const sample=/\b(?:template|sample|example|request|formulaire|modelo|vorlage)\b/iu;
const subjectReply=/^(?:(?:re|aw|sv|fw|fwd|tr|wg):\s*)+/iu;
const issue=/\b(?:where is|status of|checking on|update on|follow(?:ing)? up|question about|revised when|when (?:will|can)|already (?:sent|paid)|can you (?:confirm|check|resend)|please (?:confirm|check|resend)|dispute|not received|still waiting|could you|do you have|how (?:many|much|long))\b/iu;
const translatedQuestion=/\b(?:pouvez-vous|pourriez-vous|combien|quand est|podr[ií]a|pueden enviar|cu[aá]ndo|cu[aá]ntos|k[oö]nnen sie|wie viele|wann wird)\b/iu;
const attaches=/\b(?:attached|enclosed|please find|ci-joint|adjunto|anbei|in allegato)\b/iu;
const poHeading=/^(?:p\.?o\.?|purchase order|sales order|customer order)\s*(?:number|no\.?|#|:)?\s+[\p{L}\p{N}][\p{L}\p{N}._/-]*\s*$/iu;
const inlineInvoice=/^\s*(?:invoice|facture|factura|rechnung|fattura)(?:\s*(?:no\.?|number|#|:))?\s+[\p{L}\p{N}._/-]+\s*$/imu;
const invoiceTotals=/\b(?:amount due|invoice date|total due|grand total|subtotal|payment terms|montant total|importe total)\b/iu;
const orderRequest=/^(?:new order|order request|new purchase order|nouvelle commande|nuevo pedido|neue bestellung)(?:$|[\s:#–—-])/iu;

function decide(message,kind){
  const subject=String(message.subject||'').trim(),heading=subject.replace(subjectReply,''),fresh=heading===subject;
  const body=triage.prose(message.triageBodyText??message.bodyText??''),text=heading+'\n'+body;
  const filenames=(message.attachments||[]).map(a=>String(a.filename||'').replace(/[_-]+/g,' ')).filter(name=>!sample.test(name));
  const docs={invoice:filenames.some(name=>invoiceWords.test(name)),order:filenames.some(name=>orderWords.test(name)||/^po[ .#\d]/iu.test(name)),
    delivery:filenames.some(name=>deliveryWords.test(name))};
  if(message.providerJunk)return {category:'bulk',reason:'The mailbox provider placed this message in junk.'};
  if(docs.invoice&&docs.order)return {category:'review',reason:'This message includes both invoice and order documents.'};
  if(docs.invoice)return {category:'invoice',reason:'The message includes an invoice or credit-note attachment.'};
  if(docs.order)return {category:'order',reason:'The message includes a purchase-order attachment.'};
  if(docs.delivery)return {category:'delivery',reason:'The message includes a packing or delivery document.'};
  const orderIntent=require('./email-ingestion').looksLikeAnOrderRequest(text.toLowerCase().replace(/[’‘]/gu,"'"));
  const asks=issue.test(text)||translatedQuestion.test(text)||/[?¿]/u.test(text)||
    triage.ASKING.some(phrase=>triage.saysPhrase(text.toLowerCase(),phrase));
  const structuredCustomerOrder=kind==='customer'&&require('../sales/postgres-email-order').isOrderEnvelope(subject,body,filenames.length>0);
  if(orderIntent||!asks&&(structuredCustomerOrder||fresh&&!sample.test(heading)&&(orderRequest.test(heading)||poHeading.test(heading))||
    orderWords.test(heading)&&attaches.test(body)))
    return {category:'order',reason:'The current message asks to place an order or submits a named order.'};
  if(!asks&&(fresh&&!sample.test(heading)&&invoiceWords.test(heading)||inlineInvoice.test(body)&&invoiceTotals.test(body)))
    return {category:'invoice',reason:'The current message identifies an invoice or credit note.'};
  if(!asks&&deliveryWords.test(text))
    return {category:'delivery',reason:'The current message identifies a delivery document.'};
  if(message.listMail||triage.NO_REPLY_SENDER.test(message.sender||'')||triage.AUTOMATIC_SUBJECT.test(subject)||
    /\bunsubscribe\b|manage (?:your )?email preferences|view (?:this|it) in your browser/iu.test(body))
    return {category:'bulk',reason:'Mailing-list details or an automatic sender identify this as bulk or automated mail.'};
  if(asks)return {category:'question',reason:'The current message asks a question or requests a follow-up.'};
  if(!kind)return {category:'review',reason:'This sender and the purpose of the message need a review.'};
  return {category:'message',reason:'The current message has no clear order, invoice, delivery document or question.'};
}

function classify(message,kind){return decide(message,kind).category;}
function available(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,138,'automatic');}
async function forCapture(c,workspaceId,message,kind){
  const state=await policy.accountState(c,workspaceId);
  return available(state)?decide(message,kind):null;
}
async function draftAccess(c,workspaceId,{required=false}={}){
  const state=await policy.accountState(c,workspaceId);
  if(!policy.usesAgentTerms(state))return true;
  if(required)policy.requireJob(state.plan,187,'draft');
  return policy.permits(state.plan,187,'draft');
}
async function readPage(db,ctx,{filter='',page=1}={}){
  const owner=await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.workspaceId,ctx.actorId]);
  if(!owner.rowCount)throw new(require('../domain/errors').AuthorizationError)('Only the current inventory owner can review private sorted mail.');
  const normalized=String(filter).trim().toLowerCase();
  const category=normalized==='junk'?'bulk':Object.keys(labels).find(k=>[k,labels[k].toLowerCase()].includes(normalized))||'';
  const {rows}=await db.query(`SELECT * FROM (
    SELECT m.id,m.sender,m.subject,m.received_at,m.agent_category AS category,m.agent_category_reason AS reason,c.display_name AS mailbox,'/mail/'||m.id AS link FROM connection_email_messages m
      JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id WHERE m.workspace_id=$1
    UNION ALL SELECT m.id,m.sender,m.subject,m.received_at,m.agent_category,m.agent_category_reason,c.display_name,'/mail/set-aside?focus='||m.id||'#message-'||m.id FROM connection_email_set_aside m
      JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id WHERE m.workspace_id=$1 AND m.brought_in_message_id IS NULL
    ) mail WHERE ($2='' OR category=$2) AND ($3='' OR lower(sender)=lower($3) OR lower(mailbox)=lower($3))
    ORDER BY received_at DESC,id LIMIT 101 OFFSET $4`,[ctx.workspaceId,category,category?'':filter,(page-1)*100]);
  return {rows:rows.slice(0,100).map(r=>({Category:labels[r.category]||'Unsorted history',Mailbox:r.mailbox,From:r.sender,Subject:r.subject||'(No subject)',Reason:r.reason||'',Received:r.received_at,link:r.link})),
    more:rows.length>100,summary:'New mailbox arrivals are sorted from their original subject, current message, attachment names and mailbox flags. Unknown senders stay set aside for owner review.'};
}
const definition={id:138,key:'shared-inbox-triage',label:'Sort shared inbox mail by the work it needs',filterLabel:'Category, mailbox name or sender',readPage};
module.exports={classify,decide,available,forCapture,draftAccess,definition,labels,readPage};

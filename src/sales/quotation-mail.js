'use strict';
const {ValidationError}=require('../domain/errors'),source=require('./quote-message-source'),money=require('../domain/currency'),{hash}=require('../pricing/postgres-promotions');
const kind='quote_share',key=id=>'quotation-email:'+id;
async function facts(db,ctx,id,connectorId){
 const {q,customer}=await source.facts(db,ctx,id),box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 if(q.pricing.lines.some(line=>!q.line_labels?.[line.skuId]))throw new ValidationError('This older quotation needs a revision with clear product names before it can be emailed.');
 if(q.pricing.lines.some(line=>line.pricingQuantity!=null&&!q.line_units?.[line.skuId]?.price))throw new ValidationError('This older measured-stock quotation needs a revision with the saved pricing units before it can be emailed.');
 const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),p={recordId:q.id,quoteNumber:q.quote_number,quoteHash:q.pricing_hash,customerId:customer.id,customerName:customer.name,recipient:customer.email,pricing:q.pricing,lineLabels:q.line_labels,lineUnits:q.line_units||{},businessTimeZone:timeZone,orderDate:q.input.orderDate||null,neededBy:q.input.neededBy||null,deliveryMethod:q.input.deliveryMethod,shipToAddress:q.input.shipToAddress||null,validUntil:q.valid_until,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type};p.mailContentHash=hash(compose(p));return {...p,sourceFingerprint:hash(p)};
}
function compose(p){
 const lines=p.pricing.lines.map(line=>{const u=p.lineUnits?.[line.skuId];return p.lineLabels[line.skuId]+'\nQuantity'+(u?.quantity?' ('+u.quantity+')':'')+': '+line.quantity+(line.pricingQuantity!=null?'\nPriced quantity ('+u.price+'): '+line.pricingQuantity:'')+'\nUnit price'+(u?.price?' per '+u.price:'')+': '+money.format(line.unitPriceMinor,p.pricing.currency)+'; discount '+money.format(line.discountMinor||0,p.pricing.currency)+'; tax '+money.format(line.taxMinor||0,p.pricing.currency)+'; total '+money.format(line.totalMinor,p.pricing.currency);});
 return {subject:'Quotation '+p.quoteNumber,body:'Hello '+p.customerName+',\n\nHere is quotation '+p.quoteNumber+', valid through '+p.validUntil+'.'+(p.orderDate?'\nQuotation date: '+p.orderDate:'')+'\n\n'+lines.join('\n\n')+'\n\nSubtotal: '+money.format(p.pricing.subtotalMinor,p.pricing.currency)+'\nDiscount: '+money.format(p.pricing.discountMinor||0,p.pricing.currency)+(p.pricing.chargesMinor?'\nOther charges: '+money.format(p.pricing.chargesMinor,p.pricing.currency):'')+'\nTax: '+money.format(p.pricing.taxMinor||0,p.pricing.currency)+'\nTotal: '+money.format(p.pricing.totalMinor,p.pricing.currency)+' '+p.pricing.currency+'\nDelivery: '+(p.deliveryMethod==='SHIP'?'Ship to '+p.shipToAddress:'Customer pickup')+(p.neededBy?'\nRequested delivery date: '+p.neededBy:'')+'\n\nPlease reply if you would like to proceed or have any questions.\n\nThank you.'};
}
async function authority(db,workspaceId,p){
 if(p.kind!==kind)throw new ValidationError('Review and approve this quotation email individually.');
 // Job 73: a quote StockChief wrote alone from a customer's emailed request goes back to them alone.
 if(p.automatic===true&&p.manualApproval===false)await require('./agent-quote-requests').shareAuthority(db,workspaceId,p);
 else if(p.manualApproval!==true||p.automatic!==false)throw new ValidationError('Review and approve this quotation email individually.');
 const fresh=await facts(db,{workspaceId,actorId:p.actorId},p.recordId,p.connectorId);if(hash(fresh)!==hash(Object.fromEntries(Object.keys(fresh).map(k=>[k,p[k]]))))throw new ValidationError('The quotation, customer or mailbox changed. Preview the current email before sending.');
 const prior=await message(db,workspaceId,p.recordId),words=compose(fresh);if(prior&&(prior.recipient!==fresh.recipient||prior.connector_id!==fresh.connectorId||prior.subject!==words.subject||prior.body!==words.body))throw new ValidationError('An earlier quotation email uses different details. Review its delivery before sending another message.');return fresh;
}
async function message(db,workspaceId,id){return (await db.query('SELECT id,status,recipient,subject,body,connector_id,error_message,sent_at FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,key(id)])).rows[0]||null;}
async function page(db,ctx,id,connectorId){
 await source.owner(db,ctx);const q=await require('./postgres-quotes').get(db,ctx.workspaceId,id),mailboxes=await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),sent=await message(db,ctx.workspaceId,id);let prepared=null,problem=null;
 try{await source.facts(db,ctx,id);if(connectorId){const p=await facts(db,ctx,id,connectorId);prepared={...p,...compose(p)};}}catch(error){if(error.code!=='validation_error')throw error;problem=error.message;}const policy=require('../commercial/agent-plan'),state=await policy.accountState(db,ctx.workspaceId);return {quotation:q,mailboxes,message:sent,prepared,problem,canFollowUp:policy.usesAgentTerms(state)&&policy.permits(state.plan,74,'draft')};
}
async function send(db,ctx,id,input){
 if(input.confirmed!=='yes')throw new ValidationError('Confirm the customer, recipient and the exact quotation email before sending.');
 return db.transaction(async c=>{const p=await facts(c,ctx,id,input.connectorId);if(input.expectedFingerprint!==p.sourceFingerprint)throw new ValidationError('This quotation email changed. Preview its current recipient and terms again.');
  const grant={...p,kind,actorId:ctx.actorId,manualApproval:true,automatic:false};await authority(c,ctx.workspaceId,grant);const prior=await message(c,ctx.workspaceId,id);if(prior){const e=(await c.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND aggregate_id=$2",[ctx.workspaceId,prior.id])).rows[0];if(prior.status==='FAILED'||!e)throw new ValidationError('Review the earlier quotation email delivery before retrying.');return {communicationId:prior.id,effectId:e.id,status:prior.status,replayed:true};}
  return require('../connections/postgres-outbound-mail').queueInTransaction(c,ctx,{recipientKind:'customer',recipientId:p.customerId,recipientEmail:p.recipient,connectorId:p.connectorId,...compose(p),standingAuthority:grant},key(id));
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function accepted(c,workspaceId,p,messageId,at){
 const date=require('../lib/business-time').context(p.businessTimeZone,new Date(at)).calendarDate;
 await c.query(`INSERT INTO stockchief_runtime.agent_quote_followups(workspace_id,quote_id,quote_hash,customer_id,recipient,presented_on,presentation_channel,presentation_evidence,confirmed_by,request_key,input_hash,presentation_basis,presentation_email_id)
  SELECT $1,q.id,q.pricing_hash,q.customer_id,m.recipient,$5,'email','Your connected mailbox confirmed sending this quotation.',$6,'quotation-email:'||m.id,$7,'mailbox_accepted',m.id
  FROM sales_quotations q JOIN customer_communications m ON m.workspace_id=q.workspace_id AND m.id=$3 AND m.customer_id=q.customer_id
  WHERE q.workspace_id=$1 AND q.id=$2 AND q.pricing_hash=$4 AND m.status='SENT' AND m.external_message_id IS NOT NULL
  ON CONFLICT DO NOTHING`,[workspaceId,p.recordId,messageId,p.quoteHash,date,p.actorId,hash({quote:p.recordId,hash:p.quoteHash,messageId,date})]);
}
module.exports={facts,compose,page,send,authority,accepted,message};

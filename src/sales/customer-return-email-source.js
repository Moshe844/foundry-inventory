'use strict';
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const unclear=()=>new ValidationError('Review the original return email. StockChief needs one exact order, a reason, a requested resolution, and an exact SKU and whole quantity for every returned product.');
const isReturnSubject=value=>/^(?:return request|request to return|customer return)(?:\s*[:#-]\s*[\w.-]+)?[.!]?$/i.test(String(value||'').trim());
function parse(subject,text){
 if(!isReturnSubject(subject)||typeof text!=='string'||text.length>30000)throw unclear();
 const raw=text.split(/\r?\n/),head=raw.findIndex(line=>/^\s*SKU\s*[,|\t]\s*Quantity\s*$/i.test(line));if(head<0)throw unclear();
 const fields={};
 for(const line of raw.slice(0,head).map(line=>line.trim()).filter(Boolean)){
  if(/^(?:return request|hello|hi|thanks|thank you|regards)[,.!]?$/i.test(line))continue;
  const match=/^(Order(?: number)?|Reason|Resolution|Return reference)\s*:\s*(.+)$/i.exec(line);if(!match)throw unclear();
  const key=match[1].toLowerCase().replace(' number','');if(fields[key])throw unclear();fields[key]=match[2].trim();
 }
 if(!fields.order||fields.order.length>100||!fields.reason||fields.reason.length>1000||!fields.resolution||fields['return reference']?.length>100)throw unclear();
 const resolutions={refund:'REFUND',exchange:'EXCHANGE','no refund':'NO_REFUND'},resolution=resolutions[fields.resolution.toLowerCase()];if(!resolution)throw unclear();
 const tail=raw.slice(head+1).filter(line=>line.trim()&&!/^(?:thanks|thank you|regards)[,.!]?$/i.test(line.trim())),delimiter=raw[head].includes('|')?'|':raw[head].includes('\t')?'\t':',';
 const grid=require('../imports/parser').parseDelimited([raw[head],...tail].join('\n'),delimiter),used=new Set();
 if(grid.length<2||grid.length>101)throw unclear();
 const lines=grid.slice(1).map(row=>{
  const code=String(row[0]||'').trim(),quantityText=String(row[1]||'').trim(),quantity=Number(quantityText);
  if(row.length!==2||!code||code.length>160||used.has(code.toLowerCase())||!/^\d+(?:\.0{1,6})?$/.test(quantityText)||!Number.isSafeInteger(quantity)||quantity<=0)throw unclear();
  used.add(code.toLowerCase());return {code,quantity};
 });
 return {orderNumber:fields.order,reason:fields.reason,resolution,requestReference:fields['return reference']||null,lines};
}
async function owner(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
  AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can authorize returns from customer emails.');
 require('../actions/permissions').assertCan(user,require('../actions/permissions').AUTHORIZE_CUSTOMER_RETURN,'prepare a customer return');
}
async function facts(db,ctx,id,quarantineLocationId,{excludeReturnId=null}={}){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,111,'draft');
 const message=(await db.query(`SELECT m.*,c.provider_account_id,c.provider_type,c.status AS connector_status,c.paused_at FROM connection_email_messages m
  JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id WHERE m.workspace_id=$1 AND m.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!message)throw new NotFoundError('That customer email is not in this inventory.');
 if(message.trust_status!=='TRUSTED'||message.classification!=='customer'||message.supplier_id||message.connector_status!=='connected'||message.paused_at||!message.provider_account_id||!['gmail','microsoft365'].includes(message.provider_type))throw new ValidationError('Confirm the known customer and connected source mailbox before preparing a return.');
 if((await db.query('SELECT 1 FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 LIMIT 1',[ctx.workspaceId,id])).rowCount)throw new ValidationError('Review return requests with attachments individually so no product or instruction is missed.');
 const customers=(await db.query(`SELECT id,name,email FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(email)=lower($2)
  AND NOT EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(email)=lower($2)) LIMIT 2`,[ctx.workspaceId,message.sender])).rows;
 if(customers.length!==1)throw new ValidationError('The return email must match one active customer and must not also identify a supplier.');
 const customer=customers[0],parsed=parse(message.subject,message.body_text),order=(await db.query('SELECT id,order_number,version,status,customer_id,contact_email,currency FROM sales_orders WHERE workspace_id=$1 AND order_number=$2 AND customer_id=$3',[ctx.workspaceId,parsed.orderNumber,customer.id])).rows[0];
 if(!order||!['FULFILLED','PARTIALLY_FULFILLED'].includes(order.status)||order.contact_email&&order.contact_email.toLowerCase()!==customer.email.toLowerCase())throw new ValidationError('Match this customer and their email to an order whose goods actually left. Review different order contacts individually.');
 const location=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,quarantineLocationId])).rows[0];
 if(!location)throw new ValidationError('Choose an active internal location for the later physical return inspection.');
 const candidates=(await db.query(`SELECT l.id,l.sku_id,l.quantity_fulfilled::text,s.code,i.name,i.unit_label,i.tracking_mode,i.secondary_unit_label,
  coalesce((SELECT sum(r.quantity_authorized) FROM customer_return_lines r JOIN customer_returns h ON h.workspace_id=r.workspace_id AND h.id=r.customer_return_id WHERE r.workspace_id=l.workspace_id AND r.sales_order_line_id=l.id AND h.status<>'CANCELLED' AND h.id IS DISTINCT FROM $3::text),0)::text already_requested,
  EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id) AS kit
  FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2`,[ctx.workspaceId,order.id,excludeReturnId])).rows;
 const lines=parsed.lines.map(line=>{
  const matches=candidates.filter(row=>row.code.toLowerCase()===line.code.toLowerCase());
  if(matches.length!==1)throw new ValidationError('Match every returned SKU to one exact line on the original order.');
  const row=matches[0];
  if(row.tracking_mode!=='quantity'||row.secondary_unit_label||row.kit||!Number.isSafeInteger(Number(row.quantity_fulfilled))||!Number.isSafeInteger(Number(row.already_requested))||Number(row.quantity_fulfilled)-Number(row.already_requested)<line.quantity)throw new ValidationError('Review tracked stock, measured goods, kits and quantities beyond the unreturned fulfilled units individually.');
  return {salesOrderLineId:row.id,skuId:row.sku_id,code:row.code,name:row.name,unit:row.unit_label,quantity:line.quantity,fulfilled:Number(row.quantity_fulfilled),alreadyRequested:Number(row.already_requested)};
 });
 const input={salesOrderId:order.id,quarantineLocationId:location.id,reason:parsed.reason,resolution:parsed.resolution,lines:lines.map(line=>({salesOrderLineId:line.salesOrderLineId,quantity:line.quantity}))};
 // The return window counts from when the goods last reached or left the
 // customer: a recorded delivery, else the fulfilment that sent them.
 const left=(await db.query(`SELECT greatest(
  (SELECT max(je.created_at::timestamptz) FROM accounting_journal_entries je WHERE je.workspace_id=$1 AND je.source_type='sale_fulfillment' AND je.status='POSTED' AND je.metadata::jsonb->>'salesOrderLineId'=ANY($2::text[])),
  (SELECT max(coalesce(nullif(s.delivered_at,''),s.shipped_at)::timestamptz) FROM sales_shipments s WHERE s.workspace_id=$1 AND s.sales_order_id=$3 AND s.customer_return_id IS NULL AND s.status IN('SHIPPED','DELIVERED'))) AS at`,
  [ctx.workspaceId,lines.map(line=>line.salesOrderLineId),order.id])).rows[0]?.at;
 const prices=(await db.query('SELECT id,unit_price_minor FROM sales_order_lines WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,lines.map(line=>line.salesOrderLineId)])).rows;
 const priced=lines.every(line=>prices.some(row=>row.id===line.salesOrderLineId&&row.unit_price_minor!=null));
 const valueMinor=priced?require('../domain/currency').sum(lines.map(line=>require('../domain/exact-quantity').costMinor(line.quantity,Number(prices.find(row=>row.id===line.salesOrderLineId).unit_price_minor)))):null;
 const evidence={messageId:message.id,sender:message.sender,subject:message.subject,bodyHash:hash(message.body_text),sourceHash:message.content_hash,connectorId:message.connector_id,mailboxAccount:message.provider_account_id,providerType:message.provider_type,customerId:customer.id,customerEmail:customer.email,orderId:order.id,orderVersion:Number(order.version),orderNumber:order.order_number,locationId:location.id,locationName:location.name,requestReference:parsed.requestReference,lines,input,
  leftAt:left?new Date(left).toISOString():null,valueMinor,currency:order.currency};
 return {...evidence,customerName:customer.name,sourceFingerprint:hash(evidence)};
}
module.exports={parse,owner,facts,isReturnSubject};

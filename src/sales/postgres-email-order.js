'use strict';

const policy=require('../commercial/agent-plan');
const permissions=require('../actions/permissions');
const {ValidationError,NotFoundError}=require('../domain/errors');
const promotions=require('../pricing/postgres-promotions');
const uncertain=()=>new ValidationError('Review the original message. StockChief needs an exact product code and quantity for every line, and clear delivery instructions.');

// Match a complete line. A date, quoted price or second instruction must never
// silently become a quantity or disappear from a draft.
function parse(parts){
  if(parts.join('\n').length>30000)throw uncertain();
  const lines=[],codes=new Set();let reference=null,pickup=false,ordered=false;
  // PDF extraction can put several printed rows on one line. Restore boundaries
  // around complete SKU/quantity pairs and keep all surrounding text for review.
  const tableRow=/(?:^|[ \t])((?:SKU[ \t]+)?[\w./-]+[ \t]+(?:qty\.?[ \t]*[:=]?[ \t]*|[x×][ \t]*)\d+(?:\.\d+)?)(?=[ \t\r\n]|$)/gim;
  for(const text of parts)for(const raw of text.replace(tableRow,'\n$1').split(/\r?\n/)){
    const line=raw.trim();
    if(!line||/^(?:hello|hi|thanks|thank you|regards)[!. ,]*$/i.test(line))continue;
    if(/^(?:purchase order|new order|please (?:see (?:the )?attached (?:purchase )?order|order(?: the following)?))[.!:]?$/i.test(line)){ordered=true;continue;}
    const po=/^(?:purchase order|customer po|po)\s*(?:#|no\.?|number|:)\s*([\w.-]{1,60})$/i.exec(line);
    if(po){if(reference&&reference!==po[1])throw uncertain();reference=po[1];ordered=true;continue;}
    if(/^(?:customer pickup|pickup|pick up)[.!]?$/i.test(line)){pickup=true;continue;}
    const codeFirst=/^(?:SKU\s+)?([\w./-]+)\s+(?:qty\.?\s*[:=]?\s*|[x×]\s*)(\d+(?:\.\d+)?)$/i.exec(line);
    const quantityFirst=/^(?:please order\s+)?(\d+(?:\.\d+)?)\s*(?:[x×]\s*|units?\s+of\s+)([\w./-]+)[.]?$/i.exec(line);
    if(!codeFirst&&!quantityFirst)throw uncertain();
    if(/^please order\s/i.test(line))ordered=true;
    const code=(codeFirst?codeFirst[1]:quantityFirst[2]).toLowerCase(),quantity=Number(codeFirst?codeFirst[2]:quantityFirst[1]);
    if(quantity<=0||quantity>100000000||codes.has(code)||lines.length>=100)throw uncertain();
    codes.add(code);lines.push({code,quantity});
  }
  if(!ordered||!lines.length)throw uncertain();
  return {reference,lines,pickup};
}

async function review(c,ctx,id,{lock=false}={}){
  const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,52,'draft');
  await require('../commercial/entitlements').assertCapability(c,{accountId:state.accountId,workspaceId:ctx.workspaceId},'sales_orders.core');
  const actor=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
  permissions.assertCan(actor,permissions.OPERATE,'prepare a customer order');
  const m=(await c.query('SELECT * FROM connection_email_messages WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
  if(!m)throw new NotFoundError('This email was not found.');
  const existing=(await c.query('SELECT id,order_number FROM sales_orders WHERE workspace_id=$1 AND source_email_message_id=$2',[ctx.workspaceId,id])).rows[0];
  if(existing)return {existing};
  if(m.trust_status!=='TRUSTED'||m.classification!=='customer'||m.supplier_id)throw uncertain();
  if(!/^(?:(?:new |customer |purchase |sales )?order|purchase order attached|order request|po)(?:\s*(?:[:#-]|no\.|number)\s*[\w.-]+)?[.!]?$/i.test(String(m.subject||'').trim()))
    throw new ValidationError('Review the subject and original email before preparing this order.');
  const customers=(await c.query(`SELECT id,name,shipping_address FROM customers WHERE workspace_id=$1 AND lower(email)=lower($2) AND record_state='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM suppliers WHERE workspace_id=$1 AND lower(email)=lower($2) AND status='active') LIMIT 2`,[ctx.workspaceId,m.sender])).rows;
  if(customers.length!==1)throw uncertain();
  const customer=customers[0];
  const documents=(await c.query('SELECT filename,content_hash,extraction_status,extracted_text FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY id',[ctx.workspaceId,id])).rows;
  if(documents.some(d=>d.extraction_status!=='READABLE'||!d.extracted_text))throw new ValidationError('Wait for every attachment to finish reading, or review the original document.');
  const parsed=parse([m.body_text||'',...documents.map(d=>d.extracted_text)]);
  const subjectRef=/\s*(?:[:#]|no\.|number)\s*([\w.-]+)$/i.exec(m.subject||'');
  if(subjectRef&&parsed.reference&&subjectRef[1].toLowerCase()!==parsed.reference.toLowerCase())throw uncertain();
  if(!parsed.reference&&subjectRef)parsed.reference=subjectRef[1];
  if(!parsed.pickup&&!customer.shipping_address)throw new ValidationError('Add a delivery address to this customer before creating the order.');
  const skus=(await c.query(`SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND lower(s.code)=ANY($2::text[])`,[ctx.workspaceId,parsed.lines.map(l=>l.code)])).rows;
  const lines=parsed.lines.map(line=>{
    const found=skus.filter(s=>s.code.toLowerCase()===line.code);if(found.length!==1)throw uncertain();
    return {skuId:found[0].id,quantity:line.quantity};
  });
  const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD';
  const input={customerId:customer.id,reference:parsed.reference,currency,deliveryMethod:parsed.pickup?'PICKUP':'SHIP',lines,idempotencyKey:'customer-order-email:'+id};
  const quote=await promotions.prepareQuote(c,ctx,input,{lock});
  if(quote.violations.length)throw new ValidationError('Review the current selling prices and pricing safeguards before creating this order.');
  input.pricingQuoteHash=promotions.quoteHash(quote);
  const digest=promotions.hash({input,address:parsed.pickup?null:customer.shipping_address,sender:m.sender,body:m.body_text,documents:documents.map(d=>d.content_hash)});
  return {input,digest,customer,quote,skus};
}

async function create(db,ctx,id,digest,{automatic=false}={}){
  return db.transaction(async c=>{
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,52,automatic?'automatic':'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,'sales_order.create',automatic,{});
    if(stop)throw new ValidationError(stop);
    if(automatic){
      const authorized=(await c.query(`SELECT 1 FROM workspace_autopilot a JOIN stockchief_runtime.agent_job_modes j ON j.workspace_id=a.workspace_id
        WHERE a.workspace_id=$1 AND a.mode='POLICY_AUTOMATED' AND a.paused=0 AND a.suspended=0 AND j.job_id=52 AND j.mode='routine' AND j.updated_by=$2`,[ctx.workspaceId,ctx.actorId])).rowCount;
      if(state.shadow||!authorized)throw new ValidationError('This order is waiting for individual review.');
    }
    const restriction=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,52,automatic);
    if(restriction)throw new ValidationError(restriction);
    const result=await review(c,ctx,id,{lock:true});
    if(result.existing)return {salesOrderId:result.existing.id,replayed:true};
    if(!automatic&&result.digest!==digest)throw new ValidationError('The order details changed. Review the current order before saving.');
    const {input}=result;
    if(automatic&&!input.reference)throw new ValidationError('Review this order individually because the customer did not provide a purchase order number.');
    if(automatic&&await policy.customerOrderNeedsPerson(c,ctx.workspaceId,'sales_order.create',{...input,shipToAddress:result.customer.shipping_address}))
      throw new ValidationError('A person must review the first order for this customer or delivery address.');
    if(input.reference){
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([ctx.workspaceId,input.customerId,input.reference.toLowerCase()])]);
      if((await c.query('SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND customer_id=$2 AND lower(reference)=lower($3)',[ctx.workspaceId,input.customerId,input.reference])).rowCount)
        throw new ValidationError('An order already uses this customer purchase order number. Check it before creating another.');
    }
    const created=await require('../operations/postgres-business-workflows').createSalesOrderInTransaction(c,ctx,input);
    await c.query('UPDATE sales_orders SET source_email_message_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,created.salesOrderId,id]);
    return created;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function onArrival(db,workspaceId,id){
  const actor=(await db.query(`SELECT u.id FROM stockchief_runtime.agent_job_modes j JOIN users u ON u.workspace_id=j.workspace_id AND u.id=j.updated_by
    JOIN connection_email_messages m ON m.workspace_id=j.workspace_id AND m.id=$2
    WHERE j.workspace_id=$1 AND j.job_id=52 AND j.mode='routine' AND u.role='owner' AND m.classification='customer' AND m.agent_category='order'`,[workspaceId,id])).rows[0];
  if(!actor)return {skipped:true};
  try{return await create(db,{workspaceId,actorId:actor.id},id,null,{automatic:true});}
  catch(e){
    if(![400,402,403,404,422].includes(e.status))throw e;
    await db.query(`UPDATE connection_email_messages m SET order_draft_reason=$3 WHERE workspace_id=$1 AND id=$2
      AND NOT EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=m.workspace_id AND o.source_email_message_id=m.id)`,[workspaceId,id,e.message]);
    return {held:true,reason:e.message};
  }
}
module.exports={review,create,onArrival};

'use strict';

const { newId,nowIso }=require('../lib/util');
const { ValidationError,NotFoundError,InvariantError }=require('../domain/errors');
const providerRegistry=require('./index');
const providerEffects=require('../operations/postgres-provider-effects');
const workflows=require('../operations/postgres-business-workflows');
const customerReturns=require('../operations/postgres-returns');

function scopedDatabase(client){return {query:(statement,values=[])=>client.query(statement,values),
  transaction:(operation)=>operation(client)};}

function hydrate(row){if(!row)return null;return {id:row.id,workspaceId:row.workspace_id,invoiceId:row.invoice_id,
  salesOrderId:row.sales_order_id,customerId:row.customer_id,provider:row.provider,purpose:row.purpose,
  amountMinor:Number(row.amount_minor),paidMinor:Number(row.paid_minor),currency:row.currency,status:row.status,
  externalCustomerId:row.external_customer_id,externalInvoiceId:row.external_invoice_id,hostedUrl:row.hosted_url,
  lastError:row.last_error,createdAt:row.created_at,updatedAt:row.updated_at,openedAt:row.opened_at,paidAt:row.paid_at};}

async function accountFor(database,workspaceId,provider='stripe'){
  const row=(await database.query(`SELECT * FROM payment_connect_accounts
    WHERE workspace_id=$1 AND provider=$2`,[workspaceId,provider])).rows[0]||null;
  if(!row)throw new ValidationError('Connect this inventory’s own payment account before asking a customer to pay online.');
  if(Number(row.charges_enabled)!==1)throw new ValidationError('The connected payment account is not approved to take customer payments yet.');
  return row;
}

function providerContext(account,options={}){
  if(typeof options.accountContext==='function')return options.accountContext(account);
  if(account.provider!=='stripe')return {workspaceId:account.workspace_id,providerAccountId:account.provider_account_id};
  const secretKey=process.env.STRIPE_SECRET_KEY;
  if(!secretKey)throw new ValidationError('Stripe collection is not configured on this StockChief installation.');
  return {workspaceId:account.workspace_id,stripeSecretKey:secretKey,stripeAccountId:account.provider_account_id};
}

async function listForOrder(database,workspaceId,orderId){const result=await database.query(`SELECT request.*,
    effect.status AS effect_status,effect.error_message AS effect_error_message
  FROM payment_requests request LEFT JOIN stockchief_runtime.provider_effects effect
    ON effect.workspace_id=request.workspace_id AND effect.kind='payment.request.create'
    AND effect.payload->>'requestId'=request.id
  WHERE request.workspace_id=$1 AND request.sales_order_id=$2
  ORDER BY request.created_at DESC,request.id DESC`,[workspaceId,orderId]);
  return result.rows.map((row)=>({...hydrate(row),effectStatus:row.effect_status,effectErrorMessage:row.effect_error_message}));}

async function get(database,workspaceId,id){const row=(await database.query(
  'SELECT * FROM payment_requests WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That payment request was not found.');return hydrate(row);}

async function queueRequest(database,ctx,orderId,input={}){
  const providerName=String(input.provider||'stripe').toLowerCase();
  const purpose=['DEPOSIT','BALANCE','FULL'].includes(input.purpose)?input.purpose:'BALANCE';
  return database.transaction(async(client)=>{
    const actor=(await client.query('SELECT id FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');
    const order=(await client.query(`SELECT orders.*,customer.name AS customer_name,customer.email AS customer_email
      FROM sales_orders orders JOIN customers customer ON customer.id=orders.customer_id
      WHERE orders.workspace_id=$1 AND orders.id=$2 FOR UPDATE OF orders`,[ctx.workspaceId,orderId])).rows[0];
    if(!order)throw new NotFoundError('That sales order was not found.');
    if(!order.customer_email)throw new ValidationError(`${order.customer_name} needs an email address before StockChief can prepare a payment link.`);
    const invoice=purpose==='DEPOSIT'?null:(await client.query(`SELECT * FROM accounting_customer_invoices
      WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('OPEN','PARTIALLY_PAID')
      AND ($3::text IS NULL OR id=$3) ORDER BY issue_date DESC,id DESC LIMIT 1 FOR UPDATE`,
    [ctx.workspaceId,orderId,input.invoiceId||null])).rows[0];
    if(purpose!=='DEPOSIT'&&!invoice)throw new ValidationError('This order has no open customer invoice to collect. Fulfill the goods first or request an agreed deposit.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`payment-request:${ctx.workspaceId}:${providerName}:${invoice?.id||orderId}:${purpose}`]);
    const account=(await client.query(`SELECT * FROM payment_connect_accounts
      WHERE workspace_id=$1 AND provider=$2 FOR UPDATE`,[ctx.workspaceId,providerName])).rows[0];
    if(!account)throw new ValidationError('Connect this inventory’s own payment account before asking a customer to pay online.');
    if(Number(account.charges_enabled)!==1)throw new ValidationError('The connected payment account is not approved to take customer payments yet.');
    const prior=(await client.query(`SELECT * FROM payment_requests WHERE workspace_id=$1 AND provider=$2
      AND invoice_id IS NOT DISTINCT FROM $3 AND sales_order_id=$4 AND purpose=$5
      AND status IN ('PENDING','OPEN','REVIEW') ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
    [ctx.workspaceId,providerName,invoice?.id||null,orderId,purpose])).rows[0];
    if(prior){const effect=(await client.query(`SELECT id FROM stockchief_runtime.provider_effects
        WHERE workspace_id=$1 AND kind='payment.request.create' AND payload->>'requestId'=$2
        ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,prior.id])).rows[0];
      return {request:hydrate(prior),effectId:effect?.id||null,queued:prior.status==='PENDING',replayed:true};}
    let amountMinor=Number(invoice?.balance_minor||0);let currency=invoice?.currency||order.currency;
    if(purpose==='DEPOSIT'){
      const terms=(await client.query(`SELECT * FROM customer_payment_terms
        WHERE workspace_id=$1 AND (customer_id=$2 OR customer_id IS NULL)
        ORDER BY (customer_id IS NULL),updated_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [ctx.workspaceId,order.customer_id])).rows[0];
      if(!terms||terms.kind!=='DEPOSIT')throw new ValidationError('This customer has no agreed deposit terms. Set the terms before requesting money.');
      const total=(await client.query(`SELECT COALESCE(SUM(quantity_ordered*unit_price_minor),0)::bigint AS subtotal
        FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2`,[ctx.workspaceId,orderId])).rows[0];
      const orderTotal=Math.max(0,Number(total.subtotal)-Number(order.discount_minor||0)+Number(order.tax_minor||0));
      const required=terms.deposit_minor==null
        ?Math.round(orderTotal*Number(terms.deposit_percent||0)/100)
        :Math.min(orderTotal,Number(terms.deposit_minor));
      const received=(await client.query(`SELECT COALESCE(SUM(amount_minor),0)::bigint AS amount
        FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2
          AND direction='CUSTOMER_RECEIPT' AND status='POSTED'`,[ctx.workspaceId,orderId])).rows[0];
      amountMinor=Math.max(0,required-Number(received.amount));
      if(amountMinor===0)throw new ValidationError('The agreed deposit has already been received for this order.');
    }
    if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new ValidationError('This invoice has no positive balance to collect.');
    const requestId=newId('payreq');const at=nowIso();
    await client.query(`INSERT INTO payment_requests
      (id,workspace_id,invoice_id,sales_order_id,customer_id,provider,purpose,amount_minor,currency,status,
       created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING',$10,$11,$11)`,[requestId,ctx.workspaceId,invoice?.id||null,
      orderId,order.customer_id,providerName,purpose,amountMinor,currency,ctx.actorId,at]);
    const queued=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,
      kind:'payment.request.create',provider:providerName,aggregateType:'payment_request',aggregateId:requestId,
      idempotencyKey:`payment-request:${requestId}`,requestedByUserId:ctx.actorId,
      payload:{requestId,orderId,invoiceId:invoice?.id||null,actorId:ctx.actorId},priority:10,maxAttempts:12});
    return {request:hydrate((await client.query('SELECT * FROM payment_requests WHERE id=$1',[requestId])).rows[0]),
      effectId:queued.effect.id,queued:true,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function executeRequestEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {request:await get(database,workspaceId,claimed.effect.aggregateId),replayed:true};
  const effect=claimed.effect;const input=effect.payload;let providerCalled=false;
  try{
    const request=(await database.query(`SELECT request.*,customer.name AS customer_name,customer.email AS customer_email,
        orders.order_number,invoice.invoice_number,invoice.due_date
      FROM payment_requests request JOIN customers customer ON customer.id=request.customer_id
      JOIN sales_orders orders ON orders.id=request.sales_order_id
      LEFT JOIN accounting_customer_invoices invoice ON invoice.id=request.invoice_id
      WHERE request.workspace_id=$1 AND request.id=$2`,[workspaceId,input.requestId])).rows[0];
    if(!request||request.status!=='PENDING')throw Object.assign(new ValidationError('That payment request is no longer pending.'),
      {code:'payment_request_not_pending',status:409});
    const account=await accountFor(database,workspaceId,effect.provider);
    const provider=options.provider||providerRegistry.get(effect.provider);
    const ctx=providerContext(account,options);
    const previous=(await database.query(`SELECT external_customer_id FROM payment_requests
      WHERE workspace_id=$1 AND customer_id=$2 AND provider=$3 AND external_customer_id IS NOT NULL
      ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId,request.customer_id,effect.provider])).rows[0];
    providerCalled=true;
    const externalCustomerId=previous?.external_customer_id||(await provider.createCustomer(ctx,
      {name:request.customer_name,email:request.customer_email})).externalCustomerId;
    const created=await provider.createInvoice(ctx,{externalCustomerId,attemptId:request.id,
      amountMinor:Number(request.amount_minor),currency:request.currency,
      description:request.purpose==='DEPOSIT'?`Deposit for ${request.order_number}`:request.order_number,
      reference:request.invoice_number||`${request.order_number}-deposit`,dueDate:request.due_date||null,
      idempotencyKey:effect.idempotencyKey});
    if(!created?.externalInvoiceId||!created?.hostedUrl)throw Object.assign(
      new ValidationError('The payment provider did not confirm a hosted payment page. Nothing was sent to the customer.'),
      {code:'payment_hosted_page_missing',status:422});
    await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{
      customerId:externalCustomerId,invoiceId:created.externalInvoiceId},result:{hostedUrl:created.hostedUrl},
    apply:async(client)=>{const at=nowIso();await client.query(`UPDATE payment_requests SET status='OPEN',
      external_customer_id=$3,external_invoice_id=$4,hosted_url=$5,last_error=NULL,opened_at=$6,updated_at=$6
      WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[workspaceId,request.id,externalCustomerId,
      created.externalInvoiceId,created.hostedUrl,at]);}});
    return {request:await get(database,workspaceId,input.requestId),replayed:false};
  }catch(error){const ambiguous=providerCalled&&!providerEffects.definiteFailure(error);
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous,
      apply:(client)=>client.query(`UPDATE payment_requests SET status=$3,last_error=$4,updated_at=$5
        WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[workspaceId,input.requestId,
        ambiguous?'REVIEW':'FAILED',String(error.message||'Payment provider failed.').slice(0,500),nowIso()])});
    throw Object.assign(error,{code:ambiguous?'payment_request_ambiguous':(error.code||'payment_request_failed'),retryable:false});
  }
}

async function receiveVerifiedEvent(database,workspaceId,providerName,event,options={}){
  const provider=options.provider||providerRegistry.get(providerName);
  const externalEventId=String(event?.id||'').trim();
  if(!externalEventId)throw new ValidationError('That payment event has no stable identity.');
  const read=providerRegistry.normalise(provider.readEvent(event));
  return database.transaction(async(client)=>{
    const prior=(await client.query(`SELECT outcome,payment_id FROM payment_provider_events
      WHERE workspace_id=$1 AND provider=$2 AND external_event_id=$3`,[workspaceId,providerName,externalEventId])).rows[0];
    if(prior)return {applied:false,replayed:true,outcome:prior.outcome,paymentId:prior.payment_id};
    const request=read.externalInvoiceId?(await client.query(`SELECT * FROM payment_requests
      WHERE workspace_id=$1 AND provider=$2 AND external_invoice_id=$3 FOR UPDATE`,
    [workspaceId,providerName,read.externalInvoiceId])).rows[0]:null;
    const eventId=newId('payevt');const at=nowIso();
    await client.query(`INSERT INTO payment_provider_events
      (id,workspace_id,provider,external_event_id,event_type,payload,request_id,external_payment_id,received_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[eventId,workspaceId,providerName,externalEventId,read.kind,
      JSON.stringify(event||{}),request?.id||null,read.externalPaymentId||null,at]);
    const finish=async(outcome,paymentId=null)=>{await client.query(`UPDATE payment_provider_events SET outcome=$2,
      payment_id=$3,processed_at=$4 WHERE id=$1`,[eventId,outcome,paymentId,nowIso()]);
      return {applied:Boolean(paymentId),replayed:false,outcome,paymentId,requestId:request?.id||null};};
    if(read.kind==='IGNORED')return finish(read.reason||'Nothing StockChief acts on.');
    if(!request)return finish('No payment request in this inventory matches that provider invoice.');
    if(read.kind==='FAILED'){await client.query(`UPDATE payment_requests SET last_error=$2,updated_at=$3 WHERE id=$1`,
      [request.id,read.reason||'The customer payment failed.',at]);return finish(read.reason||'The customer payment failed.');}
    if(read.kind==='REFUNDED')return finish('A refund was reported. StockChief recorded the evidence but did not invent a refund posting.');
    const cumulative=Number(read.amountMinor);
    if(!Number.isSafeInteger(cumulative)||cumulative<=0)return finish('The provider reported no positive paid amount. Nothing was posted.');
    const delta=cumulative-Number(request.paid_minor||0);
    if(delta<=0)return finish(`The provider reported ${cumulative} minor units paid, which StockChief already recorded.`);
    if(cumulative>Number(request.amount_minor)){const message='The provider reported more money than StockChief requested. Nothing was posted automatically.';
      await client.query(`UPDATE payment_requests SET status='REVIEW',last_error=$2,updated_at=$3 WHERE id=$1`,[request.id,message,at]);
      return finish(message);}
    const paymentInput={customerId:request.customer_id,customerInvoiceId:request.invoice_id,
      salesOrderId:request.sales_order_id,amountMinor:delta,paymentDate:(read.paidAt||at).slice(0,10),
      currency:read.currency||request.currency,method:read.method||providerName,
      reference:read.externalPaymentId||externalEventId,sourceKey:`${providerName}:${request.id}:paid:${cumulative}`,
      idempotencyKey:`provider-payment:${providerName}:${request.id}:${cumulative}`};
    const receipt=await (request.purpose==='DEPOSIT'?workflows.recordCustomerDeposit:workflows.recordCustomerPayment)(scopedDatabase(client),{
      workspaceId,actorId:null,systemSource:'payment_provider',providerEventId:eventId,providerRequestId:request.id,
    },paymentInput);
    const paidMinor=Number(request.paid_minor||0)+delta;const status=paidMinor>=Number(request.amount_minor)?'PAID':'OPEN';
    await client.query(`UPDATE payment_requests SET paid_minor=$2,status=$3,paid_at=CASE WHEN $3='PAID' THEN $4 ELSE paid_at END,
      last_error=NULL,updated_at=$4 WHERE id=$1`,[request.id,paidMinor,status,at]);
    return finish(`Recorded ${delta} minor units through the canonical customer-payment journal.`,receipt.paymentId);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

function parseJson(value,fallback={}){if(value&&typeof value==='object')return value;
  try{return JSON.parse(value||JSON.stringify(fallback));}catch{return fallback;}}

async function queueCustomerReturnRefund(database,ctx,customerReturnId,input={}){
  const providerName=String(input.provider||'stripe').toLowerCase();
  return database.transaction(async(client)=>{
    const actor=(await client.query('SELECT id FROM users WHERE workspace_id=$1 AND id=$2',
      [ctx.workspaceId,ctx.actorId])).rows[0];
    if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');
    const row=(await client.query(`SELECT r.*,so.customer_id,so.currency
      FROM customer_returns r JOIN sales_orders so ON so.id=r.sales_order_id AND so.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND r.id=$2 FOR UPDATE OF r`,[ctx.workspaceId,customerReturnId])).rows[0];
    if(!row)throw new NotFoundError('That customer return was not found.');
    if(row.resolution!=='REFUND'||row.status!=='AWAITING_REFUND')throw new ValidationError('This return is not waiting for a refund.');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
      [`payment-refund:${ctx.workspaceId}:${customerReturnId}`]);
    const prior=(await client.query(`SELECT * FROM payment_refund_requests
      WHERE workspace_id=$1 AND customer_return_id=$2 FOR UPDATE`,[ctx.workspaceId,customerReturnId])).rows[0];
    if(prior){const effect=(await client.query(`SELECT id FROM stockchief_runtime.provider_effects
        WHERE workspace_id=$1 AND kind='payment.refund.create' AND aggregate_id=$2
        ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId,customerReturnId])).rows[0];
      return {refund:prior,effectId:effect?.id||null,queued:prior.status==='PENDING',replayed:true};}
    const lines=(await client.query(`SELECT rl.tracking_evidence,sol.unit_price_minor
      FROM customer_return_lines rl JOIN sales_order_lines sol ON sol.id=rl.sales_order_line_id
      WHERE rl.workspace_id=$1 AND rl.customer_return_id=$2`,[ctx.workspaceId,customerReturnId])).rows;
    const amountMinor=lines.reduce((sum,line)=>sum+(parseJson(line.tracking_evidence).costAllocations||[])
      .reduce((lineSum,allocation)=>lineSum+Number(allocation.quantity)*Number(line.unit_price_minor),0),0);
    if(!Number.isSafeInteger(amountMinor)||amountMinor<=0)throw new ValidationError('This return has no verified amount to refund.');
    const paid=(await client.query(`SELECT request.id AS payment_request_id,request.paid_minor,request.currency,
        event.external_payment_id,
        COALESCE((SELECT SUM(refund.amount_minor) FROM payment_refund_requests refund
          WHERE refund.workspace_id=request.workspace_id AND refund.payment_request_id=request.id
            AND refund.status IN ('PENDING','REVIEW','SUCCEEDED')),0)::bigint AS refunded_minor
      FROM payment_requests request JOIN LATERAL (
        SELECT external_payment_id FROM payment_provider_events event
        WHERE event.workspace_id=request.workspace_id AND event.request_id=request.id
          AND event.payment_id IS NOT NULL AND event.external_payment_id IS NOT NULL
        ORDER BY event.processed_at DESC,event.received_at DESC LIMIT 1) event ON true
      WHERE request.workspace_id=$1 AND request.sales_order_id=$2 AND request.provider=$3
        AND request.paid_minor>0 ORDER BY request.paid_at DESC,request.created_at DESC FOR UPDATE OF request`,
    [ctx.workspaceId,row.sales_order_id,providerName])).rows.find((candidate)=>
      Number(candidate.paid_minor)-Number(candidate.refunded_minor)>=amountMinor);
    if(!paid)return {queued:false,replayed:false,noProviderPayment:true,amountMinor};
    await accountFor(scopedDatabase(client),ctx.workspaceId,providerName);
    const id=newId('payrefund');const at=nowIso();
    await client.query(`INSERT INTO payment_refund_requests
      (id,workspace_id,customer_return_id,payment_request_id,provider,amount_minor,currency,
       external_payment_id,status,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$10)`,
    [id,ctx.workspaceId,customerReturnId,paid.payment_request_id,providerName,amountMinor,
      paid.currency,paid.external_payment_id,ctx.actorId,at]);
    const queued=await providerEffects.enqueueInTransaction(client,{workspaceId:ctx.workspaceId,
      kind:'payment.refund.create',provider:providerName,aggregateType:'customer_return',aggregateId:customerReturnId,
      idempotencyKey:`payment-refund:${customerReturnId}`,requestedByUserId:ctx.actorId,
      payload:{refundRequestId:id,customerReturnId,actorId:ctx.actorId},priority:5,maxAttempts:12});
    return {refund:(await client.query('SELECT * FROM payment_refund_requests WHERE id=$1',[id])).rows[0],
      effectId:queued.effect.id,queued:true,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function executeRefundEffect(database,workspaceId,effectId,options={}){
  const claimed=await providerEffects.claim(database,workspaceId,effectId);
  if(claimed.replayed)return {refundId:claimed.effect.result?.refundId||null,replayed:true};
  const effect=claimed.effect;let providerCalled=false;
  try{
    const refund=(await database.query(`SELECT * FROM payment_refund_requests
      WHERE workspace_id=$1 AND id=$2`,[workspaceId,effect.payload.refundRequestId])).rows[0];
    if(!refund||refund.status!=='PENDING')throw Object.assign(new ValidationError('That refund is no longer pending.'),
      {code:'payment_refund_not_pending',status:409});
    const account=await accountFor(database,workspaceId,effect.provider);
    const provider=options.provider||providerRegistry.get(effect.provider);
    providerCalled=true;
    const created=await provider.refundPayment(providerContext(account,options),{
      externalPaymentId:refund.external_payment_id,amountMinor:Number(refund.amount_minor),
      idempotencyKey:effect.idempotencyKey});
    if(!created?.externalRefundId)throw Object.assign(new ValidationError(
      'The payment provider did not confirm the refund. StockChief did not change cash or accounting.'),
    {code:'payment_refund_confirmation_missing',status:422});
    let accountingResult=null;
    await providerEffects.succeed(database,workspaceId,effectId,effect.claimToken,{providerReference:{
      paymentId:refund.external_payment_id,refundId:created.externalRefundId},
    result:{refundId:created.externalRefundId,amountMinor:Number(refund.amount_minor)},apply:async(client)=>{
      accountingResult=await customerReturns.refundCustomerReturnInTransaction(client,{
        workspaceId,actorId:null,systemSource:'payment_provider_refund',providerEffectId:effectId,
      },refund.customer_return_id,{destination:'CASH',refundDate:nowIso().slice(0,10),
        idempotencyKey:`provider-refund:${refund.id}`});
      await client.query(`UPDATE payment_refund_requests SET status='SUCCEEDED',external_refund_id=$3,
        accounting_refund_id=$4,last_error=NULL,completed_at=$5,updated_at=$5 WHERE workspace_id=$1 AND id=$2`,
      [workspaceId,refund.id,created.externalRefundId,accountingResult.refundIds[0]||null,nowIso()]);
    }});
    return {refundId:created.externalRefundId,accountingResult,replayed:false};
  }catch(error){const ambiguous=providerCalled&&!providerEffects.definiteFailure(error);
    await providerEffects.finishError(database,workspaceId,effectId,effect.claimToken,error,{ambiguous,
      apply:(client)=>client.query(`UPDATE payment_refund_requests SET status=$3,last_error=$4,updated_at=$5
        WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[workspaceId,effect.payload.refundRequestId,
        ambiguous?'REVIEW':'FAILED',String(error.message||'Payment refund failed.').slice(0,500),nowIso()])});
    throw Object.assign(error,{code:ambiguous?'payment_refund_ambiguous':(error.code||'payment_refund_failed'),retryable:false});
  }
}

module.exports={hydrate,get,listForOrder,accountFor,queueRequest,executeRequestEffect,receiveVerifiedEvent,
  queueCustomerReturnRefund,executeRefundEffect};

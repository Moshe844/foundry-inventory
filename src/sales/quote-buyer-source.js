
'use strict';

const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),permissions=require('../actions/permissions');
const pricing=require('../pricing/postgres-promotions'),money=require('../domain/currency');
const quotes=require('./postgres-quotes');
const ACTION='sales_quote.accept';
const JOB=75;
const unavailable=()=>new NotFoundError('This private quotation is unavailable. Please contact the business.');
const normalizeEmail=value=>String(value||'').trim().toLowerCase();
const termsHash=quote=>pricing.quoteHash({...quote,lines:quote.lines.map(l=>({...l,costUnitMinor:null}))});

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',
    [ctx.workspaceId]);
  const actor=(await db.query(`SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF u,w':''),[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!actor)throw new AuthorizationError('Only the current inventory owner can authorize a private quotation or its draft order.');
  permissions.assertCan(actor,permissions.MANAGE_SALES,'manage private quotations');
}

async function access(db,ctx,{automatic=false,stop=false,lock=false}={}){
  await owner(db,ctx,{lock});
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,automatic?'automatic':'draft');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'sales_orders.core');
  if(stop){
    const reason=await policy.stopped(db,ctx.workspaceId,account,ACTION,automatic);
    if(reason)throw new ValidationError(reason);
    if(automatic&&lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate){
      throw new ValidationError('Routine drafting of accepted quotations is paused.');
    }
  }
  return account;
}

async function currentQuote(db,ctx,q,{lockPricing=false}={}){
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  if(q.status!=='OPEN'||q.sales_order_id||q.valid_until<today)throw new ValidationError('Use an open, unexpired quotation.');
  if((await db.query('SELECT 1 FROM sales_quotations WHERE workspace_id=$1 AND supersedes_id=$2 LIMIT 1',[ctx.workspaceId,q.id])).rowCount){
    throw new ValidationError('A newer revision replaces this quotation.');
  }
  if(pricing.quoteHash(q.pricing)!==q.pricing_hash)throw new ValidationError('Review the saved quotation’s integrity before sharing or accepting it.');
  const {labels,units}=await quotes.describeLines(db,ctx.workspaceId,q.input.lines);
  if(pricing.hash(labels)!==pricing.hash(q.line_labels)||pricing.hash(units)!==pricing.hash(q.line_units)){
    throw new ValidationError('Product descriptions or units changed. Prepare a fresh quotation revision.');
  }
  const customer=(await db.query(`SELECT id,name,company,email,phone,shipping_address FROM customers
    WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,[ctx.workspaceId,q.customer_id])).rows[0];
  const email=normalizeEmail(customer?.email);
  if(!customer||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    throw new ValidationError('Confirm the existing customer and their email before publishing a private quotation.');
  }
  if(q.input.customerEmail&&normalizeEmail(q.input.customerEmail)!==email){
    throw new ValidationError('The quotation contact differs from the confirmed customer email. Review the customer and quote first.');
  }
  const method=String(q.input.deliveryMethod||'SHIP').trim().toUpperCase();
  if(!['SHIP','PICKUP','OWN_DELIVERY'].includes(method))throw new ValidationError('Review the quoted delivery method.');
  const deliveryMethod=method==='PICKUP'?'PICKUP':'SHIP';
  const shippingAddress=deliveryMethod==='SHIP'?String(q.input.shipToAddress??customer.shipping_address??'').trim():null;
  if(deliveryMethod==='SHIP'&&!shippingAddress)throw new ValidationError('Confirm the quoted delivery address first.');
  const warehouse=q.input.fulfillmentLocationId||null;
  if(warehouse){
    await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[warehouse]);
    if(!(await db.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',
      [ctx.workspaceId,warehouse])).rowCount)throw new ValidationError('The quotation fulfillment location is unavailable.');
  }
  const live=await pricing.prepareQuote(db,ctx,q.input,{lock:lockPricing});
  if(live.violations.length||termsHash(live)!==termsHash(q.pricing)){
    throw new ValidationError('The quote’s prices, discounts, taxes or safeguards changed. Prepare a fresh revision.');
  }
  const issued=(await db.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0];
  const source={quoteId:q.id,quoteNumber:q.quote_number,quoteHash:q.pricing_hash,validUntil:q.valid_until,
    inputHash:pricing.hash(q.input),customerId:q.customer_id,customerName:customer.name,company:customer.company||null,email,
    phone:String(q.input.customerPhone??customer.phone??'').trim()||null,shippingAddress,deliveryMethod,warehouse,issuer:issued.name};
  return {source,live};
}

function publicTerms(terms,currency){
  if(terms.kind==='BEFORE_FULFILMENT')return 'Payment before fulfillment';
  const settlement=terms.hold_shipping?' · Balance due before shipment':'';
  if(terms.kind==='DEPOSIT'){
    const amount=terms.deposit_minor!=null?money.format(terms.deposit_minor,currency):terms.deposit_percent+'%';
    return 'Deposit of '+amount+' before fulfillment'+settlement;
  }
  return 'Net '+terms.net_days+' days from invoice'+settlement;
}

function publicOffer(q,offer){
  const currency=money.code(q.pricing.currency);
  return {quoteNumber:offer.source.quoteNumber,issuer:offer.source.issuer,customer:offer.source.company||offer.source.customerName,
    validUntil:offer.source.validUntil,orderDate:q.input.orderDate||null,neededBy:q.input.neededBy||null,
    shippingAddress:offer.source.shippingAddress,deliveryMethod:offer.source.deliveryMethod,
    terms:publicTerms(offer.paymentTerms,currency),currency,
    subtotalMinor:q.pricing.subtotalMinor,discountMinor:q.pricing.discountMinor,taxMinor:q.pricing.taxMinor,
    chargesMinor:q.pricing.chargesMinor||0,totalMinor:q.pricing.totalMinor,
    lines:q.pricing.lines.map(l=>({product:q.line_labels[l.skuId],unit:q.line_units[l.skuId].quantity,
      priceUnit:q.line_units[l.skuId].price,quantity:l.quantity,pricedQuantity:l.pricingQuantity??null,
      unitPriceMinor:l.unitPriceMinor,discountMinor:l.discountMinor,taxMinor:l.taxMinor,totalMinor:l.totalMinor}))};
}

module.exports={ACTION,JOB,unavailable,normalizeEmail,access,owner,currentQuote,publicOffer};

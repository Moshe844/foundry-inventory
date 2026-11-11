'use strict';
const {ValidationError}=require('../domain/errors');
const pricing=require('../pricing/postgres-promotions');
const quotes=require('./postgres-quotes');
const policy=require('../commercial/agent-plan');
const permissions=require('../actions/permissions');

async function prepare(db,ctx,customer,args){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,73,'draft');
  let supplied;
  try{supplied=JSON.parse(args.orderLines);}catch{throw new ValidationError('Provide the requested products and quantities as order lines.');}
  if(!Array.isArray(supplied)||!supplied.length||supplied.length>100)throw new ValidationError('Choose one to 100 quotation lines.');
  const currency=require('../pricing/postgres-service').normaliseCurrency(args.currency||customer.currency||
    (await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD');
  const lines=[];
  for(const line of supplied){
    if(!line||typeof line!=='object'||!String(line.sku||'').trim())throw new ValidationError('Name the exact SKU on every quotation line.');
    const found=(await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE s.workspace_id=$1 AND lower(s.code)=lower($2) AND s.is_active=1 AND i.is_active=1 LIMIT 2`,[ctx.workspaceId,line.sku])).rows;
    if(found.length!==1)throw new ValidationError('Choose one active SKU for '+line.sku+'.');
    if(lines.some(l=>l.skuId===found[0].id))throw new ValidationError('List each quoted product once.');
    lines.push({skuId:found[0].id,quantity:line.quantity,
      ...(line.secondaryQuantity!=null?{secondaryQuantity:line.secondaryQuantity}:{}),
      ...(line.unitPrice!==undefined?{unitPriceMinor:require('../domain/currency').userToMinor(line.unitPrice,currency)}:{})});
  }
  const today=await require('../lib/business-time').today(db,ctx.workspaceId),validUntil=String(args.quoteValidUntil||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(validUntil)||!Number.isFinite(Date.parse(validUntil))||new Date(validUntil+'T00:00:00Z').toISOString().slice(0,10)!==validUntil||validUntil<today)
    throw new ValidationError('Choose a real quotation expiry on or after today.');
  const deliveryMethod=args.deliveryMethod||'PICKUP';
  if(!['SHIP','PICKUP'].includes(deliveryMethod))throw new ValidationError('Choose SHIP or PICKUP for this quotation.');
  const shipToAddress=deliveryMethod==='SHIP'?String(args.shipToAddress||customer.shipping_address||'').trim():null;
  if(deliveryMethod==='SHIP'&&!shipToAddress)throw new ValidationError('Choose the customer delivery address for this quotation.');
  const input={customerId:customer.id,currency,orderDate:today,deliveryMethod,shipToAddress,lines,
    codes:String(args.couponCodes||'').split(',').map(code=>code.trim()).filter(Boolean),priceListId:args.priceListId||null};
  const priced=await pricing.prepareQuote(db,ctx,input);
  await require('./agent-customer-pricing').checkOrder(db,ctx,input,priced);
  if(priced.violations.length)throw new ValidationError('Review the current price safeguards before preparing this quote.');
  const training=require('../autopilot/draft-authority').scope(customer.id,input.currency,priced.totalMinor,
    ['quotation',deliveryMethod,shipToAddress,...lines.map(l=>l.skuId).sort()],customer.name+' · customer quotation');
  return {payload:{input,validUntil,reviewedHash:pricing.quoteHash(priced),training},
    summary:'Prepare a quote for '+customer.name+' with '+lines.length+' product lines, '+require('../domain/currency').format(priced.totalMinor,input.currency)+', valid through '+validUntil+
      '. '+require('./customer-commercial-terms').describe(priced.customerTerms,input.currency)+'.'};
}
const scoped=db=>({query:(...args)=>db.query(...args),transaction:fn=>fn(db)});
const specs=[{
  name:'sales_quote.create',description:'Prepare a customer quotation for exact SKU lines at current prices, discounts and terms. Supply orderLines and quoteValidUntil.',
  record:'customer',fields:['recordReference','orderLines','quoteValidUntil','currency','deliveryMethod','shipToAddress','couponCodes','priceListId'],permission:permissions.MANAGE_SALES,capability:'sales_orders.core',
  build:prepare,execute:async(db,ctx,p)=>{
    await policy.requireWorkspaceJob(db,ctx.workspaceId,73,'draft');
    const current=await pricing.prepareQuote(db,ctx,p.input,{lock:true});
    await require('./agent-customer-pricing').checkOrder(db,ctx,p.input,current);
    if(pricing.quoteHash(current)!==p.reviewedHash)throw new ValidationError('The quoted prices or customer terms changed. Review a new quote.');
    const result=await quotes.create(scoped(db),ctx,{...p.input,validUntil:p.validUntil,requestKey:p.idempotencyKey});
    return {quoteId:result.id,quoteNumber:result.quote_number};
  },verify:async(db,ctx,r,p)=>{
    const current=await quotes.get(db,ctx.workspaceId,r.quoteId);
    return current.status==='OPEN'&&current.pricing_hash===p.reviewedHash&&current.customer_id===p.input.customerId;
  }
},{
  name:'sales_quote.accept',description:'Turn the exact customer-accepted, unexpired quotation into one draft sales order. Individual approval confirms the customer acceptance.',
  record:'sales_quotation',fields:['recordReference'],permission:permissions.MANAGE_SALES,capability:'sales_orders.core',
  build:async(db,ctx,row)=>{
    await policy.requireWorkspaceJob(db,ctx.workspaceId,75,'draft');
    const quote=await quotes.get(db,ctx.workspaceId,row.id);
    const buyers=require('./agent-quote-buyers'),link=await buyers.linked(db,ctx.workspaceId,quote.id);
    if(link)return buyers.build(db,ctx,quote,link);
    if(quote.status!=='OPEN')throw new ValidationError('Choose an open quotation the customer has accepted.');
    const today=await require('../lib/business-time').today(db,ctx.workspaceId);
    if(quote.valid_until<today)throw new ValidationError('This quote expired. Prepare a current revision.');
    return {payload:{recordId:quote.id,reviewedHash:quote.pricing_hash},summary:'Confirm the customer accepted '+quote.quote_number+' and create its draft order at the agreed quote prices.'};
  },execute:async(db,ctx,p)=>{
    await policy.requireWorkspaceJob(db,ctx.workspaceId,75,'draft');
    if(p.buyerAcceptanceId)return require('./agent-quote-buyers').approve(db,ctx,p);
    return quotes.decide(scoped(db),ctx,p.recordId,{accept:true,agent:true,expectedHash:p.reviewedHash,today:await require('../lib/business-time').today(db,ctx.workspaceId)});
  },verify:async(db,ctx,r,p)=>{
    const quote=await quotes.get(db,ctx.workspaceId,p.recordId);
    return quote.status==='ACCEPTED'&&quote.sales_order_id===r.salesOrderId;
  }
}];
module.exports={specs};

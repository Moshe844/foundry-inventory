'use strict';
const {ValidationError}=require('../domain/errors');
const pricing=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const {format}=require('../domain/currency');

async function authorize(db,ctx){
  const state=await policy.accountState(db,ctx.workspaceId);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,53,'draft');
}

async function prepare(db,ctx,customer,args){
  await authorize(db,ctx);
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const period=args.repeatPeriod||'latest';
  if(!['latest','previous-month'].includes(period))throw new ValidationError('Choose the last order or the previous calendar month.');
  const {rows}=await db.query(`SELECT o.*,s.quote FROM sales_orders o LEFT JOIN stockchief_runtime.pricing_order_snapshots s
    ON s.workspace_id=o.workspace_id AND s.id=o.pricing_quote_id
    WHERE o.workspace_id=$1 AND o.customer_id=$2 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED')
      AND ($3::text='' OR lower(o.order_number)=lower($3))
      AND o.order_date<=$4::text AND ($5::text='latest' OR
        (o.order_date>=to_char(date_trunc('month',$4::date)-interval '1 month','YYYY-MM-DD')
         AND o.order_date<to_char(date_trunc('month',$4::date),'YYYY-MM-DD')))
    ORDER BY o.order_date DESC,o.created_at DESC,o.id DESC LIMIT 2`,[ctx.workspaceId,customer.id,args.sourceOrderNumber||'',today,period]);
  if(!rows.length)throw new ValidationError('No confirmed customer order matches that request.');
  if(period==='previous-month'&&rows.length>1)throw new ValidationError('More than one customer order matches last month. Specify the order number, such as '+rows.map(r=>r.order_number).join(' or ')+'.');
  const order=rows[0];
  if(order.tax_minor>0&&!order.quote?.taxRate?.id||Number(order.charges_minor)>0||order.quote?.recordedAmounts)
    throw new ValidationError('Review the tax and charges on the original order before repeating it.');
  if(order.delivery_method==='SHIP'&&!customer.shipping_address)throw new ValidationError('Set a current delivery address for this customer first.');
  const {rows:items}=await db.query(`SELECT l.sku_id,s.code,l.quantity_ordered,l.secondary_quantity_ordered FROM sales_order_lines l
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,l.id`,[ctx.workspaceId,order.id]);
  if(!items.length)throw new ValidationError('This order has no product lines to repeat.');
  const input={customerId:customer.id,orderDate:today,deliveryMethod:order.delivery_method,currency:order.currency,
    fulfillmentLocationId:order.fulfillment_location_id,taxRateId:order.quote?.taxRate?.id||null,priceListId:order.quote?.priceListId||null,
    lines:items.map(i=>({skuId:i.sku_id,quantity:Number(i.quantity_ordered),...(i.secondary_quantity_ordered!=null?{secondaryQuantity:Number(i.secondary_quantity_ordered)}:{})}))};
  const quote=await pricing.prepareQuote(db,ctx,input);
  if(quote.violations.length)throw new ValidationError('The current prices require review before repeating this order.');
  const address=input.deliveryMethod==='SHIP'?customer.shipping_address:null;
  const training=require('../autopilot/draft-authority').scope(customer.id,input.currency,quote.totalMinor,
    [input.deliveryMethod,...new Set(items.map(i=>i.sku_id).sort())],customer.name+' · '+items.map(i=>i.code).join(', ')+' · '+input.deliveryMethod.toLowerCase());
  return {payload:{recordId:customer.id,sourceOrderNumber:order.order_number,sourceOrderId:order.id,training,
      address,input:{...input,pricingQuoteHash:pricing.quoteHash(quote)}},
    summary:'Create a draft for '+customer.name+' from '+order.order_number+' at current prices. '+
      items.map(i=>i.quantity_ordered+' × '+i.code).join(', ')+'. Total '+format(quote.totalMinor,quote.currency)+'. '+
      (address?'Deliver to '+address+'.':'Customer pickup.')};
}

async function execute(client,ctx,p){
  const {rows:[customer]}=await client.query("SELECT * FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE' FOR SHARE",[ctx.workspaceId,p.recordId]);
  if(!customer)throw new ValidationError('This customer is no longer active.');
  const current=await prepare(client,ctx,customer,{sourceOrderNumber:p.sourceOrderNumber});
  const comparable={...current.payload};
  if(!p.training)delete comparable.training;
  if(pricing.hash(comparable)!==pricing.hash({recordId:p.recordId,sourceOrderNumber:p.sourceOrderNumber,sourceOrderId:p.sourceOrderId,address:p.address,input:p.input,...(p.training?{training:p.training}:{})}))
    throw new ValidationError('The source order, date, destination or prices changed. Review the repeat order again.');
  return require('../operations/postgres-business-workflows').createSalesOrderInTransaction(client,ctx,{...p.input,
    reference:p.sourceOrderNumber,idempotencyKey:p.idempotencyKey});
}
async function verify(db,ctx,result,p){
  const {rows}=await db.query(`SELECT l.sku_id,l.quantity_ordered FROM sales_orders o JOIN sales_order_lines l
    ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND o.customer_id=$3
    AND o.status='DRAFT' AND o.reference=$4 ORDER BY l.sku_id,l.quantity_ordered`,[ctx.workspaceId,result.salesOrderId,p.recordId,p.sourceOrderNumber]);
  const keys=lines=>lines.map(([sku,qty])=>JSON.stringify([sku,Number(qty)])).sort();
  return JSON.stringify(keys(rows.map(r=>[r.sku_id,r.quantity_ordered])))===JSON.stringify(keys(p.input.lines.map(l=>[l.skuId,l.quantity])));
}
module.exports={prepare,execute,verify};

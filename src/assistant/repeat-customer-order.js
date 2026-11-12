'use strict';
const {ValidationError}=require('../domain/errors');
const pricing=require('../pricing/postgres-promotions');
const policy=require('../commercial/agent-plan');
const {format}=require('../domain/currency');
const CONFIRMED=['CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED'];

async function authorize(db,ctx){
  const state=await policy.accountState(db,ctx.workspaceId);
  policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,53,'draft');
}

// "Usual" (job 53): the lines the customer ordered in at least half of their
// last orders (three to six of them), at the quantity they ordered most often.
// With fewer orders or no repeating line, the usual order is the last order.
async function usual(db,ctx,customer,today){
  const history=await require('../commercial/agent-history').access(db,ctx.workspaceId,{allowMissing:true});
  const {rows:recent}=await db.query(`SELECT o.*,s.quote FROM sales_orders o LEFT JOIN stockchief_runtime.pricing_order_snapshots s
    ON s.workspace_id=o.workspace_id AND s.id=o.pricing_quote_id
    WHERE o.workspace_id=$1 AND o.customer_id=$2 AND o.status=ANY($5::text[]) AND o.order_date<=$3::text AND ($4::text IS NULL OR o.order_date>=$4::text)
    ORDER BY o.order_date DESC,o.created_at DESC,o.id DESC LIMIT 6`,[ctx.workspaceId,customer.id,today,history?.salesFrom||null,CONFIRMED]);
  if(!recent.length)throw new ValidationError('No confirmed customer order matches that request.');
  const {rows:lines}=await db.query(`SELECT l.sales_order_id,l.sku_id,s.code,i.name,l.quantity_ordered,l.secondary_quantity_ordered FROM sales_order_lines l
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.sales_order_id=ANY($2::text[]) ORDER BY l.created_at,l.id`,[ctx.workspaceId,recent.map(o=>o.id)]);
  const latest=recent[0];
  if(recent.length>=3){
    const need=Math.ceil(recent.length/2),seen=new Map();
    for(const [rank,order] of recent.entries())for(const line of lines.filter(l=>l.sales_order_id===order.id)){
      const entry=seen.get(line.sku_id)||{line,orders:new Set(),amounts:[]};
      if(!entry.orders.has(order.id))entry.amounts.push({rank,key:JSON.stringify([String(Number(line.quantity_ordered)),line.secondary_quantity_ordered==null?null:String(Number(line.secondary_quantity_ordered))])});
      entry.orders.add(order.id);seen.set(line.sku_id,entry);
    }
    const recurring=[...seen.values()].filter(e=>e.orders.size>=need);
    if(recurring.length){
      const items=recurring.map(e=>{
        const counts=new Map();for(const a of e.amounts)counts.set(a.key,(counts.get(a.key)||0)+1);
        const best=[...counts.entries()].sort((a,b)=>b[1]-a[1]||e.amounts.find(x=>x.key===a[0]).rank-e.amounts.find(x=>x.key===b[0]).rank)[0][0];
        const [quantity,secondary]=JSON.parse(best);
        return {sku_id:e.line.sku_id,code:e.line.code,name:e.line.name,quantity_ordered:quantity,secondary_quantity_ordered:secondary};
      });
      return {order:latest,items,orderIds:recent.map(o=>o.id),
        reading:'usual order (the products in at least '+need+' of their last '+recent.length+' orders, at the quantity they order most often)'};
    }
  }
  return {order:latest,items:lines.filter(l=>l.sales_order_id===latest.id),
    reading:'usual order, read as their last order '+latest.order_number+(recent.length<3?' (too few orders to show a pattern)':' (no product is in most of their orders)')};
}

async function prepare(db,ctx,customer,args){
  await authorize(db,ctx);
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const period=args.repeatPeriod||'latest';
  if(!['latest','previous-month','usual'].includes(period))throw new ValidationError('Choose the last order, the usual order or the previous calendar month.');
  let order,items,reading,orderIds;
  if(period==='usual'){
    ({order,items,reading,orderIds}=await usual(db,ctx,customer,today));
  }else{
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
    order=rows[0];
    items=(await db.query(`SELECT l.sku_id,s.code,i.name,l.quantity_ordered,l.secondary_quantity_ordered FROM sales_order_lines l
      JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
      WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.created_at,l.id`,[ctx.workspaceId,order.id])).rows;
    reading=period==='previous-month'?'order from last month, '+order.order_number:args.sourceOrderNumber?'order '+order.order_number:'last order, '+order.order_number;
  }
  if(order.tax_minor>0&&!order.quote?.taxRate?.id||Number(order.charges_minor)>0||order.quote?.recordedAmounts)
    throw new ValidationError('Review the tax and charges on the original order before repeating it.');
  if(order.delivery_method==='SHIP'&&!customer.shipping_address)throw new ValidationError('Set a current delivery address for this customer first.');
  if(!items.length)throw new ValidationError('This order has no product lines to repeat.');
  if(new Set(items.map(i=>i.sku_id)).size!==items.length)throw new ValidationError('The order lists a product more than once. Review it and enter the repeat yourself.');
  const input={customerId:customer.id,orderDate:today,deliveryMethod:order.delivery_method,currency:order.currency,
    fulfillmentLocationId:order.fulfillment_location_id,taxRateId:order.quote?.taxRate?.id||null,priceListId:order.quote?.priceListId||null,
    lines:items.map(i=>({skuId:i.sku_id,quantity:Number(i.quantity_ordered),...(i.secondary_quantity_ordered!=null?{secondaryQuantity:Number(i.secondary_quantity_ordered)}:{})}))};
  const quote=await pricing.prepareQuote(db,ctx,input);
  await require('../sales/agent-customer-pricing').checkOrder(db,ctx,input,quote);
  if(quote.violations.length)throw new ValidationError('The current prices require review before repeating this order.');
  const address=input.deliveryMethod==='SHIP'?customer.shipping_address:null;
  const training=require('../autopilot/draft-authority').scope(customer.id,input.currency,quote.totalMinor,
    [input.deliveryMethod,...new Set(items.map(i=>i.sku_id).sort())],customer.name+' · '+items.map(i=>i.code).join(', ')+' · '+input.deliveryMethod.toLowerCase());
  return {payload:{recordId:customer.id,sourceOrderNumber:order.order_number,sourceOrderId:order.id,training,
      address,input:{...input,pricingQuoteHash:pricing.quoteHash(quote)},repeatPeriod:period,reading,...(orderIds?{usualOrderIds:orderIds}:{})},
    summary:'Repeat '+customer.name+'’s '+reading+' at current prices. '+
      items.map(i=>Number(i.quantity_ordered)+' × '+i.code).join(', ')+'. Total '+format(quote.totalMinor,quote.currency)+'. '+
      (address?'Deliver to '+address+'.':'Customer pickup.'),quote,items};
}

// The stored proposal must still be exactly what a fresh reading gives. The
// reading's wording is a description; the source orders, lines and prices decide.
const compared=['recordId','sourceOrderNumber','sourceOrderId','address','input','training','repeatPeriod','usualOrderIds'];
async function execute(client,ctx,p){
  const {rows:[customer]}=await client.query("SELECT * FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE' FOR SHARE",[ctx.workspaceId,p.recordId]);
  if(!customer)throw new ValidationError('This customer is no longer active.');
  const current=await prepare(client,ctx,customer,p.repeatPeriod==='usual'?{repeatPeriod:'usual'}:
    {repeatPeriod:p.repeatPeriod||'latest',sourceOrderNumber:p.sourceOrderNumber});
  const shape=x=>Object.fromEntries(compared.filter(k=>p[k]!==undefined).map(k=>[k,x[k]]));
  if(pricing.hash(shape(current.payload))!==pricing.hash(shape(p)))
    throw new ValidationError('The source order, date, destination or prices changed. Review the repeat order again.');
  return require('../operations/postgres-business-workflows').createSalesOrderInTransaction(client,ctx,{...p.input,
    reference:p.sourceOrderNumber,...(p.reading?{notes:'Repeat of the customer’s '+p.reading+'.'}:{}),idempotencyKey:p.idempotencyKey});
}
async function verify(db,ctx,result,p){
  const {rows}=await db.query(`SELECT l.sku_id,l.quantity_ordered FROM sales_orders o JOIN sales_order_lines l
    ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2 AND o.customer_id=$3
    AND o.status='DRAFT' AND o.reference=$4 ORDER BY l.sku_id,l.quantity_ordered`,[ctx.workspaceId,result.salesOrderId,p.recordId,p.sourceOrderNumber]);
  const keys=lines=>lines.map(([sku,qty])=>JSON.stringify([sku,Number(qty)])).sort();
  return JSON.stringify(keys(rows.map(r=>[r.sku_id,r.quantity_ordered])))===JSON.stringify(keys(p.input.lines.map(l=>[l.skuId,l.quantity])));
}
module.exports={prepare,execute,verify};

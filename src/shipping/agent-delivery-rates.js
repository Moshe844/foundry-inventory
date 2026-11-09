'use strict';
const money=require('../domain/currency');
const {allowed}=require('./service-eligibility');
const shipping=require('./postgres-service');

async function review(db,ctx,{filter,page,today}){
  const selected=await db.query(`SELECT h.id,h.shipment_number,o.needed_by,o.order_number FROM sales_shipments h
    JOIN sales_orders o ON o.id=h.sales_order_id AND o.workspace_id=h.workspace_id WHERE h.workspace_id=$1
    AND h.status IN ('PICKING','PACKED') AND h.customer_return_id IS NULL AND coalesce(h.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')
    AND ($2='' OR lower(h.shipment_number)=lower($2) OR lower(o.order_number)=lower($2))
    ORDER BY o.needed_by NULLS LAST,h.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25]);
  const shipments=selected.rows.slice(0,25);
  const {rows:quotes}=await db.query(`SELECT * FROM shipment_rates WHERE workspace_id=$1 AND shipment_id=ANY($2::text[])
    AND quoted_at::timestamptz>now()-interval '30 minutes' AND delivery_date IS NOT NULL AND delivery_date>=$3
    ORDER BY currency,amount_minor,delivery_date,delivery_guaranteed DESC,id`,[ctx.workspaceId,shipments.map(s=>s.id),today]);
  const rows=[];
  for(const h of shipments){
    const base={Shipment:h.shipment_number,Order:h.order_number,'Promised date':h.needed_by,link:'/fulfilment/'+h.id};
    const options=quotes.filter(q=>q.shipment_id===h.id&&h.needed_by&&q.delivery_date<=h.needed_by);
    const cheapest=new Map();
    if(options.length){
      const current=await shipping.state(db,ctx.workspaceId,h.id),fingerprint=shipping.quoteFingerprint(current);
      for(const q of options){
        if(!cheapest.has(q.currency)&&q.parcel_fingerprint===fingerprint&&allowed(q,current.shipment.shipping_options||{}))cheapest.set(q.currency,q);
      }
    }
    if(!cheapest.size)rows.push({...base,Service:null,Price:null,'Carrier arrival':null,Status:h.needed_by?'No eligible dated quote meets the promise':'Set the promised delivery date'});
    for(const q of cheapest.values())rows.push({...base,Service:q.carrier+' '+q.service,Price:money.format(q.amount_minor,q.currency),
      'Carrier arrival':q.delivery_date,Status:Number(q.delivery_guaranteed)?'Carrier guarantee':'Carrier estimate'});
  }
  return {rows,more:selected.rows.length>25,summary:'Lowest current quote reaching the promised delivery date, by currency. Quotes must match the current parcel and carrier account. Estimates and guarantees are shown separately. A label purchase requires its own spending authority.'};
}
module.exports={review};

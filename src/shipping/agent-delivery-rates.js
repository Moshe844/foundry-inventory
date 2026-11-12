'use strict';
const money=require('../domain/currency');
const shipping=require('./postgres-service');

// Job 58's review: for each open parcel, the cheapest current quote in each
// currency that arrives by the promised date, and what StockChief did with it.
async function review(db,ctx,{filter,page}){
  const labels=require('./agent-labels');
  const selected=await db.query(`SELECT h.id,h.shipment_number,o.needed_by,o.order_number FROM sales_shipments h
    JOIN sales_orders o ON o.id=h.sales_order_id AND o.workspace_id=h.workspace_id WHERE h.workspace_id=$1
    AND h.status IN ('PICKING','PACKED') AND h.customer_return_id IS NULL AND coalesce(h.label_status,'') NOT IN ('PURCHASED','PENDING','REVIEW','VOID_PENDING')
    AND ($2='' OR lower(h.shipment_number)=lower($2) OR lower(o.order_number)=lower($2))
    ORDER BY o.needed_by NULLS LAST,h.id LIMIT 26 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*25]);
  const shipments=selected.rows.slice(0,25),installed=await require('../db/schema-installed').has(db,'stockchief_runtime.agent_label_runs');
  const rows=[];
  for(const h of shipments){
    const base={Shipment:h.shipment_number,Order:h.order_number,'Promised date':h.needed_by,link:'/fulfilment/'+h.id};
    const current=await shipping.state(db,ctx.workspaceId,h.id),fingerprint=shipping.quoteFingerprint(current);
    await labels.arrivals(db,ctx.workspaceId,current.rates);
    const choice=installed?(await db.query(`SELECT status,mode FROM stockchief_runtime.agent_label_runs WHERE workspace_id=$1 AND shipment_id=$2 AND fingerprint=$3`,
      [ctx.workspaceId,h.id,fingerprint])).rows[0]:null;
    // Never compare across currencies: one answer per currency.
    const cheapest=new Map();
    for(const currency of [...new Set(current.rates.map(r=>r.currency))].sort()){
      const {pick}=labels.choose({...current,shipment:{...current.shipment,currency}},h.needed_by);
      if(pick)cheapest.set(currency,pick);
    }
    if(!cheapest.size)rows.push({...base,Service:null,Price:null,'Carrier arrival':null,Status:h.needed_by?'No eligible dated quote meets the promise':'Set the promised delivery date'});
    for(const q of cheapest.values())rows.push({...base,Service:q.carrier+' '+q.service,
      Price:money.format(q.amount_minor,q.currency),'Carrier arrival':q.arrival,
      Status:(choice?.status==='QUEUED'?'Label approved · ':choice?.status==='CHOSEN'?'Chosen · ':choice?.status==='SUGGESTED'?'Suggested · ':'')+(Number(q.delivery_guaranteed)?'Carrier guarantee':q.delivery_date?'Carrier estimate':'Carrier transit days')});
  }
  return {rows,more:selected.rows.length>25,summary:'Lowest current quote reaching the promised delivery date, by currency. Arrival is the carrier’s date, or its transit days counted from its ship date. Quotes must match the current parcel and carrier account. PO boxes only get postal services. Buying the label has its own spending limits.'};
}
module.exports={review};

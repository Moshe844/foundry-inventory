'use strict';
const time=require('../lib/business-time');

// One complete, physically received order is one delivery. A split receipt
// is complete on its last receipt date in this inventory's time zone.
const deliveries=`SELECT p.id,p.po_number,p.supplier_id,p.expected_date::date AS expected,
  (p.ordered_at::timestamptz AT TIME ZONE $3)::date AS placed,
  (max(r.received_at::timestamptz) AT TIME ZONE $3)::date AS received
  FROM purchase_orders p JOIN purchase_order_receipts r ON r.workspace_id=p.workspace_id AND r.purchase_order_id=p.id
  WHERE p.workspace_id=$1 AND p.status='RECEIVED' AND p.ordered_at IS NOT NULL
    AND coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE')='WAREHOUSE' GROUP BY p.id`;

async function habits(db,ctx,{filter,page,today}){
  const {salesFrom}=await require('../commercial/agent-history').access(db,ctx.workspaceId);
  const {timeZone}=await time.forWorkspace(db,ctx.workspaceId);
  const {rows}=await db.query(`WITH placed AS (
    SELECT DISTINCT o.customer_id,o.order_date::date AS day FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.status IN('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED') AND o.order_date<=$4
    AND ($5::text IS NULL OR o.order_date>=$5) AND ($2='' OR c.id=$2 OR lower(c.name)=lower($2))
  ), gaps AS (SELECT *,day-lag(day) OVER(PARTITION BY customer_id ORDER BY day) AS gap FROM placed),
  sales AS (SELECT customer_id,count(*) AS samples,max(day) AS latest,percentile_disc(0.5) WITHIN GROUP(ORDER BY gap) AS typical
    FROM gaps GROUP BY customer_id HAVING count(*)>=3), deliveries AS (${deliveries}),
  receipts AS (SELECT supplier_id,count(*) AS samples,max(received) AS latest,
    percentile_disc(0.5) WITHIN GROUP(ORDER BY received-placed) AS typical FROM deliveries
    WHERE placed<=received AND received<=$4::date GROUP BY supplier_id HAVING count(*)>=3),
  partners AS (
    SELECT 'Customer' AS kind,c.id,c.name,s.samples,s.latest,s.typical,(s.latest+s.typical)::text AS expected FROM sales s
    JOIN customers c ON c.workspace_id=$1 AND c.id=s.customer_id AND c.record_state='ACTIVE'
    UNION ALL SELECT 'Supplier',s.id,s.name,r.samples,r.latest,r.typical,NULL FROM receipts r
    JOIN suppliers s ON s.workspace_id=$1 AND s.id=r.supplier_id AND s.status='active' WHERE ($2='' OR s.id=$2 OR lower(s.name)=lower($2))
  ) SELECT kind,name,id,samples,latest::text,typical,expected FROM partners ORDER BY kind,name,id LIMIT 101 OFFSET $6`,
    [ctx.workspaceId,filter,timeZone,today,salesFrom,(page-1)*100]);
  return {summary:'After three distinct ordering days or three completed warehouse deliveries, StockChief shows the middle observed interval. Customer dates are estimates. Supplier lead time runs from placement to final warehouse receipt.',
    more:rows.length>100,rows:rows.slice(0,100).map(r=>({Partner:r.name,Type:r.kind,'Observed days or deliveries':Number(r.samples),
      'Last recorded':r.latest,Pattern:r.kind==='Customer'?'Orders about every '+r.typical+' days':'Delivers in about '+r.typical+' days',
      'Estimated next order':r.expected,link:(r.kind==='Customer'?'/sales/customers/':'/suppliers/')+r.id}))};
}
// Job 94: the negotiation email and its facts come from negotiation-evidence.
async function negotiation(db,ctx,filter){
  const ev=require('../purchasing/negotiation-evidence'),found=await ev.collect(db,ctx,filter);
  if(!found.facts.length)return {supplier:found.supplier,summary:'Nothing recorded in the last 12 months to negotiate with: no late or short deliveries, price increases, cheaper quotes or orders.',rows:[]};
  const words=ev.negotiationEmail(found),evidence=ev.key(found,words),count=kind=>found.facts.find(f=>f.kind===kind)?.count||0;
  return {supplier:found.supplier,...words,evidence,sourceKey:evidence,summary:'Check each fact and its evidence before contacting the supplier.',
    rows:[{Supplier:found.supplier.name,'Completed dated orders':found.completed,'Late deliveries':count('late'),'Short order lines':count('short'),'Price increases':count('price'),
      'Cheaper quotes':count('quote'),'Orders placed':count('volume'),Subject:words.subject,Draft:words.body,link:'/autopilot/supplier-negotiations?supplier='+encodeURIComponent(found.supplier.id)}]};
}
const definitions=[
  {id:211,key:'partner-habits',label:'Learn customer order patterns and supplier lead times',filterLabel:'Customer or supplier',readPage:habits},
  {id:94,key:'supplier-negotiation',label:'Draft a supplier negotiation email',filterLabel:'Exact supplier name or ID',requiresFilter:true,
    readPage:async(db,ctx,{filter})=>{
      const result=await negotiation(db,ctx,filter);
      return {...result,negotiationForm:{supplier:result.supplier.id,evidence:result.evidence,
        revision:(await require('../purchasing/negotiation-drafts').setting(db,ctx.workspaceId,result.supplier.id))?.revision||''}};
    }}
];
module.exports={negotiation,definitions};

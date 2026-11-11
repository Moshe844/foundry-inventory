
'use strict';

const {ValidationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const {addDays}=require('../accounting/customer-money');
const drafts='stockchief_runtime.agent_customer_checkin_drafts';
const inactivityDays=90;
const messageKind='customer_check_in';
const batchSize=30;

function compose(row){
  return {recipient:row.email,subject:'Checking in from '+row.business,
    body:'Hello '+row.customer_name+',\n\nIt has been a while since your last order with us. Is there anything we can help you restock or plan for your next order?\n\nBest,\n'+row.business};
}

async function list(db,workspaceId,{today,filter='',customerId=null,after='',offset=0,limit=batchSize,undrafted=false}){
  const cutoff=addDays(today,-inactivityDays);
  return (await db.query(`WITH contacts AS MATERIALIZED (
    SELECT c.id,c.name,c.email,w.name business,coalesce(w.time_zone,a.time_zone,'UTC') zone
    FROM customers c JOIN workspaces w ON w.id=c.workspace_id JOIN accounts a ON a.id=w.owner_account_id
    WHERE c.workspace_id=$1 AND c.record_state='ACTIVE' AND c.id>$5
      AND ($3='' OR lower(c.name)=lower($3) OR lower(c.email)=lower($3) OR c.id=$3)
      AND ($4::text IS NULL OR c.id=$4)
      AND (NOT $6::boolean OR (length(c.email)<=254 AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
  ), orders AS (
    SELECT o.id,o.customer_id,o.order_number,h.id shipment_id,h.shipment_number,h.shipped_at,
      (h.shipped_at::timestamptz AT TIME ZONE c.zone)::date handed_on,
      EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
        AND l.unit_price_minor>0 AND l.quantity_fulfilled>
          (SELECT coalesce(sum(r.quantity_received),0) FROM customer_return_lines r
           WHERE r.workspace_id=l.workspace_id AND r.sales_order_line_id=l.id AND r.quantity_received>0))
        AND (o.pricing_total_minor IS NULL OR o.pricing_total_minor>0) AS retained
    FROM contacts c JOIN sales_orders o ON o.workspace_id=$1 AND o.customer_id=c.id
    JOIN sales_shipments h ON h.workspace_id=$1 AND h.sales_order_id=o.id
    WHERE h.status IN('SHIPPED','DELIVERED') AND h.shipped_at IS NOT NULL AND h.customer_return_id IS NULL
  ), qualified AS (
    SELECT customer_id,count(DISTINCT id) FILTER(WHERE retained)::integer prior_orders
    FROM orders GROUP BY customer_id HAVING count(DISTINCT id) FILTER(WHERE retained)>=2 AND max(handed_on)<$2::date
  ), latest_by_order AS (
    SELECT DISTINCT ON(customer_id,id) * FROM orders WHERE retained ORDER BY customer_id,id,shipped_at::timestamptz DESC,shipment_id DESC
  ), evidence AS (
    SELECT r.*,row_number() OVER(PARTITION BY r.customer_id ORDER BY r.shipped_at::timestamptz DESC,r.shipment_id DESC) rank
    FROM latest_by_order r JOIN qualified q ON q.customer_id=r.customer_id
  )
  SELECT c.id customer_id,c.name customer_name,c.email,c.business,q.prior_orders,
    e.shipment_id episode,e.handed_on::text last_purchase,
    jsonb_agg(jsonb_build_object('orderId',p.id,'orderNumber',p.order_number,'shipmentId',p.shipment_id,
      'shipmentNumber',p.shipment_number,'handedOn',p.handed_on::text,'handoff',p.shipped_at) ORDER BY p.rank) purchases,
    d.id draft_id
  FROM contacts c JOIN qualified q ON q.customer_id=c.id JOIN evidence e ON e.customer_id=c.id AND e.rank=1
  JOIN evidence p ON p.customer_id=c.id AND p.rank<=2
  LEFT JOIN ${drafts} d ON d.workspace_id=$1 AND d.customer_id=c.id AND d.episode=e.shipment_id
  WHERE (NOT $6::boolean OR d.id IS NULL) AND NOT EXISTS(
    SELECT 1 FROM sales_orders o WHERE o.workspace_id=$1 AND o.customer_id=c.id AND o.status IN('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
  ) AND NOT EXISTS(
    SELECT 1 FROM stockchief_runtime.quote_buyer_acceptances a JOIN sales_quotations q ON q.workspace_id=a.workspace_id AND q.id=a.quote_id
    WHERE a.workspace_id=$1 AND q.customer_id=c.id AND (
      (a.state IN('RECEIVED','HELD') AND q.status='OPEN' AND q.valid_until>=$9::date)
      OR (a.state='DRAFTED' AND EXISTS(SELECT 1 FROM sales_orders pending WHERE pending.workspace_id=$1 AND pending.id=a.order_id AND pending.status='DRAFT'))
    )
  )
  GROUP BY c.id,c.name,c.email,c.business,q.prior_orders,e.shipment_id,e.handed_on,d.id
  ORDER BY c.id LIMIT $7 OFFSET $8`,[workspaceId,cutoff,filter,customerId,after,undrafted,limit,offset,today])).rows;
}

async function current(db,ctx,customerId,{today}={}){
  const date=today||await require('../lib/business-time').today(db,ctx.workspaceId);
  const [row]=await list(db,ctx.workspaceId,{today:date,customerId,limit:1});
  if(!row)throw new ValidationError('This customer no longer has two retained purchases and an inactive order history.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email||'')||row.email.length>254){
    throw new ValidationError('Confirm the existing customer’s email address before saving a check-in draft.');
  }
  const evidence={customerId:row.customer_id,customer:row.customer_name,business:row.business,email:row.email,
    priorOrders:row.prior_orders,episode:row.episode,lastPurchase:row.last_purchase,purchases:row.purchases,inactivityDays};
  return {recordId:row.customer_id,episode:row.episode,evidence,evidenceHash:hash(evidence),message:compose(row),draftId:row.draft_id};
}

module.exports={current,list,compose,messageKind,batchSize,inactivityDays};

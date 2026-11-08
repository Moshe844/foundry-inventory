'use strict';
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {parse}=require('../shipping/address');
const money=require('../domain/currency');

// Use the same open receivables as the Money page. Fulfillment posts its
// journals per order line and legitimately has no journal ID on the header.
const unpaid=`SELECT i.* FROM accounting_customer_invoices i
  WHERE i.workspace_id=$1 AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>0`;
async function rule(db,workspaceId){
  const result=await db.query(`SELECT r.workspace_id FROM stockchief_runtime.agent_overdue_order_rules r JOIN users u
    ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner' WHERE r.workspace_id=$1`,[workspaceId]);
  return result.rowCount===1;
}
async function configure(db,ctx,choice){
  if(!['on','off'].includes(choice))throw new ValidationError('Choose whether to hold orders for overdue invoices.');
  return db.transaction(async client=>{
    const state=await require('../autopilot/job-reviews').ownerState(client,ctx);
    if(choice==='on'){
      policy.requireJob(policy.usesAgentTerms(state)?state.plan:null,55,'automatic');
      await client.query(`INSERT INTO stockchief_runtime.agent_overdue_order_rules(workspace_id,authorized_by) VALUES($1,$2)
        ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,updated_at=now()`,[ctx.workspaceId,ctx.actorId]);
    }else await client.query('DELETE FROM stockchief_runtime.agent_overdue_order_rules WHERE workspace_id=$1',[ctx.workspaceId]);
    await require('../operations/postgres-security-audit').record(client,ctx,{action:'Overdue customer order rule changed',after:{enabled:choice==='on'}});
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function assertCanRelease(db,workspaceId,orderId){
  if(!await rule(db,workspaceId))return;
  const state=await require('../autopilot/postgres-service').getState(db,workspaceId);
  if(!state.agentTerms||!state.canAutomate||!policy.permits(state.plan,55,'automatic'))return;
  const today=await require('../lib/business-time').today(db,workspaceId);
  const due=await db.query(`SELECT 1 FROM (${unpaid}) bill JOIN sales_orders o ON o.workspace_id=bill.workspace_id AND o.customer_id=bill.customer_id
    WHERE o.id=$2 AND bill.due_date<$3 LIMIT 1`,[workspaceId,orderId,today]);
  if(due.rowCount)throw new ValidationError('This order is on hold because the customer has an overdue invoice. Review the customer balance before releasing the order.');
}
async function check(db,ctx,{filter,page,today},overdueOnly=false){
  const {rows}=await db.query(`WITH bills AS (${unpaid}),
    orders AS (SELECT o.*,c.name FROM sales_orders o JOIN customers c ON c.id=o.customer_id AND c.workspace_id=o.workspace_id
      WHERE o.workspace_id=$1 AND o.status IN ('DRAFT','CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2))
        AND (NOT $4 OR EXISTS(SELECT 1 FROM bills b WHERE b.customer_id=o.customer_id AND b.due_date<$3))
      ORDER BY o.needed_by NULLS LAST,o.order_date,o.id LIMIT 51 OFFSET $5)
    SELECT o.id,o.order_number,o.name,o.delivery_method,o.ship_to_address,o.status,o.currency,
      a.late,a.oldest,a.same_currency_debt,a.other_currency,t.credit_limit_minor,books.base_currency,
      p.no_price,p.unreserved FROM orders o
    LEFT JOIN accounting_settings books ON books.workspace_id=o.workspace_id AND books.enabled=1
    LEFT JOIN LATERAL (SELECT credit_limit_minor FROM customer_payment_terms t WHERE t.workspace_id=o.workspace_id
      AND (t.customer_id=o.customer_id OR t.customer_id IS NULL) ORDER BY (t.customer_id IS NOT NULL) DESC LIMIT 1)t ON true
    CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE due_date<$3) late,min(due_date) FILTER(WHERE due_date<$3) oldest,
      coalesce(sum(balance_minor) FILTER(WHERE currency=o.currency),0) same_currency_debt,bool_or(currency<>o.currency) other_currency
      FROM bills WHERE customer_id=o.customer_id)a
    CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE l.unit_price_minor IS NULL) no_price,
      sum(greatest(l.quantity_ordered-l.quantity_fulfilled-coalesce(reserved.units,0)-coalesce(kits.units,0),0)) unreserved FROM sales_order_lines l
      LEFT JOIN LATERAL (SELECT sum(quantity) units FROM sales_order_allocations sa WHERE sa.workspace_id=l.workspace_id AND sa.sales_order_line_id=l.id) reserved ON true
      LEFT JOIN LATERAL (SELECT min(floor(coalesce(held.units,0)/k.quantity_per_kit)) units FROM sales_order_kit_components k
        LEFT JOIN LATERAL(SELECT sum(quantity) units FROM sales_order_kit_allocations WHERE workspace_id=k.workspace_id AND kit_component_id=k.id) held ON true
        WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id) kits ON true
      WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id)p
    ORDER BY o.needed_by NULLS LAST,o.order_date,o.id`,[ctx.workspaceId,filter,today,overdueOnly,(page-1)*50]);
  return {rows:rows.slice(0,50).map(r=>{
    const shared={Order:r.order_number,Customer:r.name,'Overdue invoices':Number(r.late),'Oldest due date':r.oldest,link:'/orders/'+r.id};
    if(overdueOnly)return shared;
    return {...shared,'Unreserved units':Number(r.unreserved||0),'Missing line prices':Number(r.no_price),
      'Delivery address':r.delivery_method==='PICKUP'?'Pickup':parse(r.ship_to_address).complete?'Complete':'Needs review',
      'Credit limit check':r.credit_limit_minor==null?'No saved limit':r.base_currency!==r.currency||r.other_currency?'Currency conversion needed':
        Number(r.same_currency_debt)>Number(r.credit_limit_minor)?'Outstanding invoices exceed limit':'Within recorded limit',
      'Outstanding in order currency':money.format(r.same_currency_debt,r.currency)};
  }),more:rows.length>50,summary:overdueOnly?'Open orders from customers with an unpaid invoice past its due date. Settled invoices clear automatically.':
    'Checks current reservations, line prices, delivery address, overdue invoices and recorded credit limits. Draft orders have not yet reserved stock.'};
}
module.exports={rule,configure,assertCanRelease,definitions:[
  {id:54,key:'sales-order-checks',label:'Check open customer orders',readPage:check},
  {id:55,key:'overdue-customer-orders',label:'Review orders from overdue customers',readPage:(db,ctx,options)=>check(db,ctx,options,true)}
]};

'use strict';

const money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');

async function current(db,workspaceId,customerId){
  return (await db.query(`SELECT t.id,t.customer_id,t.kind,t.net_days,t.deposit_percent,t.deposit_minor,t.hold_shipping,
    t.credit_approved,t.updated_at,
    CASE WHEN t.deposit_minor IS NOT NULL THEN coalesce(to_jsonb(t)->>'deposit_currency',a.base_currency) END AS deposit_currency,
    EXISTS(SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.workspace_id=t.workspace_id AND u.id=t.agreed_by_user_id AND u.role='owner') AS owner_agreed
    FROM customer_payment_terms t LEFT JOIN accounting_settings a ON a.workspace_id=t.workspace_id
    WHERE t.workspace_id=$1 AND (t.customer_id=$2 OR t.customer_id IS NULL)
    ORDER BY (t.customer_id IS NULL),t.updated_at DESC,t.id DESC LIMIT 1`,[workspaceId,customerId])).rows[0]||null;
}

function agreement(row,currency){
  if(!row)return null;
  if(row.deposit_minor!=null&&row.deposit_currency!==currency)
    throw new ValidationError('The fixed deposit has a different or unconfirmed currency. Review the customer terms for this order.');
  return {id:row.id,customer_id:row.customer_id,kind:row.kind,net_days:row.net_days==null?null:Number(row.net_days),
    deposit_percent:row.deposit_percent==null?null:String(row.deposit_percent),
    deposit_minor:row.deposit_minor==null?null:money.integer(row.deposit_minor),deposit_currency:row.deposit_currency,
    hold_shipping:Boolean(Number(row.hold_shipping)),credit_approved:Boolean(Number(row.credit_approved)),
    owner_agreed:row.owner_agreed,agreed_at:row.updated_at};
}

async function forOrder(db,workspaceId,order){
  const accepted=await require('./postgres-payment-terms').forAcceptedOrder(db,workspaceId,order.id,order.customer_id);
  if(accepted)return {terms:{...accepted,deposit_currency:accepted.deposit_currency??order.currency},frozen:true};
  if(order.pricing_quote_id){
    const saved=(await db.query(`SELECT quote FROM stockchief_runtime.pricing_order_snapshots
      WHERE workspace_id=$1 AND id=$2 AND sales_order_id=$3`,[workspaceId,order.pricing_quote_id,order.id])).rows[0]?.quote;
    if(saved&&Object.hasOwn(saved,'customerTerms'))return {terms:saved.customerTerms,frozen:true};
  }
  return {terms:await current(db,workspaceId,order.customer_id),frozen:false};
}

function requiredDeposit(terms,total,currency){
  if(terms?.kind!=='DEPOSIT')return 0;
  if(terms.deposit_minor!=null){
    if(terms.deposit_currency!==currency)throw new ValidationError('Review the fixed deposit in the order currency before collecting money.');
    return Math.min(total,money.integer(terms.deposit_minor));
  }
  const pct=require('../domain/exact-quantity').canonical(String(terms.deposit_percent),{label:'Agreed deposit percentage'});
  const [whole,fraction='']=pct.split('.');
  const divisor=100n*10n**BigInt(fraction.length);
  return Number((BigInt(money.integer(total))*BigInt(whole+fraction)+divisor/2n)/divisor);
}

async function postedPaid(db,workspaceId,order){
  const {rows:[row]}=await db.query(`SELECT
    coalesce((SELECT sum(p.amount_minor) FROM accounting_payments p WHERE p.workspace_id=$1 AND p.sales_order_id=$2
      AND p.currency=$3 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'),0)
    +coalesce((SELECT sum(a.amount_minor) FROM accounting_payment_allocations a
      JOIN accounting_customer_invoices i ON i.workspace_id=a.workspace_id AND i.id=a.customer_invoice_id
      JOIN accounting_payments p ON p.workspace_id=a.workspace_id AND p.id=a.payment_id
      WHERE a.workspace_id=$1 AND i.sales_order_id=$2 AND p.sales_order_id IS DISTINCT FROM $2
        AND i.currency=$3 AND p.currency=$3 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED'
        AND i.status<>'VOID'),0)
    -coalesce((SELECT sum(r.amount_minor) FROM accounting_deposit_refunds r WHERE r.workspace_id=$1 AND r.sales_order_id=$2),0) AS paid`,
  [workspaceId,order.id,order.currency]);
  return Math.max(0,money.integer(row.paid,'Posted payment',{signed:true}));
}

async function position(db,workspaceId,order,total,terms){
  const deposit=requiredDeposit(terms,total,order.currency);
  const upfront=terms?.kind==='BEFORE_FULFILMENT'?total:deposit;
  const dueToShip=Number(terms?.hold_shipping)?total:upfront;
  const paid=dueToShip>0?await postedPaid(db,workspaceId,order):0;
  return {deposit,depositDue:Math.max(0,deposit-paid),pickDue:Math.max(0,upfront-paid),shipDue:Math.max(0,dueToShip-paid)};
}

async function assertRelease(db,workspaceId,order,{shipping=false}={}){
  const saved=await forOrder(db,workspaceId,order);
  if(!saved.frozen||!saved.terms)return;
  const total=money.integer(order.pricing_total_minor,'Recorded order total');
  const pay=await position(db,workspaceId,order,total,saved.terms),due=shipping?pay.shipDue:pay.pickDue;
  if(due)throw new ValidationError('The agreed payment of '+money.format(due,order.currency)+
    ' is still due before this order can be '+(shipping?'fulfilled.':'picked.'));
}

function dueFrom(terms,issueDate){
  return require('../accounting/customer-money').addDays(issueDate,terms?.kind&&terms.kind!=='ON_ACCOUNT'?0:terms?.net_days??30);
}

function describe(terms,currency){
  if(!terms)return 'Payment due when invoiced';
  if(terms.kind==='BEFORE_FULFILMENT')return 'Payment before fulfillment';
  if(terms.kind==='DEPOSIT'){
    const amount=terms.deposit_minor==null?terms.deposit_percent+'% deposit':money.format(terms.deposit_minor,terms.deposit_currency||currency)+' deposit';
    return amount+(Number(terms.hold_shipping)?', balance before shipping':' before fulfillment');
  }
  return 'Net '+(terms.net_days??30)+' days'+(Number(terms.hold_shipping)?', balance before shipping':'');
}

module.exports={current,agreement,forOrder,requiredDeposit,postedPaid,position,assertRelease,dueFrom,describe};

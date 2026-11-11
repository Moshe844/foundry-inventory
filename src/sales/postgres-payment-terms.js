'use strict';const terms=require('./payment-terms'),{newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors'),permissions=require('../actions/permissions');
async function saveInTransaction(client,ctx,input){permissions.assertCan((await client.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],permissions.OPERATE,'set customer payment terms');
 const {customerId,values}=terms.normaliseInput(input);if(!customerId||!(await client.query('SELECT 1 FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,customerId])).rows.length)throw new ValidationError('Choose this inventory’s customer.');
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['customer-terms:'+ctx.workspaceId+':'+customerId]);const prior=(await client.query('SELECT id FROM customer_payment_terms WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE',[ctx.workspaceId,customerId])).rows[0],at=nowIso();
 if(prior)await client.query(`UPDATE customer_payment_terms SET kind=$2,deposit_percent=$3,deposit_minor=$4,net_days=$5,hold_shipping=$6,credit_approved=$7,credit_limit_minor=$8,note=$9,auto_request_enabled=$10,auto_request_limit_minor=$11,agreed_by_user_id=$12,updated_at=$13 WHERE id=$1`,[prior.id,...values,ctx.actorId,at]);
 else await client.query(`INSERT INTO customer_payment_terms(id,workspace_id,customer_id,kind,deposit_percent,deposit_minor,net_days,hold_shipping,credit_approved,credit_limit_minor,note,auto_request_enabled,auto_request_limit_minor,agreed_by_user_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,[newId('cpt'),ctx.workspaceId,customerId,...values,ctx.actorId,at]);
 return {customerId};
}
async function forCustomer(db,workspaceId,customerId,{lock=false}={}){
  return (await db.query(`SELECT * FROM customer_payment_terms WHERE workspace_id=$1 AND (customer_id=$2 OR customer_id IS NULL)
    ORDER BY (customer_id IS NULL),updated_at DESC,id DESC LIMIT 1`+(lock?' FOR UPDATE':''),[workspaceId,customerId])).rows[0]||null;
}
function forQuote(terms){
  return {kind:terms?.kind||'ON_ACCOUNT',net_days:Number(terms?.net_days??30),
    deposit_percent:terms?.deposit_percent??null,deposit_minor:terms?.deposit_minor??null,hold_shipping:terms?.hold_shipping?1:0};
}
async function forOrder(db,workspaceId,orderId,customerId,options){
  if(orderId){
    const saved=(await db.query(`SELECT a.payment_terms FROM stockchief_runtime.quote_buyer_acceptances a
      JOIN sales_orders o ON o.workspace_id=a.workspace_id AND o.id=a.order_id
      WHERE a.workspace_id=$1 AND a.order_id=$2 AND o.customer_id=$3 AND a.state='DRAFTED'`,[workspaceId,orderId,customerId])).rows[0];
    if(saved)return {...saved.payment_terms,quoteBound:true};
  }
  return forCustomer(db,workspaceId,customerId,options);
}
async function assertEditableOrder(db,workspaceId,orderId){
  if((await db.query('SELECT 1 FROM stockchief_runtime.quote_buyer_acceptances WHERE workspace_id=$1 AND order_id=$2',
    [workspaceId,orderId])).rowCount)throw new ValidationError('The buyer accepted the exact terms on this order. Use a new quotation for changes.');
}
module.exports={saveInTransaction,forCustomer,forOrder,forQuote,assertEditableOrder};

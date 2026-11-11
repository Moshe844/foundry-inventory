'use strict';const terms=require('./payment-terms'),{newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors'),permissions=require('../actions/permissions');
async function saveInTransaction(client,ctx,input){permissions.assertCan((await client.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0],permissions.OPERATE,'set customer payment terms');
 const {customerId,values}=terms.normaliseInput(input);if(!customerId||!(await client.query('SELECT 1 FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,customerId])).rows.length)throw new ValidationError('Choose this inventory’s customer.');
 const {rows:[schema]}=await client.query(`SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE
   attrelid='customer_payment_terms'::regclass AND attname='deposit_currency' AND NOT attisdropped) AS has_currency,
   (SELECT base_currency FROM accounting_settings WHERE workspace_id=$1) AS base_currency`,[ctx.workspaceId]);
 const currency=values[2]==null?null:require('../domain/currency').code(input.depositCurrency||schema.base_currency);
 if(currency&&!schema.has_currency&&currency!==schema.base_currency)
   throw new ValidationError('The current database must support the recorded deposit currency before saving these terms.');
 await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['customer-terms:'+ctx.workspaceId+':'+customerId]);
 const prior=(await client.query('SELECT id,updated_at FROM customer_payment_terms WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE',[ctx.workspaceId,customerId])).rows[0];
 const priorTime=Date.parse(prior?.updated_at);
 const at=Number.isFinite(priorTime)?new Date(Math.max(Date.now(),priorTime+1)).toISOString():nowIso();
 if(input.expectedUpdatedAt!==undefined&&String(input.expectedUpdatedAt)!==String(prior?.updated_at||''))
   throw new ValidationError('The agreed customer terms changed. Review the current terms before saving.');
 const extra=schema.has_currency?[currency]:[];
 if(prior)await client.query(`UPDATE customer_payment_terms SET kind=$2,deposit_percent=$3,deposit_minor=$4,net_days=$5,hold_shipping=$6,credit_approved=$7,credit_limit_minor=$8,note=$9,auto_request_enabled=$10,auto_request_limit_minor=$11,agreed_by_user_id=$12,updated_at=$13${schema.has_currency?',deposit_currency=$14':''} WHERE id=$1`,[prior.id,...values,ctx.actorId,at,...extra]);
 else await client.query(`INSERT INTO customer_payment_terms(id,workspace_id,customer_id,kind,deposit_percent,deposit_minor,net_days,hold_shipping,credit_approved,credit_limit_minor,note,auto_request_enabled,auto_request_limit_minor,agreed_by_user_id,created_at,updated_at${schema.has_currency?',deposit_currency':''}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15${schema.has_currency?',$16':''})`,[newId('cpt'),ctx.workspaceId,customerId,...values,ctx.actorId,at,...extra]);
 return {customerId};
}
async function forCustomer(db,workspaceId,customerId,{lock=false}={}){
  return (await db.query(`SELECT * FROM customer_payment_terms WHERE workspace_id=$1 AND (customer_id=$2 OR customer_id IS NULL)
    ORDER BY (customer_id IS NULL),updated_at DESC,id DESC LIMIT 1`+(lock?' FOR UPDATE':''),[workspaceId,customerId])).rows[0]||null;
}
function forQuote(terms){
  return {kind:terms?.kind||'ON_ACCOUNT',net_days:Number(terms?.net_days??30),
    deposit_percent:terms?.deposit_percent??null,deposit_minor:terms?.deposit_minor??null,
    deposit_currency:terms?.deposit_currency??null,hold_shipping:Number(terms?.hold_shipping)?1:0};
}
async function hasBuyerAcceptances(db){
  return (await db.query("SELECT to_regclass('stockchief_runtime.quote_buyer_acceptances') IS NOT NULL AS installed")).rows[0].installed;
}
async function forAcceptedOrder(db,workspaceId,orderId,customerId){
  if(orderId&&await hasBuyerAcceptances(db)){
    const saved=(await db.query(`SELECT a.payment_terms FROM stockchief_runtime.quote_buyer_acceptances a
      JOIN sales_orders o ON o.workspace_id=a.workspace_id AND o.id=a.order_id
      WHERE a.workspace_id=$1 AND a.order_id=$2 AND o.customer_id=$3 AND a.state='DRAFTED'`,[workspaceId,orderId,customerId])).rows[0];
    if(saved)return saved.payment_terms;
  }
  return null;
}
async function assertEditableOrder(db,workspaceId,orderId){
  if(await hasBuyerAcceptances(db)&&(await db.query('SELECT 1 FROM stockchief_runtime.quote_buyer_acceptances WHERE workspace_id=$1 AND order_id=$2',
    [workspaceId,orderId])).rowCount)throw new ValidationError('The buyer accepted the exact terms on this order. Use a new quotation for changes.');
}
module.exports={saveInTransaction,forCustomer,forAcceptedOrder,forQuote,assertEditableOrder,hasBuyerAcceptances};

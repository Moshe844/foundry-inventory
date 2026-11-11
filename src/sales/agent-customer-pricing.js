'use strict';
const policy=require('../commercial/agent-plan'),money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');
async function checkDefinition(db,ctx,definition){
 if(definition?.enabled===false||!Array.isArray(definition?.scope?.customerIds)||!definition.scope.customerIds.length)return;
 const state=await policy.accountState(db,ctx.workspaceId);if(policy.usesAgentTerms(state))policy.requireJob(state.plan,76,'draft');
}
async function checkOrder(db,ctx,input,quote=null,{automatic=false}={}){
 const state=await policy.accountState(db,ctx.workspaceId);
 if(!policy.usesAgentTerms(state))return;
 quote=quote||await require('../pricing/postgres-promotions').prepareQuote(db,ctx,{...input,lines:input.pricingInputLines||input.lines,discountMinor:input.pricingInputDiscountMinor??input.discountMinor});
 const used=[...new Set([...(quote.applied||[]).map(r=>r.id),...(quote.lines||[]).map(l=>l.priceSource?.id)].filter(Boolean))];
 const rules=used.length?(await db.query(`SELECT v.rule_id,EXISTS(SELECT 1 FROM users u
   JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
   WHERE u.workspace_id=v.workspace_id AND u.id=v.created_by AND u.role='owner') AS owner_agreed
   FROM stockchief_runtime.pricing_rule_versions v
   JOIN jsonb_to_recordset($4::jsonb) p(id text,version integer) ON p.id=v.rule_id AND p.version=v.revision
   WHERE v.workspace_id=$1 AND v.rule_id=ANY($2::text[]) AND v.definition#>'{scope,customerIds}' ? $3`,
  [ctx.workspaceId,used,input.customerId,JSON.stringify(quote.policyVersions||[])])).rows:[];
 const terms=quote.customerTerms?.customer_id===input.customerId?quote.customerTerms:null;
 if(!rules.length&&!terms)return;
 policy.requireJob(state.plan,76,automatic?'automatic':'draft');
 if((terms&&!terms.owner_agreed)||rules.some(r=>!r.owner_agreed))
   throw new ValidationError('The current inventory owner must confirm these customer prices, discounts or payment terms before StockChief applies them.');
 const stop=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,76,automatic);
 if(stop)throw new ValidationError(stop);
}
async function checkRevision(db,ctx,p){
 const customer=(await db.query('SELECT customer_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.recordId])).rows[0];
 if(!customer)return;
 const revised=await require('../pricing/postgres-promotions').revisionQuote(db,ctx,p.recordId,p);
 await checkOrder(db,ctx,{customerId:customer.customer_id},revised.quote);
}
function description(d){
 if(!d)return 'No customer-specific price rule';
 if(d.kind==='price_list')return (d.entries||[]).length+' saved product price tiers';
 if(d.kind==='guard')return 'Saved margin or discount safeguard';
 const discount=d.discount;if(!discount)return 'Saved pricing rule';
 if(discount.type==='percent')return discount.value/100+'% discount';
 return money.format(discount.value,d.currency)+(discount.type==='bundle'?' bundle price':' discount '+({fixed_unit:'per unit',fixed_line:'per line',fixed_order:'per order'}[discount.type]||''));
}
async function report(db,ctx,{filter='',page=1}){
 const rows=(await db.query(`SELECT c.name,rule.id AS rule_id,rule.definition,t.kind,t.net_days,t.deposit_percent,t.deposit_minor,t.hold_shipping,
   coalesce(to_jsonb(t)->>'deposit_currency',a.base_currency) AS deposit_currency,
   c.id AS customer_id FROM customers c
  LEFT JOIN accounting_settings a ON a.workspace_id=c.workspace_id
  LEFT JOIN LATERAL(SELECT r.id,v.definition FROM stockchief_runtime.pricing_rules r JOIN stockchief_runtime.pricing_rule_versions v
   ON v.workspace_id=r.workspace_id AND v.rule_id=r.id AND v.revision=r.revision
   WHERE r.workspace_id=c.workspace_id AND v.definition#>'{scope,customerIds}' ? c.id ORDER BY r.id)rule ON true
  LEFT JOIN LATERAL(SELECT * FROM customer_payment_terms t WHERE t.workspace_id=c.workspace_id AND (t.customer_id=c.id OR t.customer_id IS NULL)
   ORDER BY (t.customer_id IS NOT NULL) DESC LIMIT 1)t ON true
  WHERE c.workspace_id=$1 AND c.record_state='ACTIVE' AND ($2='' OR lower(c.name)=lower($2))
  ORDER BY c.name,c.id,rule.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {rows:rows.slice(0,100).map(r=>({Customer:r.name,'Price list or discount':r.definition?.name||'Business default','Saved terms':description(r.definition),
  'Payment terms':r.kind?require('./customer-commercial-terms').describe(r,r.deposit_currency||'USD'):'Net 30 days',
  'Rule enabled':r.definition?(r.definition.enabled===false?'No':'Yes'):'No customer-specific rule',link:r.rule_id?'/sales/pricing/rules/'+r.rule_id+'/history':'/sales/customers/'+r.customer_id})),more:rows.length>100,
  summary:'Saved customer-specific price lists, discounts and payment terms. The order calculation checks the applicable products, quantities, dates, codes, usage limits and safeguards before saving its exact prices.'};
}
module.exports={checkDefinition,checkOrder,checkRevision,definition:{id:76,key:'customer-pricing',label:'Customer price lists, discounts and terms',filterLabel:'Customer name',readPage:report}};

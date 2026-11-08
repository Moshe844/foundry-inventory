'use strict';
const money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');
const plan=require('../commercial/agent-plan');

async function candidates(db,ctx,sku,page){
  const {rows}=await db.query(`SELECT s.id,s.code,c.id cost_id,p.id price_id,prev.id previous_cost_id,old.id previous_price_id,
    c.currency,c.amount_minor cost,prev.amount_minor previous_cost,p.amount_minor price,
    ceil(old.amount_minor::numeric*c.amount_minor/NULLIF(prev.amount_minor,0)) suggested
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    JOIN LATERAL(SELECT * FROM sku_purchase_costs WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)c ON true
    JOIN LATERAL(SELECT * FROM sku_purchase_costs WHERE workspace_id=s.workspace_id AND sku_id=s.id AND (created_at,id)<(c.created_at,c.id) ORDER BY created_at DESC,id DESC LIMIT 1)prev ON true
    JOIN LATERAL(SELECT * FROM sku_prices WHERE workspace_id=s.workspace_id AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
    JOIN LATERAL(SELECT * FROM sku_prices WHERE workspace_id=s.workspace_id AND sku_id=s.id AND created_at<c.created_at ORDER BY created_at DESC,id DESC LIMIT 1)old ON true
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2='' OR s.id=$2 OR lower(s.code)=lower($2))
      AND prev.currency=c.currency AND p.currency=c.currency AND old.currency=c.currency
      AND prev.amount_minor>0 AND old.amount_minor>prev.amount_minor AND c.amount_minor>prev.amount_minor
      AND p.amount_minor<ceil(old.amount_minor::numeric*c.amount_minor/prev.amount_minor)
    ORDER BY s.code,s.id LIMIT 51 OFFSET $3`,[ctx.workspaceId,sku,(page-1)*50]);
  return rows;
}
async function review(db,ctx,{filter,page}){
  const results=await candidates(db,ctx,filter,page);
  return {rows:results.slice(0,50).map(r=>({SKU:r.code,'Previous cost':money.format(r.previous_cost,r.currency),'Current cost':money.format(r.cost,r.currency),
    'Current selling price':money.format(r.price,r.currency),'Suggested selling price':money.format(r.suggested,r.currency)})),
    more:results.length>50,summary:'A higher recorded cost is compared with the selling price immediately before the cost changed. The suggested price preserves the earlier gross margin percentage, rounded up to the nearest currency unit of account. Every selling price change requires approval.'};
}
async function build(db,ctx,_record,args){
  const state=await plan.accountState(db,ctx.workspaceId);
  plan.requireJob(plan.usesAgentTerms(state)?state.plan:null,77,'draft');
  if(!args.sku)throw new ValidationError('Choose the exact SKU to review.');
  const rows=await candidates(db,ctx,args.sku,1);
  if(rows.length!==1)throw new ValidationError('There is no single current margin-recovery price for that SKU.');
  const r=rows[0];
  return {payload:{skuId:r.id,costId:r.cost_id,priorCostId:r.previous_cost_id,priceId:r.price_id,priorPriceId:r.previous_price_id,
    amountMinor:money.integer(r.suggested),currency:r.currency},
    summary:'Change the selling price of '+r.code+' from '+money.format(r.price,r.currency)+' to '+money.format(r.suggested,r.currency)+
      ' after its cost rose from '+money.format(r.previous_cost,r.currency)+' to '+money.format(r.cost,r.currency)+'.'};
}
async function execute(client,ctx,p){
  await client.query('SELECT id FROM skus WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.skuId]);
  const current=(await build(client,ctx,null,{sku:p.skuId})).payload;
  if(Object.keys(current).some(key=>current[key]!==p[key]))throw new ValidationError('The recorded costs or selling price changed. Review a new price.');
  return require('./postgres-service').setPriceInTransaction(client,ctx,{skuId:p.skuId,amountMinor:p.amountMinor,currency:p.currency,source:'owner',
    sourceDetail:{reason:'Approved after purchase cost increase',costId:p.costId,priorCostId:p.priorCostId}});
}
async function verify(db,ctx,result,p){
  const price=await require('./postgres-service').currentPrice(db,ctx.workspaceId,p.skuId);
  return price.id===result.id&&price.amount_minor===p.amountMinor&&price.currency===p.currency;
}
module.exports={review,build,execute,verify};

'use strict';
const promotions=require('./postgres-promotions'),prices=require('./postgres-service'),{ValidationError}=require('../domain/errors');
async function quote(db,ctx,input,{lock=false}={}){
 const currency=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;if(!currency)throw new ValidationError('Configure accounting before pricing an invoice.');
 const request={customerId:input.customerId,currency,lines:[{skuId:input.skuId||null,description:input.description,quantity:Number(input.quantity),unitPriceMinor:prices.toMinor(input.unitAmount,'Unit price',currency),priceOverride:input.priceOverride===true}],taxMinor:prices.toMinor(input.tax||'0','Tax',currency),codes:input.codes||[],priceListId:input.priceListId||null};
 return promotions.prepareQuote(db,ctx,request,{lock,invoice:true});
}
async function save(db,ctx,invoiceId,quote){
 await db.query('INSERT INTO stockchief_runtime.pricing_invoice_snapshots(id,workspace_id,invoice_id,quote,integrity_hash) VALUES($1,$2,$3,$4::jsonb,$5)',[require('../lib/util').newId('invoiceprice'),ctx.workspaceId,invoiceId,JSON.stringify(quote),promotions.hash(quote)]);
 for(const applied of quote.applied)await db.query('INSERT INTO stockchief_runtime.pricing_invoice_redemptions(workspace_id,rule_id,invoice_id,customer_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ctx.workspaceId,applied.id,invoiceId,quote.customerId]);
}
module.exports={quote,save};

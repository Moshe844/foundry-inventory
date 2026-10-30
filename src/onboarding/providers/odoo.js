'use strict';
const crypto=require('node:crypto'),{ValidationError}=require('../../domain/errors');
const {providerFetch}=require('../../lib/provider-http'),network=require('../../connections/providers/store-network'),{readResponseText}=require('../../connections/providers/common');
const FIELDS=Object.freeze({
 'res.company':['id','name','currency_id'],
 'res.currency':['id','name','rounding','decimal_places'],
 'uom.uom':['id','name','rounding','factor','relative_factor','relative_uom_id'],
 'res.partner':['id','name','email','phone','street','street2','city','state_id','zip','country_id','supplier_rank','customer_rank','company_id','write_date'],
 'product.template':['id','name','uom_id','tracking','is_storable','company_id','write_date'],
 'product.product':['id','name','default_code','barcode','product_tmpl_id','uom_id','is_storable','tracking','standard_price','list_price','company_id','currency_id','write_date','product_template_attribute_value_ids','cost_method','valuation','categ_id'],
 'product.template.attribute.value':['id','name','attribute_id'],
 'stock.warehouse':['id','name','lot_stock_id','company_id'],
 'stock.picking.type':['id','name','default_location_dest_id','company_id'],
 'stock.location':['id','name','complete_name','usage','location_id','company_id','write_date'],
 'stock.quant':['id','product_id','location_id','lot_id','quantity','reserved_quantity','company_id','owner_id','package_id','write_date'],
 'stock.lot':['id','name','product_id','company_id','write_date'],
 'purchase.order':['id','name','partner_id','currency_id','date_order','state','company_id','write_date','picking_type_id','amount_total','amount_tax'],
 'purchase.order.line':['id','order_id','product_id','product_qty','qty_received','price_unit','product_uom_id','tax_ids','price_subtotal','price_total','display_type','state','company_id','write_date'],
 'sale.order':['id','name','partner_id','currency_id','date_order','state','company_id','write_date','warehouse_id','amount_total','amount_tax'],
 'sale.order.line':['id','order_id','product_id','product_uom_qty','qty_delivered','price_unit','product_uom_id','tax_ids','discount','price_subtotal','price_total','display_type','is_downpayment','state','company_id','write_date'],
 'account.move':['id','name','partner_id','currency_id','invoice_date','invoice_date_due','move_type','state','amount_total','amount_residual','company_id','write_date']
});
function create(input,options={}){
 let base;try{base=new URL(input.url);}catch{throw new ValidationError('Enter the HTTPS address of the Odoo server.');}
 const fixture=process.env.NODE_ENV==='test'&&base.hostname==='127.0.0.1'&&String(process.env.STOCKCHIEF_ERP_TEST_ORIGINS||'').split(',').includes(base.origin);
 if(base.username||base.password||base.search||base.hash||base.pathname!=='/'||(!fixture&&base.protocol!=='https:')||(fixture&&!['http:','https:'].includes(base.protocol)))throw new ValidationError('Use an HTTPS Odoo origin without credentials, paths or query parameters.');
 if(!fixture)network.address(base.origin);const companyId=Number(input.companyId);if(!Number.isSafeInteger(companyId)||companyId<=0)throw new ValidationError('Choose one exact Odoo company.');
 if(typeof input.database!=='string'||!/^[A-Za-z0-9_.-]{1,100}$/.test(input.database)||typeof input.apiKey!=='string'||!input.apiKey.trim()||/[\r\n]/.test(input.apiKey))throw new ValidationError('Supply an Odoo database and read-capable API key.');
 async function page(model,{afterId=0,limit=250,fields=FIELDS[model],domain=[]}={}){
  if(!Object.hasOwn(FIELDS,model)||!Array.isArray(fields)||!fields.length||fields.some(f=>!FIELDS[model].includes(f))||!fields.includes('id'))throw new ValidationError('This cutover reader only permits the reviewed Odoo models and fields.');
  if(!Number.isSafeInteger(afterId)||afterId<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw new ValidationError('Read 1–500 Odoo records at a time using an exact ID cursor.');
  if(!Array.isArray(domain)||domain.length>100)throw new ValidationError('Use a bounded Odoo read filter.');
  const filter=[...domain,['id','>',afterId]];if(FIELDS[model].includes('company_id'))filter.push('|',['company_id','=',false],['company_id','=',companyId]);if(model==='res.company')filter.push(['id','=',companyId]);
  const body=JSON.stringify({domain:filter,fields,order:'id asc',limit,context:{allowed_company_ids:[companyId],force_company:companyId,active_test:false}});
  const response=await providerFetch(base.origin+'/json/2/'+model+'/search_read',{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+input.apiKey,'X-Odoo-Database':input.database,'Content-Type':'application/json','Idempotency-Key':'stockchief-odoo-read:'+crypto.createHash('sha256').update(model+body).digest('hex')},body},{provider:'Odoo ERP',fetch:options.fetch||(fixture?fetch:network.fetchStore),timeoutMs:options.timeoutMs||20000});
  const text=await readResponseText(response,8*1024*1024);if(!response.ok)throw new ValidationError('Odoo refused the read request (HTTP '+response.status+'). Check this database, company and API-key access.');let rows;try{rows=JSON.parse(text);}catch{throw new ValidationError('Odoo returned an invalid JSON response.');}
  if(!Array.isArray(rows)||rows.length>limit)throw new ValidationError('Odoo returned more records than the requested bounded page.');let cursor=afterId;
  for(const row of rows){if(!Number.isSafeInteger(row.id)||row.id<=cursor)throw new ValidationError('Odoo repeated or reordered its source cursor.');if(row.company_id&&Number(Array.isArray(row.company_id)?row.company_id[0]:row.company_id)!==companyId)throw new ValidationError('Odoo returned a record belonging to another company.');cursor=row.id;}
  return {rows,nextAfterId:rows.length===limit?cursor:null,lastId:cursor};
 }
 async function* pages(model,options={}){let afterId=0;do{const result=await page(model,{...options,afterId});yield result.rows;afterId=result.nextAfterId;}while(afterId!==null);}
 return {page,pages,companyId,database:input.database,origin:base.origin};
}
module.exports={create,FIELDS};

'use strict';
// Read-only Odoo 19 qualification profile. Export iterates bounded source pages;
// no caller may present its live multi-request traversal as a frozen snapshot.
const exact=require('../../domain/exact-quantity'),money=require('../../domain/currency'),{ValidationError}=require('../../domain/errors');
const id=value=>Array.isArray(value)?value[0]:value;
const key=(type,value)=>type+':'+id(value);
function minor(value,currency,label){try{return money.toMinor(String(value),currency);}catch{throw new ValidationError(label+' requires a reviewed currency conversion or rounding decision.');}}
function precision(increment){const value=exact.canonical(increment,{scale:6});return value.includes('.')?value.split('.')[1].length:0;}
async function one(reader,model,recordId,fields){const found=await reader.page(model,{domain:[['id','=',id(recordId)]],fields,limit:1});if(found.rows.length!==1)throw new ValidationError('Odoo source reference '+model+' '+id(recordId)+' is unavailable.');return found.rows[0];}
async function* records(reader,input){
 if(input.sourceFrozen!==true||!String(input.freezeEvidence||'').trim())throw new ValidationError('Freeze Odoo writes and supply the source freeze evidence before exporting.');
 if(input.valuationBasis!=='OWNER_CONFIRMED_STANDARD_COST')throw new ValidationError('Review the Odoo valuation method before using this standard-cost export profile.');
 const company=await one(reader,'res.company',reader.companyId,['id','name','currency_id']),currencyRow=await one(reader,'res.currency',company.currency_id,['id','name','decimal_places']),currency=currencyRow.name,date=input.openingDate;if(!/^\d{4}-\d{2}-\d{2}$/.test(date||''))throw new ValidationError('Choose the opening accounting date.');
 let inventoryValue=0;
 for await(const page of reader.pages('stock.location',{domain:[['usage','=','internal']]}))for(const row of page)yield {type:'location',key:key('location',row.id),version:row.write_date,payload:{name:row.complete_name,kind:'warehouse'}};
 for await(const page of reader.pages('res.partner',{domain:['|',['supplier_rank','>',0],['customer_rank','>',0]]}))for(const row of page){const p={name:row.name,email:row.email||null,phone:row.phone||null};if(row.supplier_rank>0)yield {type:'supplier',key:key('partner',row.id),version:row.write_date,payload:{...p,currency}};if(row.customer_rank>0)yield {type:'customer',key:key('partner',row.id),version:row.write_date,payload:p};}
 for await(const templates of reader.pages('product.template',{domain:[['is_storable','=',true]]}))for(const template of templates){const templateUnit=await one(reader,'uom.uom',template.uom_id),productKey=key('product',template.id);yield {type:'product',key:productKey,version:template.write_date,payload:{name:template.name,active:template.active!==false,unitLabel:templateUnit.name,quantityPrecision:template.tracking==='serial'?0:precision(templateUnit.rounding),quantityIncrement:template.tracking==='serial'?'1':exact.canonical(templateUnit.rounding),trackingMode:template.tracking==='none'?'quantity':template.tracking}};
 for await(const page of reader.pages('product.product',{domain:[['product_tmpl_id','=',template.id]]}))for(const row of page){
  if(row.cost_method!=='standard')throw new ValidationError('Odoo product '+row.id+' uses '+row.cost_method+' costing. Export its actual valuation layers through a reviewed valuation adapter.');
  if(id(row.currency_id)!==id(company.currency_id))throw new ValidationError('The Odoo product currency differs from the selected company.');
  const unit=await one(reader,'uom.uom',row.uom_id),digits=precision(unit.rounding),options=[];for(const attributeId of row.product_template_attribute_value_ids||[]){const attribute=await one(reader,'product.template.attribute.value',attributeId);options.push({name:attribute.attribute_id[1],value:attribute.name});}
  const skuKey=key('sku',row.id);yield {type:'sku',key:skuKey,version:row.write_date,payload:{productKey,active:row.active!==false,code:row.default_code||'ODOO-'+row.id,barcode:row.barcode||null,options}};
  yield {type:'purchase_cost',key:'cost:'+row.id,payload:{skuKey,currency,amountMinor:minor(row.standard_price,currency,'Odoo standard cost')}};yield {type:'selling_price',key:'price:'+row.id,payload:{skuKey,currency,amountMinor:minor(row.list_price,currency,'Odoo selling price')}};
  for await(const quants of reader.pages('stock.quant',{domain:[['product_id','=',row.id],['location_id.usage','=','internal']]}))for(const quant of quants){
   if(quant.owner_id||quant.package_id)throw new ValidationError('Odoo quant '+quant.id+' needs a reviewed owner/package custody mapping. No owned or packed stock was combined.');
   const quantity=exact.canonical(quant.quantity,{scale:digits}),reserved=exact.canonical(quant.reserved_quantity,{scale:digits}),value=exact.costMinor(quantity,minor(row.standard_price,currency,'Odoo standard cost'));inventoryValue+=value;if(!Number.isSafeInteger(inventoryValue))throw new ValidationError('The opening inventory value exceeds the exact monetary range.');
   const payload={skuKey,locationKey:key('location',quant.location_id),quantity,reservedQuantity:reserved,availableQuantity:exact.subtract(quantity,reserved),damagedQuantity:0,totalCostMinor:value,currency};
   if(row.tracking!=='none'){if(!quant.lot_id)throw new ValidationError('Tracked Odoo stock needs its source lot or serial identity.');const lot=await one(reader,'stock.lot',quant.lot_id);if(row.tracking==='serial'){if(Number(quantity)!==1)throw new ValidationError('One serial identity must describe one physical piece.');payload.serials=[lot.name];}else payload.lotCode=lot.name;}
   yield {type:'inventory_position',key:'quant:'+quant.id,version:quant.write_date,payload};
  }
 }
 }
 for(const purchase of [true,false]){const model=purchase?'purchase.order':'sale.order',lineModel=purchase?'purchase.order.line':'sale.order.line';for await(const page of reader.pages(model,{domain:[['state','in',purchase?['purchase','done']:['sale']]]}))for(const order of page){
  if(id(order.currency_id)!==id(company.currency_id))throw new ValidationError('An open Odoo order needs a reviewed foreign-currency mapping.');
  const warehouse=await one(reader,purchase?'stock.picking.type':'stock.warehouse',purchase?order.picking_type_id:order.warehouse_id),location=purchase?warehouse.default_location_dest_id:warehouse.lot_stock_id,lines=[];
  for await(const linePage of reader.pages(lineModel,{domain:[['order_id','=',order.id]]}))for(const line of linePage){if(line.display_type)continue;if(line.is_downpayment)throw new ValidationError('Odoo order '+order.name+' has a down payment requiring its reviewed opening payment allocation.');
   const remaining=exact.safeNumber(exact.subtract(purchase?line.product_qty:line.product_uom_qty,purchase?line.qty_received:line.qty_delivered),{signed:true});if(remaining<=0)continue;const product=await one(reader,'product.product',line.product_id,['id','is_storable','uom_id']);if(!product.is_storable)throw new ValidationError('Odoo order '+order.name+' includes a service obligation that needs its reviewed service mapping.');
   if(id(product.uom_id)!==id(line.product_uom_id))throw new ValidationError('Odoo order '+order.name+' uses another purchase/sales unit. Review its exact conversion before importing.');
   const originalQuantity=purchase?line.product_qty:line.product_uom_qty,completed=purchase?line.qty_received:line.qty_delivered,fullGross=exact.costMinor(originalQuantity,minor(line.price_unit,currency,'Odoo order price')),fullNet=minor(line.price_subtotal,currency,'Odoo line net'),fullTotal=minor(line.price_total,currency,'Odoo line total'),gross=exact.portionMinor(fullGross,originalQuantity,completed,remaining),discount=exact.portionMinor(fullGross-fullNet,originalQuantity,completed,remaining),tax=exact.portionMinor(fullTotal-fullNet,originalQuantity,completed,remaining);
   lines.push({grossMinor:gross,discountMinor:discount,taxMinor:tax,skuKey:key('sku',line.product_id),quantity:remaining,unitPriceMinor:minor(line.price_unit,currency,'Odoo order unit price'),sourceLineKey:key('order-line',line.id)});if(lines.length>5000)throw new ValidationError('Split the Odoo open order into reviewed obligations of at most 5,000 lines.');
  }
  const financials=lines.reduce((a,l)=>({subtotalMinor:a.subtotalMinor+l.grossMinor,discountMinor:a.discountMinor+l.discountMinor,taxMinor:a.taxMinor+l.taxMinor,totalMinor:a.totalMinor+l.grossMinor-l.discountMinor+l.taxMinor}),{subtotalMinor:0,discountMinor:0,taxMinor:0,totalMinor:0});
  if(lines.length)yield {type:purchase?'purchase_order':'sales_order',key:key(purchase?'po':'so',order.id),version:order.write_date,payload:{orderNumber:order.name,currency,status:purchase?'ORDERED':'CONFIRMED',remainingOnly:true,lines,sourceFinancials:financials,discountMinor:financials.discountMinor,taxMinor:financials.taxMinor,...(!purchase?{recordedAmounts:true}:{}),...(purchase?{supplierKey:key('partner',order.partner_id),destinationLocationKey:key('location',location)}:{customerKey:key('partner',order.partner_id),fulfillmentLocationKey:key('location',location),deliveryMethod:'PICKUP'})}};
 }}
 // A non-empty financial ledger needs its complete chart/control mapping. This
 // profile must not silently substitute inventory cost for the ERP trial balance.
 const journals=await reader.page('account.move',{domain:[['state','=','posted']],limit:1,fields:['id']});if(journals.rows.length)throw new ValidationError('This Odoo company has posted accounting entries. Attach the reviewed trial balance and unpaid documents; the stock-only standard-cost profile cannot certify its full books.');
 if(inventoryValue)yield {type:'opening_journal',key:'opening-inventory',payload:{currency,postingDate:date,lines:[{accountKey:'INVENTORY_ASSET',debitMinor:inventoryValue},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:inventoryValue}]}};
 yield {type:'history_fact',key:'freeze-evidence',payload:{factType:'odoo_source_freeze',operatingEffect:false,companyId:reader.companyId,freezeEvidence:input.freezeEvidence,valuationBasis:input.valuationBasis}};
}
module.exports={records,precision};

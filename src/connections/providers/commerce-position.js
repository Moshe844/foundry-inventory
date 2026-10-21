'use strict';

// Transport adapters only. Authority, mapping, baselines, conflicts, retries and
// canonical accounting/inventory changes belong to the shared sync service.
const money=require('../../domain/currency');
const {ValidationError}=require('../../domain/errors');
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const eq=(a,b)=>stable(a)===stable(b);
const conflict=()=>Object.assign(new ValidationError('The provider value changed after synchronization was prepared. Review both values before trying again.'),{code:'commerce_sync_conflict',status:409,retryable:false,providerWriteAttempted:false});
function integer(value){const n=Number(value);if(value==null||value===''||!Number.isSafeInteger(n)||n<0)throw new ValidationError('Provider stock must be an explicit non-negative whole count.');return n;}
function amount(value,currency){return value==null||value===''?null:{amount:money.integer(value),currency:money.code(currency)};}
function checkErrors(body){if(body?.userErrors?.length||body?.errors?.length)throw Object.assign(new ValidationError('The provider refused this synchronization. Review its permissions and the current product.'),{code:'commerce_sync_rejected',status:422});}
function adapter(type,transport){
 async function read({credentials,externalId,externalLocationId,field,parentExternalId}){
  if(type==='shopify'){
   const d=await transport.graphql(credentials,`query SyncPosition($id:ID!,$location:ID!){shop{currencyCode} productVariant(id:$id){id price product{id} inventoryItem{id tracked inventoryLevel(locationId:$location){quantities(names:["on_hand","available"]){name quantity}}}}}`,
    {id:externalId,location:externalLocationId});const v=d.productVariant;if(!v)throw new ValidationError('The Shopify variant no longer exists.');
   const count=v.inventoryItem?.inventoryLevel?.quantities?.find(q=>q.name==='available');
   return {value:field==='price'?amount(money.toMinor(v.price,d.shop.currencyCode),d.shop.currencyCode):v.inventoryItem?.tracked&&count?integer(count.quantity):null,
    version:null,productId:v.product.id,inventoryItemId:v.inventoryItem?.id,tracked:!!v.inventoryItem?.tracked};
  }
  if(type==='square'){
   const object=(await transport.api(credentials,'/v2/catalog/object/'+encodeURIComponent(externalId))).body.object;
   if(object?.type!=='ITEM_VARIATION'||object.is_deleted)throw new ValidationError('The Square variation no longer exists.');
   if(field==='price')return {value:object.item_variation_data?.location_overrides?.find(o=>o.location_id===externalLocationId)?.price_money||object.item_variation_data?.price_money||null,version:object.version,object};
   const d=(await transport.api(credentials,'/v2/inventory/counts/batch-retrieve',{method:'POST',body:JSON.stringify({catalog_object_ids:[externalId],location_ids:[externalLocationId],states:['IN_STOCK']})})).body;
   checkErrors(d);const counts=(d.counts||[]).filter(c=>c.catalog_object_id===externalId&&c.location_id===externalLocationId&&c.state==='IN_STOCK');
   if(counts.length>1)throw new ValidationError('Square returned competing stock counts.');
   return {value:counts.length?integer(counts[0].quantity):null,version:counts[0]?.calculated_at||null,tracked:object.item_variation_data?.track_inventory===true};
  }
  if(type==='clover'){
   const base='/v3/merchants/'+encodeURIComponent(credentials.merchantId);
   if(externalLocationId!==credentials.merchantId)throw new ValidationError('This Clover location does not belong to the authorized merchant.');
   const v=(await transport.api(credentials,base+'/items/'+encodeURIComponent(externalId)+'?expand=itemStock')).body;
   if(v.deleted||v.hidden)throw new ValidationError('The Clover item is unavailable.');
   let currency=credentials.currency;if(field==='price'&&!currency){const merchant=(await transport.api(credentials,base)).body;currency=merchant.currency;
    if(!currency)currency=(await transport.api(credentials,base+'/properties')).body.defaultCurrency;}
   const stock=v.itemStock?.quantity??v.itemStock?.stockCount??v.stockCount;
   return {value:field==='price'?amount(v.price,currency):stock==null?null:integer(stock),version:v.modifiedTime||null,tracked:stock!=null,priceType:v.priceType||'FIXED'};
  }
  if(type==='woocommerce'){
   const endpoint=parentExternalId?'/products/'+encodeURIComponent(parentExternalId)+'/variations/'+encodeURIComponent(externalId):'/products/'+encodeURIComponent(externalId);
   const v=(await transport.api(credentials,endpoint)).body;
   if(!v.id||v.status&&v.status!=='publish')throw new ValidationError('The WooCommerce product is not published.');
   const currency=field==='price'?await transport.storeCurrency(credentials):null;
   return {value:field==='price'?v.price===''?null:amount(money.toMinor(v.price,currency),currency):v.manage_stock===true&&v.stock_quantity!=null?integer(v.stock_quantity):null,
    version:v.date_modified_gmt||null,endpoint,tracked:v.manage_stock===true,salePrice:v.sale_price||null,productType:v.type||'variation'};
  }
  throw new ValidationError('This provider does not support stock and price synchronization.');
 }
 async function write(input){
  const {credentials,externalId,externalLocationId,field,value,expected,idempotencyKey}=input;
  const current=await read(input);if(!eq(current.value,expected))throw conflict();
  if(field==='price'){
   if(!value||!Number.isSafeInteger(value.amount)||value.amount<0||!current.value||value.currency!==current.value.currency)throw new ValidationError('The provider and StockChief must use the same evidenced currency and exact non-negative price.');
  }else integer(value);
  if(type==='shopify'){
   let result;if(field==='price')result=(await transport.graphql(credentials,`mutation SyncPrice($product:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$product,variants:$variants,allowPartialUpdates:false){userErrors{code message field} productVariants{id price}}}`,
    {product:current.productId,variants:[{id:externalId,price:money.fromMinor(value.amount,value.currency)}]})).productVariantsBulkUpdate;
   else{
    if(!current.tracked||current.value===null)throw new ValidationError('Enable tracked inventory at this Shopify location before synchronizing its quantity.');
    result=(await transport.graphql(credentials,`mutation SyncCount($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){userErrors{code message field} inventoryAdjustmentGroup{referenceDocumentUri}}}`,
     {key:idempotencyKey,input:{name:'available',reason:'correction',referenceDocumentUri:'stockchief://synchronization/'+encodeURIComponent(idempotencyKey),quantities:[{inventoryItemId:current.inventoryItemId,locationId:externalLocationId,quantity:value,changeFromQuantity:expected}]}})).inventorySetQuantities;
   }checkErrors(result);
  }else if(type==='square'){
   let body;if(field==='price'){
    const object=structuredClone(current.object),override=object.item_variation_data.location_overrides?.find(o=>o.location_id===externalLocationId&&o.price_money);
    if(override)override.price_money=value;else object.item_variation_data.price_money=value;
    body=(await transport.api(credentials,'/v2/catalog/object',{method:'POST',body:JSON.stringify({idempotency_key:idempotencyKey,object})})).body;
   }else{
    if(!current.tracked)throw new ValidationError('Enable inventory tracking for this Square variation before synchronizing its quantity.');
    body=(await transport.api(credentials,'/v2/inventory/changes/batch-create',{method:'POST',body:JSON.stringify({idempotency_key:idempotencyKey,ignore_unchanged_counts:false,
     changes:[{type:'PHYSICAL_COUNT',physical_count:{catalog_object_id:externalId,location_id:externalLocationId,state:'IN_STOCK',quantity:String(value),occurred_at:new Date().toISOString(),reference_id:idempotencyKey}}]})})).body;
   }checkErrors(body);
  }else if(type==='clover'){
   if(field==='price'&&current.priceType!=='FIXED')throw new ValidationError('A variable-price Clover item needs review before a fixed price can be synchronized.');
   const base='/v3/merchants/'+encodeURIComponent(credentials.merchantId);
   await transport.api(credentials,base+(field==='price'?'/items/':'/item_stocks/')+encodeURIComponent(externalId),
    {method:field==='price'?'POST':'PUT',body:JSON.stringify(field==='price'?{price:value.amount}:{quantity:value})});
  }else if(type==='woocommerce'){
   if(field==='price'&&current.salePrice!==null)throw new ValidationError('This WooCommerce item has a sale-price override. Review the promotion before changing its base price.');
   if(field==='quantity'&&!current.tracked)throw new ValidationError('Enable stock management on this WooCommerce product before synchronizing quantity.');
   await transport.api(credentials,current.endpoint,{method:'PUT',body:JSON.stringify(field==='price'?{regular_price:money.fromMinor(value.amount,value.currency)}:{stock_quantity:value})});
  }
  const verified=await read(input);
  if(!eq(verified.value,value))throw Object.assign(new ValidationError('The provider has not confirmed the requested value. StockChief retained the operation for verification and did not repeat it.'),{code:'commerce_sync_unverified',providerOutcomeUncertain:true});
  return {externalId,value:verified.value,version:verified.version,verified:true};
 }
 return {readSyncPosition:read,writeSyncPosition:write};
}
module.exports={adapter};

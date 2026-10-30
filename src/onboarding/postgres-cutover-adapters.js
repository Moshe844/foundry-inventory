'use strict';
const {newId,nowIso}=require('../lib/util'),{ValidationError}=require('../domain/errors');
const catalog=require('../domain/postgres-catalog-service'),commerce=require('../operations/postgres-commerce'),flow=require('../operations/postgres-business-workflows'),pricing=require('../pricing/postgres-service');
async function identity(c,ctx,pkg,type,key){if(!key)return null;const row=(await c.query('SELECT local_id FROM external_identity_maps WHERE workspace_id=$1 AND source_namespace=$2 AND entity_type=$3 AND external_key=$4',[ctx.workspaceId,pkg.source_namespace,type,key])).rows[0];if(!row)throw new ValidationError('The source '+type+' reference '+key+' has not been applied.');return row.local_id;}
async function remember(c,ctx,pkg,row,target){if(!target.id)throw new ValidationError('The applied '+row.entity_type+' did not resolve to a native business record.');const at=nowIso();await c.query('INSERT INTO external_identity_maps(id,workspace_id,source_namespace,entity_type,external_key,external_version,local_type,local_id,evidence_hash,first_package_id,last_package_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$11) ON CONFLICT(workspace_id,source_namespace,entity_type,external_key) DO UPDATE SET external_version=EXCLUDED.external_version,local_type=EXCLUDED.local_type,local_id=EXCLUDED.local_id,evidence_hash=EXCLUDED.evidence_hash,last_package_id=EXCLUDED.last_package_id,updated_at=EXCLUDED.updated_at',[newId('emap'),ctx.workspaceId,pkg.source_namespace,row.entity_type,row.source_key,row.source_version,target.type,target.id,row.payload_hash,pkg.id,at]);}
const tx=c=>({query:c.query.bind(c),transaction:f=>f(c)});
async function apply(c,ctx,pkg,row){const p=JSON.parse(row.payload_json),type=row.entity_type,key='cutover:'+pkg.id+':'+row.id;
 if(type==='product')return {type:'source_product',id:row.id,deferred:true};
 if(type==='location'){const r=await require('../domain/postgres-location-service').createLocationInTransaction(c,ctx,{...p,kind:p.kind||'warehouse',parentLocationId:await identity(c,ctx,pkg,'location',p.parentLocationKey)});return {type:'location',id:r.id};}
 if(type==='sku'){
  const parent=(await c.query("SELECT * FROM migration_records WHERE package_id=$1 AND entity_type='product' AND source_key=$2",[pkg.id,p.productKey])).rows[0];if(!parent)throw new ValidationError('The SKU product source is missing.');const product=JSON.parse(parent.payload_json);
  const mapped=(await c.query("SELECT local_id FROM external_identity_maps WHERE workspace_id=$1 AND source_namespace=$2 AND entity_type='product' AND external_key=$3",[ctx.workspaceId,pkg.source_namespace,p.productKey])).rows[0];
  const r=await catalog.createImportedItemInTransaction(c,ctx,{name:product.name,description:product.description,trackingMode:product.trackingMode||'quantity',unitLabel:product.unitLabel||'unit',appendToItemId:mapped?.local_id,cutoverPackageId:pkg.id,cutoverProductKey:p.productKey,variants:[{key:row.source_key,code:p.code,barcode:p.barcode,label:p.label,options:p.options||[]}]});
  if(!mapped){await remember(c,ctx,pkg,parent,{type:'item',id:r.itemId});await c.query("UPDATE migration_records SET target_type='item',target_id=$2 WHERE id=$1",[parent.id,r.itemId]);}return {type:'sku',id:r.skus[0].skuId};
 }
 if(type==='supplier'){const r=await commerce.createSupplierInTransaction(c,ctx,p);return {type:'supplier',id:r.id};}
 if(type==='customer'){const r=await commerce.createCustomerInTransaction(c,ctx,p);return {type:'customer',id:r.id};}
 if(type==='supplier_item'){const r=await commerce.linkSupplierItemInTransaction(c,ctx,{...p,supplierId:await identity(c,ctx,pkg,'supplier',p.supplierKey),skuId:await identity(c,ctx,pkg,'sku',p.skuKey)});return {type:'supplier_item',id:r.id};}
 if(type==='selling_price'||type==='purchase_cost'){const r=await pricing[type==='selling_price'?'setPriceInTransaction':'setPurchaseCostInTransaction'](c,ctx,{...p,skuId:await identity(c,ctx,pkg,'sku',p.skuKey),source:'migration',sourceDetail:{cutoverPackageId:pkg.id,sourceKey:row.source_key}});return r.id?{type:type==='selling_price'?'sku_price':'sku_purchase_cost',id:r.id}:{type:'supplier_item',id:r.supplier_item_id};}
 if(type==='reorder_policy'){const [r]=await require('../operations/postgres-reorder-policies').setManyInTransaction(c,ctx,[{...p,skuId:await identity(c,ctx,pkg,'sku',p.skuKey),locationId:await identity(c,ctx,pkg,'location',p.locationKey),preferredSupplierId:await identity(c,ctx,pkg,'supplier',p.preferredSupplierKey)}]);return {type:'reorder_policy',id:r.id};}
 if(type==='inventory_position'){
  if(Number(p.quantity)===0)return {type:'zero_inventory_position',id:row.id};
  const r=await require('../domain/postgres-inventory-engine').receiveInTransaction(c,ctx,{...p,skuId:await identity(c,ctx,pkg,'sku',p.skuKey),locationId:await identity(c,ctx,pkg,'location',p.locationKey),quantity:p.quantity,reasonCode:'migration_opening',reference:key,idempotencyKey:key});
  await require('../accounting/postgres-costing').receiveInTransaction(c,ctx,{movementId:r.movementId,totalCostMinor:p.totalCostMinor,sourceType:'verified_migration_opening_value',sourceRecordId:row.id});
  if(Number(p.damagedQuantity||0))await c.query("INSERT INTO inventory_availability_holds(id,workspace_id,sku_id,location_id,kind,quantity,remaining_quantity,source_type,source_id,evidence_json,status,created_at,updated_at) VALUES($1,$2,$3,$4,'damaged',$5,$5,'migration_record',$6,$7,'OPEN',$8,$8)",[newId('hold'),ctx.workspaceId,await identity(c,ctx,pkg,'sku',p.skuKey),await identity(c,ctx,pkg,'location',p.locationKey),p.damagedQuantity,row.id,JSON.stringify({cutoverPackageId:pkg.id,sourceKey:row.source_key}),nowIso()]);
  return {type:'movement',id:r.movementId};
 }
 if(type==='purchase_order'){
  const lines=[];for(const l of p.lines)lines.push({...l,skuId:await identity(c,ctx,pkg,'sku',l.skuKey),quantityUnits:l.quantity,quantityPurchaseUnits:l.quantity,unitsPerPurchaseUnit:1,purchaseUnit:'stock unit',unitCost:require('../domain/currency').fromMinor(l.unitPriceMinor,p.currency)});
  const r=await flow.createPurchaseOrderInTransaction(c,ctx,{...p,poNumber:p.orderNumber,supplierId:await identity(c,ctx,pkg,'supplier',p.supplierKey),destinationLocationId:await identity(c,ctx,pkg,'location',p.destinationLocationKey),lines,idempotencyKey:key,source:'instruction',sourceDetail:{cutoverPackageId:pkg.id,sourceKey:row.source_key,remainingOnly:true}});
  if(p.status!=='DRAFT'){await flow.approvePurchaseOrder(tx(c),ctx,r.purchaseOrderId,{idempotencyKey:key+':approve'});await flow.placePurchaseOrder(tx(c),ctx,r.purchaseOrderId,{idempotencyKey:key+':place'});}return {type:'purchase_order',id:r.purchaseOrderId};
 }
 if(type==='sales_order'){
  const lines=[];for(const l of p.lines)lines.push({...l,skuId:await identity(c,ctx,pkg,'sku',l.skuKey),quantity:l.quantity,externalLineId:l.sourceLineKey||null});const r=await flow.createSalesOrderInTransaction(c,ctx,{...p,orderNumber:p.orderNumber,customerId:await identity(c,ctx,pkg,'customer',p.customerKey),fulfillmentLocationId:await identity(c,ctx,pkg,'location',p.fulfillmentLocationKey),lines,idempotencyKey:key});
  if(p.status!=='DRAFT')await flow.confirmSalesOrderInTransaction(c,ctx,r.salesOrderId,{idempotencyKey:key+':confirm'});return {type:'sales_order',id:r.salesOrderId};
 }
 if(type==='opening_journal'){
  const lines=[];for(const l of p.lines)lines.push({...l,customerId:await identity(c,ctx,pkg,'customer',l.customerKey),supplierId:await identity(c,ctx,pkg,'supplier',l.supplierKey)});const r=await require('../accounting/postgres-ledger').postInTransaction(c,ctx,{...p,lines,sourceKey:key,sourceType:'verified_migration_opening_value',sourceRecordType:'migration_package',sourceRecordId:pkg.id,description:p.description||'Verified ERP opening balances'});return {type:'journal_entry',id:r.entry.id};
 }
 if(type==='history_fact'){const id=newId('mhist');await c.query('INSERT INTO migration_history_facts(id,workspace_id,package_id,source_namespace,external_key,fact_type,occurred_at,payload_json,evidence_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,ctx.workspaceId,pkg.id,pkg.source_namespace,row.source_key,p.factType,p.occurredAt||null,row.payload_json,row.payload_hash,nowIso()]);return {type:'migration_history_fact',id};}
 throw new ValidationError('No native cutover handler exists for '+type+'.');
}
module.exports={apply,identity,remember};

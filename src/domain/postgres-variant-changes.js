'use strict';
const {createHash}=require('crypto'),{ValidationError,NotFoundError}=require('./errors'),money=require('./currency'),{newId,requireText}=require('../lib/util');
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
function auditValues(change,after){const values={},state=change.before;for(const [field,value] of Object.entries(change.after)){
 const label={code:'SKU',barcode:'Barcode',price:'Selling price',cost:'Purchase cost',reorder:'Reorder point',supplier:'Supplier',options:'Option values'}[field];
 if(field==='options'){values[label]=(after?value:state.options).map(o=>o.name+': '+o.value).join(' / ');continue;}
 if(['price','cost'].includes(field)){const amount=after?value:state[field];values[label]=amount?.amountMinor!==undefined?money.format(amount.amountMinor,amount.currency):amount?.amount_minor!=null?money.format(Number(amount.amount_minor),amount.currency):'Not set';}
 else if(field==='supplier'){const before=state.suppliers.find(s=>Number(s.is_active)&&Number(s.is_preferred));values[label]=after?value.name:before?.supplier_name||'Not linked';if(value.lastUnitCost!==undefined)values['Supplier cost']=after?money.format(money.toMinor(value.lastUnitCost,value.currency),value.currency):before?.last_unit_cost==null?'Not set':money.format(money.toMinor(before.last_unit_cost,before.currency),before.currency);}
 else if(field==='reorder')values[label]=after?value.reorderPoint:state.policies.find(p=>p.location_id===(value.locationId||null))?.reorder_point??'Not set';
 else values[label]=(after?value:state[field])||'Not set';
 }return values;}
async function owner(c,ctx){if((await c.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0]?.role!=='owner')throw new ValidationError('Only an owner can approve variant changes.');}
async function rows(c,ctx,itemId,ids){
 const result=(await c.query(`SELECT s.id,s.item_id,s.code,s.barcode,s.variant_label,s.is_active,
 coalesce((SELECT json_agg(json_build_object('id',o.id,'name',o.name,'value',v.value) ORDER BY o.position,o.id) FROM item_options o JOIN sku_option_values v ON v.option_id=o.id AND v.sku_id=s.id WHERE o.workspace_id=s.workspace_id AND o.item_id=s.item_id),'[]') AS options,
 (SELECT row_to_json(p) FROM(SELECT id,amount_minor,currency FROM sku_prices WHERE workspace_id=$1 AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p) AS price,
 (SELECT row_to_json(p) FROM(SELECT id,amount_minor,currency FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p) AS cost,
 coalesce((SELECT json_agg(p ORDER BY p.id) FROM(SELECT si.*,su.name AS supplier_name,su.currency FROM supplier_items si JOIN suppliers su ON su.workspace_id=si.workspace_id AND su.id=si.supplier_id WHERE si.workspace_id=$1 AND si.sku_id=s.id)p),'[]') AS suppliers,
 coalesce((SELECT json_agg(p ORDER BY p.id) FROM reorder_policies p WHERE p.workspace_id=$1 AND p.sku_id=s.id),'[]') AS policies
 FROM skus s WHERE s.workspace_id=$1 AND s.item_id=$2 AND ($3::text[] IS NULL OR s.id=ANY($3)) ORDER BY s.position,s.id LIMIT 1001`,[ctx.workspaceId,itemId,ids||null])).rows;
 if(result.length>1000)throw new ValidationError('Review at most 1,000 variants in one batch. Select a smaller group.');
 return result.map(r=>({...r,version:hash(r)}));
}
async function prepare(db,ctx,itemId,input){return db.transaction(async c=>{
 await owner(c,ctx);const supplied=Array.isArray(input.rows)?input.rows:Object.values(input.rows||{});
 if(!supplied.length||supplied.length>1000||new Set(supplied.map(r=>r.skuId)).size!==supplied.length)throw new ValidationError('Choose up to 1,000 different variants.');
 const current=await rows(c,ctx,itemId,supplied.map(r=>r.skuId));if(current.length!==supplied.length)throw new NotFoundError('Every variant must belong to this product and inventory.');
 const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.base_currency||'USD',changes=[];
 for(const raw of supplied){const before=current.find(r=>r.id===raw.skuId);if(before.version!==raw.version)throw new ValidationError('A variant changed while this page was open. Reload before preparing changes.');
  const after={};
  if(raw.optionValues!==undefined){if(!raw.optionValues||typeof raw.optionValues!=='object'||Array.isArray(raw.optionValues)||Object.keys(raw.optionValues).some(id=>!before.options.some(o=>o.id===id)))throw new ValidationError('Choose option values belonging to this product.');const options=before.options.map(o=>({...o,value:Object.hasOwn(raw.optionValues,o.id)?requireText(raw.optionValues[o.id],o.name,{max:120}):o.value}));if(options.some((o,i)=>o.value!==before.options[i].value))after.options=options;}
  if(raw.code!==undefined&&raw.code!==before.code)after.code=requireText(raw.code,'SKU',{max:120});
  if(raw.barcode!==undefined&&String(raw.barcode||'')!==String(before.barcode||'')){after.barcode=String(raw.barcode||'').trim();if(after.barcode.length>240||/[\x00-\x1f\x7f]/.test(after.barcode))throw new ValidationError('Use a printable barcode of at most 240 characters.');}
  for(const [field,state] of [['price','price'],['cost','cost']])if(raw[field]!==undefined&&String(raw[field]).trim()!==''){const amountMinor=money.toMinor(raw[field],currency,{label:field==='price'?'Selling price':'Purchase cost'});if(Number(before[state]?.amount_minor)!==amountMinor||before[state]?.currency!==currency)after[field]={amountMinor,currency};}
  if(raw.reorderPoint!==undefined&&String(raw.reorderPoint).trim()!==''){const value=require('./exact-quantity').safeNumber(raw.reorderPoint,{label:'Reorder point'});if(value<0)throw new ValidationError('Reorder point cannot be negative.');const prior=before.policies.find(p=>p.location_id===(raw.locationId||null));if(Number(prior?.reorder_point)!==value||!prior)after.reorder={reorderPoint:value,locationId:raw.locationId||null};}
  if(raw.supplierId){const supplier=(await c.query("SELECT id,name,currency FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,raw.supplierId])).rows[0];if(!supplier)throw new ValidationError('Choose an active supplier from this inventory.');const link=before.suppliers.find(s=>s.supplier_id===supplier.id&&Number(s.is_active));
   const supplierCost=String(raw.supplierCost??'').trim()===''?null:money.toMinor(raw.supplierCost,supplier.currency,{label:'Supplier cost'});
   if(!link||!Number(link.is_preferred)||supplierCost!==null&&money.toMinor(link.last_unit_cost,supplier.currency,{optional:true})!==supplierCost)after.supplier={supplierId:supplier.id,name:supplier.name,currency:supplier.currency,...(supplierCost===null?{}:{lastUnitCost:money.fromMinor(supplierCost,supplier.currency)})};
  }else if(String(raw.supplierCost??'').trim())throw new ValidationError('Choose a supplier before setting its cost.');
  if(Object.keys(after).length){if(!Number(before.is_active))throw new ValidationError('Restore archived variants before editing them.');changes.push({skuId:before.id,label:before.variant_label||before.code,code:before.code,version:before.version,before,after});}
 }
 if(!changes.length)throw new ValidationError('No variant values have changed.');await validateCombinations(c,ctx,itemId,changes);const payload={itemId,changes},id=newId('vchange'),integrityHash=hash(payload);
 await c.query('INSERT INTO variant_change_reviews(id,workspace_id,item_id,actor_id,payload,integrity_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,ctx.workspaceId,itemId,ctx.actorId,payload,integrityHash]);return {id,integrityHash,payload};
},{isolation:'SERIALIZABLE',retrySafe:true});}
async function get(db,ctx,id){const review=(await db.query('SELECT * FROM variant_change_reviews WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];if(!review)throw new NotFoundError('That variant review is unavailable.');return review;}
async function validateCombinations(c,ctx,itemId,changes){if(!changes.some(change=>change.after.options))return;const all=await rows(c,ctx,itemId),seen=new Set();for(const row of all){const options=changes.find(change=>change.skuId===row.id)?.after.options||row.options;if(!options.length)continue;const key=JSON.stringify(options.map(o=>[o.id,o.value.toLowerCase()]));if(seen.has(key))throw new ValidationError('Two variants cannot have the same option combination. Restore the existing variant or choose different values.');seen.add(key);}}
async function approve(db,ctx,id,integrityHash){return db.transaction(async c=>{
 await owner(c,ctx);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['catalog:'+ctx.workspaceId]);const review=(await c.query('SELECT * FROM variant_change_reviews WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
 if(!review||review.integrity_hash!==integrityHash||hash(review.payload)!==integrityHash)throw new ValidationError('This review changed. Open the current variant changes.');if(review.status==='COMPLETED')return {...review,replayed:true};if(review.status!=='PENDING')throw new ValidationError('This review is no longer awaiting approval.');
 const current=await rows(c,ctx,review.item_id,review.payload.changes.map(r=>r.skuId));for(const change of review.payload.changes)if(current.find(r=>r.id===change.skuId)?.version!==change.version)throw new ValidationError('A variant changed after review. Prepare a new batch before approving.');
 await validateCombinations(c,ctx,review.item_id,review.payload.changes);
 const prices=[],costs=[],reorder=[],suppliers=[];
 for(const change of review.payload.changes){const {after,before}=change;
  if(after.options){for(const option of after.options)await c.query('UPDATE sku_option_values SET value=$3 WHERE sku_id=$1 AND option_id=$2',[change.skuId,option.id,option.value]);await c.query('UPDATE skus SET variant_label=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,change.skuId,after.options.map(o=>o.value).join(' / ')]);}
  if(after.code){if((await c.query('SELECT 1 FROM skus WHERE workspace_id=$1 AND id<>$2 AND lower(code)=lower($3)',[ctx.workspaceId,change.skuId,after.code])).rows.length)throw new ValidationError('Another variant already uses SKU '+after.code+'.');await c.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,change.skuId,after.code]);}
  if(Object.hasOwn(after,'barcode'))await require('./postgres-sku-maintenance').update({query:(...args)=>c.query(...args),transaction:fn=>fn(c)},ctx,review.item_id,change.skuId,{barcode:after.barcode,expectedBarcode:before.barcode||''});
  if(after.price)prices.push({skuId:change.skuId,...after.price,expectedCurrentId:before.price?.id||null,source:'owner',sourceDetail:{variantReviewId:id}});
  if(after.cost)costs.push({skuId:change.skuId,...after.cost,source:'owner',sourceDetail:{variantReviewId:id}});
  if(after.reorder)reorder.push({skuId:change.skuId,...after.reorder});
  if(after.supplier){suppliers.push({skuId:change.skuId,supplierId:after.supplier.supplierId,isPreferred:true,...(after.supplier.lastUnitCost===undefined?{}:{lastUnitCost:after.supplier.lastUnitCost})});for(const policy of before.policies.length?before.policies:[{location_id:null}])reorder.push({skuId:change.skuId,locationId:policy.location_id,preferredSupplierId:after.supplier.supplierId});}
  await require('./postgres-sku-maintenance').history(c,ctx,{id:change.skuId,item_id:review.item_id},'variant_batch',auditValues(change,false),auditValues(change,true));
 }
 await require('../pricing/postgres-service').setPricesInTransaction(c,ctx,prices);await require('../pricing/postgres-service').setPurchaseCostsInTransaction(c,ctx,costs);
 await require('../operations/postgres-reorder-policies').setManyInTransaction(c,ctx,reorder);await require('../operations/postgres-commerce').linkSupplierItemsInTransaction(c,ctx,suppliers);
 await c.query("UPDATE variant_change_reviews SET status='COMPLETED',approved_at=now(),approved_by_user_id=$3 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,ctx.actorId]);return {id,replayed:false};
},{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={rows,prepare,get,approve,auditValues};

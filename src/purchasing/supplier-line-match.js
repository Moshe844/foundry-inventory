'use strict';
const normalize=value=>String(value??'').trim().toLocaleLowerCase().replace(/\s+/g,' ');
function matchLine(lines,proposed){
 const keys=[proposed.purchaseOrderLineId,proposed.skuId,proposed.supplierSku,proposed.sku,proposed.skuCode].filter(Boolean).map(normalize);
 const coded=lines.filter(line=>[line.id,line.sku_id,line.supplier_sku,line.mapped_supplier_sku,line.sku_code,line.code].filter(Boolean).some(value=>keys.includes(normalize(value))));
 if(coded.length)return coded.length===1?coded[0]:null;
 if(keys.length)return null;
 const description=normalize(proposed.description||proposed.displayName||proposed.name);if(!description)return null;
 const described=lines.filter(line=>[line.description,line.item_name,line.name,line.variant_label?`${line.item_name} / ${line.variant_label}`:null].filter(Boolean).some(value=>normalize(value)===description));
 return described.length===1?described[0]:null;
}
module.exports={matchLine};

'use strict';

const {hash}=require('../pricing/postgres-promotions');
const {normalized}=require('./document-target-proof');
const {ValidationError}=require('../domain/errors');

const orders={
  purchase_order:{table:'purchase_orders',reference:'po_number',party:'supplier_id',partyKind:'supplier'},
  sales_order:{table:'sales_orders',reference:'order_number',party:'customer_id',partyKind:'customer'}
};

async function orderTarget(db,workspaceId,kind,value,origin){
  const type=orders[kind];
  const rows=(await db.query(`SELECT id,${type.reference} AS reference,${type.party} AS party_id,status
    FROM ${type.table} WHERE workspace_id=$1 AND lower(btrim(${type.reference}))=$2 ORDER BY id FOR SHARE`,
    [workspaceId,normalized(value)])).rows;
  if(rows.length!==1)return null;
  const row=rows[0];
  if(origin?.partyKind&&(origin.partyKind!==type.partyKind||origin.partyId!==row.party_id))return null;
  return {id:row.id,reference:row.reference,kind,identity:hash([row.id,row.reference,row.party_id]),
    inactive:['CANCELLED','CANCELED','VOID'].includes(String(row.status).toUpperCase())};
}

async function productTarget(db,workspaceId,value,origin){
  const rows=(await db.query(`SELECT i.id,i.base_code,i.name,i.is_active AS item_active,s.id AS sku_id,s.code,s.is_active
    FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE i.workspace_id=$1
    AND (lower(btrim(s.code))=$2 OR lower(btrim(i.base_code))=$2 OR s.id IN(
      SELECT sku_id FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$3 AND is_active=1 AND lower(btrim(supplier_sku))=$2))
    ORDER BY i.id,s.id FOR SHARE OF i,s`,
    [workspaceId,normalized(value),origin?.partyKind==='supplier'?origin.partyId:null])).rows;
  if(!rows.length||new Set(rows.map(row=>row.id)).size!==1)return null;
  const skuIds=rows.map(row=>row.sku_id);
  const supplierLinks=origin?.partyKind==='supplier'?(await db.query(`SELECT sku_id,supplier_sku FROM supplier_items
    WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=ANY($3::text[]) AND is_active=1 FOR SHARE`,
    [workspaceId,origin.partyId,skuIds])).rows:[];
  const exactSkus=rows.filter(row=>normalized(row.code)===normalized(value)||supplierLinks.some(link=>
    link.sku_id===row.sku_id&&normalized(link.supplier_sku||'')===normalized(value)));
  if(exactSkus.length>1)return null;
  const matches=exactSkus.length?exactSkus:rows;
  if(origin?.partyKind){
    const related=origin.partyKind==='supplier'?supplierLinks:
      (await db.query(`SELECT l.sku_id FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id
        WHERE l.workspace_id=$1 AND o.customer_id=$2 AND l.sku_id=ANY($3::text[]) FOR SHARE OF l,o`,[workspaceId,origin.partyId,skuIds])).rows;
    if(!matches.every(row=>related.some(line=>line.sku_id===row.sku_id)))return null;
  }
  const row=matches[0];
  return {id:row.id,kind:'item',reference:exactSkus.length===1?row.code:row.base_code,
    identity:hash([row.id,row.base_code,matches.map(x=>[x.sku_id,x.code,supplierLinks.find(link=>link.sku_id===x.sku_id)?.supplier_sku||null])]),
    inactive:!row.item_active||matches.some(x=>!x.is_active)};
}

async function resolve(db,workspaceId,kind,value,origin){
  if(kind==='item')return productTarget(db,workspaceId,value,origin);
  if(Object.hasOwn(orders,kind))return orderTarget(db,workspaceId,kind,value,origin);
  throw new ValidationError('Choose a purchase order, customer order or product.');
}
module.exports={resolve};

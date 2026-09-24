'use strict';

const TYPE_LABEL={item:'Product',sku:'Product',variant:'Variant',serial:'Unit',lot:'Batch',location:'Location',
  supplier:'Supplier',purchase_order:'Purchase order',customer:'Customer',sales_order:'Sales order'};

async function search(database,workspaceId,rawTerm,{limit=25}={}){
  const term=String(rawTerm||'').trim();if(!term)return {term,results:[],total:0};
  const result=await database.query(`WITH matches AS (
    SELECT CASE WHEN sku.variant_label IS NULL OR sku.variant_label='' THEN 'sku' ELSE 'variant' END AS type,
      sku.id,CASE WHEN sku.variant_label IS NULL OR sku.variant_label='' THEN item.name ELSE item.name||' / '||sku.variant_label END AS title,
      CASE WHEN sku.variant_label IS NULL OR sku.variant_label='' THEN 'Product · '||sku.code ELSE 'Variant · '||sku.code END AS subtitle,
      COALESCE((SELECT SUM(balance.on_hand) FROM balances balance WHERE balance.workspace_id=$1 AND balance.sku_id=sku.id),0)::text||' on hand' AS meta,
      '/inventory/'||item.id||'#sku-'||sku.id AS href,
      CASE WHEN lower(sku.code)=lower($2) THEN 120 WHEN lower(item.name)=lower($2) THEN 110
        WHEN lower(COALESCE(sku.variant_label,''))=lower($2) THEN 105 WHEN sku.code ILIKE $2||'%' THEN 90 ELSE 60 END AS score
    FROM skus sku JOIN items item ON item.id=sku.item_id WHERE sku.workspace_id=$1 AND sku.is_active=1 AND item.is_active=1
      AND (sku.code ILIKE '%'||$2||'%' OR item.name ILIKE '%'||$2||'%' OR COALESCE(sku.variant_label,'') ILIKE '%'||$2||'%')
    UNION ALL
    SELECT 'serial',unit.id,unit.serial,item.name||' · '||sku.code,
      CASE WHEN unit.status='in_stock' THEN COALESCE(location.name,'Location missing') ELSE replace(unit.status,'_',' ') END,
      '/inventory/'||item.id||'#sku-'||sku.id,CASE WHEN lower(unit.serial)=lower($2) THEN 125 ELSE 75 END
    FROM serial_units unit JOIN skus sku ON sku.id=unit.sku_id JOIN items item ON item.id=sku.item_id
    LEFT JOIN locations location ON location.id=unit.location_id WHERE unit.workspace_id=$1 AND unit.serial ILIKE '%'||$2||'%'
    UNION ALL
    SELECT 'lot',lot.id,lot.code,item.name||' · '||sku.code,
      COALESCE((SELECT SUM(lot_balance.quantity) FROM lot_balances lot_balance WHERE lot_balance.workspace_id=$1 AND lot_balance.lot_id=lot.id),0)::text||' on hand',
      '/inventory/'||item.id||'#sku-'||sku.id,CASE WHEN lower(lot.code)=lower($2) THEN 125 ELSE 75 END
    FROM lots lot JOIN skus sku ON sku.id=lot.sku_id JOIN items item ON item.id=sku.item_id
    WHERE lot.workspace_id=$1 AND lot.code ILIKE '%'||$2||'%'
    UNION ALL
    SELECT 'location',location.id,location.name,CASE WHEN location.is_active=1 THEN 'Location' ELSE 'Location · archived' END,
      COALESCE((SELECT SUM(balance.on_hand) FROM balances balance WHERE balance.workspace_id=$1 AND balance.location_id=location.id),0)::text||' on hand',
      '/locations#location-'||location.id,CASE WHEN lower(location.name)=lower($2) THEN 115 ELSE 55 END
    FROM locations location WHERE location.workspace_id=$1 AND location.name ILIKE '%'||$2||'%'
    UNION ALL
    SELECT 'supplier',supplier.id,supplier.name,'Supplier'||CASE WHEN supplier.code IS NULL THEN '' ELSE ' · '||supplier.code END,
      replace(supplier.status,'_',' '),'/suppliers/'||supplier.id,CASE WHEN lower(supplier.name)=lower($2) OR lower(COALESCE(supplier.code,''))=lower($2) THEN 115 ELSE 55 END
    FROM suppliers supplier WHERE supplier.workspace_id=$1 AND (supplier.name ILIKE '%'||$2||'%' OR COALESCE(supplier.code,'') ILIKE '%'||$2||'%')
    UNION ALL
    SELECT 'purchase_order',purchase.id,purchase.po_number,'Purchase order · '||supplier.name,replace(purchase.status,'_',' '),
      '/purchasing/orders/'||purchase.id,CASE WHEN lower(purchase.po_number)=lower($2) THEN 125 ELSE 65 END
    FROM purchase_orders purchase JOIN suppliers supplier ON supplier.id=purchase.supplier_id
    WHERE purchase.workspace_id=$1 AND (purchase.po_number ILIKE '%'||$2||'%' OR supplier.name ILIKE '%'||$2||'%')
    UNION ALL
    SELECT 'customer',customer.id,customer.name,'Customer',replace(customer.record_state,'_',' '),
      '/sales/customers/'||customer.id,CASE WHEN lower(customer.name)=lower($2) THEN 115 ELSE 55 END
    FROM customers customer WHERE customer.workspace_id=$1 AND customer.name ILIKE '%'||$2||'%'
    UNION ALL
    SELECT 'sales_order',sales.id,sales.order_number,'Sales order · '||customer.name,replace(sales.status,'_',' '),
      '/sales/orders/'||sales.id,CASE WHEN lower(sales.order_number)=lower($2) THEN 125 ELSE 65 END
    FROM sales_orders sales JOIN customers customer ON customer.id=sales.customer_id
    WHERE sales.workspace_id=$1 AND (sales.order_number ILIKE '%'||$2||'%' OR customer.name ILIKE '%'||$2||'%')
  ) SELECT * FROM matches ORDER BY score DESC,title,id LIMIT $3`,[workspaceId,term,Math.min(100,Math.max(1,Number(limit)||25))]);
  const results=result.rows.map((row)=>({...row,typeLabel:TYPE_LABEL[row.type]||row.type,score:Number(row.score)}));
  return {term,results,total:results.length};
}

module.exports={TYPE_LABEL,search};

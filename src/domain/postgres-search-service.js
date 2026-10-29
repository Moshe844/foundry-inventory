'use strict';

const TYPE_LABEL={item:'Product',sku:'Product',variant:'Variant',serial:'Unit',lot:'Batch',location:'Location',
  supplier:'Supplier',purchase_order:'Purchase order',customer:'Customer',sales_order:'Sales order'};

async function search(database,workspaceId,rawTerm,{limit=25,groupLimit=null}={}){
  const term=String(rawTerm||'').trim().slice(0,200),short=compactReference(term);if(!term)return {term,results:[],total:0};
  const boundedLimit=Math.min(100,Math.max(1,Number(limit)||25));
  // An exact SKU is authoritative independently of broad text discovery. Do
  // the indexed lookup first so a common word never requires ranking every
  // matching product (and aggregating all its stock) to find the exact code.
  const exactRows=(await database.query(`SELECT CASE WHEN COALESCE(s.variant_label,'')='' THEN 'sku' ELSE 'variant' END AS type,
    s.id,CASE WHEN COALESCE(s.variant_label,'')='' THEN i.name ELSE i.name||' / '||s.variant_label END AS title,
    CASE WHEN COALESCE(s.variant_label,'')='' THEN 'Product · ' ELSE 'Variant · ' END||s.code AS subtitle,
    COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.workspace_id=$1 AND b.sku_id=s.id),0)::text||' on hand' AS meta,
    '/inventory/'||i.id||'#sku-'||s.id AS href,120 AS score
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND lower(s.code)=lower($2)
    ORDER BY s.id LIMIT $3`,[workspaceId,term,Math.max(2,boundedLimit)])).rows;
  if(exactRows.length){const results=exactRows.slice(0,boundedLimit).map(row=>({...row,typeLabel:TYPE_LABEL[row.type]}));
    return {term,results,total:results.length,exactSku:exactRows.length===1};}
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
    WHERE purchase.workspace_id=$1 AND (purchase.po_number ILIKE '%'||$2||'%' OR lower(regexp_replace(purchase.po_number,'(^[A-Za-z]+[- ]*)0+','\\1'))=lower($4) OR supplier.name ILIKE '%'||$2||'%')
    UNION ALL
    SELECT 'customer',customer.id,customer.name,'Customer',replace(customer.record_state,'_',' '),
      '/sales/customers/'||customer.id,CASE WHEN lower(customer.name)=lower($2) THEN 115 ELSE 55 END
    FROM customers customer WHERE customer.workspace_id=$1 AND customer.name ILIKE '%'||$2||'%'
    UNION ALL
    SELECT 'sales_order',sales.id,sales.order_number,'Sales order · '||customer.name,
      CASE WHEN sales.status='CANCELLED' AND EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=sales.workspace_id AND l.sales_order_id=sales.id AND l.quantity_fulfilled>0) THEN 'Partly '||(CASE WHEN sales.delivery_method='PICKUP' THEN 'collected' ELSE 'shipped' END)||' · remainder cancelled'
      WHEN sales.status='FULFILLED' AND sales.delivery_method='PICKUP' THEN 'Collected'
      ELSE initcap(replace(sales.status,'_',' ')) END,
      '/sales/orders/'||sales.id,CASE WHEN lower(sales.order_number)=lower($2) THEN 125 ELSE 65 END
    FROM sales_orders sales JOIN customers customer ON customer.id=sales.customer_id
    WHERE sales.workspace_id=$1 AND (sales.order_number ILIKE '%'||$2||'%' OR lower(regexp_replace(sales.order_number,'(^[A-Za-z]+[- ]*)0+','\\1'))=lower($4) OR customer.name ILIKE '%'||$2||'%')
  ), ranked AS (SELECT matches.*,row_number() OVER (PARTITION BY type ORDER BY score DESC,title,id) AS group_position FROM matches) SELECT * FROM ranked WHERE ($5::int IS NULL OR group_position<=$5) ORDER BY score DESC,title,id LIMIT $3`,[workspaceId,term,Math.min(100,Math.max(1,Number(limit)||25)),short,groupLimit==null?null:Math.min(100,Math.max(1,Number(groupLimit)||8))]);
  if(result.rows.length<limit&&term.length>=4){const near=(await database.query(`WITH item_matches AS MATERIALIZED (
 SELECT id,GREATEST(similarity(name,$2),word_similarity($2,name)) AS relevance FROM items
 WHERE workspace_id=$1 AND is_active=1 AND (name % $2 OR $2 <% name)
 ORDER BY relevance DESC,id LIMIT 100), code_matches AS MATERIALIZED (
 SELECT id,similarity(code,$2) AS relevance FROM skus WHERE workspace_id=$1 AND is_active=1 AND code % $2
 ORDER BY relevance DESC,id LIMIT 100), candidates AS (
 SELECT s.id,m.relevance FROM item_matches m CROSS JOIN LATERAL(SELECT id FROM skus
  WHERE workspace_id=$1 AND item_id=m.id AND is_active=1 ORDER BY id LIMIT 100)s
 UNION ALL SELECT id,relevance FROM code_matches), ranked AS (
 SELECT id,max(relevance) AS relevance FROM candidates GROUP BY id ORDER BY max(relevance) DESC,id LIMIT 300)
 SELECT s.id,'sku' AS type,i.name AS title,'Product · '||s.code AS subtitle,'' AS meta,
 '/inventory/'||i.id||'#sku-'||s.id AS href,s.code FROM ranked r JOIN skus s ON s.id=r.id AND s.workspace_id=$1
 JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id WHERE i.is_active=1
 ORDER BY r.relevance DESC,s.id`,[workspaceId,term])).rows;const known=new Set(result.rows.map(r=>r.id));for(const r of near){const distance=Math.min(editDistance(term.toLowerCase(),r.title.toLowerCase()),editDistance(term.toLowerCase(),r.code.toLowerCase()),...r.title.toLowerCase().split(/\s+/).map(word=>editDistance(term.toLowerCase(),word)));if(distance<=Math.min(2,Math.floor(term.length/4))&&!known.has(r.id)){result.rows.push({...r,score:40-distance});known.add(r.id);}}result.rows.sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title));result.rows=result.rows.slice(0,limit);}
  const results=result.rows.map((row)=>({...row,typeLabel:TYPE_LABEL[row.type]||row.type,score:Number(row.score)}));
  const exact=results.filter(row=>['sku','variant'].includes(row.type)&&row.score===120);
  return {term,results:exact.length?exact:results,total:exact.length||results.length,exactSku:exact.length===1};
}

function compactReference(value){const m=/^([a-z]+)[- ]*([0-9]+)$/i.exec(value);return m?m[1]+'-'+m[2].replace(/^0+(?=\d)/,''):value;}
function editDistance(a,b){if(Math.abs(a.length-b.length)>2)return 3;let prior=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const row=[i];for(let j=1;j<=b.length;j++)row[j]=Math.min(row[j-1]+1,prior[j]+1,prior[j-1]+(a[i-1]===b[j-1]?0:1));prior=row;}return prior[b.length];}
module.exports={TYPE_LABEL,search,compactReference,editDistance};

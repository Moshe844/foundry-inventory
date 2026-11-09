'use strict';
const money=require('./currency');
const currencyDigits=JSON.stringify(Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)])));
function range(min,max,currency){return min===max?money.format(min,currency):money.format(min,currency)+'–'+money.format(max,currency);}
// A supplier's last cost is a decimal price; round it to whole minor units like
// every other cost here, or the page cannot format a value such as 210.0000.
async function summary(db,workspaceId,itemId){
 const rows=(await db.query(`WITH quoted AS MATERIALIZED (
 SELECT s.id,p.amount_minor AS price,p.currency AS price_currency,
 coalesce(c.amount_minor,round(supplier.last_unit_cost*power(10,coalesce(($3::jsonb->>supplier.currency)::int,2))),stock.amount_minor) AS cost,
 coalesce(c.currency,supplier.currency,stock.currency) AS cost_currency
 FROM skus s
 LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=$1 AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)p ON true
 LEFT JOIN LATERAL(SELECT amount_minor,currency FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)c ON true
 LEFT JOIN LATERAL(SELECT si.last_unit_cost,su.currency FROM supplier_items si JOIN suppliers su ON su.id=si.supplier_id AND su.workspace_id=si.workspace_id WHERE si.workspace_id=$1 AND si.sku_id=s.id AND si.is_active=1 AND si.last_unit_cost IS NOT NULL ORDER BY si.is_preferred DESC,si.last_cost_at DESC,si.updated_at DESC LIMIT 1)supplier ON c.amount_minor IS NULL
 LEFT JOIN LATERAL(SELECT round(sum(b.total_cost_minor)::numeric/nullif(sum(CASE WHEN i.secondary_unit_label IS NOT NULL THEN b.secondary_quantity_units ELSE b.quantity_units END),0)) AS amount_minor,a.base_currency AS currency FROM accounting_inventory_cost_balances b JOIN accounting_settings a ON a.workspace_id=b.workspace_id JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id WHERE b.workspace_id=$1 AND b.sku_id=s.id AND b.quantity_units>0 GROUP BY a.base_currency)stock ON c.amount_minor IS NULL AND supplier.last_unit_cost IS NULL
 WHERE s.workspace_id=$1 AND s.item_id=$2 AND s.is_active=1
 ), amounts AS (
 SELECT 'price' AS kind,price_currency AS currency,price AS amount FROM quoted WHERE price IS NOT NULL
 UNION ALL SELECT 'cost',cost_currency,cost FROM quoted WHERE cost IS NOT NULL
 UNION ALL SELECT 'profit',price_currency,price-cost FROM quoted WHERE price IS NOT NULL AND cost IS NOT NULL AND price_currency=cost_currency
 UNION ALL SELECT 'margin',price_currency,round((price::numeric-cost::numeric)*100/price::numeric,1) FROM quoted WHERE price>0 AND cost IS NOT NULL AND price_currency=cost_currency
 ) SELECT kind,currency,min(amount)::text AS minimum,max(amount)::text AS maximum,count(*)::int AS recorded,(SELECT count(*)::int FROM quoted) AS variants FROM amounts GROUP BY kind,currency`,[workspaceId,itemId,currencyDigits])).rows;
 const percent=n=>Number(n).toFixed(1).replace(/\.0$/,'')+'%';
 const label=kind=>{const values=rows.filter(r=>r.kind===kind);return values.map(r=>(kind==='margin'?(r.minimum===r.maximum?percent(r.minimum):percent(r.minimum)+'–'+percent(r.maximum))+(values.length>1?' '+r.currency:''):range(Number(r.minimum),Number(r.maximum),r.currency))+(r.recorded<r.variants?' ('+r.recorded+' of '+r.variants+' variants)':'')).join(' · ')||'Not set';};
 return {priceLabel:label('price'),costLabel:label('cost'),profitLabel:label('profit'),marginLabel:label('margin')};
}
module.exports={summary,range};

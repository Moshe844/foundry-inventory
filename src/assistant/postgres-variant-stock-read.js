'use strict';
// Read-only discovery. Option names and values come from each product's own
// configuration. Single-character values and numeric values remain exact
// words, so L cannot match XL and 9 cannot match 19.
async function read(db,workspaceId,subject){
 const words=[...new Set(String(subject||'').toLocaleLowerCase().match(/[\p{L}\p{N}]+(?:\.[\p{N}]+)?[\p{L}\p{N}]*/gu)||[])].filter(w=>!['the','my','our','units','unit','of'].includes(w));
 if(!words.length||words.length>16)return null;
 const patterns=words.map(w=>'(^|[^[:alnum:]])'+w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'([^[:alnum:]]|$)');
 // Codes and barcodes use their existing indexes. Do not compile the costly
 // option-word discovery plan for a question already identifying exact SKUs.
 const exact=(await db.query(`
 SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND (lower(s.code)=lower($2) OR lower(s.barcode)=lower($2))`,[workspaceId,String(subject).trim()])).rows;
 const filter=exact.length?'s.id=ANY($2::text[])':`NOT EXISTS(
 SELECT 1 FROM unnest($2::text[]) term(pattern) WHERE NOT(
 lower(concat_ws(' ',i.name,s.code,s.barcode,s.variant_label))~term.pattern OR EXISTS(
 SELECT 1 FROM sku_option_values v JOIN item_options o ON o.workspace_id=s.workspace_id AND o.id=v.option_id WHERE v.sku_id=s.id AND lower(o.name)~term.pattern)))`;
 const result=(await db.query(`WITH matching AS MATERIALIZED(
 SELECT s.id,s.item_id,s.code,s.variant_label,i.name,i.unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ${filter}),
 positions AS MATERIALIZED(SELECT m.*,b.on_hand,l.name AS location FROM matching m LEFT JOIN balances b ON b.workspace_id=$1 AND b.sku_id=m.id LEFT JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id),
 totals AS(SELECT unit_label,sum(coalesce(on_hand,0)) AS quantity FROM positions GROUP BY unit_label),
 page AS(SELECT * FROM positions ORDER BY name,code,location LIMIT 101)
 SELECT (SELECT count(*)::int FROM matching) AS sku_count,(SELECT count(*)::int FROM positions) AS position_count,
 coalesce((SELECT jsonb_agg(totals) FROM totals),'[]') AS totals,coalesce((SELECT jsonb_agg(page) FROM page),'[]') AS positions`,[workspaceId,exact.length?exact.map(s=>s.id):patterns])).rows[0];
 if(!result.sku_count)return null;
 const rows=result.positions.slice(0,100).map(r=>({product:r.name,variant:r.variant_label||'',sku:r.code,location:r.location||'No stock received',onHand:Number(r.on_hand||0),unit:r.unit_label,href:'/inventory/'+r.item_id+'#sku-'+r.id})),totals=result.totals.map(r=>({unit:r.unit_label,quantity:Number(r.quantity)}));
 return {rows,totals,skuCount:result.sku_count,positionCount:result.position_count,complete:result.position_count<=100};
}
module.exports={read};

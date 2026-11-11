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
 const result=(await db.query(`WITH RECURSIVE matching AS MATERIALIZED(
 SELECT s.id,s.item_id,s.code,s.variant_label,i.name,i.unit_label,i.secondary_unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND ${filter}),
 positions AS MATERIALIZED(
 SELECT m.*,b.on_hand::text,b.secondary_on_hand::text,l.name AS location,l.id AS location_id,
 CASE a.kind WHEN 'CONSIGN_IN' THEN 'Supplier-owned consignment' WHEN 'CONSIGN_OUT' THEN 'Customer consignment'
   WHEN 'RENTAL' THEN 'Rental custody' ELSE 'On hand' END AS holding
 FROM matching m LEFT JOIN balances b ON b.workspace_id=$1 AND b.sku_id=m.id
 LEFT JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
 LEFT JOIN custody_agreements a ON a.workspace_id=l.workspace_id AND a.id=l.custody_agreement_id
 UNION ALL
 SELECT m.*,sum(t.shipped_quantity-t.received_quantity-t.lost_quantity-t.damaged_quantity)::text,
 sum(t.shipped_secondary_quantity-t.received_secondary_quantity-t.lost_secondary_quantity-t.damaged_secondary_quantity)::text,
 l.name,l.id,'In transit'
 FROM matching m JOIN inventory_transfer_lines t ON t.workspace_id=$1 AND t.sku_id=m.id
 JOIN inventory_transfers h ON h.workspace_id=t.workspace_id AND h.id=t.transfer_id
 JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.destination_location_id
 WHERE h.status IN ('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')
 AND t.shipped_quantity>t.received_quantity+t.lost_quantity+t.damaged_quantity
 GROUP BY m.id,m.item_id,m.code,m.variant_label,m.name,m.unit_label,m.secondary_unit_label,l.id,l.name),
 totals AS(SELECT unit_label,(sum(coalesce(on_hand::numeric,0)) FILTER (WHERE holding='On hand'))::text AS quantity
 FROM positions GROUP BY unit_label),
 page AS(SELECT * FROM positions ORDER BY name,code,location,holding,location_id LIMIT 101),
 ancestry AS (
  SELECT l.id AS location_id,l.parent_location_id,l.name AS label,ARRAY[l.id] AS visited
  FROM locations l JOIN (SELECT DISTINCT location_id FROM page) p ON p.location_id=l.id WHERE l.workspace_id=$1
  UNION ALL
  SELECT a.location_id,l.parent_location_id,l.name||' / '||a.label,a.visited||l.id
  FROM ancestry a JOIN locations l ON l.workspace_id=$1 AND l.id=a.parent_location_id WHERE NOT l.id=ANY(a.visited)
 ),
 paths AS (SELECT DISTINCT ON (location_id) location_id,label FROM ancestry ORDER BY location_id,cardinality(visited) DESC)
 SELECT (SELECT count(*)::int FROM matching) AS sku_count,(SELECT count(*)::int FROM positions) AS position_count,
 coalesce((SELECT jsonb_agg(totals) FROM totals),'[]') AS totals,
 coalesce((SELECT jsonb_agg(to_jsonb(page)||jsonb_build_object('location',coalesce(paths.label,page.location))
   ORDER BY page.name,page.code,page.location,page.holding,page.location_id)
   FROM page LEFT JOIN paths USING (location_id)),'[]') AS positions`,[workspaceId,exact.length?exact.map(s=>s.id):patterns])).rows[0];
 if(!result.sku_count)return null;
 const rows=result.positions.slice(0,100).map(r=>({product:r.name,variant:r.variant_label||'',sku:r.code,
  location:r.location||'No stock received',onHand:Number(r.on_hand||0),quantity:r.on_hand||'0',unit:r.unit_label,holding:r.holding,
  measured:r.secondary_on_hand!=null&&r.secondary_unit_label?r.secondary_on_hand+' '+r.secondary_unit_label:null,
  href:'/inventory/'+r.item_id+'#sku-'+r.id}));
 const totals=result.totals.map(r=>({unit:r.unit_label,quantity:Number(r.quantity||0),quantityText:r.quantity||'0'}));
 return {rows,totals,skuCount:result.sku_count,positionCount:result.position_count,complete:result.position_count<=100};
}

function present(stock,subject){
 const unitLabel=require('../lib/units').unitLabel;
 const amounts=stock.totals.map(t=>t.quantityText+' '+unitLabel(t.quantity,t.unit)).join(', ');
 const product=r=>r.product+(r.variant?' — '+r.variant:'');
 const places=stock.rows.map(r=>{
  const location=r.holding==='In transit'?'in transit to '+r.location:'at '+r.location;
  const custody=r.holding==='On hand'||r.holding==='In transit'?'':' ('+r.holding+')';
  return product(r)+' '+location+': '+r.quantity+(r.measured?' ('+r.measured+')':'')+custody;
 }).join(', ');
 const single=stock.skuCount===1,first=stock.rows[0];
 const lead=single?product(first)+' ('+first.sku+') has '+amounts+' on hand. ':
  'Recorded on hand: '+amounts+' across '+stock.skuCount+' matching variants. ';
 const mixed=stock.rows.some(r=>r.holding!=='On hand');
 return {answer:lead+places+(stock.complete?'.':'. The first 100 positions are listed. On-hand totals include all matching positions.'),
  rows:stock.rows,columns:['product','variant','sku','location',mixed?'quantity':'onHand','unit',
   ...(mixed?['holding']:[]),...(stock.rows.some(r=>r.measured)?['measured']:[])],
  extent:{complete:stock.complete,totalRows:stock.positionCount,returnedRows:stock.rows.length},
  ...(single?{carryForward:{directSku:first.sku}}:{}),
  handoff:{href:single?first.href:'/inventory/table?'+new URLSearchParams({q:subject}),label:'Review matching stock'}};
}
module.exports={read,present};

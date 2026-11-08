'use strict';

async function review(db,ctx,{filter,page}){
  const {rows}=await db.query(`WITH product AS (
    SELECT i.id,i.name,coalesce(i.base_code,'') AS code,f.category,f.facts::jsonb AS facts,
      nullif(lower(btrim(coalesce(f.facts::jsonb->>'brand',f.facts::jsonb->>'Brand'))),'') AS brand
    FROM items i LEFT JOIN catalogue_item_facts f ON f.workspace_id=i.workspace_id AND f.item_id=i.id
    WHERE i.workspace_id=$1 AND i.is_active=1
  ), peers AS (
    SELECT brand,min(btrim(category)) AS category,count(*)::int AS examples,count(DISTINCT lower(btrim(category))) AS categories
    FROM product WHERE brand IS NOT NULL AND nullif(btrim(category),'') IS NOT NULL GROUP BY brand
  ), selected AS (
    SELECT p.* FROM product p WHERE nullif(trim(p.category),'') IS NULL AND ($2='' OR lower(p.code)=lower($2) OR lower(p.name)=lower($2)
      OR EXISTS(SELECT 1 FROM skus s WHERE s.workspace_id=$1 AND s.item_id=p.id AND lower(s.code)=lower($2)))
    ORDER BY p.name,p.id LIMIT 101 OFFSET $3
  ) SELECT p.*,q.category AS peer_category,q.examples,q.categories AS peer_categories,source.categories,source.tags FROM selected p
    LEFT JOIN peers q ON q.brand=p.brand
    LEFT JOIN LATERAL (
      SELECT array_agg(DISTINCT trim(e.value) ORDER BY trim(e.value)) FILTER (WHERE lower(trim(e.key)) IN ('category','product category','product type','product_type')) AS categories,
        array_agg(DISTINCT trim(e.value) ORDER BY trim(e.value)) FILTER (WHERE lower(trim(e.key)) IN ('tag','tags','product tags','brand','material')) AS tags
      FROM skus s JOIN catalog_source_facts f ON f.workspace_id=s.workspace_id AND f.sku_id=s.id
      JOIN import_plans ip ON ip.workspace_id=f.workspace_id AND ip.id=f.source_import_id AND ip.approval_status='APPROVED' AND ip.status IN ('SUCCEEDED','PARTIAL')
      CROSS JOIN LATERAL jsonb_each_text(coalesce(f.attributes,jsonb_build_object(coalesce(f.name,''),f.value))) e
      WHERE s.workspace_id=$1 AND s.item_id=p.id AND length(trim(e.value)) BETWEEN 1 AND 240
    ) source ON true
    ORDER BY p.name,p.id`,[ctx.workspaceId,filter,(page-1)*100]);
  return {more:rows.length>100,summary:'Category suggestions use a recorded supplier category or agreement among previously classified products of the same brand. Tags come from recorded product details.',
    rows:rows.slice(0,100).map(r=>{
      const supplied=r.categories||[],consistent=r.examples>=2&&Number(r.peer_categories)===1;
      const category=supplied.length===1?supplied[0]:!supplied.length&&consistent?r.peer_category:null;
      const evidence=supplied.length===1?'Supplier category':supplied.length>1?'Supplier categories disagree':
        consistent?r.examples+' categorized products of the same brand':'More product evidence needed';
      const tags=new Set([r.facts?.brand??r.facts?.Brand,r.facts?.material??r.facts?.Material,...(r.tags||[])].filter(v=>typeof v==='string'&&v.trim()).flatMap(v=>v.split(',').map(t=>t.trim()).filter(Boolean)));
      return {Product:r.name,Code:r.code,'Suggested category':category,'Suggested tags':[...tags].join(', ')||null,Evidence:evidence,link:'/inventory/'+r.id};
    })};
}

module.exports={review};

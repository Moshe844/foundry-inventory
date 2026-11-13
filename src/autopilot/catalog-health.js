'use strict';

// The checks behind job 200's data health score, one row per active SKU.
// The first four are the original checks; the rest come from the inventory's
// own records: duplicate products, supplier links, reorder points, stock below
// zero and when stock was last counted.
const CHECKS=[
  {key:'code_ok',label:'Usable SKU',fix:'Fix the SKU: it is blank, has spaces, uses characters sales channels reject or repeats another SKU'},
  {key:'barcode_ok',label:'Unique barcode',fix:'Enter a unique barcode or resolve the duplicate'},
  {key:'cost_ok',label:'Purchase cost',fix:'Add the current purchase cost'},
  {key:'weight_ok',label:'Weight',fix:'Record the unit weight in grams'},
  {key:'unique_ok',label:'Not a duplicate',fix:'Merge the duplicate product'},
  {key:'supplier_ok',label:'Supplier',fix:'Link a supplier'},
  {key:'reorder_ok',label:'Reorder point',fix:'Set a reorder point'},
  {key:'stock_ok',label:'Stock not below zero',fix:'Count the stock shown below zero'},
  {key:'counted_ok',label:'Counted in the last year',fix:'Count the stock: not counted in the last year'}
];
const SAFE=require('../catalog/agent-catalog-fixes').SAFE_SQL;

// Stock counts: a count correction or an imported count. Stock that arrived
// within the year counts as recently counted.
const assessed=`WITH active AS MATERIALIZED (
    SELECT s.id,s.code,s.barcode,s.weight_grams,s.item_id,i.name,
      count(*) OVER(PARTITION BY lower(btrim(s.code))) AS same_code,
      count(*) OVER(PARTITION BY lower(btrim(s.barcode))) AS same_barcode,
      regexp_replace(lower(i.name),'[^[:alnum:]]+','','g') AS name_key,
      regexp_replace(lower(i.name),'[^[:alnum:]]+','','g')||chr(31)||regexp_replace(lower(coalesce(s.variant_label,'')),'[^[:alnum:]]+','','g')
        ||chr(31)||lower(btrim(i.unit_label))||chr(31)||i.tracking_mode||chr(31)||lower(coalesce(i.secondary_unit_label,'')) AS same_key
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
  ), named AS (
    SELECT same_key FROM active WHERE name_key<>'' GROUP BY same_key
    HAVING count(DISTINCT item_id)>1 AND count(DISTINCT lower(nullif(btrim(barcode),'')))<=1
  ), supplied AS (
    SELECT si.supplier_id,lower(btrim(si.supplier_sku)) AS code FROM supplier_items si JOIN active a ON a.id=si.sku_id
    WHERE si.workspace_id=$1 AND si.is_active=1 AND btrim(coalesce(si.supplier_sku,''))<>'' GROUP BY 1,2 HAVING count(DISTINCT si.sku_id)>1
  ), duplicated AS (
    SELECT a.id FROM active a JOIN named n ON n.same_key=a.same_key
    UNION SELECT si.sku_id FROM supplier_items si JOIN supplied d ON d.supplier_id=si.supplier_id AND d.code=lower(btrim(si.supplier_sku))
      WHERE si.workspace_id=$1 AND si.is_active=1
  ), below_zero AS (
    SELECT DISTINCT sku_id FROM balances WHERE workspace_id=$1 AND on_hand<0
  ), uncounted AS (
    SELECT DISTINCT b.sku_id
    FROM balances b JOIN active a ON a.id=b.sku_id
    JOIN LATERAL (
      SELECT stockchief_movement_instant(m.occurred_at) AS arrived
      FROM movements m WHERE m.workspace_id=b.workspace_id AND m.sku_id=b.sku_id AND m.location_id=b.location_id
      ORDER BY m.seq LIMIT 1
    ) first ON first.arrived<now()-interval '365 days'
    WHERE b.workspace_id=$1 AND b.on_hand>0
      AND NOT EXISTS(SELECT 1 FROM movements m WHERE m.workspace_id=b.workspace_id AND m.sku_id=b.sku_id AND m.location_id=b.location_id
        AND (m.operation='adjust' OR m.reason_code='file_physical_count') AND stockchief_movement_instant(m.occurred_at)>=now()-interval '365 days')
  ), checks AS (
    SELECT a.*,coalesce(a.code=btrim(a.code) AND a.code ~ '${SAFE}' AND a.same_code=1,false) AS code_ok,
      coalesce(length(btrim(a.barcode))>0 AND a.same_barcode=1,false) AS barcode_ok,
      EXISTS(SELECT 1 FROM sku_purchase_costs p WHERE p.workspace_id=$1 AND p.sku_id=a.id) AS cost_ok,
      coalesce(a.weight_grams>0,false) AS weight_ok,
      NOT EXISTS(SELECT 1 FROM duplicated d WHERE d.id=a.id) AS unique_ok,
      EXISTS(SELECT 1 FROM supplier_items si JOIN suppliers v ON v.workspace_id=si.workspace_id AND v.id=si.supplier_id AND v.status='active'
        WHERE si.workspace_id=$1 AND si.sku_id=a.id AND si.is_active=1) AS supplier_ok,
      EXISTS(SELECT 1 FROM reorder_policies r WHERE r.workspace_id=$1 AND r.sku_id=a.id AND r.reorder_point IS NOT NULL) AS reorder_ok,
      z.sku_id IS NULL AS stock_ok,
      un.sku_id IS NULL AS counted_ok
    FROM active a
    LEFT JOIN below_zero z ON z.sku_id=a.id
    LEFT JOIN uncounted un ON un.sku_id=a.id
  ), scores AS (SELECT c.*,${CHECKS.map(c=>'c.'+c.key+'::int').join('+')} AS passed FROM checks c)`;

// The whole score: active SKUs, and how many pass and fail each check.
async function score(db,workspaceId){
  const {rows:[t]}=await db.query(assessed+` SELECT count(*)::int AS products,coalesce(sum(passed),0)::bigint AS passed,
    ${CHECKS.map(c=>`count(*) FILTER(WHERE ${c.key})::int AS ${c.key}`).join(',')} FROM scores`,[workspaceId]);
  const n=t.products*CHECKS.length;
  return {products:t.products,passed:Number(t.passed),score:n?Math.round(Number(t.passed)*100/n):0,
    checks:CHECKS.map(c=>({key:c.key,passed:t[c.key],failed:t.products-t[c.key]}))};
}

async function findings(db,ctx,{page,filter}){
  const result=await db.query(assessed+`
    SELECT * FROM scores WHERE passed<${CHECKS.length} AND ($2='' OR lower(btrim(code))=lower($2) OR lower(name)=lower($2))
    ORDER BY passed,name,code,id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100]);
  return {more:result.rows.length>100,rows:result.rows.slice(0,100).map(r=>({Product:r.name,SKU:r.code,
    'Checks passed':r.passed+' of '+CHECKS.length,'What to fix':CHECKS.filter(c=>!r[c.key]).map(c=>c.fix).join('. '),
    link:'/inventory/'+r.item_id}))};
}

// The review behind the agent reviews list: the score and each product that needs work.
async function health(db,ctx,options){
  const s=await score(db,ctx.workspaceId);
  if(!s.products)return {rows:[],more:false,summary:'Add your first product to calculate a data health score.'};
  return {summary:'Data health: '+s.score+' of 100. '+s.passed+' of '+s.products*CHECKS.length+' checks passed across '+s.products+
    ' active SKUs. Each SKU is checked for a usable SKU, a unique barcode, a purchase cost, a weight, not being a duplicate, a supplier, a reorder point, stock not below zero and a count in the last year. Products needing work appear below.',
    ...await findings(db,ctx,options)};
}

module.exports={CHECKS,score,health,findings};

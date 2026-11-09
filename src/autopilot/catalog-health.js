'use strict';

const checks=[
  ['code_ok','Review the missing, ambiguous or malformed SKU'],
  ['barcode_ok','Enter a unique barcode or resolve the duplicate'],
  ['cost_ok','Add the current purchase cost'],
  ['weight_ok','Record the unit weight in grams']
];
const assessed=`WITH active AS (
    SELECT s.id,s.code,s.barcode,s.weight_grams,s.item_id,i.name,
      count(*) OVER(PARTITION BY lower(btrim(s.code))) AS same_code,
      count(*) OVER(PARTITION BY lower(btrim(s.barcode))) AS same_barcode
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
  ), checks AS (
    SELECT a.*,coalesce(a.code=btrim(a.code) AND length(a.code)>0 AND a.code !~ '[[:cntrl:]]' AND a.same_code=1,false) AS code_ok,
      coalesce(length(btrim(a.barcode))>0 AND a.same_barcode=1,false) AS barcode_ok,
      coalesce(p.amount_minor>=0,false) AS cost_ok,coalesce(a.weight_grams>0,false) AS weight_ok
    FROM active a LEFT JOIN LATERAL (SELECT amount_minor FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=a.id
      ORDER BY created_at DESC,id DESC LIMIT 1) p ON true
  ), scores AS (SELECT c.*,c.code_ok::int+c.barcode_ok::int+c.cost_ok::int+c.weight_ok::int AS passed FROM checks c)`;

async function findings(db,ctx,{page,filter}){
  const result=await db.query(assessed+`
    SELECT * FROM scores WHERE passed<4 AND ($2='' OR lower(btrim(code))=lower($2) OR lower(name)=lower($2))
    ORDER BY passed,name,code,id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100]);
  return {more:result.rows.length>100,rows:result.rows.slice(0,100).map(r=>({Product:r.name,SKU:r.code,
    'Checks passed':r.passed+' of 4','What to fix':checks.filter(([key])=>!r[key]).map(([,label])=>label).join('. '),
    link:'/inventory/'+r.item_id}))};
}

async function health(db,ctx,options){
  const {rows:[totals]}=await db.query(assessed+` SELECT count(*)::int AS products,coalesce(sum(passed),0)::bigint AS passed FROM scores`,[ctx.workspaceId]);
  if(!totals.products)return {rows:[],more:false,summary:'Add your first product to calculate a catalog health score.'};
  const n=totals.products*checks.length,score=Math.round(Number(totals.passed)*100/n);
  return {summary:'Catalog health: '+score+'%. '+totals.passed+' of '+n+' checks passed across '+totals.products+
    ' active SKUs. Each SKU is checked for a usable code, unique barcode, purchase cost and weight. Products needing work appear below.',
    ...await findings(db,ctx,options)};
}

module.exports={health,findings};

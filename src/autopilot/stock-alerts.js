'use strict';

// Job 166: low stock and stock-out alerts, alone on every plan.
//
// The routine check (operational-notices.refresh, run by the worker's
// autopilot.evaluate about every 15 minutes) raises one alert per stocking
// position and clears it when stock recovers:
//  - a position with a reorder point (one location, or the whole business)
//    alerts at or below that point;
//  - a stocked product with no reorder point alerts at or below the owner's own
//    alert level, when the owner saved one, and otherwise only when it runs out;
//  - a position the owner covered with their own per-product stock rule
//    (stock_threshold_rules) is left to that rule, so it never alerts twice.
// An alert that runs out turns from "Low stock" into "Out of stock" (a new
// alert); an alert that recovers clears. Products never stocked are not news.
//
// Alerts change nothing, so they appear in the app and in Needs you in every
// mode. Email goes through agent-alerts.js.

const {unitCount}=require('../lib/units');
const exact=require('../domain/exact-quantity');

const JOB=166,key='low-stock-alerts',path='/autopilot/reviews/'+key;

// Every position that is out of stock or at or below its alert level.
// $1 workspace, $2 an exact SKU or location name ('' for all).
const sql=`WITH active AS MATERIALIZED (SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1),
 setting AS MATERIALIZED (SELECT low_stock_units FROM stockchief_runtime.agent_alert_channels WHERE workspace_id=$1 AND job_id=166),
 totals AS MATERIALIZED (SELECT b.sku_id,sum(b.on_hand) AS on_hand FROM balances b
   WHERE b.workspace_id=$1 AND b.location_id IN (SELECT id FROM active) GROUP BY b.sku_id),
 points AS MATERIALIZED (SELECT p.sku_id,p.location_id,p.reorder_point::numeric AS level FROM reorder_policies p
   WHERE p.workspace_id=$1 AND p.reorder_point IS NOT NULL AND (p.location_id IS NULL OR p.location_id IN (SELECT id FROM active))),
 positions AS (
   SELECT p.sku_id,p.location_id,p.level,'Reorder point' AS basis,
     coalesce(CASE WHEN p.location_id IS NULL THEN t.on_hand ELSE b.on_hand END,0)::numeric AS on_hand
   FROM points p LEFT JOIN totals t ON t.sku_id=p.sku_id
   LEFT JOIN balances b ON b.workspace_id=$1 AND b.sku_id=p.sku_id AND b.location_id=p.location_id
   UNION ALL
   SELECT s.sku_id,NULL::text,(SELECT low_stock_units FROM setting)::numeric,
     CASE WHEN (SELECT low_stock_units FROM setting) IS NULL THEN 'None' ELSE 'Your alert level' END,coalesce(t.on_hand,0)::numeric
   FROM (SELECT DISTINCT sku_id FROM balances WHERE workspace_id=$1) s LEFT JOIN totals t ON t.sku_id=s.sku_id
   WHERE NOT EXISTS(SELECT 1 FROM points p WHERE p.sku_id=s.sku_id))
 SELECT CASE WHEN x.on_hand<=0 THEN 'Out of stock' ELSE 'Low stock' END AS kind,
   s.code||coalesce(' at '||l.name,'') AS ref,'/inventory/'||i.id AS link,
   s.code AS sku,concat_ws(' — ',i.name,nullif(s.variant_label,'')) AS product,coalesce(l.name,'All locations') AS location,
   x.on_hand::text AS on_hand,x.level::text AS level,x.basis,i.unit_label
 FROM positions x JOIN skus s ON s.workspace_id=$1 AND s.id=x.sku_id AND s.is_active=1
 JOIN items i ON i.workspace_id=$1 AND i.id=s.item_id AND i.is_active=1
 LEFT JOIN active l ON l.id=x.location_id
 WHERE (x.on_hand<=0 OR x.on_hand<=x.level)
  AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.stock_threshold_rules r WHERE r.workspace_id=$1 AND r.is_active
    AND r.sku_id=x.sku_id AND r.location_id IS NOT DISTINCT FROM x.location_id)
  AND ($2='' OR lower(s.code)=lower($2) OR lower(l.name)=lower($2))`;

const quantity=(value,label)=>unitCount(Number(exact.canonical(String(value),{signed:true})),label);
function describe(r){
  return {Alert:r.kind,SKU:r.sku,Product:r.product,Location:r.location,'On hand':quantity(r.on_hand,r.unit_label),
    'Alert level':r.level==null?'Out of stock only':quantity(r.level,r.unit_label),
    'Level from':r.basis==='None'?'No reorder point':r.basis,link:r.link};
}

// The review: stock-outs first, then low stock, by SKU.
async function review(db,ctx,{filter='',page=1}){
  if(!await require('../db/schema-installed').has(db,'stockchief_runtime.agent_alert_channels'))
    return {rows:[],more:false,summary:'Stock alerts are being upgraded. Check back shortly.'};
  const rows=(await db.query(`SELECT * FROM (${sql}) a ORDER BY (a.kind='Out of stock') DESC,a.sku,a.location LIMIT 101 OFFSET $3`,
    [ctx.workspaceId,filter||'',(page-1)*100])).rows;
  return {rows:rows.slice(0,100).map(describe),more:rows.length>100,
    summary:'Products at or below their reorder point, or your own alert level when they have none, and products that ran out. '+
      'StockChief checks through the day and clears an alert when stock recovers.'};
}

// One plain line per alert, for the alert email.
async function lines(db,workspaceId,keys){
  const rows=(await db.query(`SELECT * FROM (${sql}) a`,[workspaceId,''])).rows;
  const found=new Map(rows.map(r=>[r.kind+'\u0000'+r.ref+'\u0000'+r.link,r]));
  return keys.map(k=>{
    const r=found.get(k.kind+'\u0000'+k.reference+'\u0000'+k.link);
    if(!r)return k.kind+': '+k.reference+'.';
    const d=describe(r);
    return r.kind+': '+r.sku+(r.location==='All locations'?'':' at '+r.location)+' ('+r.product+'). '+d['On hand']+' on hand'+
      (r.level==null?'.':'; alert level '+d['Alert level']+' ('+d['Level from'].toLowerCase()+').');
  });
}

module.exports={JOB,key,path,sql,review,lines,
  definition:{id:JOB,key,label:'Low stock and stock-out alerts',filterLabel:'Exact SKU or location',readPage:review}};

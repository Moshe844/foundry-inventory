'use strict';
const policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity');
async function review(db,ctx,{page=1,filter=''}){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,123,'automatic');
 // Job 186: stock other 3PLs reported, read through the same 3PL connections that ship orders.
 const thirdParty=require('../connections/agent-3pl-orders'),partnerReads=await require('../db/schema-installed').has(db,thirdParty.STOCK)?' UNION ALL '+thirdParty.partnerStockSql:'';
 const rows=(await db.query(`WITH activity AS (
  SELECT agreement_id,max(created_at) recorded_at FROM custody_events WHERE workspace_id=$1 GROUP BY agreement_id
 ), positions AS (
  SELECT 'consignment:'||a.id||':'||l.id sort_key,
   CASE a.kind WHEN 'CONSIGN_OUT' THEN 'Customer consignment' ELSE 'Supplier consignment' END source,
   coalesce(c.name,p.name) partner,a.agreement_number reference,s.code sku,
   CASE a.kind WHEN 'CONSIGN_OUT' THEN 'Our business' ELSE p.name END stock_owner,
   l.external_quantity::text quantity,l.inspection_quantity::text inspection,NULL::text available,
   CASE WHEN l.external_quantity<>coalesce(external_stock.on_hand,0) OR l.inspection_quantity<>coalesce(inspection_stock.on_hand,0)
    THEN 'Recorded quantities differ' WHEN l.external_quantity=0 AND l.inspection_quantity=0 THEN 'No units currently held' ELSE 'Recorded positions agree' END status,
   coalesce(activity.recorded_at,a.created_at) recorded_at,'/custody/'||a.id link
  FROM custody_agreements a JOIN custody_lines l ON l.workspace_id=a.workspace_id AND l.agreement_id=a.id
  JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
  LEFT JOIN customers c ON c.workspace_id=a.workspace_id AND c.id=a.customer_id
  LEFT JOIN suppliers p ON p.workspace_id=a.workspace_id AND p.id=a.supplier_id
  LEFT JOIN activity ON activity.agreement_id=a.id
  LEFT JOIN balances external_stock ON external_stock.workspace_id=a.workspace_id AND external_stock.sku_id=l.sku_id AND external_stock.location_id=a.external_location_id
  LEFT JOIN balances inspection_stock ON inspection_stock.workspace_id=a.workspace_id AND inspection_stock.sku_id=l.sku_id AND inspection_stock.location_id=a.inspection_location_id
  WHERE a.workspace_id=$1 AND a.kind IN ('CONSIGN_OUT','CONSIGN_IN') AND (a.status='OPEN' OR l.external_quantity>0 OR l.inspection_quantity>0)
  UNION ALL
  SELECT 'shipbob:'||s.id,'ShipBob sandbox saved read',c.display_name,'Saved partner stock',s.code,'Not established by the snapshot',
   b.on_hand::text,NULL::text,b.fulfillable::text,
   CASE WHEN c.status='connected' AND c.paused_at IS NULL THEN 'Connected; saved provider reading' ELSE 'Connection paused or disconnected; saved reading' END,
   b.observed_at,'/autopilot/shipbob'
  FROM stockchief_runtime.shipbob_sandbox_stock b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
   JOIN workspace_connectors c ON c.workspace_id=b.workspace_id AND c.id=b.connector_id WHERE b.workspace_id=$1${partnerReads}
 ) SELECT * FROM positions WHERE $2='' OR lower(sku)=lower($2) OR partner ILIKE '%'||$2||'%' OR lower(reference)=lower($2)
 ORDER BY source,partner,reference,sku,sort_key LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),clock=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'});
 return {partnerStockForm:await require('../connections/agent-partner-stock-reads').setting(db,ctx),summary:'Recorded consignment positions and saved ShipBob sandbox readings, with the stock owner and last activity or provider-read time. This review does not request a fresh partner reading. Supplier-owned goods stay separate from company stock. Partner snapshots are shown separately so overlapping records are not added together.',
  rows:rows.slice(0,100).map(r=>({Source:r.source,Partner:r.partner,Reference:r.reference,SKU:r.sku,'Stock owner':r.stock_owner,'Recorded units':exact.canonical(r.quantity,{signed:true}),'In inspection':r.inspection==null?'Not reported':exact.canonical(r.inspection,{signed:true}),'3PL reported available':r.available==null?'Not reported':exact.canonical(r.available,{signed:true}),Status:r.status,Recorded:clock.format(new Date(r.recorded_at)),link:r.link})),more:rows.length>100};
}
module.exports={review,definition:{id:123,key:'third-party-stock',label:'Stock with fulfilment partners and on consignment',filterLabel:'SKU, agreement or partner',readPage:review}};

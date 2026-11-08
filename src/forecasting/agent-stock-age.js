'use strict';

const {THRESHOLDS}=require('./excess');

async function review(db,ctx,{filter,page,today}){
  const {rows}=await db.query(`WITH selected AS (
    SELECT s.id,s.code,i.id AS item_id,i.tracking_mode FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND ($2='' OR lower(s.code)=lower($2))
  ), positions AS (
    SELECT s.id,s.code,s.item_id,b.location_id,b.quantity AS units,t.code AS identity,t.received_at,
      'Lot receipt' AS basis FROM selected s JOIN lots t ON t.workspace_id=$1 AND t.sku_id=s.id
      JOIN lot_balances b ON b.workspace_id=t.workspace_id AND b.lot_id=t.id AND b.quantity>0 WHERE s.tracking_mode='lot'
    UNION ALL
    SELECT s.id,s.code,s.item_id,u.location_id,1,u.serial,u.received_at,'Serial receipt' FROM selected s
      JOIN serial_units u ON u.workspace_id=$1 AND u.sku_id=s.id AND u.status='in_stock' WHERE s.tracking_mode='serial'
    UNION ALL
    SELECT s.id,s.code,s.item_id,b.location_id,b.on_hand,NULL,
      CASE WHEN h.receipts=1 AND h.additions=1 THEN h.received END,
      CASE WHEN h.receipts=1 AND h.additions=1 THEN 'Single recorded receipt' ELSE 'Receipt age unavailable' END
      FROM selected s JOIN balances b ON b.workspace_id=$1 AND b.sku_id=s.id AND b.on_hand>0
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER(WHERE m.operation='receive') AS receipts,count(*) AS additions,max(m.occurred_at) AS received
        FROM movements m WHERE m.workspace_id=b.workspace_id AND m.sku_id=b.sku_id AND m.location_id=b.location_id
          AND m.quantity_delta>0 AND m.seq>coalesce((SELECT max(z.seq) FROM movements z WHERE z.workspace_id=b.workspace_id
          AND z.sku_id=b.sku_id AND z.location_id=b.location_id AND z.balance_after<=0),0)) h ON true WHERE s.tracking_mode='quantity'
  )
    SELECT p.*,l.name AS location, $3::date-CASE WHEN p.received_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN p.received_at::date
      ELSE (nullif(p.received_at,'')::timestamptz AT TIME ZONE coalesce(w.time_zone,a.time_zone,'UTC'))::date END AS days
    FROM positions p JOIN locations l ON l.workspace_id=$1 AND l.id=p.location_id JOIN workspaces w ON w.id=l.workspace_id
    JOIN accounts a ON a.id=w.owner_account_id ORDER BY days DESC NULLS LAST,p.code,l.id,p.identity,p.id LIMIT 101 OFFSET $4`,
    [ctx.workspaceId,filter,today,(page-1)*100]);
  return {more:rows.length>100,summary:'Age uses recorded receipt dates. Mixed untracked stock has no reliable unit age. Review older stock against its recoverable value before approving a write-down.',
    rows:rows.slice(0,100).map(r=>({SKU:r.code,Location:r.location,'Lot or serial':r.identity,Units:Number(r.units),'Days since receipt':r.days>=0?r.days:null,
      'Age evidence':r.basis,Review:r.days>=THRESHOLDS.deadDays?'Review for a possible write-down':r.days==null||r.days<0?'Check receipt evidence':'No age flag',link:'/inventory/'+r.item_id}))};
}

module.exports={review};

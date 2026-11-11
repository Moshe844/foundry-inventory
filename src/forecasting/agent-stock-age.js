
'use strict';

const {THRESHOLDS}=require('./excess');
const money=require('../domain/currency'),exact=require('../domain/exact-quantity');

const statement=`WITH positions AS (
  SELECT s.id sku_id,s.code,i.id item_id,i.name,i.tracking_mode,i.unit_label,i.secondary_unit_label,
    b.location_id,b.on_hand::text on_hand,b.secondary_on_hand::text secondary_on_hand,b.updated_at physical_updated,
    l.name location_name,l.custody_agreement_id,l.is_active location_active,
    c.quantity_units::text cost_units,c.secondary_quantity_units::text cost_weight,c.total_cost_minor book_value,
    c.updated_at cost_updated,a.base_currency currency,coalesce(w.time_zone,o.time_zone,'UTC') time_zone,
    coalesce((SELECT max(m.seq) FROM movements m WHERE m.workspace_id=b.workspace_id AND m.sku_id=b.sku_id
      AND m.location_id=b.location_id),0)::text movement_version
  FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id
  JOIN workspaces w ON w.id=b.workspace_id JOIN accounts o ON o.id=w.owner_account_id
  LEFT JOIN accounting_settings a ON a.workspace_id=b.workspace_id AND a.enabled=1
  LEFT JOIN accounting_inventory_cost_balances c ON c.workspace_id=b.workspace_id AND c.sku_id=b.sku_id AND c.location_id=b.location_id
  WHERE b.workspace_id=$1 AND b.on_hand>0 AND s.is_active=1 AND i.is_active=1
    AND ($2='' OR lower(s.code)=lower($2)) AND ($3::text IS NULL OR s.id=$3) AND ($4::text IS NULL OR b.location_id=$4)
), history AS (
  SELECT p.sku_id,p.location_id,p.on_hand,h.additions,h.added,h.issues,start.seq,pool.workspace_id IS NOT NULL has_pool,pooled.units pool_units
  FROM positions p
  LEFT JOIN stockchief_runtime.stock_rotation_pools pool ON pool.workspace_id=$1 AND pool.sku_id=p.sku_id AND pool.location_id=p.location_id
  LEFT JOIN LATERAL(SELECT coalesce(sum(x.remaining_quantity),0) units FROM stockchief_runtime.stock_rotation_layers x
    WHERE x.workspace_id=$1 AND x.sku_id=p.sku_id AND x.location_id=p.location_id AND x.remaining_quantity>0) pooled ON pool.workspace_id IS NOT NULL
  LEFT JOIN LATERAL(SELECT coalesce(max(m.seq),0) seq FROM movements m
    WHERE m.workspace_id=$1 AND m.sku_id=p.sku_id AND m.location_id=p.location_id AND m.balance_after<=0) start ON pool.workspace_id IS NULL
  LEFT JOIN LATERAL(SELECT count(*) FILTER(WHERE m.quantity_delta>0) additions,
    coalesce(sum(m.quantity_delta) FILTER(WHERE m.quantity_delta>0),0) added,
    count(*) FILTER(WHERE m.quantity_delta<0) issues FROM movements m
    WHERE m.workspace_id=$1 AND m.sku_id=p.sku_id AND m.location_id=p.location_id AND m.seq>start.seq) h ON pool.workspace_id IS NULL
  WHERE p.tracking_mode='quantity'
), cohorts AS (
  SELECT p.sku_id,p.location_id,t.id source_id,t.code identity,b.quantity::text units,
    b.secondary_quantity::text weight,
    CASE WHEN origin.opening AND origin.occurred_at=t.received_at THEN NULL ELSE t.received_at END received_at,
    'Lot receipt' basis FROM positions p
  JOIN lots t ON t.workspace_id=$1 AND t.sku_id=p.sku_id
  JOIN lot_balances b ON b.workspace_id=$1 AND b.lot_id=t.id AND b.location_id=p.location_id AND b.quantity>0
  LEFT JOIN LATERAL(SELECT m.occurred_at,coalesce(cm.cost_source_type IN ('opening_inventory','verified_migration_opening_value'),false)
    OR m.reference LIKE 'cutover:%' opening FROM movements m
    LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=m.workspace_id AND cm.inventory_movement_id=m.id
    WHERE m.workspace_id=$1 AND m.lot_id=t.id AND m.operation='receive' ORDER BY m.seq LIMIT 1) origin ON true
  WHERE p.tracking_mode='lot'
  UNION ALL
  SELECT p.sku_id,p.location_id,u.id,u.serial,'1',u.secondary_quantity::text,
    CASE WHEN origin.opening THEN NULL ELSE u.received_at END,'Serial receipt' FROM positions p
  JOIN serial_units u ON u.workspace_id=$1 AND u.sku_id=p.sku_id AND u.location_id=p.location_id AND u.status='in_stock'
  LEFT JOIN LATERAL(SELECT coalesce(cm.cost_source_type IN ('opening_inventory','verified_migration_opening_value'),false)
    OR m.reference LIKE 'cutover:%' opening FROM stockchief_runtime.inventory_movement_serial_units ms
    JOIN movements m ON m.workspace_id=ms.workspace_id AND m.id=ms.movement_id AND m.operation='receive'
    LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=m.workspace_id AND cm.inventory_movement_id=m.id
    WHERE ms.workspace_id=$1 AND ms.serial_unit_id=u.id ORDER BY m.seq LIMIT 1) origin ON true
  WHERE p.tracking_mode='serial'
  UNION ALL
  SELECT p.sku_id,p.location_id,m.id,NULL,r.remaining_quantity::text,
    CASE WHEN r.remaining_quantity=p.on_hand::numeric THEN p.secondary_on_hand
         WHEN r.remaining_quantity=m.quantity_delta THEN m.secondary_quantity_delta::text END,
    CASE WHEN m.operation='transfer' THEN stockchief_runtime.proven_transfer_receipt_date($1,m.id)
         WHEN m.operation='receive' AND coalesce(cm.cost_source_type,'') NOT IN ('opening_inventory','verified_migration_opening_value')
           AND coalesce(m.reference,'') NOT LIKE 'cutover:%' THEN r.received_at::text END,
    CASE WHEN m.operation='transfer' THEN 'Recorded transfer origin' ELSE 'Recorded FIFO layer' END
  FROM positions p JOIN history h USING(sku_id,location_id)
  JOIN stockchief_runtime.stock_rotation_layers r ON r.workspace_id=$1 AND r.sku_id=p.sku_id
    AND r.location_id=p.location_id AND r.remaining_quantity>0
  JOIN movements m ON m.workspace_id=$1 AND m.id=r.receipt_movement_id
  LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=m.workspace_id AND cm.inventory_movement_id=m.id
  WHERE h.has_pool AND h.pool_units=p.on_hand::numeric
  UNION ALL
  SELECT p.sku_id,p.location_id,m.id,NULL,
    CASE WHEN h.additions=1 THEN p.on_hand ELSE m.quantity_delta::text END,
    CASE WHEN h.additions=1 THEN p.secondary_on_hand ELSE m.secondary_quantity_delta::text END,
    CASE WHEN m.operation='transfer' THEN stockchief_runtime.proven_transfer_receipt_date($1,m.id)
         WHEN m.operation='receive' AND coalesce(cm.cost_source_type,'') NOT IN ('opening_inventory','verified_migration_opening_value')
           AND coalesce(m.reference,'') NOT LIKE 'cutover:%' THEN m.occurred_at END,
    CASE WHEN m.operation='transfer' THEN 'Recorded transfer origin' ELSE 'Recorded receipt' END
  FROM positions p JOIN history h USING(sku_id,location_id)
  JOIN movements m ON m.workspace_id=$1 AND m.sku_id=p.sku_id AND m.location_id=p.location_id AND m.seq>h.seq AND m.quantity_delta>0
  LEFT JOIN accounting_inventory_cost_movements cm ON cm.workspace_id=m.workspace_id AND cm.inventory_movement_id=m.id
  WHERE NOT h.has_pool AND (h.additions=1 AND h.added>=p.on_hand::numeric OR h.issues=0 AND h.added=p.on_hand::numeric)
), coverage AS (
  SELECT sku_id,location_id,sum(units::numeric) units FROM cohorts GROUP BY sku_id,location_id
), verified AS (
  SELECT p.*,c.source_id,c.identity,c.units,c.weight,c.received_at,c.basis FROM positions p
  JOIN coverage v ON v.sku_id=p.sku_id AND v.location_id=p.location_id AND v.units=p.on_hand::numeric
  JOIN cohorts c ON c.sku_id=p.sku_id AND c.location_id=p.location_id
  UNION ALL
  SELECT p.*,NULL,NULL,p.on_hand,p.secondary_on_hand,NULL,'Receipt age unavailable' FROM positions p
  LEFT JOIN coverage v USING(sku_id,location_id) WHERE v.units IS DISTINCT FROM p.on_hand::numeric
), dated AS (
  SELECT *, $5::date-CASE WHEN received_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN received_at::date
    ELSE (nullif(received_at,'')::timestamptz AT TIME ZONE time_zone)::date END AS days FROM verified
)
SELECT * FROM dated ORDER BY CASE WHEN days>=0 THEN days END DESC NULLS LAST,code,location_id,identity,source_id
LIMIT $6 OFFSET $7`;

async function rows(db,ctx,{filter='',skuId=null,locationId=null,today,limit=null,offset=0}){
  return (await db.query(statement,[ctx.workspaceId,filter,skuId,locationId,today,limit,offset])).rows;
}
const known=row=>Number.isInteger(row.days)&&row.days>=0;
const old=row=>known(row)&&row.days>=THRESHOLDS.deadDays;
const completelyCosted=row=>row.currency&&row.cost_units!==null&&row.book_value!==null&&Number(row.book_value)>=0
  &&exact.canonical(row.cost_units)===exact.canonical(row.on_hand)
  &&(row.cost_weight===null||row.secondary_on_hand===null?row.cost_weight===row.secondary_on_hand:
    exact.canonical(row.cost_weight)===exact.canonical(row.secondary_on_hand));
const owned=row=>!row.custody_agreement_id&&Number(row.location_active)===1;
const positionReference=row=>row.sku_id+':'+row.location_id;
const route='/autopilot/reviews/stock-age/write-down';

async function review(db,ctx,{filter,page,today,adviceOnly=false}){
  const result=await rows(db,ctx,{filter,today,limit:adviceOnly?1:101,offset:adviceOnly?0:(page-1)*100});
  return {more:result.length>100,summary:'Receipt age comes from recorded lots, serials, individual receipts, established FIFO layers or proven transfer origins. Older stock can be reviewed against its supported recoverable value.',
    rows:result.slice(0,100).map(r=>{
      const prepare=old(r)&&owned(r)&&completelyCosted(r)&&Number(r.book_value)>0;
      return {SKU:r.code,Location:r.location_name,'Lot or serial':r.identity,Units:Number(r.units),
        'Actual second measure':r.weight===null?null:r.weight+' '+r.secondary_unit_label,
        'Days since receipt':known(r)?r.days:null,'Age evidence':known(r)?r.basis:'Receipt age unavailable',
        'Position book value':owned(r)&&completelyCosted(r)?money.format(Number(r.book_value),r.currency):null,
        Review:old(r)?'Review for a possible write-down':known(r)?'No age flag':'Check receipt evidence',
        link:prepare?route+'?position='+encodeURIComponent(positionReference(r)):'/inventory/'+r.item_id,
        ...(prepare?{linkLabel:'Review write-down'}:{})};
    })};
}

module.exports={review,rows,known,old,owned,completelyCosted,positionReference,route};

'use strict';

// Job 194: blocks recalled or expired lots from being shipped.
//
// StockChief refuses a recalled or expired batch on every way out: picks and
// shipments, transfers to another location, the quantity offered on sales
// channels, kit components, rentals and consignment. Only a write-off or a
// return to the supplier may take it out of stock. These blocks are safety
// rules: they hold in every mode, including pause, shadow and Watch only,
// because they never move stock.
//
// Placing a recall is a person's decision on Growth, Pro and Custom; releasing
// one always needs a person with a reason, and both are audited. This module
// shows the open work a blocked batch still holds up, so a person can choose
// other stock.

const policy=require('../commercial/agent-plan');

const JOB=194;
const blocked=`(l.recalled_at IS NOT NULL OR l.expires_at::date<$2::date)`;
const why=`CASE WHEN l.recalled_at IS NOT NULL THEN 'Under recall' ELSE 'Expired' END`;

// Open transfers and order reservations that still name a blocked batch.
async function holding(db,workspaceId,{lotId=null,limit=50}={}){
  const today=await require('../lib/business-time').today(db,workspaceId);
  return (await db.query(`SELECT * FROM (
      SELECT 'Transfer' AS kind,t.transfer_number AS reference,'/transfers/'||t.id AS href,s.code AS sku,l.code AS lot,l.id AS lot_id,
        (CASE WHEN t.status='REQUESTED' THEN tl.requested_quantity ELSE tl.approved_quantity END)::text AS units,${why} AS reason,t.created_at::text AS at
      FROM inventory_transfer_lines tl JOIN inventory_transfers t ON t.workspace_id=tl.workspace_id AND t.id=tl.transfer_id
      JOIN lots l ON l.workspace_id=tl.workspace_id AND l.id=tl.lot_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
      WHERE tl.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED') AND ${blocked} AND ($3::text IS NULL OR l.id=$3)
      UNION ALL
      SELECT 'Transfer',t.transfer_number,'/transfers/'||t.id,s.code,l.code,l.id,count(*)::text,${why},t.created_at::text
      FROM inventory_transfer_serials ts JOIN inventory_transfer_lines tl ON tl.id=ts.transfer_line_id
      JOIN inventory_transfers t ON t.workspace_id=tl.workspace_id AND t.id=tl.transfer_id
      JOIN serial_units u ON u.workspace_id=tl.workspace_id AND u.id=ts.serial_unit_id
      JOIN lots l ON l.workspace_id=u.workspace_id AND l.id=u.lot_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
      WHERE tl.workspace_id=$1 AND t.status IN ('REQUESTED','APPROVED','PICKED') AND ${blocked} AND ($3::text IS NULL OR l.id=$3)
      GROUP BY t.id,t.transfer_number,s.code,l.code,l.id,l.recalled_at,t.created_at
      UNION ALL
      SELECT 'Order',o.order_number,'/orders/'||o.id,s.code,l.code,l.id,sum(r.quantity)::text,${why},o.created_at::text
      FROM stockchief_runtime.sales_rotation_entries r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id
      JOIN lots l ON l.workspace_id=r.workspace_id AND l.id=r.lot_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
      WHERE r.workspace_id=$1 AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED') AND ${blocked} AND ($3::text IS NULL OR l.id=$3)
      GROUP BY o.id,o.order_number,s.code,l.code,l.id,l.recalled_at,o.created_at) x
    ORDER BY x.at,x.reference,x.lot LIMIT $4`,[workspaceId,today,lotId,limit])).rows;
}

async function inbox(db,workspaceId){
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,JOB,'draft'))return [];
  const rows=await holding(db,workspaceId,{limit:20});
  if(!rows.length)return [];
  const first=rows[0];
  return [{kind:'inventory',importance:'Needs You',priority:70,grouped:true,
    title:rows.length===1?'Open work holds a blocked batch':'Open work holds blocked batches',
    happened:rows.slice(0,3).map(r=>r.kind+' '+r.reference+' holds '+r.units+' of '+r.sku+' batch '+r.lot+' ('+r.reason.toLowerCase()+').').join(' ')+(rows.length>3?' And more.':''),
    why:'StockChief will not ship, move or sell recalled or expired stock.',recommendation:'Choose other stock for this work, or cancel it.',
    href:'/autopilot/lots?'+new URLSearchParams({sku:first.sku,lot:first.lot}),actionLabel:'Review the batch',sourceId:'lot-blocks',at:first.at,createdAt:first.at}];
}

module.exports={JOB,holding,inbox};

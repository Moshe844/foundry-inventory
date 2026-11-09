'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),P=require('../actions/permissions'),policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity');
const {addDays}=require('../accounting/customer-money'),{hash}=require('../pricing/postgres-promotions');
const SCALE=1000000n;
function scaled(value){const [whole,fraction='']=exact.canonical(value).split('.');return BigInt(whole)*SCALE+BigInt(fraction.padEnd(6,'0'));}
function decimal(value){const fraction=String(value%SCALE).padStart(6,'0').replace(/0+$/,'');return String(value/SCALE)+(fraction?'.'+fraction:'');}
function project(today,weeks,firstDate,orderDays){
 const from=addDays(today,-84),first=firstDate?Math.floor((Date.parse(firstDate)-Date.parse(from))/604800000)+1:12,observed=12-first;
 const total=weeks.slice(first).reduce((sum,n)=>sum+scaled(n),0n),ready=observed>=8&&orderDays>=2;
 let prior=0n;const forecast=Array.from({length:12},(_,i)=>{const cumulative=ready?(total*BigInt(i+1)+BigInt(observed)/2n)/BigInt(observed):null,quantity=ready?decimal(cumulative-prior):null;if(ready)prior=cumulative;return {from:addDays(today,i*7),to:addDays(today,i*7+6),quantity};});
 return {observedWeeks:Math.max(0,observed),orderDays,method:ready?'Average confirmed order demand in complete seven-day periods':'More order history needed',forecast,total:ready?decimal(prior):null};
}
async function owner(db,ctx){
 const user=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can authorize sharing supplier stock forecasts.');P.assertCan(user,P.MANAGE_SUPPLIERS,'share supplier forecasts');P.assertCan(user,P.VIEW,'review the selected stock');
}
async function access(db,ctx){await owner(db,ctx);return policy.requireWorkspaceJob(db,ctx.workspaceId,36,'draft');}
async function snapshot(db,ctx,{supplierId,skuIds,connectorId}){
 if(!Array.isArray(skuIds)||!skuIds.length||skuIds.length>250||skuIds.some(id=>typeof id!=='string'||!id)||new Set(skuIds).size!==skuIds.length)throw new ValidationError('Choose one to 250 distinct products to share with this supplier.');
 const read=async c=>{
  await access(c,ctx);const supplier=(await c.query("SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND id=$2 AND status='active'",[ctx.workspaceId,supplierId])).rows[0];if(!supplier||!/^\S+@\S+\.\S+$/.test(supplier.email||''))throw new ValidationError('Choose the active supplier and confirm their email address.');
  const box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
  const clock=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId),from=addDays(clock.calendarDate,-84),ids=[...skuIds].sort();
  const products=(await c.query(`SELECT s.id,s.code,i.name,i.unit_label,coalesce(stock.quantity,0)::text on_hand,coalesce(stock.negative,0)::int negative_positions FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id LEFT JOIN LATERAL(SELECT sum(b.on_hand) quantity,count(*) FILTER(WHERE b.on_hand<0) negative FROM balances b JOIN locations l ON l.workspace_id=b.workspace_id AND l.id=b.location_id WHERE b.workspace_id=$1 AND b.sku_id=s.id AND l.is_active=1 AND l.custody_agreement_id IS NULL) stock ON true WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.id`,[ctx.workspaceId,ids])).rows;
  if(products.length!==ids.length)throw new ValidationError('Choose active products from this inventory only.');
  const history=(await c.query(`SELECT l.sku_id,o.order_date,sum(l.quantity_ordered)::text quantity FROM sales_order_lines l JOIN sales_orders o ON o.workspace_id=l.workspace_id AND o.id=l.sales_order_id WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND o.status NOT IN ('DRAFT','CANCELLED') AND o.order_date>=$3 AND o.order_date<$4 GROUP BY l.sku_id,o.order_date ORDER BY l.sku_id,o.order_date`,[ctx.workspaceId,ids,from,clock.calendarDate])).rows;
  const rows=products.map(p=>{const sales=history.filter(r=>r.sku_id===p.id),weeks=Array(12).fill(0n);for(const r of sales){const week=Math.floor((Date.parse(r.order_date)-Date.parse(from))/604800000);weeks[week]+=scaled(r.quantity);}return {skuId:p.id,sku:p.code,name:p.name,unit:p.unit_label,onHand:exact.canonical(p.on_hand,{signed:true}),needsReview:p.negative_positions>0,...project(clock.calendarDate,weeks.map(decimal),sales[0]?.order_date||null,sales.length)};});
  const report={supplierId:supplier.id,supplierName:supplier.name,recipient:supplier.email,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,preparedAt:clock.instant,timeZone:clock.timeZone,today:clock.calendarDate,historyFrom:from,historyThrough:addDays(clock.calendarDate,-1),skuIds:ids,rows};return {...report,sourceFingerprint:hash(report)};
 };
 return typeof db.transaction==='function'?db.transaction(read,{isolation:'REPEATABLE READ',readOnly:true,retrySafe:true}):read(db);
}
module.exports={owner,access,snapshot,project};

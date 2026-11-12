'use strict';
const {ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity');
function codes(value){if(value==null)return [];if(typeof value==='string'){if(value.length>20000)throw new ValidationError('Scan at most 500 serial numbers at once.');value=value.split(/[\n,]+/);}if(!Array.isArray(value)||value.length>500)throw new ValidationError('Scan at most 500 serial numbers at once.');const result=value.map(v=>String(v).trim()).filter(Boolean);if(new Set(result.map(v=>v.toLowerCase())).size!==result.length)throw new ValidationError('Each serial number must be scanned once.');return result;}
async function expand(client,ctx,orderId,requested,at){
 if(requested.length>500)throw new ValidationError('Fulfill at most 500 order lines at once.');
 const lines=(await client.query('SELECT l.id,l.sku_id,i.name,i.tracking_mode,i.secondary_unit_label FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2 AND l.id=ANY($3::text[])',[ctx.workspaceId,orderId,requested.map(r=>r.lineId)])).rows;return expandLines(client,ctx,lines,requested,at);
}
async function expandForSku(client,ctx,skuId,requested,at){
 if(!Array.isArray(requested)||requested.length>500)throw new ValidationError('Choose at most 500 component stock positions.');
 const line=(await client.query('SELECT s.id,s.id AS sku_id,i.name,i.tracking_mode,i.secondary_unit_label FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1',[ctx.workspaceId,skuId])).rows[0];if(!line)throw new ValidationError('Choose an active component from this inventory.');return expandLines(client,ctx,[line],requested.map(r=>({...r,lineId:line.id})),at);
}
async function expandLines(client,ctx,lines,requested,at){
 const result=[],businessDay=lines.some(l=>l.tracking_mode==='lot')?await require('../lib/business-time').today(client,ctx.workspaceId,new Date(at)):null;
 for(const request of requested){const line=lines.find(l=>l.id===request.lineId);if(!line)throw new ValidationError('Choose lines from this order.');const quantity=exact.safeNumber(request.quantity,{label:line.name+' quantity'});if(quantity<=0)throw new ValidationError('Fulfillment quantity must be above zero.');
  if(line.tracking_mode==='serial'&&request.serials!=null){const serials=codes(request.serials);if(serials.length!==quantity)throw new ValidationError(line.name+': scan one serial number for each unit leaving.');const found=(await client.query("SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 AND status='in_stock' AND lower(serial)=ANY($4::text[]) ORDER BY id FOR UPDATE",[ctx.workspaceId,line.sku_id,request.locationId,serials.map(s=>s.toLowerCase())])).rows;if(found.length!==quantity)throw new ValidationError(line.name+': one or more scanned serial numbers are not available at this location.');result.push({...request,serialUnitIds:found.map(r=>r.id)});continue;}
  if(line.tracking_mode!=='lot'||request.lotId){result.push(request);continue;}
  const rotation=require('./postgres-stock-rotation'),allocation=request.rotationAllocation||await rotation.normalAllocation(client,ctx,line.id,request.locationId);
  // Job 191: with no batch named, a pick takes the soonest expiry first, or the
  // exact batches a FIFO/FEFO reservation already holds.
  const strategy=request.lotStrategy||(allocation?.rotation_selection?'RESERVED':'FEFO');
  if(strategy==='RESERVED'&&allocation?.rotation_selection&&!request.lotCode){result.push(...rotation.frozenLotRequests(request,allocation));continue;}
  if(request.lotCode){const lot=(await client.query('SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2 AND code=$3',[ctx.workspaceId,line.sku_id,String(request.lotCode).trim()])).rows[0];if(!lot)throw new ValidationError(line.name+': that lot or batch was not found.');result.push({...request,lotId:lot.id});continue;}
  if(strategy!=='FEFO'){result.push(request);continue;}
  if(line.secondary_unit_label)throw new ValidationError(line.name+': choose the exact batch and measured weight before fulfilling it.');
  const lots=(await client.query(`SELECT l.id,b.quantity FROM lots l JOIN lot_balances b ON b.workspace_id=l.workspace_id AND b.lot_id=l.id WHERE l.workspace_id=$1 AND l.sku_id=$2 AND b.location_id=$3 AND b.quantity>0 AND l.recalled_at IS NULL AND (l.expires_at IS NULL OR l.expires_at::date>=$4::date) ORDER BY l.expires_at::date NULLS LAST,l.received_at,l.id FOR UPDATE OF l,b`,[ctx.workspaceId,line.sku_id,request.locationId,businessDay])).rows;
  const held=await require('./postgres-return-holds').heldLots(client,ctx.workspaceId,line.sku_id,request.locationId),rotated=await rotation.heldLots(client,ctx.workspaceId,line.sku_id,request.locationId,{excludeAllocation:allocation?(request.rotationKind||'sales')+':'+allocation.id:null});
  let remaining=quantity;for(const lot of lots){if(remaining<=0)break;const take=Math.min(remaining,Math.max(0,Number(lot.quantity)-(held.get(lot.id)||0)-Number(rotated.get(lot.id)||0)));if(take<=0)continue;result.push({...request,quantity:take,lotId:lot.id});remaining=exact.safeNumber(exact.subtract(remaining,take));}
  if(remaining>0)throw new ValidationError(line.name+': not enough unexpired batch stock is available at this location. Nothing was fulfilled.');
 }
 return result;
}
module.exports={expand,expandForSku,codes};

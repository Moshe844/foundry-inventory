'use strict';
const policy=require('../commercial/agent-plan'),photos=require('../operations/quality-photos'),{hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError}=require('../domain/errors'),money=require('../domain/currency');
async function owner(c,ctx,{lock=true}={}){
 const user=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
  WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) ${lock?'FOR SHARE OF u,w':''}`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!user)throw new AuthorizationError('Only the inventory owner can prepare or authorize supplier claims.');
}
async function access(c,ctx,{automatic=false,trained=false,readOnly=false,withPhotos=false}={}){
 await owner(c,ctx,{lock:!readOnly});if(!readOnly)await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const account=await policy.requireWorkspaceJob(c,ctx.workspaceId,45,automatic?'automatic':'draft',{trained});
 const stopped=await policy.stopped(c,ctx.workspaceId,account,'supplier.open_damage_claim',automatic);if(stopped)throw new ValidationError(stopped);
 if(withPhotos){await policy.requireWorkspaceJob(c,ctx.workspaceId,46,automatic?'automatic':'draft');const stopped=await policy.stopped(c,ctx.workspaceId,account,'supplier.attach_damage_photos',automatic);if(stopped)throw new ValidationError(stopped);}
 if(automatic&&!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine supplier claims are paused.');return account;
}
async function facts(c,ctx,{holdId,connectorId,photoIds=[],reference},{readOnly=false,automatic=false}={}){
 await owner(c,ctx,{lock:!readOnly});
 const row=(await c.query(`SELECT h.*,s.code,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,
  l.name location_name,v.id supplier_id,v.name supplier_name,v.email,v.currency,o.id purchase_order_id,o.po_number,
  p.unit_cost,r.id receipt_id,r.received_at FROM stockchief_runtime.agent_quality_holds h
  JOIN skus s ON s.workspace_id=h.workspace_id AND s.id=h.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  JOIN locations l ON l.workspace_id=h.workspace_id AND l.id=h.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
  JOIN purchase_order_receipt_lines rl ON rl.workspace_id=h.workspace_id AND rl.id=h.receipt_line_id
  JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
  JOIN purchase_order_lines p ON p.workspace_id=rl.workspace_id AND p.id=rl.purchase_order_line_id
  JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  JOIN suppliers v ON v.workspace_id=o.workspace_id AND v.id=o.supplier_id AND v.status='active'
  WHERE h.workspace_id=$1 AND h.id=$2 AND s.is_active=1 AND i.is_active=1`,[ctx.workspaceId,holdId])).rows[0];
 const damaged=Number(row?.inspection?.damagedQuantity);
 if(!row||row.status!=='FAILED'||row.inspection?.decision!=='FAIL'||!row.inspected_by||!row.inspected_at||!Number.isSafeInteger(damaged)||damaged<1||damaged>row.quantity)throw new ValidationError('Record the actual damaged-unit count in a failed physical delivery inspection before preparing a supplier claim.');
 await require('../operations/postgres-warehouse-access').assertLocations(c,ctx,[row.location_id]);
 if(row.tracking_mode!=='quantity'||Number(row.quantity_precision)!==0||row.secondary_unit_label)throw new ValidationError('This claim workflow covers whole-unit quantity stock. Review lots, serials and measured goods separately.');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email||''))throw new ValidationError('Record the exact known supplier claim email address before preparing this message.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,connectorId);if(!box?.provider_account_id)throw new ValidationError('Choose a connected sending mailbox with its verified account identity.');
 const currency=money.code(row.currency),unitCostMinor=money.userToMinor(String(row.unit_cost),currency,{label:'Recorded supplier unit cost'}),totalMinor=require('../domain/exact-quantity').costMinor(damaged,unitCostMinor);
 const clock=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId),received=new Date(row.received_at);
 if(!Number.isFinite(received.getTime())||received.getTime()>Date.parse(clock.instant))throw new ValidationError('Check the actual delivery date before preparing a claim.');
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:clock.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(received),ageDays=Math.round((Date.parse(clock.calendarDate+'T12:00:00Z')-Date.parse(day+'T12:00:00Z'))/86400000);
 const evidence=await photos.selected(c,ctx,holdId,photoIds,{automatic});
 const p={holdId,qualityRevision:row.revision,reference,connectorId,mailboxAccount:box.provider_account_id,providerType:box.provider_type,
  supplierId:row.supplier_id,supplierName:row.supplier_name,recipient:row.email,currency,skuId:row.sku_id,sku:row.code,product:row.name,unit:row.unit_label,
  locationId:row.location_id,location:row.location_name,purchaseOrderId:row.purchase_order_id,poNumber:row.po_number,receiptId:row.receipt_id,
  receivedAt:row.received_at,damagedQuantity:damaged,unitCostMinor,totalMinor,inspectionBy:row.inspected_by,inspectionAt:row.inspected_at,
  inspectionNote:row.inspection.note,photos:evidence,preparedAt:clock.instant,timeZone:clock.timeZone};
 return {...p,ageDays,sourceFingerprint:hash(p)};
}
function profile(p){return {supplierId:p.supplierId,supplierName:p.supplierName,recipient:p.recipient,currency:p.currency,skuId:p.skuId,sku:p.sku,product:p.product,unit:p.unit,locationId:p.locationId,location:p.location,connectorId:p.connectorId,mailboxAccount:p.mailboxAccount,providerType:p.providerType,timeZone:p.timeZone};}
function stable(p){const {preparedAt,ageDays,sourceFingerprint,...rest}=p;return rest;}
function compose(p){
 return {subject:'Damaged delivery claim '+p.reference+' · '+p.poNumber,body:'Hello '+p.supplierName+',\n\nPlease open a damage claim for purchase order '+p.poNumber+' under our reference '+p.reference+'.\n\nProduct: '+p.sku+' · '+p.product+'\nPhysically inspected damaged quantity: '+p.damagedQuantity+' '+p.unit+'\nDelivery recorded: '+p.receivedAt+'\nRecorded goods cost for these damaged units: '+money.format(p.totalMinor,p.currency)+' (freight and tax are separate).\n\nRecorded physical findings:\n'+p.inspectionNote+'\n\n'+(p.photos.length?'Attached: '+p.photos.length+' resized copies of the inspection photos. The original files remain preserved.\n\n':'')+'Please acknowledge this claim and propose replacement goods, collection or a credit note for review. This request does not accept a settlement or change payment, tax, stock or accounting records. Any credit, write-off or other disposition needs separate approval.\n\nThank you.'};
}
module.exports={owner,access,facts,profile,stable,compose};

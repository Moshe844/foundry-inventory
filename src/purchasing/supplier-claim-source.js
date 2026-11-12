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
async function deliveryContext(c,ctx,row,connectorId,receivedAt){
 await require('../operations/postgres-warehouse-access').assertLocations(c,ctx,[row.location_id]);
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email||''))throw new ValidationError('Record the exact known supplier claim email address before preparing this message.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(c,ctx.workspaceId,connectorId);if(!box?.provider_account_id)throw new ValidationError('Choose a connected sending mailbox with its verified account identity.');
 const clock=await require('../lib/business-time').forWorkspace(c,ctx.workspaceId),received=new Date(receivedAt);
 if(!Number.isFinite(received.getTime())||received.getTime()>Date.parse(clock.instant))throw new ValidationError('Check the actual delivery date before preparing a claim.');
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:clock.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(received),ageDays=Math.round((Date.parse(clock.calendarDate+'T12:00:00Z')-Date.parse(day+'T12:00:00Z'))/86400000);
 return {box,clock,ageDays};
}

// What the claim asks the supplier for. A claim prepared before this choice
// existed has no remedy and keeps its original wording.
const REMEDIES=Object.freeze({credit:'A credit note',replacement:'Replacement goods',refund:'A refund'});
function remedyOf(value){
 if(value===undefined||value===null)return undefined;
 if(!Object.hasOwn(REMEDIES,value))throw new ValidationError('Choose what to ask the supplier for: a credit note, replacement goods or a refund.');
 return value;
}

async function shortageFacts(c,ctx,{comparisonId,lineId,connectorId,photoIds,reference,remedy},{automatic=false}={}){
 const {row,check,receipts,actual,missingUnits,missingWeight,currency,unitCostMinor,totalMinor,receivedAt}=
  await require('./supplier-shortage-source').facts(c,ctx,{comparisonId,lineId});
 const {box,clock,ageDays}=await deliveryContext(c,ctx,row,connectorId,receivedAt);
 // Photos of the delivery check or of the receipts that booked these goods.
 const evidence=photoIds.length?await photos.selectedFor(c,ctx,{comparisonId,receiptIds:receipts.map(r=>r.id)},photoIds,{automatic}):[];
 const p={claimKind:'shortage',comparisonId,lineId,reference,connectorId,mailboxAccount:box.provider_account_id,providerType:box.provider_type,
  supplierId:row.supplier_id,supplierName:row.supplier_name,recipient:row.email,currency,skuId:row.sku_id,sku:row.code,product:actual.name,unit:row.unit_label,
  locationId:row.location_id,location:row.location_name,purchaseOrderId:row.purchase_order_id,poNumber:row.po_number,
  deliveryReference:check.source_reference,checkedBy:check.recorded_by,checkedAt:new Date(check.recorded_at).toISOString(),receivedAt,
  missingUnits,missingWeight,weightUnit:row.secondary_unit_label,trackingMode:row.tracking_mode,quantityPrecision:Number(row.quantity_precision),
  weightPrecision:row.secondary_precision==null?null:Number(row.secondary_precision),
  expectedUnits:actual.expected,observedUnits:actual.observed,receiptLines:receipts,
  unitCostMinor,totalMinor,photos:evidence,preparedAt:clock.instant,timeZone:clock.timeZone,...(remedy?{remedy}:{})};
 return {...p,ageDays,sourceFingerprint:hash(p)};
}

// A staff damage report from the receiving form: the units were received and
// written off as damaged, so the whole received line is the damaged quantity.
async function reportFacts(c,ctx,{reportId,connectorId,photoIds,reference,remedy},{automatic=false}={}){
 const row=(await c.query(`SELECT d.id,d.quantity::text AS quantity,d.note,d.reported_by,d.created_at AS reported_at,
  rl.sku_id,rl.location_id,rl.receipt_id,r.received_at,r.reference AS receipt_reference,
  s.code,i.name,i.unit_label,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,l.name AS location_name,
  v.id AS supplier_id,v.name AS supplier_name,v.email,o.currency,o.id AS purchase_order_id,o.po_number,p.unit_cost::text AS unit_cost
  FROM stockchief_runtime.agent_receipt_damage_reports d
  JOIN purchase_order_receipt_lines rl ON rl.workspace_id=d.workspace_id AND rl.id=d.receipt_line_id
  JOIN purchase_order_receipts r ON r.workspace_id=rl.workspace_id AND r.id=rl.receipt_id
  JOIN purchase_order_lines p ON p.workspace_id=rl.workspace_id AND p.id=rl.purchase_order_line_id
  JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id
  JOIN suppliers v ON v.workspace_id=o.workspace_id AND v.id=o.supplier_id AND v.status='active'
  JOIN skus s ON s.workspace_id=rl.workspace_id AND s.id=rl.sku_id AND s.is_active=1
  JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
  JOIN locations l ON l.workspace_id=rl.workspace_id AND l.id=rl.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
  WHERE d.workspace_id=$1 AND d.id=$2`,[ctx.workspaceId,reportId])).rows[0];
 if(!row)throw new ValidationError('Choose a staff damage report for an active supplier, product and owned receiving location.');
 const damaged=Number(row.quantity);
 if(row.tracking_mode!=='quantity'||Number(row.quantity_precision)!==0||row.secondary_unit_label||!Number.isSafeInteger(damaged)||damaged<1)
  throw new ValidationError('This claim workflow covers whole-unit quantity stock. Review lots, serials and measured goods separately.');
 if(row.unit_cost==null)throw new ValidationError('Record the purchase order price for this line before preparing a claim.');
 const {box,clock,ageDays}=await deliveryContext(c,ctx,row,connectorId,row.received_at);
 const currency=money.code(row.currency),unitCostMinor=money.userToMinor(String(row.unit_cost),currency,{label:'Recorded supplier unit cost'});
 const totalMinor=require('../domain/exact-quantity').costMinor(damaged,unitCostMinor);
 const evidence=photoIds.length?await photos.selectedFor(c,ctx,{reportId},photoIds,{automatic}):[];
 const p={claimKind:'report',reportId,reference,connectorId,mailboxAccount:box.provider_account_id,providerType:box.provider_type,
  supplierId:row.supplier_id,supplierName:row.supplier_name,recipient:row.email,currency,skuId:row.sku_id,sku:row.code,product:row.name,unit:row.unit_label,
  locationId:row.location_id,location:row.location_name,purchaseOrderId:row.purchase_order_id,poNumber:row.po_number,receiptId:row.receipt_id,
  receiptReference:row.receipt_reference||null,receivedAt:row.received_at,damagedQuantity:damaged,unitCostMinor,totalMinor,
  reportedBy:row.reported_by,reportedAt:new Date(row.reported_at).toISOString(),reportNote:row.note,photos:evidence,
  preparedAt:clock.instant,timeZone:clock.timeZone,...(remedy?{remedy}:{})};
 return {...p,ageDays,sourceFingerprint:hash(p)};
}

async function facts(c,ctx,{holdId,comparisonId,lineId,reportId,connectorId,photoIds=[],reference,remedy},{readOnly=false,automatic=false}={}){
 await owner(c,ctx,{lock:!readOnly});remedy=remedyOf(remedy);
 if(comparisonId)return shortageFacts(c,ctx,{comparisonId,lineId,connectorId,photoIds,reference,remedy},{automatic});
 if(reportId)return reportFacts(c,ctx,{reportId,connectorId,photoIds,reference,remedy},{automatic});
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
 if(row.tracking_mode!=='quantity'||Number(row.quantity_precision)!==0||row.secondary_unit_label)throw new ValidationError('This claim workflow covers whole-unit quantity stock. Review lots, serials and measured goods separately.');
 const {box,clock,ageDays}=await deliveryContext(c,ctx,row,connectorId,row.received_at);
 const currency=money.code(row.currency),unitCostMinor=money.userToMinor(String(row.unit_cost),currency,{label:'Recorded supplier unit cost'}),totalMinor=require('../domain/exact-quantity').costMinor(damaged,unitCostMinor);
 const evidence=photoIds.length?await photos.selected(c,ctx,holdId,photoIds,{automatic}):[];
 const p={holdId,qualityRevision:row.revision,reference,connectorId,mailboxAccount:box.provider_account_id,providerType:box.provider_type,
  supplierId:row.supplier_id,supplierName:row.supplier_name,recipient:row.email,currency,skuId:row.sku_id,sku:row.code,product:row.name,unit:row.unit_label,
  locationId:row.location_id,location:row.location_name,purchaseOrderId:row.purchase_order_id,poNumber:row.po_number,receiptId:row.receipt_id,
  receivedAt:row.received_at,damagedQuantity:damaged,unitCostMinor,totalMinor,inspectionBy:row.inspected_by,inspectionAt:row.inspected_at,
  inspectionNote:row.inspection.note,photos:evidence,preparedAt:clock.instant,timeZone:clock.timeZone,...(remedy?{remedy}:{})};
 return {...p,ageDays,sourceFingerprint:hash(p)};
}
// The remedy is part of the owner's authority: a rule that asks for credit
// never sends a claim asking for a refund.
function profile(p){return {supplierId:p.supplierId,supplierName:p.supplierName,recipient:p.recipient,currency:p.currency,skuId:p.skuId,sku:p.sku,product:p.product,unit:p.unit,locationId:p.locationId,location:p.location,connectorId:p.connectorId,mailboxAccount:p.mailboxAccount,providerType:p.providerType,timeZone:p.timeZone,
 ...(p.claimKind==='shortage'?{claimKind:p.claimKind,trackingMode:p.trackingMode,weightUnit:p.weightUnit,quantityPrecision:p.quantityPrecision,weightPrecision:p.weightPrecision}:{}),
 ...(p.remedy?{remedy:p.remedy}:{})};}
// The delivery evidence a claim's photos may come from.
function photoSource(p){return p.claimKind==='shortage'?{comparisonId:p.comparisonId,receiptIds:p.receiptLines.map(r=>r.id)}:p.reportId?{reportId:p.reportId}:{holdId:p.holdId};}
function units(p){return p.claimKind==='shortage'?p.missingUnits:p.damagedQuantity;}
function stable(p){const {preparedAt,ageDays,sourceFingerprint,...rest}=p;return rest;}
function when(p,value){return new Intl.DateTimeFormat('en-US',{timeZone:p.timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value))+' ('+p.timeZone+')';}
function quantityText(p){return p.claimKind==='shortage'?(p.missingWeight==null?p.missingUnits+' '+p.unit:p.missingWeight+' '+p.weightUnit):p.damagedQuantity+' '+p.unit;}
// One sentence that says exactly what the supplier is asked to do.
function ask(p){
 const value=money.format(p.totalMinor,p.currency);
 if(p.remedy==='credit')return ['We ask for a credit note for '+value+'.','Please reply to this email with your credit note number.'];
 if(p.remedy==='refund')return ['We ask for a refund of '+value+'.','Please reply to this email with the date you will send the refund.'];
 if(p.remedy==='replacement')return ['We ask for replacement goods: '+quantityText(p)+' of '+p.sku+' · '+p.product+'.','Please reply to this email with the date the replacement goods will ship.'];
 return null;
}
function valueLine(p,label){
 const each=p.claimKind==='shortage'&&p.missingWeight!=null?' per '+p.weightUnit:' each';
 return label+': '+quantityText(p)+' at '+money.format(p.unitCostMinor,p.currency)+each+' = '+money.format(p.totalMinor,p.currency)+' (freight and tax are separate).';
}
const settlementNote='This request does not accept a settlement or change payment, tax, stock or accounting records. Any credit, write-off or other disposition needs separate approval.';
function compose(p){
 const remedy=ask(p);
 if(p.claimKind==='shortage')return {subject:'Short delivery claim '+p.reference+' · '+p.poNumber,body:[
  'Hello '+p.supplierName+',','','Please open a shortage claim for purchase order '+p.poNumber+' under our reference '+p.reference+'.',
  'Delivery reference: '+p.deliveryReference,
  ...(remedy?['Received: '+when(p,p.receivedAt)+' · '+p.receiptLines.length+' receipt line'+(p.receiptLines.length===1?'':'s')]:[]),
  'Product: '+p.sku+' · '+p.product,
  p.expectedUnits+' '+p.unit+' due, '+p.observedUnits+' checked and received, '+p.missingUnits+' missing.',
  ...(p.missingWeight===null?[]:['Missing measured quantity: '+p.missingWeight+' '+p.weightUnit+'.']),
  ...(remedy?[valueLine(p,'Value at the purchase order price')]:['Recorded goods cost for the shortage: '+money.format(p.totalMinor,p.currency)+' (freight and tax are separate).']),'',
  ...(p.photos?.length?['Attached: '+p.photos.length+' resized cop'+(p.photos.length===1?'y':'ies')+' of our delivery photos. The original files remain preserved.','']:[]),
  ...(remedy?[...remedy,'We will review any settlement separately.']:['Please confirm this case and propose a replacement or credit note for review. We will review any settlement separately.']),'','Thank you.'
 ].join('\n')};
 const report=p.claimKind==='report';
 const lines=['Hello '+p.supplierName+',','','Please open a damage claim for purchase order '+p.poNumber+' under our reference '+p.reference+'.','',
  'Product: '+p.sku+' · '+p.product,
  (report?'Damaged on arrival, reported by our receiving team: ':'Physically inspected damaged quantity: ')+p.damagedQuantity+' '+p.unit,
  'Delivery recorded: '+when(p,p.receivedAt)+(p.receiptReference?' · delivery reference '+p.receiptReference:''),
  remedy?valueLine(p,'Value at the purchase order price'):'Recorded goods cost for these damaged units: '+money.format(p.totalMinor,p.currency)+' (freight and tax are separate).','',
  report?'Damage reported at receiving:':'Recorded physical findings:',report?p.reportNote:p.inspectionNote,'',
  ...(p.photos.length?['Attached: '+p.photos.length+' resized copies of the '+(report?'delivery':'inspection')+' photos. The original files remain preserved.','']:[]),
  ...(remedy?[...remedy,settlementNote]:['Please acknowledge this claim and propose replacement goods, collection or a credit note for review. '+settlementNote]),'','Thank you.'];
 return {subject:'Damaged delivery claim '+p.reference+' · '+p.poNumber,body:lines.join('\n')};
}
// A reminder for a sent claim that has had no answer.
function composeChase(p,{number,sentAt}){
 const original=compose(p),remedy=ask(p);
 return {subject:'Reminder '+number+': '+original.subject,body:[
  'Hello '+p.supplierName+',','',
  'We have not had a reply to our claim '+p.reference+' for purchase order '+p.poNumber+', sent '+when(p,sentAt)+'.',
  'Product: '+p.sku+' · '+p.product+' · '+quantityText(p)+(p.claimKind==='shortage'?' missing':' damaged')+' · '+money.format(p.totalMinor,p.currency)+' at the purchase order price.',
  ...(remedy||['Please confirm the claim and propose a replacement or credit note for review.']),'','Thank you.'
 ].join('\n')};
}
module.exports={owner,access,facts,profile,units,stable,compose,composeChase,quantityText,photoSource,REMEDIES,remedyOf};

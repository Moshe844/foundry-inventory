'use strict';
const {ValidationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions'),money=require('../domain/currency'),exact=require('../domain/exact-quantity');
const action='purchase_order.receive_from_document',receiptKey=s=>'receiving-document:'+s.source_hash;
async function source(db,ctx,reference,lock=false){
 const rows=(await db.query(`SELECT * FROM import_plans WHERE workspace_id=$1 AND (id=$2 OR lower(source_name)=lower($2)) ORDER BY created_at DESC LIMIT 2`+(lock?' FOR UPDATE':''),[ctx.workspaceId,reference])).rows;
 if(rows.length!==1)throw new ValidationError('Choose one exact packing-slip preview. Use its import ID when file names repeat.');return rows[0];
}
async function prior(db,ctx,s,orderId){
 const r=(await db.query("SELECT result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='purchase_order.receive' AND idempotency_key=$2 AND status='COMPLETED'",[ctx.workspaceId,receiptKey(s)])).rows[0];
 if(r&&r.result.purchaseOrderId!==orderId)throw new ValidationError('This delivery document already belongs to another recorded receipt. Review that receipt before reusing it.');return r?.result;
}
async function snapshot(db,ctx,orderId,reference,basis){
 if(!['stock','purchase'].includes(basis))throw new ValidationError('Confirm whether slip quantities are stock units or the purchase packs on the PO.');
 const s=await source(db,ctx,reference),order=(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,orderId])).rows[0];
 if(!order)throw new ValidationError('Choose a purchase order from this inventory.');
 const existing=await prior(db,ctx,s,orderId),base={recordId:orderId,sourceId:s.id,sourceHash:s.source_hash,sourceName:s.source_name,orderNumber:order.po_number};
 if(existing)return {...base,existing};
 const transforms=JSON.parse(s.transformations||'{}');
 if(s.status!=='READY'||s.approval_status!=='AWAITING_APPROVAL'||Date.parse(s.created_at)+86400000<Date.now())throw new ValidationError('Choose a fresh file preview that has not been approved as a stock import.');
 if(transforms.agentJob!==undefined&&transforms.agentJob!==43)throw new ValidationError('Continue this source through its existing approved task.');
 if((s.source_kind==='image'||transforms.visualSource)&&transforms.imageReadingConfirmed!==true)throw new ValidationError('Check and confirm the image reading before preparing a receiving form.');
 if(!['ORDERED','PARTIALLY_RECEIVED'].includes(order.status))throw new ValidationError('Choose a placed PO with goods still expected.');
 if((await db.query(`SELECT 1 FROM import_executions e JOIN import_plans p ON p.workspace_id=e.workspace_id AND p.id=e.import_id
  WHERE e.workspace_id=$1 AND p.source_hash=$2 AND e.status NOT IN ('FAILED','CANCELLED') LIMIT 1`,[ctx.workspaceId,s.source_hash])).rowCount)throw new ValidationError('This source already has a stock import attempt. Review its saved result before using it as a PO receipt.');
 const rows=(await db.query("SELECT row_number,raw::jsonb AS raw,parsed::jsonb AS parsed,status FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status<>'EXCLUDED' ORDER BY row_number LIMIT 501",[ctx.workspaceId,s.id])).rows;
 if(!rows.length||rows.length>500)throw new ValidationError('Prepare between 1 and 500 delivered source rows at a time.');
 const poColumns=JSON.parse(s.source_columns||'[]').filter(c=>/^(po|ponumber|poref|purchaseorder|purchaseordernumber|purchaseorderref)$/.test(c.name.toLowerCase().replace(/[^a-z0-9]/g,'')));
 const lines=(await db.query(`SELECT l.*,s.code,i.name,i.tracking_mode,i.unit_label,i.secondary_unit_label,i.quantity_precision,i.quantity_increment FROM purchase_order_lines l
  JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.id`,[ctx.workspaceId,order.id])).rows,selected=new Map();
 for(const row of rows){
  const p=row.parsed;
  for(const column of poColumns){const ref=String(row.raw[column.index]??'').trim().replace(/^#/,'');if(ref&&ref.toLowerCase()!==order.po_number.toLowerCase())throw new ValidationError('The purchase-order reference on the slip differs from '+order.po_number+'.');}
  if(row.status!=='VALID'||!p.existingSkuId||!Number.isFinite(Number(p.quantity))||Number(p.quantity)<=0)throw new ValidationError('Every delivered row needs one existing SKU and a positive, reviewed quantity. Resolve the file preview first.');
  const matches=lines.filter(l=>l.sku_id===p.existingSkuId);if(matches.length!==1)throw new ValidationError('Each source SKU must match one exact PO line and warehouse. Review split lines separately.');
  const line=matches[0];if(line.secondary_unit_label)throw new ValidationError(line.code+' needs its actual received weight. Use the tracked receiving form.');
  if(basis==='stock'&&String(p.unitLabel||'unit').toLowerCase()!==String(line.unit_label).toLowerCase())throw new ValidationError('Confirm the source unit of measure for '+line.code+' against the PO.');
  const quantity=require('../domain/stock-quantity').validate(line,exact.convert(p.quantity,{numerator:String(basis==='purchase'?line.units_per_purchase_unit:1),precision:Number(line.quantity_precision)}));
  const locationId=line.destination_location_id||order.destination_location_id;if(!locationId)throw new ValidationError('Choose the receiving warehouse on the PO first.');
  const entry=selected.get(line.id)||{lineId:line.id,skuId:line.sku_id,code:line.code,name:line.name,locationId,quantity:0,unitCostMinor:money.userToMinor(line.unit_cost,order.currency),serials:[],lotCode:null,expiresAt:null};
  if(selected.has(line.id)&&line.tracking_mode!=='serial')throw new ValidationError('Include each non-serial PO line once. Review split batches separately.');
  if(line.tracking_mode==='serial'){if(quantity!==1||!p.serial||entry.serials.includes(p.serial))throw new ValidationError('Provide each received serial exactly once, with one stock unit per source row.');entry.serials.push(p.serial);}
  if(line.tracking_mode==='lot'){if(!p.lotCode)throw new ValidationError('Record the received batch for '+line.code+'.');entry.lotCode=p.lotCode;entry.expiresAt=p.expiresAt||null;}
  entry.quantity=exact.safeNumber(exact.add(entry.quantity,quantity));if(entry.quantity>Number(line.quantity_units)-Number(line.quantity_received_units))throw new ValidationError('The slip exceeds the units still due for '+line.code+'. Review the difference with the supplier.');selected.set(line.id,entry);
 }
 const receiving=[...selected.values()],locations=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) AND is_active=1',[ctx.workspaceId,receiving.map(r=>r.locationId)])).rows;
 for(const r of receiving){r.locationName=locations.find(l=>l.id===r.locationId)?.name;if(!r.locationName)throw new ValidationError('A receiving warehouse is no longer active.');}
 return {...base,basis,currency:order.currency,receiving,fingerprint:hash({sourceHash:s.source_hash,integrityHash:s.integrity_hash,rows,order:{id:order.id,status:order.status,currency:order.currency},lines})};
}
async function build(db,ctx,row,args){
 await require('../commercial/agent-plan').requireWorkspaceJob(db,ctx.workspaceId,43,'draft');
 const p=await snapshot(db,ctx,row.id,args.sourceImport,args.receivingBasis);
 return {payload:p,summary:p.existing?'This delivery document already has a receipt for '+p.orderNumber+'. Recording it again adds no stock.':
  'Confirm the quantities physically received on '+p.orderNumber+' from '+p.sourceName+': '+p.receiving.map(r=>r.quantity+' × '+r.code+' at '+r.locationName+', approved cost '+money.format(r.unitCostMinor,p.currency)+' each'+(r.lotCode?', batch '+r.lotCode:'')+(r.serials.length?', '+r.serials.length+' serials':'')).join('; ')+'.'};
}
async function execute(db,ctx,p){
 if(!(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',['catalog:'+ctx.workspaceId])).rows[0].held)throw new ValidationError('An approved stock import or product update is running. This receipt stays ready; retry after it finishes.');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['receiving-doc:'+ctx.workspaceId+':'+p.sourceHash]);
 const s=await source(db,ctx,p.sourceId,true);if(s.source_hash!==p.sourceHash)throw new ValidationError('The delivery source changed. Review it again.');
 const existing=await prior(db,ctx,s,p.recordId);if(existing)return {...existing,replayed:true};
 await db.query('SELECT id FROM purchase_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.recordId]);
 const fresh=await snapshot(db,ctx,p.recordId,p.sourceId,p.basis);if(fresh.fingerprint!==p.fingerprint||hash(fresh.receiving)!==hash(p.receiving))throw new ValidationError('The delivery source or PO changed. Prepare a fresh receiving form.');
 await db.query("UPDATE import_plans SET transformations=(transformations::jsonb||jsonb_build_object('agentJob',43,'receivingOrderId',$3::text))::text WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,s.id,p.recordId]);
 return require('../operations/postgres-business-workflows').receivePurchaseOrderInTransaction(db,ctx,p.recordId,{idempotencyKey:receiptKey(s),reference:s.source_name,note:'Owner confirmed the quantities read from the delivery document.',
  lines:p.receiving.map(r=>({lineId:r.lineId,quantity:r.quantity,locationId:r.locationId,...(r.lotCode?{lotCode:r.lotCode,expiresAt:r.expiresAt}:{}),...(r.serials.length?{serials:r.serials}:{})}))});
}
async function verify(db,ctx,r,p){return Boolean(r.receiptId&&(await db.query('SELECT 1 FROM purchase_order_receipts WHERE workspace_id=$1 AND id=$2 AND purchase_order_id=$3 AND idempotency_key=$4',[ctx.workspaceId,r.receiptId,p.recordId,'receiving-document:'+p.sourceHash])).rowCount);}
async function review(db,ctx,{filter='',page=1}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId);
 const rows=(await db.query(`SELECT p.summary AS "Receiving form",CASE WHEN o.id IS NOT NULL THEN 'Goods received' WHEN p.status='PENDING' THEN 'Needs physical confirmation' ELSE initcap(lower(p.status)) END AS "Status",
  CASE WHEN o.id IS NOT NULL THEN '/purchasing/orders/'||(o.result->>'purchaseOrderId') ELSE '/actions/'||p.id END AS link
  FROM stockchief_runtime.assistant_action_proposals p LEFT JOIN stockchief_runtime.business_operations o ON o.workspace_id=p.workspace_id AND o.kind='purchase_order.receive'
   AND o.idempotency_key='receiving-document:'||(p.payload->>'sourceHash') AND o.status='COMPLETED'
  WHERE p.workspace_id=$1 AND p.action_type='purchase_order.receive_from_document' AND ($2='' OR lower(p.payload->>'orderNumber')=lower($2))
   AND ($3::timestamptz IS NULL OR p.created_at>=$3::timestamptz) ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,history.activityAfter,(page-1)*100])).rows;
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Prepared receiving forms and their recorded results. Confirm the quantities physically received before posting a pending form.'};
}
module.exports={snapshot,spec:{name:action,record:'purchase_order',fields:['recordReference','sourceImport','receivingBasis'],permission:require('../actions/permissions').RECEIVE_PO,ownerOnly:true,capability:'purchasing.core',resultingRecords:['purchase_order_receipts','movements','accounting_journal_entries'],
 description:'Fill a receiving confirmation from a fresh packing-slip preview and exact placed PO. Match existing SKUs, stock units or the PO purchase packs, warehouses, lots or serials. Use approved PO costs. A person must confirm physical receipt; broad mission approval cannot post it. No supplier bill or payment is created.',build,execute,verify},
 definition:{id:43,key:'receiving-forms',label:'Prepared receiving confirmations',filterLabel:'Purchase order number',readPage:review}};

'use strict';

const { inTransaction } = require('../db');
const engine = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const permissions = require('../actions/permissions');
const refunds = require('../accounting/refunds');
const supplierCredits = require('../accounting/supplier-credits');
const sales = require('../sales/sales-order-service');
const provenance = require('../provenance/service');
const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso, requireText, requirePositiveInt, requireOneOf, trimOrNull } = require('../lib/util');

function nextNumber(db, workspaceId, table, column, prefix) {
  const rows=db.prepare(`SELECT ${column} AS n FROM ${table} WHERE workspace_id=?`).all(workspaceId);
  let highest=1000;
  rows.forEach((row)=>{const match=String(row.n||'').match(new RegExp(`^${prefix}-(\\d+)$`,'i'));if(match)highest=Math.max(highest,Number(match[1]));});
  return `${prefix}-${highest+1}`;
}
function parseIds(value){try{return JSON.parse(value||'[]');}catch{return [];}}

function fulfilledIdentityMovements(db,workspaceId,salesOrderLineId){
  const order=db.prepare('SELECT sales_order_id FROM sales_order_lines WHERE workspace_id=? AND id=?').get(workspaceId,salesOrderLineId);
  if(!order)return [];
  const ids=[];
  for(const event of db.prepare("SELECT detail FROM sales_order_events WHERE workspace_id=? AND sales_order_id=? AND event_type IN ('FULFILLED','PARTIALLY_FULFILLED')").all(workspaceId,order.sales_order_id)){
    let detail={};try{detail=JSON.parse(event.detail||'{}');}catch{detail={};}
    for(const line of detail.fulfilled||[])if(line.lineId===salesOrderLineId)ids.push(...(line.movementIds||[]));
  }
  if(!ids.length)return [];
  const read=db.prepare('SELECT m.id,m.lot_id,m.serial_unit_id,su.serial FROM movements m LEFT JOIN serial_units su ON su.id=m.serial_unit_id WHERE m.workspace_id=? AND m.id=?');
  return ids.map((id)=>read.get(workspaceId,id)).filter(Boolean);
}

function getCustomerReturn(db,workspaceId,id){
  const row=db.prepare(`SELECT r.*,so.order_number,c.name AS customer_name,q.name AS quarantine_name
    FROM customer_returns r JOIN sales_orders so ON so.id=r.sales_order_id JOIN customers c ON c.id=so.customer_id
    JOIN locations q ON q.id=r.quarantine_location_id WHERE r.workspace_id=? AND r.id=?`).get(workspaceId,id);
  if(!row)throw new NotFoundError('That customer return could not be found.');
  row.lines=db.prepare(`SELECT l.*,sol.quantity_fulfilled,s.code AS sku_code,i.name AS item_name,s.variant_label,i.tracking_mode
    FROM customer_return_lines l JOIN sales_order_lines sol ON sol.id=l.sales_order_line_id
    JOIN skus s ON s.id=l.sku_id JOIN items i ON i.id=s.item_id WHERE l.customer_return_id=? ORDER BY l.created_at`).all(id)
    .map((line)=>({...line,receiveMovementIds:parseIds(line.receive_movement_ids),dispositionMovementIds:parseIds(line.disposition_movement_ids)}));
  return row;
}

function requestCustomerReturn(db,ctx,membership,input){
  permissions.assertCan(membership,permissions.AUTHORIZE_CUSTOMER_RETURN,'authorize customer returns');
  return inTransaction(db,()=>{
    const order=sales.getOrder(db,ctx.workspaceId,requireText(input.salesOrderId,'Customer order'));
    if(!['PARTIALLY_FULFILLED','FULFILLED'].includes(order.status))throw new ValidationError('Only goods that actually left can be returned.');
    const quarantine=repo.requireLocation(db,ctx.workspaceId,requireText(input.quarantineLocationId,'Quarantine location'));
    const resolution=requireOneOf(String(input.resolution||'REFUND').toUpperCase(),['REFUND','EXCHANGE','NO_REFUND'],'Return resolution');
    const requested=Array.isArray(input.lines)?input.lines:[];
    if(!requested.length)throw new ValidationError('Choose at least one fulfilled order line to return.');
    const id=newId('rma');const at=nowIso();
    db.prepare(`INSERT INTO customer_returns
      (id,workspace_id,return_number,sales_order_id,status,resolution,reason,quarantine_location_id,created_by_user_id,created_at)
      VALUES (?,?,?,?,'REQUESTED',?,?,?,?,?)`).run(id,ctx.workspaceId,nextNumber(db,ctx.workspaceId,'customer_returns','return_number','RMA'),order.id,resolution,trimOrNull(input.reason),quarantine.id,ctx.actorId,at);
    provenance.record(db,ctx.workspaceId,{type:'RETURN_OF',from:{type:'customer_return',id},to:{type:'sales_order',id:order.id}});
    const add=db.prepare(`INSERT INTO customer_return_lines
      (id,workspace_id,customer_return_id,sales_order_line_id,sku_id,quantity_authorized,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    for(const raw of requested){
      const line=order.lines.find((candidate)=>candidate.id===raw.salesOrderLineId);
      if(!line)throw new ValidationError('A selected return line is not on that order.');
      const quantity=requirePositiveInt(raw.quantity,'Return quantity');
      const prior=Number(db.prepare(`SELECT COALESCE(SUM(l.quantity_authorized),0) AS n FROM customer_return_lines l
        JOIN customer_returns r ON r.id=l.customer_return_id WHERE r.workspace_id=? AND l.sales_order_line_id=? AND r.status<>'CANCELLED'`).get(ctx.workspaceId,line.id).n);
      if(prior+quantity>Number(line.quantity_fulfilled))throw new ValidationError(`${line.displayName}: the return quantity exceeds what actually left.`);
      const lineId=newId('rmal');add.run(lineId,ctx.workspaceId,id,line.id,line.sku_id,quantity,at,at);
      provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'customer_return',id},to:{type:'customer_return_line',id:lineId}});
    }
    return getCustomerReturn(db,ctx.workspaceId,id);
  });
}

function authorizeCustomerReturn(db,ctx,membership,id){
  permissions.assertCan(membership,permissions.AUTHORIZE_CUSTOMER_RETURN,'authorize customer returns');
  const row=getCustomerReturn(db,ctx.workspaceId,id);
  if(row.status==='AUTHORIZED')return row;
  if(row.status!=='REQUESTED')throw new ValidationError('Only a requested return can be authorized.');
  db.prepare("UPDATE customer_returns SET status='AUTHORIZED',authorized_by_user_id=?,authorized_at=? WHERE id=? AND workspace_id=?")
    .run(ctx.actorId,nowIso(),id,ctx.workspaceId);
  return getCustomerReturn(db,ctx.workspaceId,id);
}

function receiveCustomerReturn(db,ctx,membership,id,input){
  permissions.assertCan(membership,permissions.INSPECT_CUSTOMER_RETURN,'receive customer returns');
  return inTransaction(db,()=>{
    const row=getCustomerReturn(db,ctx.workspaceId,id);
    if(!['AUTHORIZED','PARTIALLY_RECEIVED'].includes(row.status))throw new ValidationError('Authorize this return before receiving it.');
    const received=Array.isArray(input.lines)?input.lines:[];
    if(!received.length)throw new ValidationError('Record what physically arrived.');
    for(const raw of received){
      const line=row.lines.find((candidate)=>candidate.id===raw.lineId);if(!line)throw new ValidationError('That product is not authorized on this return.');
      const quantity=requirePositiveInt(raw.quantity,'Received quantity');
      if(Number(line.quantity_received)+quantity>Number(line.quantity_authorized))throw new ValidationError(`${line.item_name}: received quantity exceeds the authorization.`);
      const proven=fulfilledIdentityMovements(db,ctx.workspaceId,line.sales_order_line_id);
      let exact={};
      if(line.tracking_mode==='lot'){
        const lot=repo.getLotByCode(db,ctx.workspaceId,line.sku_id,requireText(raw.lotCode,'Returned lot'));
        if(!lot||!proven.some((movement)=>movement.lot_id===lot.id))throw new ValidationError(`${line.item_name}: that lot is not proven to have left on this customer order.`);
        exact={lotId:lot.id};
      }
      if(line.tracking_mode==='serial'){
        const serials=(Array.isArray(raw.serials)?raw.serials:[]).map((x)=>String(x).trim()).filter(Boolean);
        if(serials.length!==quantity)throw new ValidationError(`${line.item_name}: scan every returned serial number.`);
        const bySerial=new Map(proven.filter((movement)=>movement.serial_unit_id).map((movement)=>[String(movement.serial).toLowerCase(),movement.serial_unit_id]));
        const ids=serials.map((serial)=>bySerial.get(serial.toLowerCase()));
        if(ids.some((id)=>!id)||new Set(ids).size!==ids.length)throw new ValidationError(`${line.item_name}: one serial number is not proven to have left on this customer order.`);
        exact={returnSerialUnitIds:ids,returnCondition:'unknown'};
      }
      const movement=engine.receive(db,ctx,{skuId:line.sku_id,locationId:row.quarantine_location_id,quantity,
        reasonCode:'customer_return',reference:row.return_number,notes:'Received into quarantine; condition not yet decided.',
        ...exact});
      if(Number(movement.quantity)!==quantity)throw new ValidationError(`${line.item_name}: the scanned identities do not equal the received quantity.`);
      const ids=[...line.receiveMovementIds,...movement.movementIds];
      movement.movementIds.forEach((movementId)=>provenance.record(db,ctx.workspaceId,{type:'CAUSED_MOVEMENT',from:{type:'customer_return_line',id:line.id},to:{type:'inventory_movement',id:movementId}}));
      db.prepare(`UPDATE customer_return_lines SET quantity_received=quantity_received+?,receive_movement_ids=?,tracking_evidence=?,updated_at=? WHERE id=?`)
        .run(quantity,JSON.stringify(ids),JSON.stringify({lotCode:raw.lotCode||null,serials:raw.serials||null}),nowIso(),line.id);
    }
    const after=getCustomerReturn(db,ctx.workspaceId,id);
    const complete=after.lines.every((line)=>Number(line.quantity_received)===Number(line.quantity_authorized));
    db.prepare("UPDATE customer_returns SET status=?,received_at=CASE WHEN ? THEN COALESCE(received_at,?) ELSE received_at END WHERE id=?")
      .run(complete?'RECEIVED':'PARTIALLY_RECEIVED',complete?1:0,nowIso(),id);
    return getCustomerReturn(db,ctx.workspaceId,id);
  });
}

function movementIdentity(db, movementId){return db.prepare('SELECT lot_id,serial_unit_id FROM movements WHERE id=?').get(movementId)||{};}

function inspectCustomerReturn(db,ctx,membership,id,input){
  permissions.assertCan(membership,permissions.INSPECT_CUSTOMER_RETURN,'inspect customer returns');
  return inTransaction(db,()=>{
    const row=getCustomerReturn(db,ctx.workspaceId,id);
    if(row.status!=='RECEIVED')throw new ValidationError('Receive the returned goods into quarantine before inspecting them.');
    const decisions=Array.isArray(input.lines)?input.lines:[];
    if(!decisions.length)throw new ValidationError('Record the physical condition and disposition of every returned unit.');
    for(const line of row.lines){
      const decision=decisions.find((candidate)=>candidate.lineId===line.id);if(!decision)throw new ValidationError(`${line.item_name}: choose restock, scrap, or repair.`);
      const restock=Number(decision.restock||0),scrap=Number(decision.scrap||0),repair=Number(decision.repair||0);
      if([restock,scrap,repair].some((n)=>!Number.isInteger(n)||n<0)||restock+scrap+repair!==Number(line.quantity_received))throw new ValidationError(`${line.item_name}: dispositions must total the ${line.quantity_received} units received.`);
      const movementIds=[];let serialOffset=0;
      const sourceIdentities=line.receiveMovementIds.map((movementId)=>movementIdentity(db,movementId));
      const base={skuId:line.sku_id,fromLocationId:row.quarantine_location_id,reference:row.return_number};
      const run=(quantity,destination,kind)=>{
        if(!quantity)return;
        const serialIds=sourceIdentities.filter((x)=>x.serial_unit_id).map((x)=>x.serial_unit_id);
        const tracking=line.tracking_mode==='lot'?{lotId:sourceIdentities.find((x)=>x.lot_id)?.lot_id}
          :line.tracking_mode==='serial'?{serialUnitIds:serialIds.slice(serialOffset,serialOffset+quantity)}:{};
        serialOffset+=quantity;
        const result=kind==='scrap'?engine.issue(db,ctx,{skuId:line.sku_id,locationId:row.quarantine_location_id,quantity,reasonCode:'damaged',reference:row.return_number,...tracking})
          :engine.transfer(db,ctx,{...base,toLocationId:requireText(destination,kind==='repair'?'Repair location':'Restock location'),quantity,...tracking});
        movementIds.push(...result.movementIds);
        result.movementIds.forEach((movementId)=>provenance.record(db,ctx.workspaceId,{type:'CAUSED_MOVEMENT',from:{type:'customer_return_line',id:line.id},to:{type:'inventory_movement',id:movementId}}));
      };
      run(restock,decision.restockLocationId,'restock');run(scrap,null,'scrap');run(repair,decision.repairLocationId,'repair');
      db.prepare(`UPDATE customer_return_lines SET quantity_restocked=?,quantity_scrapped=?,quantity_repair=?,condition_note=?,disposition_movement_ids=?,updated_at=? WHERE id=?`)
        .run(restock,scrap,repair,trimOrNull(decision.conditionNote),JSON.stringify(movementIds),nowIso(),line.id);
    }
    const status=row.resolution==='NO_REFUND'?'COMPLETED':row.resolution==='REFUND'?'AWAITING_REFUND':'INSPECTED';const at=nowIso();
    db.prepare('UPDATE customer_returns SET status=?,inspected_by_user_id=?,inspected_at=?,completed_at=? WHERE id=?').run(status,ctx.actorId,at,status==='COMPLETED'?at:null,id);
    return getCustomerReturn(db,ctx.workspaceId,id);
  });
}

function refundCustomerReturn(db,ctx,membership,id,input){
  permissions.assertCan(membership,permissions.REFUND_CUSTOMER_RETURN,'approve customer refunds');
  return inTransaction(db,()=>{
    const row=getCustomerReturn(db,ctx.workspaceId,id);
    if(row.resolution!=='REFUND'||row.status!=='AWAITING_REFUND')throw new ValidationError('This return is not waiting for a refund.');
    const original=db.prepare(`SELECT id FROM accounting_journal_entries WHERE workspace_id=? AND source_type='sales_fulfillment'
      AND json_extract(metadata,'$.salesOrderId')=? AND status='POSTED' ORDER BY posting_date LIMIT 1`).get(ctx.workspaceId,row.sales_order_id);
    if(!original)throw new ValidationError('Foundry cannot refund this return until the original fulfilled sale has a posted accounting entry.');
    const movementIds=row.lines.flatMap((line)=>line.receiveMovementIds);
    const result=refunds.refundSale(db,ctx,membership,{originalJournalEntryId:original.id,revenueMinor:Number(input.revenueMinor),taxMinor:Number(input.taxMinor||0),cogsMinor:Number(input.cogsMinor||0),physicalReturn:true,movementIds,destination:input.destination||'CASH',reference:row.return_number,sourceKey:`customer-return:${row.id}`});
    const at=nowIso();db.prepare("UPDATE customer_returns SET status='COMPLETED',refund_id=?,completed_at=? WHERE id=?").run(result.refund.id,at,id);
    provenance.record(db,ctx.workspaceId,{type:'RESOLVED_BY',from:{type:'customer_return',id},to:{type:'sale_refund',id:result.refund.id}});
    return getCustomerReturn(db,ctx.workspaceId,id);
  });
}

function exchangeCustomerReturn(db,ctx,membership,id,input){
  permissions.assertCan(membership,permissions.REFUND_CUSTOMER_RETURN,'approve return exchanges');
  return inTransaction(db,()=>{
    const row=getCustomerReturn(db,ctx.workspaceId,id);if(row.resolution!=='EXCHANGE'||row.status!=='INSPECTED')throw new ValidationError('This return is not waiting for an exchange.');
    const original=sales.getOrder(db,ctx.workspaceId,row.sales_order_id);
    const exchange=sales.createOrder(db,ctx,{customerId:original.customer_id,orderDate:nowIso().slice(0,10),deliveryMethod:original.delivery_method,shipToAddress:original.ship_to_address,reference:`Exchange for ${row.return_number}`,lines:input.lines,requirePrices:true});
    if(input.confirm!==false)sales.confirm(db,ctx,exchange.id,{idempotencyKey:`return-exchange:${row.id}`});
    db.prepare("UPDATE customer_returns SET status='COMPLETED',exchange_order_id=?,completed_at=? WHERE id=?").run(exchange.id,nowIso(),id);
    provenance.record(db,ctx.workspaceId,{type:'RESOLVED_BY',from:{type:'customer_return',id},to:{type:'sales_order',id:exchange.id}});
    return getCustomerReturn(db,ctx.workspaceId,id);
  });
}

function getSupplierReturn(db,workspaceId,id){const row=db.prepare(`SELECT r.*,s.name AS supplier_name FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id WHERE r.workspace_id=? AND r.id=?`).get(workspaceId,id);if(!row)throw new NotFoundError('That supplier return could not be found.');row.lines=db.prepare(`SELECT l.*,sk.code AS sku_code,i.name AS item_name,loc.name AS location_name,i.tracking_mode FROM supplier_return_lines l JOIN skus sk ON sk.id=l.sku_id JOIN items i ON i.id=sk.item_id JOIN locations loc ON loc.id=l.location_id WHERE l.supplier_return_id=?`).all(id).map((line)=>({...line,movementIds:parseIds(line.movement_ids),serialUnitIds:parseIds(line.serial_unit_ids)}));return row;}

function requestSupplierReturn(db,ctx,membership,input){permissions.assertCan(membership,permissions.AUTHORIZE_SUPPLIER_RETURN,'authorize supplier returns');return inTransaction(db,()=>{const supplier=db.prepare('SELECT * FROM suppliers WHERE workspace_id=? AND id=?').get(ctx.workspaceId,requireText(input.supplierId,'Supplier'));if(!supplier)throw new ValidationError('Choose a supplier from this inventory.');const lines=Array.isArray(input.lines)?input.lines:[];if(!lines.length)throw new ValidationError('Choose stock to return.');const id=newId('rtv'),at=nowIso();const supplierBillId=trimOrNull(input.supplierBillId);db.prepare(`INSERT INTO supplier_returns (id,workspace_id,return_number,supplier_id,supplier_bill_id,status,expected_credit_minor,reason,created_by_user_id,created_at) VALUES (?,?,?,?,?,'REQUESTED',?,?,?,?)`).run(id,ctx.workspaceId,nextNumber(db,ctx.workspaceId,'supplier_returns','return_number','RTV'),supplier.id,supplierBillId,input.expectedCreditMinor===''||input.expectedCreditMinor==null?null:Number(input.expectedCreditMinor),trimOrNull(input.reason),ctx.actorId,at);if(supplierBillId)provenance.record(db,ctx.workspaceId,{type:'RETURN_OF',from:{type:'supplier_return',id},to:{type:'supplier_bill',id:supplierBillId}});const add=db.prepare(`INSERT INTO supplier_return_lines (id,workspace_id,supplier_return_id,sku_id,location_id,lot_id,serial_unit_ids,quantity,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);lines.forEach((line)=>{const sku=repo.requireSku(db,ctx.workspaceId,line.skuId);repo.requireLocation(db,ctx.workspaceId,line.locationId);const quantity=requirePositiveInt(line.quantity,'Return quantity');const serialIds=Array.isArray(line.serialUnitIds)?line.serialUnitIds:[];if(sku.tracking_mode==='serial'&&serialIds.length!==quantity)throw new ValidationError('Name every serial unit being returned to the supplier.');if(sku.tracking_mode==='lot'&&!line.lotId)throw new ValidationError('Name the exact lot being returned to the supplier.');const lineId=newId('rtvl');add.run(lineId,ctx.workspaceId,id,line.skuId,line.locationId,trimOrNull(line.lotId),JSON.stringify(serialIds),quantity,trimOrNull(line.reason),at);provenance.record(db,ctx.workspaceId,{type:'HAS_PART',from:{type:'supplier_return',id},to:{type:'supplier_return_line',id:lineId}});});return getSupplierReturn(db,ctx.workspaceId,id);});}

function authorizeSupplierReturn(db,ctx,membership,id){permissions.assertCan(membership,permissions.AUTHORIZE_SUPPLIER_RETURN,'authorize supplier returns');const row=getSupplierReturn(db,ctx.workspaceId,id);if(row.status==='AUTHORIZED')return row;if(row.status!=='REQUESTED')throw new ValidationError('Only a requested supplier return can be authorized.');db.prepare("UPDATE supplier_returns SET status='AUTHORIZED',authorized_by_user_id=?,authorized_at=? WHERE id=?").run(ctx.actorId,nowIso(),id);return getSupplierReturn(db,ctx.workspaceId,id);}

function shipSupplierReturn(db,ctx,membership,id){permissions.assertCan(membership,permissions.SHIP_SUPPLIER_RETURN,'ship supplier returns');return inTransaction(db,()=>{const row=getSupplierReturn(db,ctx.workspaceId,id);if(row.status==='SHIPPED'||row.status==='AWAITING_CREDIT')return row;if(row.status!=='AUTHORIZED')throw new ValidationError('Authorize this supplier return before shipping it.');row.lines.forEach((line)=>{const result=engine.issue(db,ctx,{skuId:line.sku_id,locationId:line.location_id,quantity:Number(line.quantity),reasonCode:'returned',reference:row.return_number,...(line.tracking_mode==='lot'?{lotId:line.lot_id}:{}),...(line.tracking_mode==='serial'?{serialUnitIds:line.serialUnitIds}:{})});db.prepare('UPDATE supplier_return_lines SET movement_ids=? WHERE id=?').run(JSON.stringify(result.movementIds),line.id);result.movementIds.forEach((movementId)=>provenance.record(db,ctx.workspaceId,{type:'CAUSED_MOVEMENT',from:{type:'supplier_return_line',id:line.id},to:{type:'inventory_movement',id:movementId}}));});db.prepare("UPDATE supplier_returns SET status='AWAITING_CREDIT',shipped_at=? WHERE id=?").run(nowIso(),id);return getSupplierReturn(db,ctx.workspaceId,id);});}

function reconcileSupplierReturn(db,ctx,membership,id,input){permissions.assertCan(membership,permissions.RECONCILE_SUPPLIER_RETURN,'reconcile supplier credits');return inTransaction(db,()=>{const row=getSupplierReturn(db,ctx.workspaceId,id);if(!['AWAITING_CREDIT','CREDIT_MISMATCH'].includes(row.status))throw new ValidationError('This supplier return is not waiting for a credit.');if(!row.supplier_bill_id)throw new ValidationError('Match the supplier return to the bill the credit reduces.');const amount=Number(input.amountMinor);const result=supplierCredits.record(db,ctx,membership,{billId:row.supplier_bill_id,amountMinor:amount,creditNumber:input.creditNumber,creditDate:input.creditDate,reason:`Supplier return ${row.return_number}`,sourceKey:`supplier-return:${row.id}`});const matches=row.expected_credit_minor==null||Number(row.expected_credit_minor)===amount;db.prepare(`UPDATE supplier_returns SET actual_credit_minor=?,supplier_credit_id=?,status=?,reconciled_at=? WHERE id=?`).run(amount,result.credit.id,matches?'RECONCILED':'CREDIT_MISMATCH',matches?nowIso():null,id);provenance.record(db,ctx.workspaceId,{type:'RESOLVED_BY',from:{type:'supplier_return',id},to:{type:'supplier_credit',id:result.credit.id}});return getSupplierReturn(db,ctx.workspaceId,id);});}

function listReturns(db,workspaceId){return {customers:db.prepare(`SELECT r.*,so.order_number,c.name AS customer_name FROM customer_returns r JOIN sales_orders so ON so.id=r.sales_order_id JOIN customers c ON c.id=so.customer_id WHERE r.workspace_id=? ORDER BY r.created_at DESC`).all(workspaceId),suppliers:db.prepare(`SELECT r.*,s.name AS supplier_name FROM supplier_returns r JOIN suppliers s ON s.id=r.supplier_id WHERE r.workspace_id=? ORDER BY r.created_at DESC`).all(workspaceId)};}

module.exports={requestCustomerReturn,authorizeCustomerReturn,receiveCustomerReturn,inspectCustomerReturn,refundCustomerReturn,exchangeCustomerReturn,getCustomerReturn,requestSupplierReturn,authorizeSupplierReturn,shipSupplierReturn,reconcileSupplierReturn,getSupplierReturn,listReturns};

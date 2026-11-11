'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const calculator=require('../pricing/calculator');
const json=value=>typeof value==='string'?JSON.parse(value):value;

async function read(db,ctx,salesOrderLineId){
  const entries=(await db.query(`SELECT * FROM accounting_journal_entries WHERE workspace_id=$1
    AND source_type='sale_fulfillment' AND status='POSTED' AND metadata::jsonb->>'salesOrderLineId'=$2
    AND metadata::jsonb?'supplierDirect' ORDER BY posted_at,created_at,id`,[ctx.workspaceId,salesOrderLineId])).rows;
  if(!entries.length)return [];
  const proofs=(await db.query(`SELECT x.*,l.sales_order_line_id,d.state,d.original,d.purchase_receipt_id,
    (SELECT coalesce(sum(j.credit_minor-j.debit_minor),0) FROM accounting_journal_lines j
      JOIN accounting_accounts a ON a.workspace_id=j.workspace_id AND a.id=j.account_id
      WHERE j.workspace_id=x.workspace_id AND j.entry_id=x.journal_entry_id AND a.system_key='RECEIVED_NOT_INVOICED')::text AS rni,
    EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=x.workspace_id
      AND r.reversal_of_entry_id=x.journal_entry_id AND r.status='POSTED') AS reversed
    FROM stockchief_runtime.agent_direct_dispatch_lines x
    JOIN stockchief_runtime.agent_direct_dispatches d ON d.workspace_id=x.workspace_id AND d.id=x.dispatch_id
    JOIN stockchief_runtime.agent_direct_order_lines l ON l.workspace_id=x.workspace_id AND l.id=x.direct_order_line_id
    WHERE x.workspace_id=$1 AND x.journal_entry_id=ANY($2::text[])`,[ctx.workspaceId,entries.map(entry=>entry.id)])).rows;
  const serials=(await db.query(`SELECT d.dispatch_line_id,u.id,u.serial,u.lot_id,u.secondary_quantity,u.status
    FROM stockchief_runtime.agent_direct_serial_units d JOIN serial_units u ON u.workspace_id=d.workspace_id AND u.id=d.serial_unit_id
    WHERE d.workspace_id=$1 AND d.dispatch_line_id=ANY($2::text[])`,[ctx.workspaceId,proofs.map(proof=>proof.id)])).rows;
  const result=[];
  for(const entry of entries){
    const metadata=json(entry.metadata),direct=metadata.supplierDirect,proof=proofs.find(proof=>proof.journal_entry_id===entry.id);
    if(!proof||proof.state!=='APPLIED'||proof.reversed||proof.sales_order_line_id!==salesOrderLineId||
      proof.id!==direct.dispatchLineId||proof.purchase_receipt_id!==direct.receiptId||Number(proof.rni)!==Number(proof.cost_minor)||
      Number(metadata.cogsMinor)!==Number(proof.cost_minor)||exact.canonical(metadata.quantity)!==exact.canonical(proof.quantity))
      throw new ValidationError('The original supplier-direct dispatch and its posted cost need reconciliation before receiving a return.');
    const lots=direct.lots||[],units=direct.serials||[],identity=direct.trackingIdentity||{};
    const parts=lots.length?lots.map((batch,index)=>({quantity:batch.quantity,secondaryQuantity:batch.secondaryQuantity,
      lotId:identity.lotIds[index]})):units.length?units.map(unit=>{
      const native=serials.find(serial=>serial.dispatch_line_id===proof.id&&serial.serial===unit.serial);
      if(!native||!identity.serialUnitIds.includes(native.id))throw new ValidationError('The supplier’s original serial identity needs reconciliation before this return.');
      return {quantity:1,secondaryQuantity:unit.weight,lotId:native.lot_id,serialUnitId:native.id,serial:unit.serial};
    }):[{quantity:Number(proof.quantity),secondaryQuantity:proof.secondary_quantity==null?null:Number(proof.secondary_quantity)}];
    const measure=direct.secondaryQuantity??Number(proof.quantity);
    let before='0';
    for(const [index,part] of parts.entries()){
      if(lots.length&&!part.lotId)throw new ValidationError('The supplier’s original batch identity needs reconciliation before this return.');
      const size=part.secondaryQuantity??part.quantity;
      const pricing=calculator.monetaryPortion(metadata,measure,Number(before),Number(size));
      const cost=calculator.monetaryPortion({grossMinor:Number(proof.cost_minor),discountMinor:0,taxMinor:0},measure,Number(before),Number(size)).grossMinor;
      result.push({evidenceId:'supplier-direct:'+proof.id+':'+index,inventoryMovementId:null,
        originalJournalEntryId:entry.id,quantity:Number(part.quantity),secondaryQuantity:part.secondaryQuantity,
        costMinor:cost,lotId:part.lotId||null,directSerialUnitId:part.serialUnitId||null,directSerial:part.serial||null,
        pricing:{...pricing,supplierDirect:{dispatchLineId:proof.id},allocationVersion:2}});
      before=exact.add(before,size);
    }
  }
  return result;
}

module.exports={read};

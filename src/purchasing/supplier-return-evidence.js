
'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const exact=require('../domain/exact-quantity'),units=require('../domain/stock-quantity');
const money=require('../domain/currency'),policy=require('../commercial/agent-plan');
const JOB=115,ACTION='supplier_return.request';
const cases='stockchief_runtime.agent_supplier_return_cases',sources='stockchief_runtime.agent_supplier_return_lines';
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const expected=error=>[400,402,403,404,409,422].includes(error.status);

async function owner(db,ctx,{lock=false}={}){
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`+
    (lock?' FOR SHARE OF u,w':''),[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can authorize supplier return routines or credit.');
}
async function access(db,ctx,{lock=false,automatic=false,trained=false,stop=false}={}){
  await owner(db,ctx,{lock});
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,JOB,automatic?'automatic':'draft',{trained});
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'returns.core');
  if(stop){
    if(lock)await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,ACTION,automatic);
    if(reason)throw new ValidationError(reason);
    if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine supplier returns are paused.');
  }
  return state;
}
async function lookup(db,workspaceId,returnId,{lock=false}={}){
  return (await db.query('SELECT * FROM '+cases+' WHERE workspace_id=$1 AND return_id=$2'+(lock?' FOR UPDATE':''),
    [workspaceId,returnId])).rows[0];
}
async function bill(db,ctx,id,{lock=false}={}){
  const b=(await db.query(`SELECT b.*,p.po_number,s.name supplier_name FROM accounting_supplier_bills b
    JOIN purchase_orders p ON p.workspace_id=b.workspace_id AND p.id=b.purchase_order_id AND p.supplier_id=b.supplier_id
    JOIN suppliers s ON s.workspace_id=b.workspace_id AND s.id=b.supplier_id AND s.status='active'
    JOIN accounting_settings a ON a.workspace_id=b.workspace_id AND a.enabled=1 AND a.base_currency=b.currency
    JOIN accounting_journal_entries j ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED'
    WHERE b.workspace_id=$1 AND b.id=$2 AND b.status IN('OPEN','PARTIALLY_PAID','PAID')
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')`+
    (lock?' FOR UPDATE OF b':''),[ctx.workspaceId,id])).rows[0];
  if(!b)throw new ValidationError('Choose the exact posted bill for the original receipt in the accounting currency.');
  return b;
}
async function receipts(db,ctx,purchaseId,ids=null){
  return (await db.query(`SELECT l.id,l.sku_id,l.location_id,l.lot_id,l.lot_code,l.serials,l.quantity_units,l.secondary_quantity,l.movement_ids,
    l.purchase_order_line_id,r.reference,r.received_at,s.code,i.name,i.tracking_mode,i.unit_label,i.quantity_precision,i.quantity_increment,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment,h.id hold_id,h.revision hold_revision,h.status hold_status,
    h.inspection,h.quantity hold_quantity,h.returned_quantity,h.written_off_quantity,loc.name location_name
    FROM purchase_order_receipt_lines l JOIN purchase_order_receipts r ON r.workspace_id=l.workspace_id AND r.id=l.receipt_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id AND loc.is_active=1 AND loc.custody_agreement_id IS NULL
    LEFT JOIN stockchief_runtime.agent_quality_holds h ON h.workspace_id=l.workspace_id AND h.receipt_line_id=l.id
    WHERE l.workspace_id=$1 AND r.purchase_order_id=$2 AND ($3::text[] IS NULL OR l.id=ANY($3))
    ORDER BY r.received_at DESC,l.id`,[ctx.workspaceId,purchaseId,ids])).rows;
}

async function confirmLines(db,ctx,b,input,{caseId=null}={}){
  const supplied=input.lines;
  if(!Array.isArray(supplied)||!supplied.length||new Set(supplied.map(l=>l.receiptLineId)).size!==supplied.length)throw new ValidationError('Choose each exact receipt line once.');
  const ids=supplied.map(l=>l.receiptLineId).sort();
  for(const id of ids)await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['supplier-return-receipt:'+ctx.workspaceId+':'+id]);
  const rows=await receipts(db,ctx,b.purchase_order_id,ids);
  if(rows.length!==ids.length)throw new ValidationError('Every selected physical receipt must belong to this bill’s purchase order.');
  await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,rows.map(r=>r.location_id));
  const lines=[];
  for(const r of rows){
    const raw=supplied.find(l=>l.receiptLineId===r.id),qty=units.validate(r,raw.quantity,{label:'Faulty goods quantity'});
    const weight=units.secondary(r,raw.secondaryQuantity);
    const primaryAtoms=n=>exact.atoms(n,Number(r.quantity_precision));
    const weightAtoms=n=>exact.atoms(n,Number(r.secondary_precision));
    const claimed=(await db.query(`SELECT coalesce(sum(s.quantity),0) quantity,coalesce(sum(s.secondary_quantity),0) weight,
      coalesce(jsonb_agg(to_jsonb(s.serial_ids)) FILTER(WHERE cardinality(s.serial_ids)>0),'[]'::jsonb) serials
      FROM ${sources} s JOIN ${cases} a ON a.id=s.case_id AND a.workspace_id=s.workspace_id
      LEFT JOIN supplier_returns ret ON ret.workspace_id=a.workspace_id AND ret.id=a.return_id
      WHERE s.workspace_id=$1 AND s.receipt_line_id=$2 AND s.case_id IS DISTINCT FROM $3 AND a.cancelled_at IS NULL AND coalesce(ret.status,'REQUESTED')<>'CANCELLED'`,
    [ctx.workspaceId,r.id,caseId])).rows[0];
    if(primaryAtoms(exact.add(qty,claimed.quantity))>primaryAtoms(r.quantity_units)||
      weight!=null&&(r.secondary_quantity==null||weightAtoms(exact.add(weight,claimed.weight))>weightAtoms(r.secondary_quantity))){
      throw new ValidationError('Faulty quantities and weight exceed what remains from this recorded receipt.');
    }
    const billed=(await db.query(`SELECT coalesce(sum(quantity),0) quantity,coalesce(sum(secondary_quantity),0) weight
      FROM accounting_supplier_bill_lines WHERE workspace_id=$1 AND bill_id=$2 AND purchase_order_line_id=$3`,
      [ctx.workspaceId,b.id,r.purchase_order_line_id])).rows[0];
    const priorBilled=(await db.query(`SELECT coalesce(sum(s.quantity),0) quantity,coalesce(sum(s.secondary_quantity),0) weight
      FROM ${sources} s JOIN ${cases} c ON c.workspace_id=s.workspace_id AND c.id=s.case_id
      JOIN purchase_order_receipt_lines l ON l.workspace_id=s.workspace_id AND l.id=s.receipt_line_id
      WHERE s.workspace_id=$1 AND c.bill_id=$2 AND l.purchase_order_line_id=$3 AND c.cancelled_at IS NULL AND c.id IS DISTINCT FROM $4`,
      [ctx.workspaceId,b.id,r.purchase_order_line_id,caseId])).rows[0];
    const earlier=lines.filter(l=>l.purchaseOrderLineId===r.purchase_order_line_id);
    const sum=(value,key)=>earlier.reduce((total,l)=>exact.add(total,l[key]??0),value);
    if(primaryAtoms(exact.add(qty,sum(priorBilled.quantity,'quantity')))>primaryAtoms(billed.quantity)||
      weight!=null&&weightAtoms(exact.add(weight,sum(priorBilled.weight,'secondaryQuantity')))>weightAtoms(billed.weight)){
      throw new ValidationError('These goods or weight exceed the remaining quantities on the original posted bill line.');
    }
    const movements=parse(r.movement_ids)||[];
    if(!movements.length)throw new ValidationError('This receipt needs its original physical movement.');
    const serialIds=Array.isArray(raw.serialUnitIds)?raw.serialUnitIds:[];
    const named=Array.isArray(raw.serials)?raw.serials.map(s=>String(s).trim().toLowerCase()):[];
    let confirmedSerials=[];
    if(r.tracking_mode==='serial'){
      const native=(await db.query(`SELECT DISTINCT s.id,s.serial,s.secondary_quantity FROM serial_units s
        JOIN stockchief_runtime.inventory_movement_serial_units ms ON ms.workspace_id=s.workspace_id AND ms.serial_unit_id=s.id
        WHERE s.workspace_id=$1 AND s.sku_id=$2 AND s.location_id=$3 AND s.status='in_stock' AND ms.movement_id=ANY($4::text[])
        AND (s.id=ANY($5::text[]) OR lower(s.serial)=ANY($6::text[])) ORDER BY s.id`,
      [ctx.workspaceId,r.sku_id,r.location_id,movements,serialIds,named])).rows;
      confirmedSerials=native.map(s=>s.id);
      if(confirmedSerials.length!==qty||confirmedSerials.some(id=>claimed.serials.flat().includes(id))||
        weight!=null&&(native.some(s=>s.secondary_quantity==null)||weightAtoms(native.reduce((s,x)=>exact.add(s,x.secondary_quantity),'0'))!==weightAtoms(weight))){
        throw new ValidationError('Name every distinct in-stock serial from the original receipt and its exact actual weight.');
      }
    }else if(serialIds.length||named.length)throw new ValidationError('Use serial numbers only for a serialized receipt.');
    if(r.tracking_mode==='lot'&&!r.lot_id)throw new ValidationError('Confirm the receipt’s original lot first.');
    const position=(await db.query('SELECT on_hand,secondary_on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
      [ctx.workspaceId,r.sku_id,r.location_id])).rows[0];
    if(!position||Number(position.on_hand)<qty||weight!=null&&Number(position.secondary_on_hand)<weight)throw new ValidationError('The exact goods or weight are no longer on hand at the original receipt location.');
    if(r.lot_id&&!(await db.query('SELECT 1 FROM lot_balances WHERE workspace_id=$1 AND lot_id=$2 AND location_id=$3 AND quantity>=$4',
      [ctx.workspaceId,r.lot_id,r.location_id,qty])).rowCount)throw new ValidationError('The original lot no longer holds the requested quantity at this location.');
    if(r.hold_id&&Number(r.written_off_quantity)>0&&r.hold_status==='FAILED')throw new ValidationError('These failed QC goods were written off. Return goods from another receipt.');
    if(r.hold_id&&['HELD','FAILED'].includes(r.hold_status)&&(r.hold_status!=='FAILED'||!r.inspection?.damagedQuantity||
      primaryAtoms(exact.add(qty,claimed.quantity))>primaryAtoms(exact.add(r.inspection.damagedQuantity,r.inspection.returnedBeforeInspection||0)))){
      throw new ValidationError('Confirm the physically damaged count on the original QC hold before returning it.');
    }
    lines.push({receiptLineId:r.id,purchaseOrderLineId:r.purchase_order_line_id,skuId:r.sku_id,sku:r.code,item:r.name,locationId:r.location_id,location:r.location_name,
      quantity:qty,secondaryQuantity:weight,unit:r.unit_label,weightUnit:r.secondary_unit_label,lotId:r.lot_id,lotCode:r.lot_code,
      serialUnitIds:confirmedSerials,receipt:r.reference,receivedAt:r.received_at,movements,
      holdId:r.hold_status==='FAILED'?r.hold_id:null,inspection:r.hold_status==='FAILED'?r.inspection:null});
  }
  return lines.sort((a,b)=>a.receiptLineId.localeCompare(b.receiptLineId));
}
function dispatchProof(c){
  return c?.dispatch&&hash(c.dispatch)===c.dispatch_hash&&hash(c.evidence)===c.evidence_hash;
}

module.exports={JOB,ACTION,cases,sources,owner,access,expected,lookup,bill,receipts,confirmLines,dispatchProof,money,hash};

'use strict';

const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');
const exact=require('../domain/exact-quantity');
const {newId,nowIso}=require('../lib/util');
const {project}=require('./po-amendment-terms');

async function prepare(db,workspaceId,order,changes){
  if(!Array.isArray(changes)||!changes.length||changes.length>250)
    throw new ValidationError('Choose one to 250 purchase lines to amend.');
  const ids=changes.map(change=>change.lineId);
  if(ids.some(id=>typeof id!=='string'||!id||id.length>160)||new Set(ids).size!==ids.length)
    throw new ValidationError('Select each exact purchase line only once.');
  const result=await db.query(`SELECT l.*,s.code,i.name,i.unit_label,i.quantity_precision,i.quantity_increment,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment,i.tracking_mode,
    coalesce(l.destination_location_id,p.destination_location_id) AS receiving_location,
    EXISTS(SELECT 1 FROM stockchief_runtime.agent_preorder_sources source
      WHERE source.workspace_id=l.workspace_id AND source.purchase_order_line_id=l.id) AS published_preorder,
    EXISTS(SELECT 1 FROM stockchief_runtime.agent_preorder_claims claim
      WHERE claim.workspace_id=l.workspace_id AND claim.purchase_order_line_id=l.id) AS preorder_claim,
    EXISTS(SELECT 1 FROM accounting_supplier_bill_lines bl JOIN accounting_supplier_bills b
      ON b.workspace_id=bl.workspace_id AND b.id=bl.bill_id
      WHERE bl.workspace_id=l.workspace_id AND bl.purchase_order_line_id=l.id AND b.status<>'VOID') AS supplier_bill
    FROM purchase_order_lines l JOIN purchase_orders p ON p.workspace_id=l.workspace_id AND p.id=l.purchase_order_id
    JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 AND l.id=ANY($3::text[])
    ORDER BY l.line_number,l.id`,[workspaceId,order.id,ids]);
  if(result.rows.length!==ids.length)throw new ValidationError('The supplier selected a purchase line that is no longer on this order.');
  const inputs=new Map(changes.map(change=>[change.lineId,change]));
  return result.rows.map(line=>{
    const amendment=project(line,inputs.get(line.id),order.currency);
    const revisedQuantity=amendment.replacement
      ?exact.add(amendment.retained.quantity,amendment.replacement.quantity)
      :amendment.retained.quantity;
    const reduces=exact.atoms(exact.subtract(revisedQuantity,amendment.before.quantity),6,{signed:true})<0;
    if((line.published_preorder||line.preorder_claim)&&(amendment.replacement||reduces))
      throw new ValidationError(line.code+' has a customer preorder tied to this purchase line. Review the customer’s incoming commitment before changing its supply.');
    if(line.supplier_bill&&(amendment.retained.price!==amendment.before.price||revisedQuantity==='0'))
      throw new ValidationError(line.code+' already has a supplier bill against this purchase line. Review the bill before changing or cancelling its purchase terms.');
    return {line,amendment};
  });
}

function values(terms,currency){
  return [terms.quantity,terms.packs,terms.secondary,terms.price==null?null:money.fromMinor(terms.price,currency),
    terms.totalMinor==null?null:money.fromMinor(terms.totalMinor,currency)];
}

// Call inside the same transaction that locks the order and verifies the
// currently approved source fingerprint. Preserve native receipt and bill IDs.
async function write(db,workspaceId,order,changes){
  let nextLineNumber=null;
  const revisions=[];
  for(const {line,amendment} of changes){
    if(!amendment.changed)continue;
    const {before,retained,replacement}=amendment;
    await db.query(`UPDATE purchase_order_lines SET quantity_units=$4,quantity_purchase_units=$5,
      secondary_quantity_ordered=$6,unit_cost=$7,line_total=$8,supplier_amendment_closed_at=$9
      WHERE workspace_id=$1 AND purchase_order_id=$2 AND id=$3`,
    [workspaceId,order.id,line.id,...values(retained,order.currency),amendment.closed?nowIso():null]);
    let replacementLineId=null;
    if(replacement){
      if(nextLineNumber===null)nextLineNumber=Number((await db.query(`SELECT coalesce(max(line_number),0)+1 AS next
        FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2`,[workspaceId,order.id])).rows[0].next);
      replacementLineId=newId('pol');
      await db.query(`INSERT INTO purchase_order_lines(id,workspace_id,purchase_order_id,line_number,
        sku_id,supplier_item_id,supplier_sku,description,purchase_unit,units_per_purchase_unit,quantity_units,
        quantity_purchase_units,secondary_quantity_ordered,unit_cost,line_total,destination_location_id,notes,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [replacementLineId,workspaceId,order.id,nextLineNumber++,line.sku_id,line.supplier_item_id,line.supplier_sku,line.description,
        line.purchase_unit,line.units_per_purchase_unit,...values(replacement,order.currency),line.destination_location_id,line.notes,nowIso()]);
    }
    revisions.push({lineId:line.id,sku:line.code,before,retained,replacement,replacementLineId});
  }
  return revisions;
}

module.exports={prepare,write};

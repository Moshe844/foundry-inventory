'use strict';

const {ValidationError}=require('../domain/errors');
const {newId}=require('../lib/util');

async function lot(db,ctx,skuId,detail,shippedAt){
  if(!detail.lotCode)return null;
  const existing=(await db.query(`SELECT * FROM lots WHERE workspace_id=$1 AND sku_id=$2 AND lower(code)=lower($3)
    ORDER BY id LIMIT 2 FOR UPDATE`,[ctx.workspaceId,skuId,detail.lotCode])).rows;
  if(existing.length>1)throw new ValidationError('This supplier batch has more than one existing identity. Confirm its exact batch before recording dispatch.');
  if(existing.length){
    const row=existing[0];
    if((row.expires_at||null)!==(detail.expiresAt||null)||row.recalled_at&&new Date(row.recalled_at)<=new Date(shippedAt))
      throw new ValidationError('The supplier batch expiry or recall record needs review before this dispatch can be recorded.');
    return row.id;
  }
  const id=newId('lot');
  await db.query(`INSERT INTO lots(id,workspace_id,sku_id,code,expires_at,received_at,created_at,note)
    VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()::text,'Supplier batch delivered directly to a customer.')`,
    [id,ctx.workspaceId,skuId,detail.lotCode,detail.expiresAt,shippedAt]);
  return id;
}

async function record(db,ctx,skuId,direct,shippedAt){
  if(!direct.lots.length&&!direct.serials.length)return {lotIds:[],serialUnitIds:[]};
  // Native tracked receipts take a shared product lock. Holding its update
  // lock serializes these external identities with actual warehouse receipts.
  await db.query(`SELECT i.id FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id
    WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF i`,[ctx.workspaceId,skuId]);
  const lotIds=[],serialUnitIds=[];
  for(const batch of direct.lots){
    const lotId=await lot(db,ctx,skuId,batch,shippedAt);
    await db.query(`INSERT INTO stockchief_runtime.agent_direct_lots(workspace_id,dispatch_line_id,lot_id,quantity,secondary_quantity)
      VALUES($1,$2,$3,$4,$5)`,[ctx.workspaceId,direct.dispatchLineId,lotId,batch.quantity,batch.secondaryQuantity]);
    lotIds.push(lotId);
  }
  for(const unit of direct.serials){
    const duplicate=await db.query('SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND lower(serial)=lower($3) LIMIT 1',
      [ctx.workspaceId,skuId,unit.serial]);
    if(duplicate.rowCount)throw new ValidationError('Serial '+unit.serial+' already has an inventory or customer identity. Review its original delivery before recording another shipment.');
    const lotId=await lot(db,ctx,skuId,unit,shippedAt),id=newId('serial');
    await db.query(`INSERT INTO serial_units(id,workspace_id,sku_id,serial,status,location_id,condition,lot_id,note,
      received_at,updated_at,secondary_quantity) VALUES($1,$2,$3,$4,'issued',NULL,'good',$5,$6,$7,$7,$8)`,
      [id,ctx.workspaceId,skuId,unit.serial,lotId,'Supplier delivered directly to the customer. Dispatch '+direct.dispatchId+'.',shippedAt,unit.weight]);
    await db.query(`INSERT INTO stockchief_runtime.agent_direct_serial_units(workspace_id,dispatch_line_id,serial_unit_id)
      VALUES($1,$2,$3)`,[ctx.workspaceId,direct.dispatchLineId,id]);
    serialUnitIds.push(id);
  }
  return {lotIds,serialUnitIds};
}

module.exports={record};

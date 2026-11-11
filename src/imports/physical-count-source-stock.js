'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const stock=require('../domain/stock-quantity');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');

const pair=(skuId,locationId)=>JSON.stringify([skuId,locationId]);
const value=(input,signed=false)=>exact.canonical(input??'0',{signed});
const number=(input,signed=false)=>exact.safeNumber(input,{signed});
const sameUnit=(left,right)=>String(left).trim().toLowerCase()===String(right).trim().toLowerCase()||
  (right==='unit'&&String(left).trim().toLowerCase()==='units');

async function lookup(c,workspaceId,inputs){
  if(!inputs.length)return [];
  return (await c.query(`SELECT x.number,x.location_id,l.name location_name,s.id sku_id,s.code,i.id item_id,
    i.tracking_mode,i.unit_label,i.quantity_precision,i.quantity_increment,i.secondary_unit_label,i.secondary_precision,i.secondary_increment,
    b.on_hand::text physical,b.secondary_on_hand::text secondary,b.updated_at balance_version,
    v.quantity_units::text costed,v.secondary_quantity_units::text costed_secondary,v.total_cost_minor::text stock_value,v.updated_at cost_version,
    batch.id lot_id,batch.code lot_code,lb.quantity::text lot_quantity,lb.secondary_quantity::text lot_weight,lb.updated_at lot_version,
    serial.id serial_id,serial.serial serial_code,serial.status serial_status,serial.location_id serial_location,
    serial.secondary_quantity::text serial_weight,serial.updated_at serial_version,serial.lot_id serial_lot_id,sl.code serial_lot_code,
    price.amount_minor saved_cost,price.currency saved_currency
    FROM jsonb_to_recordset($2::jsonb) x(number int,sku text,location_id text,lot text,serial text)
    LEFT JOIN locations l ON l.workspace_id=$1 AND l.id=x.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    LEFT JOIN skus s ON s.workspace_id=$1 AND s.code=x.sku AND s.is_active=1
    LEFT JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    LEFT JOIN balances b ON b.workspace_id=$1 AND b.sku_id=s.id AND b.location_id=l.id
    LEFT JOIN accounting_inventory_cost_balances v ON v.workspace_id=$1 AND v.sku_id=s.id AND v.location_id=l.id
    LEFT JOIN lots batch ON batch.workspace_id=$1 AND batch.sku_id=s.id AND batch.code=x.lot
    LEFT JOIN lot_balances lb ON lb.workspace_id=$1 AND lb.lot_id=batch.id AND lb.location_id=l.id
    LEFT JOIN LATERAL (
      SELECT q.* FROM serial_units q WHERE q.workspace_id=$1 AND q.sku_id=s.id AND q.serial=x.serial
      AND (q.status='in_stock' OR NOT EXISTS(SELECT 1 FROM serial_units live WHERE live.workspace_id=$1 AND live.sku_id=s.id
        AND live.serial=x.serial AND live.status='in_stock')) ORDER BY q.id LIMIT 2
    ) serial ON true
    LEFT JOIN lots sl ON sl.workspace_id=$1 AND sl.id=serial.lot_id
    LEFT JOIN LATERAL (
      SELECT pc.amount_minor,pc.currency FROM sku_purchase_costs pc WHERE pc.workspace_id=$1 AND pc.sku_id=s.id
      ORDER BY pc.created_at DESC,pc.id DESC LIMIT 1
    ) price ON true
    ORDER BY x.number`,[workspaceId,JSON.stringify(inputs)])).rows;
}

function current(row){
  const measured=Boolean(row.secondary_unit_label);
  return {position:pair(row.sku_id,row.location_id),skuId:row.sku_id,itemId:row.item_id,locationId:row.location_id,code:row.code,location:row.location_name,
    profile:[row.tracking_mode,row.unit_label,row.quantity_precision,value(row.quantity_increment),row.secondary_unit_label,
      row.secondary_precision,value(row.secondary_increment)],
    balance:{quantity:value(row.physical,true),weight:measured?value(row.secondary,true):null,version:row.balance_version},
    cost:{quantity:value(row.costed),weight:measured?value(row.costed_secondary):null,value:row.stock_value||'0',version:row.cost_version},
    price:{minor:row.saved_cost,currency:row.saved_currency},
    lot:row.lot_id?{id:row.lot_id,code:row.lot_code,quantity:value(row.lot_quantity,true),weight:measured?value(row.lot_weight,true):null,version:row.lot_version}:null,
    serial:row.serial_id?{id:row.serial_id,code:row.serial_code,status:row.serial_status,locationId:row.serial_location,lotId:row.serial_lot_id,
      lotCode:row.serial_lot_code,weight:measured&&row.serial_weight!=null?value(row.serial_weight):null,version:row.serial_version}:null};
}

function chooseLocation(locations,observed){
  if(!observed.location&&locations.length===1)return locations[0].id;
  const matching=locations.filter(l=>l.id===observed.location||l.name===observed.location);
  if(matching.length!==1)throw new ValidationError('Name one exact active location from this source’s approved scope.');
  return matching[0].id;
}

function result(row,observed,baseCurrency){
  if(!row?.sku_id||!row.tracking_mode)throw new ValidationError('Match the exact active SKU from the original.');
  if(!row.location_name)throw new ValidationError('Choose a current owned stock location.');
  if(!observed.quantity)throw new ValidationError('Enter the written physical quantity. Blank is unknown.');
  const expected=current(row),mode=row.tracking_mode,measured=Boolean(row.secondary_unit_label);
  if((observed.unit||Number(row.quantity_precision)>0)&&!sameUnit(observed.unit,row.unit_label))
    throw new ValidationError('Use the recorded stocking unit '+row.unit_label+' and enter an exact measured quantity.');
  const quantity=value(stock.validate(row,observed.quantity,{positive:false,total:true,label:'Physical quantity'}));
  const weight=measured?value(stock.secondary(row,observed.secondary,{positive:false,total:true,label:'Independent physical measure'})):null;
  const measureCorrection=observed.measureCorrection==='yes'&&Boolean(observed.measureReason?.trim())&&observed.measureReason.length<=500;
  if(measured&&(!sameUnit(observed.secondaryUnit,row.secondary_unit_label)||(quantity==='0')!==(weight==='0')))
    throw new ValidationError('Enter the exact independent '+row.secondary_unit_label+' measure. The quantity and its measure are both zero for empty stock.');
  if(!measured&&(observed.secondary||observed.secondaryUnit))throw new ValidationError('This SKU has no independent stocking measure.');
  let before=expected.balance.quantity,beforeWeight=expected.balance.weight;
  if(mode==='quantity'&&(observed.lot||observed.serial))throw new ValidationError('Use the SKU’s recorded tracking method for this count.');
  if(mode==='lot'){
    if(!observed.lot||!expected.lot||observed.serial)throw new ValidationError('Match an existing exact lot code for this SKU.');
    before=expected.lot.quantity;beforeWeight=expected.lot.weight;
  }
  if(mode==='serial'){
    if(!observed.serial||!expected.serial)throw new ValidationError('Match one existing exact serial number for this SKU.');
    if(!['0','1'].includes(quantity))throw new ValidationError('Enter 1 for this serial physically present or 0 if it was physically checked and absent.');
    if(observed.lot&&observed.lot!==expected.serial.lotCode)throw new ValidationError('The observed serial does not match the stated lot.');
    const present=expected.serial.status==='in_stock';
    if(present&&expected.serial.locationId!==row.location_id)throw new ValidationError('This serial is recorded at another location. Review its movement before applying the count.');
    if(measured&&expected.serial.weight==null)throw new ValidationError('Record the original exact serial weight before changing its count.');
    if(measured&&quantity==='1'&&weight!==expected.serial.weight&&!present)
      throw new ValidationError('The observed weight differs from this exact serial’s recorded weight. Review the measured correction separately.');
    before=present?'1':'0';beforeWeight=measured?(present?expected.serial.weight:'0'):null;
  }
  if(number(before,true)<0||number(expected.balance.quantity,true)<0)throw new ValidationError('Reconcile the recorded negative stock before posting this count.');
  const delta=exact.subtract(quantity,before),deltaWeight=measured?exact.subtract(weight,beforeWeight):null;
  const reweigh=measured&&delta==='0'&&deltaWeight!=='0';
  if(reweigh&&!measureCorrection)throw new ValidationError('Confirm a correction to the measure of the same physical stock and its retained recorded cost.');
  if(measured&&!reweigh&&(Math.sign(number(delta,true))!==Math.sign(number(deltaWeight,true))))
    throw new ValidationError('The piece and weight differences need separate measured stock review.');
  let unitCost=null;
  if(number(delta,true)>0){
    if(observed.cost){
      if(!baseCurrency||observed.currency!==baseCurrency)throw new ValidationError('Confirm the added stock’s exact cost in the current book currency.');
      unitCost=money.toMinor(observed.cost,baseCurrency,{label:'Reviewed unit cost'});
    }else if(row.saved_cost!=null&&baseCurrency&&row.saved_currency===baseCurrency)unitCost=money.integer(row.saved_cost);
    else throw new ValidationError('The additional stock needs a reviewed cost in the current book currency.');
  }
  const target=expected.serial?'serial:'+expected.serial.id:JSON.stringify([expected.position,expected.lot?.id??null]);
  return {expected,mode,before,beforeWeight,quantity,weight,delta,deltaWeight,reweigh,unitCost,target,
    lookup:{sku:row.code,location_id:row.location_id,lot:observed.lot,serial:observed.serial}};
}

function effectOrder(a,b){
  return Math.sign(number(a.preview.delta,true))-Math.sign(number(b.preview.delta,true))||a.number-b.number;
}

function valueGroup(group,currency){
  const baseline=group[0].preview.expected,changed=group.some(r=>r.preview.delta!=='0'||r.preview.reweigh);
  if(changed&&(!currency||baseline.balance.quantity!==baseline.cost.quantity||baseline.balance.weight!==baseline.cost.weight))
    throw new ValidationError('Establish the exact stock value and independent measure at this position before posting its count.');
  let quantity=baseline.cost.quantity,weight=baseline.cost.weight,total=money.integer(baseline.cost.value);
  for(const row of [...group].sort(effectOrder)){
    const {preview:p}=row,n=number(p.delta,true),weightDelta=p.deltaWeight==null?null:number(p.deltaWeight,true);
    let delta=0;
    if(n<0){
      if(number(quantity)<-n||weightDelta!=null&&number(weight)<-weightDelta)throw new ValidationError('The exact reductions exceed the current costed stock.');
      delta=-(number(quantity)===-n?total:exact.ratioMinor(total,weightDelta==null?-n:-weightDelta,weight==null?quantity:weight));
    }else if(n>0)delta=exact.costMinor(weightDelta??n,p.unitCost);
    p.costDelta=delta;p.currency=currency;
    quantity=exact.add(quantity,p.delta);
    if(weight!=null)weight=exact.add(weight,p.deltaWeight);
    total=money.sum([total,delta],'Stock value');
  }
}

async function preview(c,workspaceId,locations,rows){
  const currency=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[workspaceId])).rows[0]?.base_currency||null;
  const inputs=[];
  for(const row of rows){
    row.preview=null;row.issue=null;
    if(row.checked&&row.observed.excludeReason)continue;
    try{
      inputs.push({number:row.number,sku:row.observed.sku,location_id:chooseLocation(locations,row.observed),lot:row.observed.lot,serial:row.observed.serial});
    }catch(error){if(!(error instanceof ValidationError))throw error;row.issue=error.message;}
  }
  const seen=new Map(),targets=new Map(),groups=new Map();
  for(let offset=0;offset<inputs.length;offset+=500){
    for(const item of await lookup(c,workspaceId,inputs.slice(offset,offset+500))){
      if(!seen.has(item.number))seen.set(item.number,[]);
      seen.get(item.number).push(item);
    }
  }
  for(const row of rows){
    if(row.issue||row.checked&&row.observed.excludeReason)continue;
    try{
      const candidates=seen.get(row.number)||[];
      if(candidates.length>1)throw new ValidationError('More than one historical unit matches this serial. Confirm its native identity separately.');
      const p=result(candidates[0],row.observed,currency);row.preview=p;
      if(!targets.has(p.target))targets.set(p.target,[]);
      targets.get(p.target).push(row);
      if(!groups.has(p.expected.position))groups.set(p.expected.position,[]);
      groups.get(p.expected.position).push(row);
      if(!row.checked)row.issue='Compare this reading with the original and confirm the exact physical values.';
    }catch(error){if(!(error instanceof ValidationError))throw error;row.issue=error.message;}
  }
  for(const entries of targets.values())if(entries.length>1)for(const row of entries)row.issue='The same exact stock position or identity appears more than once. Review the original.';
  for(const group of groups.values()){
    try{valueGroup(group,currency);}
    catch(error){if(!(error instanceof ValidationError))throw error;for(const row of group)row.issue ||= error.message;}
  }
  return rows;
}

async function assertCurrent(c,workspaceId,group){
  const first=group[0].preview.expected;
  await c.query('SELECT sku_id FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE',
    [workspaceId,first.skuId,first.locationId]);
  const live=await lookup(c,workspaceId,group.map(r=>({number:r.number,...r.preview.lookup})));
  if(live.length!==group.length||live.some((row,index)=>!row.tracking_mode||!row.location_name||hash(current(row))!==hash(group[index].preview.expected)))
    throw new ValidationError('Stock, identities or recorded cost changed after review. Recheck the pending counts against the saved original.');
  const settings=(await c.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1 FOR SHARE',[workspaceId])).rows[0];
  if(group.some(row=>row.preview.currency!==(settings?.base_currency||null)))throw new ValidationError('The book currency changed after the physical count was reviewed.');
}

async function apply(c,ctx,source,row){
  const p=row.preview,n=number(p.delta,true);
  if(!n&&!p.reweigh)return {unchanged:true};
  const key='count-source:'+source.id+':'+row.number;
  const input={skuId:p.expected.skuId,locationId:p.expected.locationId,reasonCode:'cycle_count',
    reference:source.filename,notes:'Reviewed count source '+source.id+', row '+row.number,idempotencyKey:key};
  if(p.reweigh){
    const physical=await require('../domain/postgres-inventory-engine').reweighInTransaction(c,ctx,{...input,lotId:p.expected.lot?.id,
      serialUnitId:p.expected.serial?.id,countedSecondaryQuantity:p.weight,notes:input.notes+' — '+row.observed.measureReason});
    await require('../accounting/postgres-costing').correctMeasureInTransaction(c,ctx,{movementId:physical.movementId,sourceId:source.id});
    return {...physical,costDeltaMinor:0,journalEntryId:null};
  }
  if(p.mode==='quantity'){
    return require('../accounting/postgres-physical-count').applyInTransaction(c,ctx,{...input,countedQuantity:p.quantity,secondaryCountedQuantity:p.weight,
      expectedBefore:{physical:number(p.expected.balance.quantity,true),costed:number(p.expected.cost.quantity),value:money.integer(p.expected.cost.value)},
      unitCostMinor:p.unitCost,expectedCostDeltaMinor:p.costDelta,currency:p.currency,sourceType:'physical_count_source',sourceRecordId:source.id});
  }
  const inventory=require('../domain/postgres-inventory-engine'),costing=require('../accounting/postgres-costing');
  const units=Math.abs(n),weight=p.deltaWeight==null?null:Math.abs(number(p.deltaWeight,true));
  const tracking={lotId:p.expected.lot?.id||p.expected.serial?.lotId,secondaryQuantity:weight};
  const physical=n<0?await inventory.issueInTransaction(c,ctx,{...input,...tracking,quantity:units,serialUnitIds:p.expected.serial?[p.expected.serial.id]:undefined})
    :await inventory.receiveInTransaction(c,ctx,{...input,...tracking,quantity:units,returnSerialUnitIds:p.expected.serial?[p.expected.serial.id]:undefined});
  const removal=n<0?await costing.prepareIssueInTransaction(c,ctx,{movementId:physical.movementId}):null;
  if(removal&&-removal.totalCostMinor!==p.costDelta)throw new ValidationError('The cost for these exact units changed after the physical count review.');
  const amount=Math.abs(p.costDelta),post=amount?await require('../accounting/postgres-ledger').postInTransaction(c,ctx,{sourceKey:key,
    sourceType:'physical_count_source',sourceRecordType:'count_source',sourceRecordId:source.id,currency:p.currency,
    description:'Owner-approved physical count of '+p.expected.code,
    lines:n<0?[{accountKey:'INVENTORY_ADJUSTMENTS',debitMinor:amount},{accountKey:'INVENTORY_ASSET',creditMinor:amount,skuId:input.skuId,locationId:input.locationId}]
      :[{accountKey:'INVENTORY_ASSET',debitMinor:amount,skuId:input.skuId,locationId:input.locationId},{accountKey:'INVENTORY_ADJUSTMENTS',creditMinor:amount}]}):null;
  const proof={journalEntryId:post?.entry.id||null,sourceType:'physical_count_source',sourceRecordId:source.id};
  if(removal)await costing.commitIssueInTransaction(c,ctx,removal,proof);
  else await costing.receiveInTransaction(c,ctx,{...proof,movementId:physical.movementId,unitCostMinor:p.unitCost,totalCostMinor:amount});
  return {movementId:physical.movementId,journalEntryId:proof.journalEntryId,costDeltaMinor:p.costDelta};
}

module.exports={preview,assertCurrent,apply,effectOrder};

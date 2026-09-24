'use strict';

const crypto=require('node:crypto');
const config=require('../config');
const {createProviderUnobserved}=require('../ai/provider');
const {newId,nowIso}=require('../lib/util');
const {ValidationError,NotFoundError,InvariantError}=require('../domain/errors');
const autonomy=require('../autopilot/postgres-service');

const DOMAINS=['replenishment','supplier_terms','transfer_authority','purchase_authority',
  'operating_preference','stock_protection'];
const CHANGE_SCHEMA={type:'object',additionalProperties:false,required:['domain','operation','sku','supplier','location',
  'sourceLocation','reorderPoint','targetStock','safetyStock','leadTimeDays','unitsPerPurchaseUnit',
  'minimumOrderQuantity','orderMultiple','maximumQuantity','maximumValue','weeklyValue','daysOfStock',
  'preferTransferBeforePurchasing','guardMode','guardComparator','guardThreshold','guardReleaseCondition'],properties:{
  domain:{type:'string',enum:DOMAINS},operation:{type:'string',enum:['set','remove']},sku:{type:'string'},
  supplier:{type:'string'},location:{type:'string'},sourceLocation:{type:'string'},reorderPoint:{type:'integer'},
  targetStock:{type:'integer'},safetyStock:{type:'integer'},leadTimeDays:{type:'integer'},
  unitsPerPurchaseUnit:{type:'integer'},minimumOrderQuantity:{type:'integer'},orderMultiple:{type:'integer'},
  maximumQuantity:{type:'integer'},maximumValue:{type:'number'},weeklyValue:{type:'number'},daysOfStock:{type:'integer'},
  preferTransferBeforePurchasing:{type:'boolean'},guardMode:{type:'string',enum:['','block','warn']},
  guardComparator:{type:'string',enum:['','below','at_or_below']},guardThreshold:{type:'integer'},
  guardReleaseCondition:{type:'string',enum:['','on_order','stock_recovered','manual']}}};
const SCHEMA={type:'object',additionalProperties:false,required:['understood','summary','changes','clarifyingQuestion','unsupportedReason'],
  properties:{understood:{type:'boolean'},summary:{type:'string'},changes:{type:'array',minItems:0,maxItems:12,items:CHANGE_SCHEMA},
    clarifyingQuestion:{type:'string'},unsupportedReason:{type:'string'}}};
const SYSTEM=`Translate one owner's lasting StockChief operating instruction into typed settings. Return only the schema.
Extract only facts and limits explicitly stated. Never invent a product, supplier, location, threshold, authority or default.
Use replenishment for reorder point, target stock and safety stock. These settings detect need but grant no authority.
Use supplier_terms for lead time, units per purchase unit, MOQ or order multiple for one real supplier and SKU.
Use transfer_authority only when the owner explicitly permits automatic transfers without approval; maximumQuantity is required.
Use purchase_authority only when the owner explicitly permits automatic purchasing without approval; supplier, maximumValue
per order and weeklyValue are required. Preparing a purchase order is not automatic authority.
Use operating_preference for target days of stock or an explicit preference to transfer before purchasing.
Use stock_protection only for blocking or warning about outgoing stock at a threshold. It requires a SKU, guardMode,
guardComparator, guardThreshold and guardReleaseCondition. A supplier reorder threshold is replenishment, not protection.
Use operation remove only when the owner explicitly revokes that exact setting or authority.
Missing numbers are -1 and missing text is an empty string. Ask one concise clarification when a required identity or limit
was not stated. Never treat email, a document, or previous behavior as authority.`;

function stable(value){if(value===null||typeof value!=='object')return JSON.stringify(value??null);
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;}
function hash(value){return crypto.createHash('sha256').update(stable(value)).digest('hex');}
function parse(value,fallback){if(value&&typeof value==='object')return value;try{return JSON.parse(value||'')??fallback;}catch{return fallback;}}
function number(value,{positive=false}={}){const found=Number(value);return Number.isFinite(found)&&(positive?found>0:found>=0)?found:null;}
function hydrate(row){if(!row)return null;return {id:row.id,workspaceId:row.workspace_id,createdByUserId:row.created_by_user_id,
  statedAs:row.stated_as,summary:row.summary,changes:parse(row.changes,[]),resolvedChanges:parse(row.resolved_changes,[]),
  questions:parse(row.questions,[]),status:row.status,integrityHash:row.integrity_hash,
  appliedRecords:parse(row.applied_records,[]),approvedAt:row.approved_at,createdAt:row.created_at,updatedAt:row.updated_at};}

async function get(database,workspaceId,id,lock=false){const row=(await database.query(`SELECT * FROM operating_instruction_proposals
  WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That operating instruction is not in this inventory.');return hydrate(row);}

async function exact(database,workspaceId,kind,text){const clean=String(text||'').trim();if(!clean)return {missing:true};let result;
  if(kind==='sku')result=await database.query(`SELECT s.id,s.code,s.variant_label,i.id AS item_id,i.name
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id WHERE s.workspace_id=$1
    AND s.is_active=1 AND i.is_active=1 AND (lower(s.code)=lower($2) OR lower(i.name)=lower($2)
      OR lower(i.name||CASE WHEN COALESCE(s.variant_label,'')='' THEN '' ELSE ' '||s.variant_label END)=lower($2))
    ORDER BY i.name,s.position LIMIT 12`,[workspaceId,clean]);
  else if(kind==='supplier')result=await database.query(`SELECT id,name FROM suppliers WHERE workspace_id=$1 AND status='active'
    AND lower(name)=lower($2) ORDER BY name LIMIT 12`,[workspaceId,clean]);
  else result=await database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1
    AND lower(name)=lower($2) ORDER BY name LIMIT 12`,[workspaceId,clean]);
  if(result.rows.length===1)return {row:result.rows[0]};
  return result.rows.length?{ambiguous:result.rows}:{notFound:true};}

function cleanChange(raw={}){return {domain:DOMAINS.includes(raw.domain)?raw.domain:'',operation:raw.operation==='remove'?'remove':'set',
  sku:String(raw.sku||'').trim(),supplier:String(raw.supplier||'').trim(),location:String(raw.location||'').trim(),
  sourceLocation:String(raw.sourceLocation||'').trim(),reorderPoint:Number(raw.reorderPoint),targetStock:Number(raw.targetStock),
  safetyStock:Number(raw.safetyStock),leadTimeDays:Number(raw.leadTimeDays),unitsPerPurchaseUnit:Number(raw.unitsPerPurchaseUnit),
  minimumOrderQuantity:Number(raw.minimumOrderQuantity),orderMultiple:Number(raw.orderMultiple),maximumQuantity:Number(raw.maximumQuantity),
  maximumValue:Number(raw.maximumValue),weeklyValue:Number(raw.weeklyValue),daysOfStock:Number(raw.daysOfStock),
  preferTransferBeforePurchasing:Boolean(raw.preferTransferBeforePurchasing),guardMode:String(raw.guardMode||''),
  guardComparator:String(raw.guardComparator||''),guardThreshold:Number(raw.guardThreshold),
  guardReleaseCondition:String(raw.guardReleaseCondition||'')};}

async function resolveChange(database,workspaceId,raw){const change=cleanChange(raw);const questions=[];
  if(!change.domain){questions.push('Which lasting inventory rule should StockChief set?');return {...change,questions};}
  if(['replenishment','supplier_terms','stock_protection'].includes(change.domain)){
    const found=await exact(database,workspaceId,'sku',change.sku);
    if(found.row)Object.assign(change,{skuId:found.row.id,itemId:found.row.item_id,skuCode:found.row.code,
      displayName:`${found.row.name}${found.row.variant_label?` · ${found.row.variant_label}`:''}`});
    else questions.push(!change.sku?'Which product or SKU is this for?':
      found.ambiguous?`More than one SKU exactly matches “${change.sku}”. Which SKU code?`:
        `No active product or SKU exactly matches “${change.sku}”.`);
  }
  if(['supplier_terms','purchase_authority'].includes(change.domain)){
    const found=await exact(database,workspaceId,'supplier',change.supplier);
    if(found.row)Object.assign(change,{supplierId:found.row.id,supplierName:found.row.name});
    else questions.push(!change.supplier?'Which supplier is this for?':`No active supplier exactly matches “${change.supplier}”.`);
  }
  if(change.location){const found=await exact(database,workspaceId,'location',change.location);
    if(found.row)Object.assign(change,{locationId:found.row.id,locationName:found.row.name});
    else questions.push(`No active location exactly matches “${change.location}”.`);}
  if(change.sourceLocation){const found=await exact(database,workspaceId,'location',change.sourceLocation);
    if(found.row)Object.assign(change,{sourceLocationId:found.row.id,sourceLocationName:found.row.name});
    else questions.push(`No active source location exactly matches “${change.sourceLocation}”.`);}
  if(change.operation==='set'&&change.domain==='replenishment'&&
    [change.reorderPoint,change.targetStock,change.safetyStock].every((value)=>number(value)===null))questions.push('State the reorder point, target stock or safety stock.');
  if(change.operation==='set'&&change.domain==='supplier_terms'&&[change.leadTimeDays,change.unitsPerPurchaseUnit,
    change.minimumOrderQuantity,change.orderMultiple].every((value)=>number(value,{positive:true})===null))
    questions.push('State the supplier lead time, pack size, minimum order or order multiple.');
  if(change.operation==='set'&&change.domain==='transfer_authority'&&number(change.maximumQuantity,{positive:true})===null)
    questions.push('What is the maximum number of units StockChief may transfer without asking?');
  if(change.operation==='set'&&change.domain==='purchase_authority'){
    if(number(change.maximumValue,{positive:true})===null)questions.push('What is the maximum value of one automatic purchase order?');
    if(number(change.weeklyValue,{positive:true})===null)questions.push('What is the rolling seven-day purchasing limit?');
  }
  if(change.operation==='set'&&change.domain==='operating_preference'&&number(change.daysOfStock,{positive:true})===null
    &&!change.preferTransferBeforePurchasing)questions.push('State the target days of stock or say whether transfers should be preferred before purchasing.');
  if(change.operation==='set'&&change.domain==='stock_protection'){
    if(!['block','warn'].includes(change.guardMode))questions.push('Should StockChief block the outgoing stock or only warn you?');
    if(!['below','at_or_below'].includes(change.guardComparator))questions.push('Does the rule apply below the threshold or at-or-below it?');
    if(number(change.guardThreshold)===null)questions.push('What stock threshold should the rule use?');
    if(!['on_order','stock_recovered','manual'].includes(change.guardReleaseCondition))
      questions.push('Should the rule release when supply is ordered, stock recovers, or only manually?');
  }
  return {...change,questions};}

function describe(change){if(change.domain==='replenishment')return `${change.displayName}: ${change.operation==='remove'?'remove its taught replenishment settings':[
    number(change.reorderPoint)!==null?`reorder at ${change.reorderPoint}`:null,number(change.targetStock)!==null?`target ${change.targetStock}`:null,
    number(change.safetyStock)!==null?`safety stock ${change.safetyStock}`:null].filter(Boolean).join(', ')}`;
  if(change.domain==='supplier_terms')return `${change.supplierName} terms for ${change.displayName}: ${change.operation==='remove'?'remove the relationship':[
    number(change.leadTimeDays,{positive:true})!==null?`${change.leadTimeDays}-day lead time`:null,
    number(change.unitsPerPurchaseUnit,{positive:true})!==null?`${change.unitsPerPurchaseUnit} units per purchase unit`:null,
    number(change.minimumOrderQuantity,{positive:true})!==null?`MOQ ${change.minimumOrderQuantity}`:null,
    number(change.orderMultiple,{positive:true})!==null?`order multiple ${change.orderMultiple}`:null].filter(Boolean).join(', ')}`;
  if(change.domain==='transfer_authority')return change.operation==='remove'?'Remove automatic transfer authority.':
    `Allow automatic transfers up to ${change.maximumQuantity} units${change.locationName?` involving ${change.locationName}`:''}${change.sourceLocationName?` from ${change.sourceLocationName}`:''}.`;
  if(change.domain==='purchase_authority')return change.operation==='remove'?`Remove automatic purchasing authority for ${change.supplierName}.`:
    `Allow automatic purchase orders from ${change.supplierName} up to $${change.maximumValue.toFixed(2)} each and $${change.weeklyValue.toFixed(2)} per rolling seven days.`;
  if(change.domain==='operating_preference')return change.operation==='remove'?'Remove the taught replenishment preference.':
    number(change.daysOfStock,{positive:true})!==null?`Target ${change.daysOfStock} days of stock.`:'Prefer transfers before purchasing.';
  return `${change.displayName}: ${change.guardMode} outgoing stock ${change.guardComparator.replaceAll('_',' ')} ${change.guardThreshold}; release ${change.guardReleaseCondition.replaceAll('_',' ')}.`;}

async function interpret(database,ctx,instruction,options={}){const clean=String(instruction||'').trim().slice(0,2000);
  if(!clean)throw new ValidationError('Tell StockChief how you want this inventory run.');
  const provider=options.provider||(config.ai.configured?createProviderUnobserved(config.ai.provider,config.ai.tier('standard')):null);
  if(!provider)throw new ValidationError('StockChief needs its model connection to read a free-form standing instruction.');
  const [catalogue,locations,suppliers]=await Promise.all([
    database.query(`SELECT i.name,s.code,s.variant_label FROM skus s JOIN items i ON i.id=s.item_id
      WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 ORDER BY i.name,s.position LIMIT 500`,[ctx.workspaceId]),
    database.query(`SELECT name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name LIMIT 200`,[ctx.workspaceId]),
    database.query(`SELECT name FROM suppliers WHERE workspace_id=$1 AND status='active' ORDER BY name LIMIT 200`,[ctx.workspaceId])]);
  const response=await provider.complete({system:SYSTEM,prompt:JSON.stringify({instruction:clean,realSkus:catalogue.rows,
    realLocations:locations.rows,realSuppliers:suppliers.rows}),schema:SCHEMA,schemaName:'postgres_operating_instruction'});
  const read=response?.data||{};
  if(!read.understood||!Array.isArray(read.changes)||!read.changes.length)
    throw new ValidationError(read.unsupportedReason||read.clarifyingQuestion||'StockChief could not turn that into a safe standing rule.');
  const resolved=await Promise.all(read.changes.map((change)=>resolveChange(database,ctx.workspaceId,change)));
  const questions=[...new Set([read.clarifyingQuestion,...resolved.flatMap((change)=>change.questions)].filter(Boolean))];
  const resolvedChanges=resolved.map(({questions:unused,...change})=>change);const snapshot={statedAs:clean,resolvedChanges};
  const id=newId('oin');const at=nowIso();await database.query(`INSERT INTO operating_instruction_proposals
    (id,workspace_id,created_by_user_id,stated_as,summary,changes,resolved_changes,questions,status,integrity_hash,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$10)`,[id,ctx.workspaceId,ctx.actorId,clean,
    String(read.summary||'Standing operating rule').slice(0,500),JSON.stringify(read.changes.map(cleanChange)),
    JSON.stringify(resolvedChanges),JSON.stringify(questions),hash(snapshot),at]);return get(database,ctx.workspaceId,id);}

async function assertOwner(client,ctx){const actor=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',
  [ctx.workspaceId,ctx.actorId])).rows[0];if(actor?.role!=='owner')throw new ValidationError('Only an owner can approve standing operating rules.');}

async function applyChange(client,ctx,change){const at=nowIso();
  if(change.domain==='replenishment'){
    if(change.operation==='remove'){await client.query('DELETE FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NULL',
      [ctx.workspaceId,change.skuId]);return {kind:'reorder_policy',skuId:change.skuId,removed:true};}
    const prior=(await client.query(`SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id IS NULL`,
      [ctx.workspaceId,change.skuId])).rows[0];const id=prior?.id||newId('rpol');const values=[number(change.reorderPoint)??prior?.reorder_point??null,
      number(change.targetStock)??prior?.target_stock??null,number(change.safetyStock)??prior?.safety_stock??null];
    if(prior)await client.query(`UPDATE reorder_policies SET reorder_point=$3,target_stock=$4,safety_stock=$5,
      source='foundry',notes='Approved through Ask StockChief.',updated_at=$6 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,id,...values,at]);else await client.query(`INSERT INTO reorder_policies
      (id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,notes,created_at,updated_at)
      VALUES($1,$2,$3,NULL,$4,$5,$6,'foundry','Approved through Ask StockChief.',$7,$7)`,
    [id,ctx.workspaceId,change.skuId,...values,at]);return {kind:'reorder_policy',id,skuId:change.skuId};}
  if(change.domain==='supplier_terms'){
    if(change.operation==='remove'){await client.query(`UPDATE supplier_items SET is_active=0,updated_at=$4
      WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3`,[ctx.workspaceId,change.supplierId,change.skuId,at]);
      return {kind:'supplier_item',supplierId:change.supplierId,skuId:change.skuId,removed:true};}
    const prior=(await client.query(`SELECT * FROM supplier_items WHERE workspace_id=$1 AND supplier_id=$2 AND sku_id=$3`,
      [ctx.workspaceId,change.supplierId,change.skuId])).rows[0];const id=prior?.id||newId('supitem');
    await client.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,purchase_unit,units_per_purchase_unit,
      lead_time_days,minimum_order_quantity,order_multiple,is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11)
      ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET units_per_purchase_unit=EXCLUDED.units_per_purchase_unit,
      lead_time_days=EXCLUDED.lead_time_days,minimum_order_quantity=EXCLUDED.minimum_order_quantity,
      order_multiple=EXCLUDED.order_multiple,is_active=1,updated_at=EXCLUDED.updated_at`,[id,ctx.workspaceId,change.supplierId,
      change.skuId,prior?.purchase_unit||'unit',number(change.unitsPerPurchaseUnit,{positive:true})??prior?.units_per_purchase_unit??1,
      number(change.leadTimeDays,{positive:true})??prior?.lead_time_days??null,
      number(change.minimumOrderQuantity,{positive:true})??prior?.minimum_order_quantity??null,
      number(change.orderMultiple,{positive:true})??prior?.order_multiple??null,prior?.is_preferred||0,at]);
    return {kind:'supplier_item',id,supplierId:change.supplierId,skuId:change.skuId};}
  if(change.domain==='transfer_authority'||change.domain==='purchase_authority'){
    const transfer=change.domain==='transfer_authority';const enabled=change.operation!=='remove';
    const id=await autonomy.replacePolicy(client,ctx,{enabled,action:transfer?autonomy.ACTIONS.TRANSFER:autonomy.ACTIONS.PURCHASE,
      name:transfer?'Taught automatic transfers':`Taught purchasing — ${change.supplierName}`,
      description:`Approved through Ask StockChief: ${change.statedAs}`,locationScope:
        [change.sourceLocationId,change.locationId].filter(Boolean),supplierScope:change.supplierId?[change.supplierId]:[],
      conditions:transfer?['destination_stockout_risk','source_above_safety','no_conflicting_transfer']:
        ['replenishment_evidence','moq_order_multiple_compliant','no_duplicate_incoming_demand','price_within_policy'],
      maximumQuantity:transfer?change.maximumQuantity:null,maximumValue:transfer?null:change.maximumValue,
      thresholds:transfer?{}:{maxValuePerWeek:change.weeklyValue}});
    if(enabled)await client.query(`UPDATE workspace_autopilot SET mode='POLICY_AUTOMATED',updated_at=$2 WHERE workspace_id=$1`,
      [ctx.workspaceId,at]);return {kind:'automation_policy',id,domain:change.domain,removed:!enabled};}
  if(change.domain==='operating_preference'){const key=number(change.daysOfStock,{positive:true})!==null?'target_days_of_stock':'prefer_transfer_before_purchasing';
    if(change.operation==='remove'){await client.query('DELETE FROM operational_preferences WHERE workspace_id=$1 AND key=$2',[ctx.workspaceId,key]);
      return {kind:'preference',key,removed:true};}const value=key==='target_days_of_stock'?change.daysOfStock:true;
    await client.query(`INSERT INTO operational_preferences(id,workspace_id,key,value,stated_as,source,set_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'instruction',$6,$7,$7) ON CONFLICT(workspace_id,key) DO UPDATE SET value=EXCLUDED.value,
      stated_as=EXCLUDED.stated_as,source='instruction',set_by_user_id=EXCLUDED.set_by_user_id,updated_at=EXCLUDED.updated_at`,
    [newId('pref'),ctx.workspaceId,key,JSON.stringify(value),change.statedAs,ctx.actorId,at]);return {kind:'preference',key};}
  if(change.domain==='stock_protection'){
    await client.query(`UPDATE operating_guards SET is_active=0,updated_at=$4 WHERE workspace_id=$1 AND sku_id=$2
      AND location_id IS NOT DISTINCT FROM $3 AND action_type='issue' AND is_active=1`,[ctx.workspaceId,change.skuId,change.locationId||null,at]);
    if(change.operation==='remove')return {kind:'stock_guard',skuId:change.skuId,removed:true};const id=newId('guard');
    await client.query(`INSERT INTO operating_guards(id,workspace_id,sku_id,location_id,action_type,enforcement_mode,metric,
      comparator,threshold,release_condition,release_threshold,source,stated_as,is_active,created_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'issue',$5,$6,$7,$8,$9,$10,'foundry',$11,1,$12,$13,$13)`,[id,ctx.workspaceId,
      change.skuId,change.locationId||null,change.guardMode,change.locationId?'location_on_hand':'network_on_hand',
      change.guardComparator,change.guardThreshold,change.guardReleaseCondition,
      change.guardReleaseCondition==='stock_recovered'?change.guardThreshold:null,change.statedAs,ctx.actorId,at]);
    return {kind:'stock_guard',id,skuId:change.skuId};}
  throw new ValidationError('That instruction domain is not supported by the PostgreSQL runtime.');}

function target(change){if(change.domain==='replenishment')return `replenishment:${change.skuId}`;
  if(change.domain==='supplier_terms')return `supplier:${change.supplierId}:${change.skuId}`;
  if(change.domain==='transfer_authority')return 'authority:transfer';if(change.domain==='purchase_authority')return 'authority:purchase';
  if(change.domain==='operating_preference')return `preference:${number(change.daysOfStock,{positive:true})!==null?'days':'transfer'}`;
  if(change.domain==='stock_protection')return `guard:${change.skuId}:${change.locationId||'*'}`;return null;}

async function approve(database,ctx,id,expectedHash){return database.transaction(async(client)=>{await assertOwner(client,ctx);
  const proposal=await get(client,ctx.workspaceId,id,true);if(proposal.status==='APPROVED')return {...proposal,replayed:true};
  if(proposal.status!=='PENDING')throw new InvariantError('That standing instruction is no longer waiting for approval.','instruction_not_pending');
  if(proposal.questions.length)throw new ValidationError(proposal.questions[0]);
  if(expectedHash&&expectedHash!==proposal.integrityHash)throw new ValidationError('This instruction changed since you reviewed it.');
  if(hash({statedAs:proposal.statedAs,resolvedChanges:proposal.resolvedChanges})!==proposal.integrityHash)
    throw new InvariantError('That instruction snapshot failed its integrity check.','instruction_integrity');
  const applied=[];for(const change of proposal.resolvedChanges)applied.push(await applyChange(client,ctx,{...change,statedAs:proposal.statedAs}));
  const keys=new Set(proposal.resolvedChanges.map(target).filter(Boolean));const prior=(await client.query(`SELECT * FROM operating_instruction_proposals
    WHERE workspace_id=$1 AND status='APPROVED' AND id<>$2 FOR UPDATE`,[ctx.workspaceId,id])).rows;
  for(const row of prior){if(parse(row.resolved_changes,[]).some((change)=>keys.has(target(change))))
    await client.query(`UPDATE operating_instruction_proposals SET status='SUPERSEDED',updated_at=$3 WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,row.id,nowIso()]);}
  const at=nowIso();const changed=(await client.query(`UPDATE operating_instruction_proposals SET status='APPROVED',
    applied_records=$3,approved_by_user_id=$4,approved_at=$5,updated_at=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
  [ctx.workspaceId,id,JSON.stringify(applied),ctx.actorId,at])).rows[0];return {...hydrate(changed),replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});}

async function cancel(database,ctx,id){const row=(await database.query(`UPDATE operating_instruction_proposals SET status='CANCELLED',
  updated_at=$3 WHERE workspace_id=$1 AND id=$2 AND status='PENDING' RETURNING *`,[ctx.workspaceId,id,nowIso()])).rows[0];
  if(!row)throw new InvariantError('That standing instruction is no longer waiting.','instruction_not_pending');return hydrate(row);}

async function answer(database,ctx,id,value,options={}){const proposal=await get(database,ctx.workspaceId,id);
  if(proposal.status!=='PENDING'||!proposal.questions.length)throw new ValidationError('That instruction is not waiting for an answer.');
  const clean=String(value||'').trim().slice(0,500);if(!clean)throw new ValidationError('Enter the missing detail.');
  const replacement=await interpret(database,ctx,`${proposal.statedAs}\nClarification: ${clean}`,options);
  await database.query(`UPDATE operating_instruction_proposals SET status='SUPERSEDED',updated_at=$3
    WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[ctx.workspaceId,id,nowIso()]);return replacement;}

module.exports={SCHEMA,SYSTEM,interpret,get,approve,cancel,answer,describe};

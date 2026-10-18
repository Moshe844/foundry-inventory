'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const catalog=require('../domain/postgres-catalog-service');
const locations=require('../domain/postgres-location-service');
const inventory=require('../domain/postgres-inventory-engine');
const prices=require('../pricing/postgres-service');
const mapping=require('./postgres-provider-sync');
const parse=require('./postgres-service').parseJson;
const {exclusion}=require('./catalog-record-policy');
function revision(connection,rows){return require('./commerce-facts').hash({id:connection.id,
 rows:rows.map(r=>[r.id,r.external_id,r.parent_external_id,r.display_name,r.mapping_status,
  r.foundry_record_id||null,r.selected,r.code,parse(r.provider_data,{})])});}
async function read(queryable,ctx,connectorId,{lock=false}={}){
 const connection=(await queryable.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,connectorId])).rows[0];
 if(!connection)throw new ValidationError('That connection is not in this business.');
 const rows=(await queryable.query(`SELECT e.*,m.foundry_record_id FROM connection_external_records e
 LEFT JOIN connection_mappings m ON m.workspace_id=e.workspace_id AND m.connector_id=e.connector_id AND m.entity_type=e.entity_type AND m.external_id=e.external_id
 WHERE e.workspace_id=$1 AND e.connector_id=$2 AND e.selected=1 ORDER BY e.entity_type,e.external_id${lock?' FOR UPDATE OF e':''}`,[ctx.workspaceId,connectorId])).rows;
 return {connection,rows,revision:revision(connection,rows)};
}
async function owner(client,ctx){
 const row=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(row?.role!=='owner')throw new AuthorizationError('Only an owner can approve provider matching and opening stock.');
}
async function describe(database,ctx,connectorId){
 const state=await read(database,ctx,connectorId);
 const [skus,places]=await Promise.all([
  database.query(`SELECT s.id,s.code,i.name,s.variant_label FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 ORDER BY lower(i.name),s.position`,[ctx.workspaceId]),
  database.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY lower(name)',[ctx.workspaceId])]);
 return {...state,rows:state.rows.map(row=>({...row,data:parse(row.provider_data,{}),exclusion:exclusion(parse(row.provider_data,{}))})),skus:skus.rows,locations:places.rows};
}
async function mutate(database,ctx,connectorId,input,operation){
 return database.transaction(async client=>{
  await owner(client,ctx);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`provider-sync:${connectorId}`]);
  const state=await read(client,ctx,connectorId,{lock:true});
  if(state.connection.status!=='connected'||state.connection.paused_at)throw new ValidationError('Reconnect or resume this provider before changing its matches.');
  await require('../commercial/enforcement').workspace(client,ctx.workspaceId,'connections.commerce');
  if(input.revision&&input.revision!==state.revision)throw new ValidationError('The provider catalogue or its matches changed. Review the current records before confirming.');
  const result=await operation(client,state);
  const remaining=(await client.query("SELECT count(*) AS n FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 AND selected=1 AND mapping_status='UNMAPPED'",[ctx.workspaceId,connectorId])).rows[0];
  await client.query("UPDATE workspace_connectors SET setup_status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connectorId,Number(remaining.n)?'MAPPING':'CONNECTED',nowIso()]);
  return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
function selectedRecord(state,entityType,externalId){
 const row=state.rows.find(r=>r.entity_type===entityType&&r.external_id===externalId);
 if(!row)throw new ValidationError('That provider record is no longer in the current catalogue. Refresh and review it.');
 return row;
}
async function mapExternal(database,ctx,connectorId,input){
 return mutate(database,ctx,connectorId,input,async(client,state)=>{
  const record=selectedRecord(state,input.entityType,input.externalId);
  const reason=exclusion(parse(record.provider_data,{}));if(reason)throw new ValidationError(reason);
  return mapping.setMappingInTransaction(client,ctx,{...input,connectorId});
 });
}
async function createLocation(database,ctx,connectorId,input){
 return mutate(database,ctx,connectorId,input,async(client,state)=>{
  const row=selectedRecord(state,'location',input.externalId);
  if(row.foundry_record_id)return {id:row.foundry_record_id,replayed:true};
  const reason=exclusion(parse(row.provider_data,{}));if(reason)throw new ValidationError(reason);
  const place=await locations.createLocationInTransaction(client,ctx,{name:row.display_name,kind:'store',note:'Imported from '+state.connection.display_name+'; '+row.external_id});
  await mapping.setMappingInTransaction(client,ctx,{connectorId,entityType:'location',externalId:row.external_id,foundryRecordId:place.id});
  return place;
 });
}
async function ignore(database,ctx,connectorId,input){
 return mutate(database,ctx,connectorId,input,async(client,state)=>{
  const row=selectedRecord(state,input.entityType,input.externalId);
  if(row.foundry_record_id)throw new ValidationError('An established match cannot be discarded as an excluded product.');
  const reason=exclusion(parse(row.provider_data,{}));if(!reason)throw new ValidationError('This is a supported physical record. Match it or import it instead of hiding it.');
  const at=nowIso();
  await client.query("UPDATE connection_external_records SET mapping_status='IGNORED',updated_at=$4 WHERE workspace_id=$1 AND connector_id=$2 AND id=$3",[ctx.workspaceId,connectorId,row.id,at]);
  await mapping.resolveMappingIssues(client,state.connection,input.entityType,input.externalId,at);
  return {excluded:true,reason};
 });
}
async function importProducts(database,ctx,connectorId,input){
 const ids=[...new Set((Array.isArray(input.externalIds)?input.externalIds:[input.externalIds]).filter(Boolean).map(String))];
 if(!ids.length||ids.length>500)throw new ValidationError('Select between 1 and 500 products or variants.');
 const includeOpening=input.includeOpening===true||input.includeOpening==='1';
 return mutate(database,ctx,connectorId,input,async(client,state)=>{
  const requested=ids.map(id=>selectedRecord(state,'sku',id));
  const groups=new Set(requested.filter(r=>!r.foundry_record_id&&r.mapping_status!=='IGNORED').map(r=>r.parent_external_id||r.external_id));
  const result={items:0,mapped:0,prices:0,openingUnits:0,openingMovements:[],replayed:groups.size===0};
  for(const group of groups){
   const siblings=state.rows.filter(r=>r.entity_type==='sku'&&(r.parent_external_id||r.external_id)===group);
   const records=siblings.filter(r=>!r.foundry_record_id&&r.mapping_status!=='IGNORED'&&!exclusion(parse(r.provider_data,{})));
   if(!records.length)throw new ValidationError('The selected product is excluded from physical inventory. Review its explanation.');
   const details=records.map(row=>({row,data:parse(row.provider_data,{})}));
   if(includeOpening){for(const {row,data}of details)for(const count of data.inventoryCounts||[]){
    const amount=Number(count.quantity);if(!Number.isSafeInteger(amount)||amount<0)throw new ValidationError('The provider supplied unsupported opening stock for '+row.display_name+'.');
    if(amount>0&&!(await client.query("SELECT 1 FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='location' AND external_id=$3",[ctx.workspaceId,connectorId,String(count.externalLocationId)])).rows.length)throw new ValidationError('Match every location holding this product before importing its opening stock.');
   }}
   const established=siblings.find(r=>r.foundry_record_id);
   let created;
   if(established){
    const parent=(await client.query('SELECT item_id FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,established.foundry_record_id])).rows[0];
    const opts=(await client.query('SELECT id,name FROM item_options WHERE workspace_id=$1 AND item_id=$2 ORDER BY position',[ctx.workspaceId,parent.item_id])).rows;
    const scoped={query:(s,v)=>client.query(s,v),transaction:fn=>fn(client)};created={skus:[]};
    for(const {row,data}of details){const options=(data.selectedOptions||[]).filter(o=>!(o.name==='Title'&&o.value==='Default Title'));
     if(!opts.length||options.some(o=>!opts.some(p=>p.name===o.name)))throw new ValidationError('The provider changed its variant option structure. Review this product before adding a new variant.');
     const variant=await catalog.addVariant(scoped,ctx,parent.item_id,{optionValues:Object.fromEntries(opts.map(o=>[o.id,options.find(p=>p.name===o.name)?.value]))});created.skus.push({...variant,key:row.external_id});
    }
   }else{
    created=await catalog.createImportedItemInTransaction(client,ctx,{name:details[0].data.itemName||records[0].display_name,trackingMode:'quantity',description:'Imported from '+state.connection.display_name+'; '+group,
     variants:details.map(({row,data})=>({key:row.external_id,code:row.code||undefined,label:data.variationName||null,options:(data.selectedOptions||[]).filter(o=>!(o.name==='Title'&&o.value==='Default Title'))}))});result.items++;
   }
   for(const {row,data}of details){
    const sku=created.skus.find(s=>s.key===row.external_id);if(!sku)throw new ValidationError('The imported variant identity was not preserved.');
    await mapping.setMappingInTransaction(client,ctx,{connectorId,entityType:'sku',externalId:row.external_id,foundryRecordId:sku.skuId});result.mapped++;
    if(data.priceMoney){const amount=data.priceMoney.amount;if(!Number.isSafeInteger(amount)||amount<0)throw new ValidationError('The provider price is invalid.');
     await prices.setPriceInTransaction(client,ctx,{skuId:sku.skuId,amountMinor:amount,currency:data.priceMoney.currency,source:'provider_opening_catalog',sourceDetail:{connectorId,externalId:row.external_id}});result.prices++;}
    if(includeOpening)for(const count of data.inventoryCounts||[]){
     const amount=Number(count.quantity);if(!amount)continue;
     const place=(await client.query("SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='location' AND external_id=$3",[ctx.workspaceId,connectorId,String(count.externalLocationId)])).rows[0];
     const receipt=await inventory.receiveInTransaction(client,ctx,{skuId:sku.skuId,locationId:place.foundry_record_id,quantity:amount,reference:'Provider opening stock',notes:'Captured from '+state.connection.display_name+'; no supplier liability or inventory cost inferred.',idempotencyKey:'provider-opening:'+connectorId+':'+row.external_id+':'+count.externalLocationId});
     result.openingUnits+=amount;result.openingMovements.push(receipt.movementId);
    }
   }
  }
  await client.query(`INSERT INTO connection_sync_runs(id,workspace_id,connector_id,sync_kind,status,discovered_products,discovered_locations,auto_mapped,needs_mapping,started_at,completed_at)
   VALUES($1,$2,$3,'OWNER_CATALOG_IMPORT','COMPLETED',$4,0,$4,0,$5,$5)`,[newId('csync'),ctx.workspaceId,connectorId,result.mapped,nowIso()]);
  return result;
 });
}
module.exports={describe,mapExternal,createLocation,importProducts,ignore,exclusion};
require('../commercial/enforcement').guardExports(module.exports,0,1,{mapExternal:'connections.commerce',createLocation:'connections.commerce',importProducts:'connections.commerce',ignore:'connections.commerce'});

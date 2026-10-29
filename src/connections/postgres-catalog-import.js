'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso}=require('../lib/util');
const catalog=require('../domain/postgres-catalog-service');
const locations=require('../domain/postgres-location-service');
const inventory=require('../domain/postgres-inventory-engine');
const prices=require('../pricing/postgres-service');
const mapping=require('./postgres-provider-sync');
const parse=require('./postgres-service').parseJson;
const {exclusion,openingCounts}=require('./catalog-record-policy');
function revision(connection){return require('./commerce-facts').hash({id:connection.id,revision:String(connection.catalogue_revision)});}
async function read(queryable,ctx,connectorId,{lock=false,scope=null,page=null}={}){
 const connection=(await queryable.query(`SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.workspaceId,connectorId])).rows[0];
 if(!connection)throw new ValidationError('That connection is not in this business.');
 const values=[ctx.workspaceId,connectorId];
 let where='';
 if(scope){
  values.push(scope.entityType,scope.externalIds);
  where=scope.families?` AND e.entity_type=$3 AND COALESCE(NULLIF(e.parent_external_id,''),e.external_id) IN
   (SELECT COALESCE(NULLIF(parent_external_id,''),external_id) FROM connection_external_records
    WHERE workspace_id=$1 AND connector_id=$2 AND entity_type=$3 AND external_id=ANY($4::text[]) AND selected=1)`:
   ' AND e.entity_type=$3 AND e.external_id=ANY($4::text[])';
 }else if(page){
  values.push(page.afterType||'',page.afterExternalId||'',page.q||null);
  where=` AND (e.entity_type,e.external_id)>($3::text,$4::text)
   AND ($5::text IS NULL OR e.display_name ILIKE '%'||$5||'%' OR e.code ILIKE '%'||$5||'%' OR e.external_id=$5)`;
 }
 const rows=(await queryable.query(`SELECT e.*,m.foundry_record_id FROM connection_external_records e
 LEFT JOIN connection_mappings m ON m.workspace_id=e.workspace_id AND m.connector_id=e.connector_id AND m.entity_type=e.entity_type AND m.external_id=e.external_id
 WHERE e.workspace_id=$1 AND e.connector_id=$2 AND e.selected=1${where} ORDER BY e.entity_type,e.external_id${page?' LIMIT 101':''}${lock?' FOR UPDATE OF e':''}`,values)).rows;
 return {connection,rows,revision:revision(connection)};
}
async function owner(client,ctx){
 const row=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(row?.role!=='owner')throw new AuthorizationError('Only an owner can approve provider matching and opening stock.');
}
async function describe(database,ctx,connectorId,input={}){
 const q=String(input.catalogueQ||'').trim().slice(0,160),matchQ=String(input.matchQ||'').trim().slice(0,160);
 const afterType=['location','sku'].includes(input.afterType)?input.afterType:'',afterExternalId=String(input.afterExternalId||'').slice(0,240);
 const state=await read(database,ctx,connectorId,{page:{afterType,afterExternalId,q}});
 const hasMore=state.rows.length>100;state.rows=state.rows.slice(0,100);
 async function matchingSkus(){
  if(matchQ){const exact=await database.query(`SELECT s.id,s.code,i.name,s.variant_label FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
   WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND lower(s.code)=lower($2) ORDER BY s.code,s.id LIMIT 101`,[ctx.workspaceId,matchQ]);if(exact.rows.length)return exact;}
  return database.query(`SELECT s.id,s.code,i.name,s.variant_label FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
   WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
    AND ($2::text IS NULL OR i.name ILIKE '%'||$2||'%' OR s.variant_label ILIKE '%'||$2||'%')
   ORDER BY s.code,s.id LIMIT 101`,[ctx.workspaceId,matchQ||null]);
 }
 const [skus,places]=await Promise.all([
  matchingSkus(),
  database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1
   AND ($2::text IS NULL OR name ILIKE '%'||$2||'%') ORDER BY name,id LIMIT 101`,[ctx.workspaceId,matchQ||null])]);
 return {...state,rows:state.rows.map(row=>{const data=parse(row.provider_data,{});return {...row,
  data:{...data,inventoryCounts:openingCounts(data),inventoryCountNote:data.inventoryCountNote||data.inventoryCountUnavailable||(data.tracked===false?'The provider does not track physical stock for this product. Confirm quantities before recording any stock.':null)},
  exclusion:exclusion(data)};}),skus:skus.rows.slice(0,100),locations:places.rows.slice(0,100),
  page:{q,matchQ,hasMore,afterType,afterExternalId,next:hasMore?{afterType:state.rows.at(-1).entity_type,afterExternalId:state.rows.at(-1).external_id}:null,
   moreSkus:skus.rows.length>100,moreLocations:places.rows.length>100}};
}
async function mutate(database,ctx,connectorId,input,operation,recordScope=null){
 return database.transaction(async client=>{
  await owner(client,ctx);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`provider-sync:${connectorId}`]);
  // The connector revision covers all semantic source and mapping changes;
  // validation and mutation only load the affected records/product families.
  const state=await read(client,ctx,connectorId,{lock:true,scope:recordScope});
  if(state.connection.status!=='connected'||state.connection.paused_at)throw new ValidationError('Reconnect or resume this provider before changing its matches.');
  const currentPolicy=parse(state.connection.config,{});
  if(input.automatic===true&&(currentPolicy.autoImportCatalog!==true||
      (input.includeOpening===true&&currentPolicy.autoImportOpeningStock!==true)))
    throw new ValidationError('Automatic import authority changed. Review the current connection settings before continuing.');
  const accounting=require('./providers/registry').get(state.connection.provider_type)?.integrationClass==='accounting';
  await require('../commercial/enforcement').workspace(client,ctx.workspaceId,accounting?'connections.accounting':'connections.commerce');
  if(input.revision&&input.revision!==state.revision)throw new ValidationError('The provider catalogue or its matches changed. Review the current records before confirming.');
  const result=await operation(client,state);
  const remaining=(await client.query("SELECT 1 FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 AND selected=1 AND mapping_status='UNMAPPED' LIMIT 1",[ctx.workspaceId,connectorId])).rows.length;
  await client.query("UPDATE workspace_connectors SET setup_status=$3,updated_at=$4 WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connectorId,accounting?state.connection.setup_status:remaining?'MAPPING':'CONNECTED',nowIso()]);
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
 },{entityType:input.entityType,externalIds:[input.externalId]});
}
async function createLocation(database,ctx,connectorId,input){
 return mutate(database,ctx,connectorId,input,async(client,state)=>{
  const row=selectedRecord(state,'location',input.externalId);
  if(row.foundry_record_id)return {id:row.foundry_record_id,replayed:true};
  const reason=exclusion(parse(row.provider_data,{}));if(reason)throw new ValidationError(reason);
  const suppliedKind=parse(row.provider_data,{}).kind;
  const kind=require('../domain/constants').LOCATION_KIND_IDS.includes(suppliedKind)?suppliedKind:'store';
  const place=await locations.createLocationInTransaction(client,ctx,{name:row.display_name,kind,note:'Imported from '+state.connection.display_name+'; '+row.external_id});
  await mapping.setMappingInTransaction(client,ctx,{connectorId,entityType:'location',externalId:row.external_id,foundryRecordId:place.id});
  return place;
 },{entityType:'location',externalIds:[input.externalId]});
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
 },{entityType:input.entityType,externalIds:[input.externalId]});
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
   if(includeOpening){for(const {row,data}of details)for(const count of openingCounts(data)){
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
    await require('./postgres-catalog-reconciliation').register(client,ctx,connectorId,row.external_id,sku.skuId);
    if(includeOpening)for(const count of openingCounts(data)){
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
 },{entityType:'sku',externalIds:ids,families:true});
}
async function importAutomatic(database,ctx,connectorId){
 const connection=(await database.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,connectorId])).rows[0];
 if(!connection)throw new ValidationError('That connection is not in this business.');
 if(parse(connection.config,{}).autoImportCatalog!==true)return {skipped:'catalogue_import_not_enabled'};
 const summary={locations:0,products:0,prices:0,openingUnits:0};
 for(const entityType of ['location','sku']){
  let after=null;
  while(true){
   const page=(await database.query(`SELECT e.external_id,e.provider_data FROM connection_external_records e
    WHERE e.workspace_id=$1 AND e.connector_id=$2 AND e.entity_type=$3 AND e.selected=1 AND e.mapping_status='UNMAPPED'
     AND ($4::text IS NULL OR e.external_id>$4) AND NOT EXISTS(SELECT 1 FROM connection_mappings m
      WHERE m.workspace_id=e.workspace_id AND m.connector_id=e.connector_id AND m.entity_type=e.entity_type AND m.external_id=e.external_id)
    ORDER BY e.external_id LIMIT 500`,[ctx.workspaceId,connectorId,entityType,after])).rows;
   if(!page.length)break;
   after=page.at(-1).external_id;
   const ids=page.filter(r=>!exclusion(parse(r.provider_data,{}))).map(r=>r.external_id);
   if(entityType==='location'){
    for(const externalId of ids){const location=await createLocation(database,ctx,connectorId,{externalId,automatic:true});if(!location.replayed)summary.locations++;}
    continue;
   }
   if(!ids.length)continue;
  // The owner authorizes initial quantities explicitly at connection/setup.
  // Reuse the canonical new-record-only receipt and stable idempotency keys;
  // never replay historical orders or reset stock on subsequent snapshots.
  const imported=await importProducts(database,ctx,connectorId,{externalIds:ids,automatic:true,
    includeOpening:parse(connection.config,{}).autoImportOpeningStock===true});
  summary.products+=imported.mapped;summary.prices+=imported.prices;
  summary.openingUnits+=imported.openingUnits;
  }
 }
 return summary;
}
module.exports={describe,mapExternal,createLocation,importProducts,ignore,exclusion,importAutomatic};
for(const name of ['importAutomatic']){
 const original=module.exports[name];module.exports[name]=async(database,ctx,connectorId)=>{
  const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(database,ctx.workspaceId),context=require('../commercial/context');
  return context.run({...context.current(),database,scope,requestId:context.current()?.requestId||newId('operation')},()=>original(database,ctx,connectorId));
 };
}
for(const name of ['mapExternal','createLocation','importProducts','ignore']){
 const original=module.exports[name];
 module.exports[name]=async(database,ctx,connectorId,...args)=>{
  const connection=await require('./postgres-service').get(database,ctx.workspaceId,connectorId);
  const capability=require('./providers/registry').get(connection.provider_type)?.integrationClass==='accounting'?'connections.accounting':'connections.commerce';
  await require('../commercial/enforcement').workspace(database,ctx.workspaceId,capability);
  const scope=await require('../commercial/entitlements').ownerScopeForWorkspace(database,ctx.workspaceId),context=require('../commercial/context');
  return context.run({...context.current(),database,scope,requestId:context.current()?.requestId||newId('operation')},()=>original(database,ctx,connectorId,...args));
 };
}

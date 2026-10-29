'use strict';
const {newId,nowIso}=require('../lib/util');
const {AuthorizationError}=require('../domain/errors');
const {parseJson:parse}=require('./postgres-service');
const prices=require('../pricing/postgres-service');
const catalog=require('../domain/postgres-catalog-service');
const {exclusion}=require('./catalog-record-policy');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const priceValue=row=>row?.amount_minor==null?null:{amount:Number(row.amount_minor),currency:row.currency};
async function save(client,w,id,state){await client.query('UPDATE connection_mappings SET catalog_sync_state=$3 WHERE workspace_id=$1 AND id=$2',[w,id,JSON.stringify(state)]);}
async function register(client,ctx,connectorId,externalId,skuId){
 const item=(await client.query('SELECT i.id,i.name FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE s.workspace_id=$1 AND s.id=$2',[ctx.workspaceId,skuId])).rows[0];
 const price=await prices.currentPrice(client,ctx.workspaceId,skuId);
 await client.query(`UPDATE connection_mappings SET catalog_sync_state=$5 WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku' AND external_id=$3 AND foundry_record_id=$4`,
 [ctx.workspaceId,connectorId,externalId,skuId,JSON.stringify({imported:true,itemId:item.id,nameBase:item.name,priceBase:priceValue(price),priceId:price.id})]);
}
async function issue(client,c,row,field,conflict){
 const fingerprint='catalog-sync:'+c.id+':'+row.external_id+':'+field,at=nowIso();
 if(!conflict){await client.query("UPDATE connection_issues SET status='RESOLVED',resolved_at=$4,updated_at=$4 WHERE workspace_id=$1 AND connector_id=$2 AND fingerprint=$3 AND status='OPEN'",[c.workspace_id,c.id,fingerprint,at]);return;}
 await client.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
  VALUES($1,$2,$3,'CATALOG_SYNC_CONFLICT',$4,$5,$6,$7,'OPEN',$8,$8) ON CONFLICT(workspace_id,fingerprint)
  DO UPDATE SET status='OPEN',resolved_at=NULL,detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at`,
 [newId('conissue'),c.workspace_id,c.id,fingerprint,'Review '+field+' for '+row.display_name,
  'StockChief and the provider have different values for this '+field+'. Your StockChief value was preserved because it could not be replaced safely.',
  'Review both values and set the intended value. Matching values resolve the conflict on the next check.',at]);
}
async function audit(client,c,row,field,before,after){
 const id=newId('evt'),at=nowIso();
 await client.query(`INSERT INTO domain_events(id,workspace_id,event_type,payload,source,source_record_type,source_record_id,idempotency_key,status,result,created_at,processed_at)
  VALUES($1,$2,'connection.catalog.updated',$3,'provider_sync','connection',$4,$1,'PROCESSED','{"verified":true}',$5,$5)`,
 [id,c.workspace_id,JSON.stringify({actorId:c.authorized_by_user_id,connectorId:c.id,externalId:row.external_id,skuId:row.foundry_record_id,field,before,after}),c.id,at]);
}
async function reconcile(client,c,previous){
 if(parse(c.config,{}).autoImportCatalog!==true)return {names:0,prices:0,conflicts:0};
 const ctx={workspaceId:c.workspace_id,actorId:c.authorized_by_user_id};
 const actor=(await client.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(actor?.role!=='owner')throw new AuthorizationError('Automatic catalogue authority changed. The business owner must review this connection.');
 // Compute family-wide ambiguity once in PostgreSQL (which can spill its
 // aggregation to disk). Never decide a name from just the current page.
 await client.query(`CREATE TEMP TABLE stockchief_catalog_sync_names ON COMMIT DROP AS
  SELECT s.item_id,COUNT(DISTINCT NULLIF(e.provider_data::jsonb->>'itemName',''))::integer AS name_count
  FROM connection_external_records e JOIN connection_mappings m ON m.workspace_id=e.workspace_id AND m.connector_id=e.connector_id AND m.entity_type=e.entity_type AND m.external_id=e.external_id
  JOIN skus s ON s.workspace_id=e.workspace_id AND s.id=m.foundry_record_id
  WHERE e.workspace_id=$1 AND e.connector_id=$2 AND e.entity_type='sku' AND e.selected=1 AND e.mapping_status='MAPPED' AND s.is_active=1
  GROUP BY s.item_id`,[c.workspace_id,c.id]);
 await client.query('CREATE UNIQUE INDEX ON stockchief_catalog_sync_names(item_id)');
 const result={names:0,prices:0,conflicts:0};let after=null;
 for(;;){
 const rows=(await client.query(`SELECT e.*,m.id AS mapping_id,m.foundry_record_id,m.catalog_sync_state,s.item_id,names.name_count
  FROM connection_external_records e JOIN connection_mappings m ON m.workspace_id=e.workspace_id AND m.connector_id=e.connector_id AND m.entity_type=e.entity_type AND m.external_id=e.external_id
  JOIN skus s ON s.workspace_id=e.workspace_id AND s.id=m.foundry_record_id
  JOIN stockchief_catalog_sync_names names ON names.item_id=s.item_id
  WHERE e.workspace_id=$1 AND e.connector_id=$2 AND e.entity_type='sku' AND e.selected=1 AND e.mapping_status='MAPPED' AND s.is_active=1
    AND ($3::text IS NULL OR e.external_id>$3) ORDER BY e.external_id LIMIT 500 FOR UPDATE OF m`,[c.workspace_id,c.id,after])).rows;
 for(const row of rows){
  const data=parse(row.provider_data,{});if(exclusion(data))continue;
  let state=parse(row.catalog_sync_state,{});
  if(state.imported&&state.itemId===row.item_id&&!state.nameConflict&&!state.priceConflict&&Number(row.name_count)===1&&
    state.nameBase===data.itemName&&same(state.priceBase,data.priceMoney||null))continue;
  const item=(await client.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2 AND is_active=1 FOR UPDATE',[c.workspace_id,row.item_id])).rows[0];if(!item)continue;
  const price=await prices.currentPrice(client,c.workspace_id,row.foundry_record_id);
  if(!state.imported){
   // Adopt legacy imports only from the canonical price's exact provenance.
   // Merely matching a local product never gives a provider write authority.
   const source=parse(price.source_detail,{});
   if(price.source!=='provider_opening_catalog'||source.connectorId!==c.id||source.externalId!==row.external_id)continue;
   const prior=previous.get(row.external_id)||{};
   state={imported:true,itemId:item.id,priceBase:priceValue(price),priceId:price.id,
    ...(prior.itemName===item.name?{nameBase:item.name}:{})};
  }
  if(state.itemId!==item.id)continue;
  const wantedName=data.itemName;
  if(typeof state.nameBase!=='string'&&wantedName===item.name)state.nameBase=item.name;
  if(typeof state.nameBase!=='string'&&typeof wantedName==='string'&&wantedName!==item.name){state.nameConflict=true;await issue(client,c,row,'name',true);result.conflicts++;}
  if(typeof state.nameBase==='string'&&typeof wantedName==='string'&&wantedName.trim()){
   const conflict=Number(row.name_count)!==1||(wantedName!==state.nameBase&&item.name!==state.nameBase&&item.name!==wantedName);
   state.nameConflict=conflict;
   await issue(client,c,row,'name',conflict);
   if(conflict)result.conflicts++;
   else if(wantedName!==state.nameBase){
    if(item.name!==wantedName){await catalog.updateItem({query:(s,v)=>client.query(s,v),transaction:fn=>fn(client)},ctx,item.id,
      {name:wantedName,baseCode:item.base_code,description:item.description,unitLabel:item.unit_label,allowNegative:Boolean(item.allow_negative)});
     await audit(client,c,row,'name',item.name,wantedName);result.names++;}
    state.nameBase=wantedName;
   }
  }
  const pricePolicy=(await client.query("SELECT 1 FROM connection_commerce_positions WHERE workspace_id=$1 AND connector_id=$2 AND sku_id=$3 AND field='price' AND mode<>'off' LIMIT 1",[c.workspace_id,c.id,row.foundry_record_id])).rows.length;
  if(pricePolicy){await save(client,c.workspace_id,row.mapping_id,state);continue;}
  const wanted=data.priceMoney;let validPrice=true;
  if(wanted){try{require('../domain/currency').code(wanted.currency);validPrice=Number.isSafeInteger(wanted.amount)&&wanted.amount>=0;}catch{validPrice=false;}}
  if(wanted&&!validPrice){state.priceConflict=true;await issue(client,c,row,'price',true);result.conflicts++;}
  else if(wanted&&!same(wanted,state.priceBase)){
   const current=priceValue(price),conflict=price.id!==state.priceId&&!same(current,wanted);
   state.priceConflict=conflict;
   await issue(client,c,row,'price',conflict);
   if(conflict)result.conflicts++;
   else{
    if(!same(current,wanted)){const next=await prices.setPriceInTransaction(client,ctx,{skuId:row.foundry_record_id,
      amountMinor:wanted.amount,currency:wanted.currency,expectedCurrentId:price.id,source:'provider_catalog_sync',sourceDetail:{connectorId:c.id,externalId:row.external_id}});
     await audit(client,c,row,'price',current,wanted);state.priceId=next.id;result.prices++;
    }else state.priceId=price.id;
    state.priceBase=wanted;
   }
  }else if(wanted){state.priceConflict=false;await issue(client,c,row,'price',false);}
  await save(client,c.workspace_id,row.mapping_id,state);
 }
 if(rows.length<500)break;after=rows.at(-1).external_id;
 }
 await client.query('DROP TABLE pg_temp.stockchief_catalog_sync_names');
 return result;
}
module.exports={register,reconcile};

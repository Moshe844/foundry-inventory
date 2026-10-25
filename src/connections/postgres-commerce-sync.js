'use strict';

const crypto=require('node:crypto');
const {newId,nowIso}=require('../lib/util');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const prices=require('../pricing/postgres-service');
const effects=require('../operations/postgres-provider-effects');
const providers=require('./providers/registry');
const parse=require('./postgres-service').parseJson;
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().filter(k=>v[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const same=(a,b)=>stable(a)===stable(b);
const hash=v=>crypto.createHash('sha256').update(stable(v)).digest('hex');
const modes=['off','inbound','outbound','two_way'];
const scoped=c=>({query:(s,v)=>c.query(s,v),transaction:fn=>fn(c)});
async function connection(db,ctx,id,{allowInactive=false}={}){
 const owner=(await db.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(owner?.role!=='owner')throw new AuthorizationError('Only this inventory’s owner can authorize channel stock and price synchronization.');
 const c=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 if(!c)throw new NotFoundError('Connection not found.');
 if(!allowInactive&&(c.status!=='connected'||c.paused_at||parse(c.config,{}).syncDisabled===true))throw new ValidationError('Reconnect or resume this connection before synchronizing stock or prices.');
 return c;
}
async function local(db,p){
 const row=(await db.query(`SELECT s.id,i.tracking_mode,b.on_hand,b.updated_at,loc.custody_agreement_id,
   COALESCE(cost.quantity_units,0) AS costed,
   COALESCE((SELECT SUM(a.quantity) FROM sales_order_allocations a JOIN sales_order_lines l ON l.id=a.sales_order_line_id AND l.workspace_id=a.workspace_id
     JOIN sales_orders o ON o.id=l.sales_order_id AND o.workspace_id=l.workspace_id
     WHERE a.workspace_id=s.workspace_id AND l.sku_id=s.id AND a.location_id=$3 AND o.status NOT IN ('CANCELLED','FULFILLED')),0) AS committed
  FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
  JOIN locations loc ON loc.workspace_id=s.workspace_id AND loc.id=$3 AND loc.is_active=1
  LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=loc.id
  LEFT JOIN accounting_inventory_cost_balances cost ON cost.workspace_id=s.workspace_id AND cost.sku_id=s.id AND cost.location_id=loc.id
  WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1`,[p.workspace_id,p.sku_id,p.location_id])).rows[0];
 if(!row)throw new ValidationError('The mapped product or location is no longer active.');
 if(p.field==='price'){const v=await prices.currentPrice(db,p.workspace_id,p.sku_id);return {value:v.amount_minor===null?null:{amount:v.amount_minor,currency:v.currency},version:v.id};}
 const physical=Number(row.on_hand||0),costed=Number(row.costed),committed=Number(row.committed);
 if(![physical,costed,committed].every(Number.isSafeInteger))throw new ValidationError('This stock position needs an exact quantity review.');
 return {value:row.custody_agreement_id?0:Math.max(0,Math.min(physical,costed)-committed),physical,costed,committed,tracking:row.tracking_mode,version:row.updated_at||null};
}
async function mapped(db,p){
 return Boolean((await db.query(`SELECT 1 FROM connection_mappings sku JOIN connection_mappings loc ON loc.workspace_id=sku.workspace_id AND loc.connector_id=sku.connector_id AND loc.entity_type='location'
  WHERE sku.workspace_id=$1 AND sku.connector_id=$2 AND sku.entity_type='sku' AND sku.external_id=$3 AND sku.foundry_record_id=$4
   AND loc.external_id=$5 AND loc.foundry_record_id=$6`,[p.workspace_id,p.connector_id,p.external_id,p.sku_id,p.external_location_id,p.location_id])).rows.length);
}
const readInput=(p,credentials)=>({credentials,externalId:p.external_id,parentExternalId:p.parent_external_id,externalLocationId:p.external_location_id,field:p.field});
async function providerRead(db,c,p,adapter,key){
 return require('../commercial/operations').run(db,p.workspace_id,{capability:'connections.commerce',key,provider:c.provider_type,operation:'commerce_position_read'},async()=>{
  const credentials=await require('./postgres-provider-service').loadProviderCredentials(db,c,adapter);
  return adapter.readSyncPosition(readInput(p,credentials));
 });
}
async function issue(db,p,detail){
 const at=nowIso(),fingerprint='commerce-position:'+p.id;
 if(!detail){await db.query("UPDATE connection_issues SET status='RESOLVED',resolved_at=$4,updated_at=$4 WHERE workspace_id=$1 AND connector_id=$2 AND fingerprint=$3 AND status='OPEN'",[p.workspace_id,p.connector_id,fingerprint,at]);return;}
 await db.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,status,created_at,updated_at)
 VALUES($1,$2,$3,'COMMERCE_SYNC_REVIEW',$4,$5,$6,$7,'OPEN',$8,$8) ON CONFLICT(workspace_id,fingerprint) DO UPDATE SET status='OPEN',resolved_at=NULL,title=EXCLUDED.title,detail=EXCLUDED.detail,updated_at=EXCLUDED.updated_at`,
 [newId('conissue'),p.workspace_id,p.connector_id,fingerprint,p.field==='quantity'?'Review channel stock difference':'Review channel price difference',detail,
  'Ask StockChief to compare the saved channel synchronization for this product. Physical quantity corrections require evidence and approval; sales, receipts and refunds are never inferred from a count.',at]);
}
async function audit(db,p,type,detail){const id=newId('evt'),at=nowIso();await db.query(`INSERT INTO domain_events(id,workspace_id,event_type,payload,source,source_record_type,source_record_id,idempotency_key,status,result,created_at,processed_at)
 VALUES($1,$2,$3,$4,'commerce_sync','connection',$5,$1,'PROCESSED','{"verified":true}',$6,$6)`,[id,p.workspace_id,type,JSON.stringify({positionId:p.id,skuId:p.sku_id,locationId:p.location_id,field:p.field,...detail}),p.connector_id,at]);}
async function advance(db,p,l,r){await db.query(`UPDATE connection_commerce_positions SET baseline_local=$4::jsonb,baseline_provider=$5::jsonb,last_verified_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$3`,[p.workspace_id,p.id,p.revision,JSON.stringify(l),JSON.stringify(r)]);await issue(db,p,null);}
async function prepare(db,ctx,c,args,options={}){
 const disabling=[args.quantitySyncMode,args.priceSyncMode].some(v=>v==='off')&&[args.quantitySyncMode,args.priceSyncMode].every(v=>v==null||v==='off');
 const active=await connection(db,ctx,c.id,{allowInactive:disabling}),adapter=(options.providers||providers).get(active.provider_type);
 if(!active.provider_account_id)throw new ValidationError('Verify the connected provider account identity before authorizing write-back.');
 if(!adapter?.readSyncPosition||!adapter?.writeSyncPosition)throw new ValidationError('This connection does not support governed stock and price synchronization.');
 const sku=(await db.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND is_active=1 AND (id=$2 OR lower(code)=lower($2)) LIMIT 2',[ctx.workspaceId,args.sku])).rows;
 const loc=(await db.query('SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 AND (id=$2 OR lower(name)=lower($2)) LIMIT 2',[ctx.workspaceId,args.location])).rows;
 if(sku.length!==1||loc.length!==1)throw new ValidationError('Choose one exact mapped SKU and location for this synchronization policy.');
 const skumaps=(await db.query(`SELECT m.external_id,e.parent_external_id FROM connection_mappings m JOIN connection_external_records e ON e.workspace_id=m.workspace_id AND e.connector_id=m.connector_id AND e.entity_type=m.entity_type AND e.external_id=m.external_id
  WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.entity_type='sku' AND m.foundry_record_id=$3 AND e.selected=1`,[ctx.workspaceId,c.id,sku[0].id])).rows;
 const locmaps=(await db.query("SELECT external_id FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='location' AND foundry_record_id=$3",[ctx.workspaceId,c.id,loc[0].id])).rows;
 if(skumaps.length!==1||locmaps.length!==1)throw new ValidationError('Resolve the product and location matches before authorizing synchronization. Each needs one unambiguous provider match.');
 const definitions=[['quantity',args.quantitySyncMode],['price',args.priceSyncMode]].filter(([,mode])=>mode!=null);
 if(!definitions.length||definitions.some(([,mode])=>!modes.includes(mode)))throw new ValidationError('Choose off, inbound, outbound or two_way for stock and/or price.');
 const source=args.initialSyncSource||'require_equal';if(!['require_equal','stockchief','provider'].includes(source))throw new ValidationError('Choose StockChief, the provider or matching values as the initial authority.');
 const positions=[];
 for(const [field,mode] of definitions){
  const prior=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND connector_id=$2 AND sku_id=$3 AND location_id=$4 AND field=$5',[ctx.workspaceId,c.id,sku[0].id,loc[0].id,field])).rows[0];
  const p={id:prior?.id||newId('cspos'),workspace_id:ctx.workspaceId,connector_id:c.id,provider_account_id:active.provider_account_id,sku_id:sku[0].id,location_id:loc[0].id,external_id:skumaps[0].external_id,parent_external_id:skumaps[0].parent_external_id,external_location_id:locmaps[0].external_id,field,mode,expectedRevision:prior?.revision||0};
  const l=await local(db,p),r=mode==='off'?{value:null}:await providerRead(db,active,p,adapter,'commerce-preview:'+newId('read'));
  if(mode!=='off'&&field==='price'&&(!l.value||!r.value||l.value.currency!==r.value.currency))throw new ValidationError('Both systems need an evidenced selling price in the same currency. No conversion or missing price will be invented.');
  if(mode!=='off'&&!same(l.value,r.value)&&source==='require_equal')throw new ValidationError('The initial values differ. Choose which system owns the initial value; nothing changed.');
  if(source==='stockchief'&&mode==='inbound'||source==='provider'&&mode==='outbound')throw new ValidationError('The initial source must agree with the chosen synchronization direction.');
  positions.push({...p,local:l,remote:{value:r.value,version:r.version||null}});
 }
 const payload={recordId:c.id,sku:sku[0].code,location:loc[0].name,source,positions};payload.integrity=hash(payload);
 return {payload,summary:`Synchronize ${sku[0].code} at ${loc[0].name} with ${c.display_name}: ${definitions.map(([f,m])=>f+' '+m).join(', ')}. Initial source: ${source}. Outbound quantity is costed, uncommitted sellable stock; provider count differences need physical confirmation. This authorizes future changes only for these exact matches, with conflicts held for review.`};
}
async function configureInTransaction(db,ctx,payload){
 const {integrity,idempotencyKey:executionKey,...body}=payload;if(hash(body)!==integrity)throw new ValidationError('The synchronization proposal changed. Prepare it again.');
 const c=await connection(db,ctx,payload.recordId,{allowInactive:payload.positions.every(p=>p.mode==='off')});await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['provider-sync:'+c.id]);
 for(const p of payload.positions){
  if(p.workspace_id!==ctx.workspaceId||p.connector_id!==c.id||p.provider_account_id!==c.provider_account_id||!await mapped(db,p))throw new ValidationError('The approved channel account or mapping changed. Prepare synchronization again.');
  if(['outbound','two_way'].includes(p.mode)){
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['commerce-authority:'+hash([c.provider_type,c.provider_account_id,p.external_id,p.field==='price'?'':p.external_location_id,p.field])]);
   const other=(await db.query("SELECT 1 FROM connection_commerce_positions WHERE provider_type=$1 AND provider_account_id=$2 AND external_id=$3 AND ($5='price' OR external_location_id=$4) AND field=$5 AND mode IN ('outbound','two_way') AND id<>$6 LIMIT 1",[c.provider_type,c.provider_account_id,p.external_id,p.external_location_id,p.field,p.id])).rows.length;
   if(other)throw new ValidationError('Another StockChief synchronization already owns this provider product and location. Disable its outbound authority before choosing a new source.');
  }
  const old=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,p.id])).rows[0];
  const priorEffect=old?.pending_effect_id?await effects.get(db,ctx.workspaceId,old.pending_effect_id):null;
  if((old?.revision||0)!==p.expectedRevision||priorEffect&&!['PENDING','FAILED','SUCCEEDED','CANCELLED'].includes(priorEffect.status))throw new ValidationError('The synchronization policy changed or has an unresolved delivery. Verify it before changing authority.');
  if(priorEffect?.status==='PENDING'){
   const cancelled=await db.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status='PENDING' RETURNING id",[ctx.workspaceId,priorEffect.id]);
   if(!cancelled.rows.length)throw new ValidationError('The provider delivery started while this change was being approved. Verify it first.');
   await db.query("UPDATE stockchief_runtime.jobs SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND kind='provider.effect' AND payload->>'effectId'=$2 AND status IN ('PENDING','RETRY')",[ctx.workspaceId,priorEffect.id]);
  }
  const l=await local(db,p);if(!same(l.value,p.local.value)||l.version!==p.local.version)throw new ValidationError('The local stock or price changed after approval was prepared. Review a fresh proposal.');
  let localValue=l.value;if(p.mode!=='off'&&payload.source==='provider'&&p.field==='price'&&!same(l.value,p.remote.value)){
   await prices.setPriceInTransaction(db,ctx,{skuId:p.sku_id,amountMinor:p.remote.value.amount,currency:p.remote.value.currency,expectedCurrentId:l.version,source:'provider_catalog_sync',sourceDetail:{connectorId:c.id,externalId:p.external_id}});localValue=p.remote.value;
  }
  await db.query(`INSERT INTO connection_commerce_positions(id,workspace_id,connector_id,sku_id,location_id,external_id,parent_external_id,external_location_id,field,mode,baseline_local,baseline_provider,authorized_by_user_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13) ON CONFLICT(workspace_id,connector_id,sku_id,location_id,field) DO UPDATE SET mode=EXCLUDED.mode,revision=connection_commerce_positions.revision+1,external_id=EXCLUDED.external_id,parent_external_id=EXCLUDED.parent_external_id,external_location_id=EXCLUDED.external_location_id,baseline_local=EXCLUDED.baseline_local,baseline_provider=EXCLUDED.baseline_provider,pending_effect_id=NULL,authorized_by_user_id=EXCLUDED.authorized_by_user_id,updated_at=now()`,
   [p.id,ctx.workspaceId,c.id,p.sku_id,p.location_id,p.external_id,p.parent_external_id,p.external_location_id,p.field,p.mode,JSON.stringify(localValue),JSON.stringify(p.remote.value),ctx.actorId]);
  await db.query('UPDATE connection_commerce_positions SET provider_account_id=$3,provider_type=$4 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.id,c.provider_account_id,c.provider_type]);
  const saved=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.id])).rows[0];
  if(p.mode!=='off'&&payload.source==='stockchief'&&!same(localValue,p.remote.value))await queue(db,c,saved,l,p.remote.value);
  if(p.mode!=='off'&&payload.source==='provider'&&p.field==='quantity'&&!same(localValue,p.remote.value))await issue(db,saved,'The initial provider count differs. Confirm physical stock before accepting a count correction. No inventory or money changed.');
  await audit(db,saved,'connection.commerce_sync.authorized',{mode:p.mode,revision:saved.revision,actorId:ctx.actorId});
 }
 return {connectorId:c.id,positionIds:payload.positions.map(p=>p.id),configured:true,providerDeliveryVerified:false};
}
async function queue(db,c,p,l,expected){
 const key=hash({id:p.id,revision:p.revision,local:l.value,localVersion:l.version,expected});
 const queued=await effects.enqueueInTransaction(db,{workspaceId:p.workspace_id,kind:'commerce.position.publish',provider:c.provider_type,aggregateType:'connection_commerce_position',aggregateId:p.id,
  idempotencyKey:key,requestedByUserId:p.authorized_by_user_id,payload:{connectorId:c.id,positionId:p.id,revision:p.revision,value:l.value,localVersion:l.version,expected,
   externalId:p.external_id,parentExternalId:p.parent_external_id,externalLocationId:p.external_location_id,providerAccountId:p.provider_account_id,field:p.field},maxAttempts:5});
 await db.query('UPDATE connection_commerce_positions SET pending_effect_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2',[p.workspace_id,p.id,queued.effect.id]);
 return queued;
}
// Commit the price and its authorized delivery together. The adapter rereads the
// actual provider value and compares it with this verified baseline before writing.
async function publishPriceChangesInTransaction(db,ctx,changes){
 const result=new Map();if(!changes.length)return result;
 const origins=new Map(changes.map(change=>[change.skuId,change.sourceConnectorId])),skuIds=[...origins.keys()];
 const positions=(await db.query(`SELECT * FROM connection_commerce_positions WHERE workspace_id=$1
  AND sku_id=ANY($2::text[]) AND field='price' AND mode IN ('outbound','two_way') ORDER BY id FOR UPDATE`,[ctx.workspaceId,skuIds])).rows;
 for(const p of positions){
  if(origins.get(p.sku_id)===p.connector_id)continue;
  const delivery=result.get(p.sku_id)||{effectIds:[],synchronizationHolds:[]};result.set(p.sku_id,delivery);
  const c=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.connector_id])).rows[0];
  const owner=(await db.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.authorized_by_user_id])).rows[0];
  let reason=null;
  if(!c||c.status!=='connected'||c.paused_at||parse(c.config,{}).syncDisabled===true)reason='The channel is disconnected or synchronization is paused.';
  else if(owner?.role!=='owner'||p.provider_account_id!==c.provider_account_id||!await mapped(db,p))reason='The channel authorization, account or mapping changed. Review its synchronization policy.';
  if(reason){await issue(db,p,reason);delivery.synchronizationHolds.push({positionId:p.id,reason});continue;}
  if(p.pending_effect_id){const pending=await effects.get(db,p.workspace_id,p.pending_effect_id);
   if(pending.status!=='SUCCEEDED')throw new ValidationError('A previous price delivery still needs verification or review. Resolve it before changing this price again.');
  }
  const l=await local(db,p);
  if(l.value===null||p.baseline_provider===null){reason='A verified local price and provider baseline are required before publishing.';await issue(db,p,reason);delivery.synchronizationHolds.push({positionId:p.id,reason});continue;}
  if(same(l.value,p.baseline_provider))continue;
  const queued=await queue(db,c,p,l,p.baseline_provider);delivery.effectIds.push(queued.effect.id);
 }
 return result;
}
async function reconcile(db,c){
 const positions=(await db.query("SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND connector_id=$2 AND mode<>'off' ORDER BY id FOR UPDATE",[c.workspace_id,c.id])).rows;
 const result={queued:0,inboundPrices:0,conflicts:0};
 for(const p of positions){
  const active=await connection(db,{workspaceId:c.workspace_id,actorId:p.authorized_by_user_id},c.id);
  if(p.provider_account_id!==active.provider_account_id||!await mapped(db,p)){await issue(db,p,'The connected account, product or location mapping changed. Reapprove the intended match.');result.conflicts++;continue;}
  if(p.pending_effect_id){const e=await effects.get(db,p.workspace_id,p.pending_effect_id);if(e.status==='SUCCEEDED')await db.query('UPDATE connection_commerce_positions SET pending_effect_id=NULL WHERE workspace_id=$1 AND id=$2',[p.workspace_id,p.id]);else continue;}
  const record=(await db.query("SELECT provider_data FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 AND entity_type='sku' AND external_id=$3 AND selected=1",[p.workspace_id,c.id,p.external_id])).rows[0];
  if(!record){await issue(db,p,'The provider no longer returns this product. No outbound write was attempted.');result.conflicts++;continue;}
  const data=parse(record.provider_data,{}),raw=p.field==='price'?data.locationPriceOverrides?.find(o=>o.location_id===p.external_location_id)?.price_money||data.priceMoney||null:(data.syncCounts||data.inventoryCounts||[]).find(q=>q.externalLocationId===p.external_location_id)?.quantity??null;
  const r=p.field==='quantity'&&raw!==null?Number(raw):raw,l=await local(db,p);
  if(p.field==='quantity'&&r!==null&&(!Number.isSafeInteger(r)||r<0)){await issue(db,p,'The provider supplied a negative, fractional or invalid count. Review it before any quantity change.');result.conflicts++;continue;}
  if(r===null){await issue(db,p,'The provider did not supply an explicit tracked value. A missing count or price was not treated as zero.');result.conflicts++;continue;}
  if(same(l.value,r)){await advance(db,p,l.value,r);continue;}
  const lc=!same(l.value,p.baseline_local),rc=!same(r,p.baseline_provider);
  if(!lc&&!rc)continue;
  if(lc&&rc){await issue(db,p,'Both StockChief and the provider changed since their last verified baseline. Neither value was overwritten.');result.conflicts++;continue;}
  if(lc&&['outbound','two_way'].includes(p.mode)){
   if(l.value===null){await issue(db,p,'StockChief has no evidenced price to publish.');result.conflicts++;continue;}
   await queue(db,c,p,l,r);result.queued++;continue;
  }
  if(rc&&['inbound','two_way'].includes(p.mode)&&p.field==='price'){
   if(!r||!Number.isSafeInteger(r.amount)||r.amount<0||!l.value||r.currency!==l.value.currency){await issue(db,p,'The incoming price or currency needs review. No conversion was invented.');result.conflicts++;continue;}
   await prices.setPriceInTransaction(db,{workspaceId:p.workspace_id,actorId:p.authorized_by_user_id},{skuId:p.sku_id,amountMinor:r.amount,currency:r.currency,expectedCurrentId:l.version,source:'provider_catalog_sync',sourceDetail:{connectorId:c.id,externalId:p.external_id}});
   await advance(db,p,r,r);await audit(db,p,'connection.commerce_sync.received',{before:l.value,after:r});result.inboundPrices++;continue;
  }
  await issue(db,p,p.field==='quantity'&&rc?'The channel count changed. StockChief retained the difference for a physical-count review; it did not infer a receipt, sale, refund or inventory cost.':'This change is outside the approved synchronization direction.');result.conflicts++;
 }
 return result;
}
async function execute(db,workspaceId,effectId,options={}){
 const claimed=await effects.claim(db,workspaceId,effectId);if(claimed.replayed)return claimed.effect;
 const e=claimed.effect,token=e.claimToken;let attempted=false;
 try{
  const p=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2',[workspaceId,e.payload.positionId])).rows[0];
  if(!p||p.revision!==e.payload.revision||p.pending_effect_id!==e.id||!['outbound','two_way'].includes(p.mode))throw new ValidationError('The synchronization authority changed before delivery.');
  const c=await connection(db,{workspaceId,actorId:p.authorized_by_user_id},p.connector_id),adapter=(options.providers||providers).get(c.provider_type);
  if(p.provider_account_id!==c.provider_account_id)throw new ValidationError('The connected provider account changed before delivery.');
  if(!await mapped(db,p))throw new ValidationError('The mapped product or location changed before delivery.');
  const l=await local(db,p);if(!same(l.value,e.payload.value)||l.version!==e.payload.localVersion)throw new ValidationError('StockChief changed before delivery. A fresh synchronization must be prepared.');
  const result=await require('../commercial/operations').run(db,workspaceId,{capability:'connections.commerce',key:'commerce-write:'+e.id,provider:c.provider_type,operation:'commerce_position_publish',retryReversed:true},async()=>{
   const credentials=await require('./postgres-provider-service').loadProviderCredentials(db,c,adapter);
   await effects.checkpoint(db,workspaceId,e.id,token,{externalId:p.external_id,positionId:p.id});
   attempted=true;
   return adapter.writeSyncPosition({...readInput(p,credentials),value:e.payload.value,expected:e.payload.expected,idempotencyKey:e.id});
  });
  return await effects.succeed(db,workspaceId,e.id,token,{providerReference:{externalId:p.external_id,positionId:p.id},result,
   apply:async tx=>{const current=(await tx.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,p.id])).rows[0];
    if(current?.revision===p.revision){await advance(tx,p,e.payload.value,result.value);await tx.query('UPDATE connection_commerce_positions SET pending_effect_id=NULL WHERE workspace_id=$1 AND id=$2 AND pending_effect_id=$3',[workspaceId,p.id,e.id]);}
    await audit(tx,p,'connection.commerce_sync.published',{effectId:e.id,value:result.value,verified:true});}});
 }catch(error){
  if(error.status===429&&error.providerOutcomeUncertain!==true){
   await db.query("UPDATE stockchief_runtime.provider_effects SET status='PENDING',claim_token=NULL,claimed_at=NULL,error_code='provider_rate_limited',error_message='The provider requested a delay. StockChief will reread the current value before retrying.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND claim_token=$3",[workspaceId,e.id,token]);
   error.retryable=true;error.retryAfterMs=Math.max(60000,Math.ceil(Number(error.retryAfterMs)||60000));throw error;
  }
  const rejectedBeforeWrite=error.code==='commerce_sync_conflict'&&error.providerWriteAttempted===false;
  const ambiguous=attempted&&!rejectedBeforeWrite&&(error.providerOutcomeUncertain===true||!effects.definiteFailure(error));
  await effects.finishError(db,workspaceId,e.id,token,error,{ambiguous,apply:async(tx)=>{
   const p=(await tx.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2',[workspaceId,e.payload.positionId])).rows[0];
   if(p)await issue(tx,p,attempted?'The provider did not verify this delivery. The operation was retained without an automatic repeat.':'The prepared delivery changed before it was sent. Review the current product, price and stock.');
  }});
  if(ambiguous)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:'provider.commerce-verify',idempotencyKey:'commerce-verify:'+e.id,payload:{effectId:e.id},maxAttempts:5,availableAt:Date.now()+10000});
  error.retryable=false;throw error;
 }
}
async function verifyDelivery(db,workspaceId,effectId,options={}){
 const claimed=await effects.claimVerification(db,workspaceId,effectId,'commerce.position.publish');if(claimed.replayed)return claimed.effect;
 const e=claimed.effect,current=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2',[workspaceId,e.payload.positionId])).rows[0];
 const p=current?{...current,external_id:e.payload.externalId,parent_external_id:e.payload.parentExternalId,external_location_id:e.payload.externalLocationId,field:e.payload.field,provider_account_id:e.payload.providerAccountId}:null;
 try{
  if(!p)throw new ValidationError('The retained synchronization record needs review.');
  const c=await connection(db,{workspaceId,actorId:p.authorized_by_user_id},p.connector_id),adapter=(options.providers||providers).get(c.provider_type);
  if(p.provider_account_id!==c.provider_account_id)throw new ValidationError('The connected provider account changed. Verify this delivery in the original provider account.');
  const observed=await providerRead(db,c,p,adapter,'commerce-verification:'+e.id+':'+newId('read'));
  if(!same(observed.value,e.payload.value))throw new ValidationError('The retained delivery is not confirmed by the provider. No write was repeated.');
  return effects.succeed(db,workspaceId,e.id,e.claimToken,{providerReference:e.providerReference,result:{externalId:p.external_id,value:observed.value,verified:true,recoveredByReadback:true},apply:async tx=>{
   if(p.revision===e.payload.revision&&current.pending_effect_id===e.id){await advance(tx,p,e.payload.value,observed.value);await tx.query('UPDATE connection_commerce_positions SET pending_effect_id=NULL WHERE workspace_id=$1 AND id=$2 AND pending_effect_id=$3',[workspaceId,p.id,e.id]);}
   await audit(tx,p,'connection.commerce_sync.verified',{effectId:e.id,value:observed.value,writeRepeated:false});}});
 }catch(error){await effects.finishError(db,workspaceId,e.id,e.claimToken,error,{ambiguous:true});throw error;}
}
async function list(db,workspaceId,connectorId){return (await db.query(`SELECT p.id,p.field,p.mode,p.revision,p.baseline_local,p.baseline_provider,p.pending_effect_id,p.last_verified_at,s.code,l.name AS location,e.status AS delivery_status
 FROM connection_commerce_positions p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
 LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=p.workspace_id AND e.id=p.pending_effect_id
 WHERE p.workspace_id=$1 AND p.connector_id=$2 ORDER BY s.code,p.field,l.name`,[workspaceId,connectorId])).rows;}
async function prepareCount(db,ctx,c,args,options={}){
 c=await connection(db,ctx,c.id);
 const rows=(await db.query(`SELECT p.* FROM connection_commerce_positions p JOIN skus s ON s.workspace_id=p.workspace_id AND s.id=p.sku_id JOIN locations l ON l.workspace_id=p.workspace_id AND l.id=p.location_id
  WHERE p.workspace_id=$1 AND p.connector_id=$2 AND p.field='quantity' AND p.mode IN ('inbound','two_way') AND (s.id=$3 OR lower(s.code)=lower($3)) AND (l.id=$4 OR lower(l.name)=lower($4))`,[ctx.workspaceId,c.id,args.sku,args.location])).rows;
 if(rows.length!==1)throw new ValidationError('Choose one product and location with an approved incoming quantity policy.');
 const p=rows[0];if(p.provider_account_id!==c.provider_account_id)throw new ValidationError('The connected provider account changed. Reapprove its synchronization before reading this count.');
 const l=await local(db,p),counted=Number(args.countedQuantity);
 if(!Number.isSafeInteger(counted)||counted<0||!String(args.reason||'').trim())throw new ValidationError('Provide the confirmed physical count and its evidence or reason. The channel number alone is not receipt or return evidence.');
 if(l.tracking!=='quantity'||l.committed>counted)throw new ValidationError('Tracked units or existing commitments require their exact stock workflow before this count can be corrected.');
 if(counted<l.physical&&l.costed>0&&l.costed!==l.physical)throw new ValidationError('This position mixes costed and uncosted units. Identify the affected units and review their accounting before reducing stock.');
 const adapter=(options.providers||providers).get(c.provider_type),r=await providerRead(db,c,p,adapter,'commerce-count-preview:'+newId('read'));
 if(r.value===null)throw new ValidationError('The provider has no tracked count to reconcile.');
 const cost=(await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,p.sku_id,p.location_id])).rows[0];
 const reduction=l.physical-counted,costMinor=reduction>0&&l.costed===l.physical?reduction===l.physical?Number(cost?.total_cost_minor||0):Math.round(Number(cost?.total_cost_minor||0)*reduction/l.physical):0;
 const settings=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0],postingDate=args.postingDate||new Date().toISOString().slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(postingDate)||Number.isNaN(Date.parse(postingDate+'T00:00:00Z'))||new Date(postingDate+'T00:00:00Z').toISOString().slice(0,10)!==postingDate)throw new ValidationError('Choose a valid count posting date.');
 if(costMinor&&!settings)throw new ValidationError('Configure accounting before correcting valued inventory.');
 const payload={recordId:c.id,positionId:p.id,revision:p.revision,skuId:p.sku_id,locationId:p.location_id,local:l,providerValue:r.value,countedQuantity:counted,reason:String(args.reason).trim(),costMinor,postingDate,currency:settings?.base_currency||null,countOperationKey:newId('channelcount')};payload.integrity=hash(payload);
 return {payload,summary:`Confirm the evidenced physical count for ${args.sku} at ${args.location}: ${l.physical} → ${counted} units. Evidence: ${payload.reason}. ${costMinor?'Record '+prices.formatMinor(costMinor,settings.base_currency)+' inventory count loss on '+postingDate+' using the existing weighted-average cost.':'No new inventory cost, supplier liability or payment is created.'} This is a physical count correction; it is not a sale, delivery or refund.`};
}
async function acceptCountInTransaction(db,ctx,payload){
 const {integrity,idempotencyKey:executionKey,...body}=payload;if(hash(body)!==integrity)throw new ValidationError('The count correction changed. Prepare it again.');
 const operationKey=payload.countOperationKey;
 if(typeof operationKey!=='string'||!operationKey)throw new ValidationError('The count correction needs its frozen operation identity.');
 const currentConnection=await connection(db,ctx,payload.recordId);
 const prior=(await db.query("SELECT result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='inventory.adjust' AND idempotency_key=$2 AND status='COMPLETED'",[ctx.workspaceId,operationKey])).rows[0];
 if(prior){const journal=(await db.query('SELECT id FROM accounting_journal_entries WHERE workspace_id=$1 AND source_key=$2',[ctx.workspaceId,operationKey])).rows[0];return {...prior.result,positionId:payload.positionId,journalEntryId:journal?.id||null,verified:true,replayed:true};}
 const p=(await db.query('SELECT * FROM connection_commerce_positions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,payload.positionId])).rows[0];
 if(!p||p.connector_id!==payload.recordId||p.provider_account_id!==currentConnection.provider_account_id||p.revision!==payload.revision||p.pending_effect_id||!['inbound','two_way'].includes(p.mode)||!await mapped(db,p))throw new ValidationError('The count synchronization changed. Review a fresh correction.');
 const l=await local(db,p);if(!same(l,payload.local))throw new ValidationError('Stock, commitments or cost changed after this count was prepared. Review the new position.');
 const physical=await require('../domain/postgres-inventory-engine').adjustInTransaction(db,ctx,{skuId:p.sku_id,locationId:p.location_id,countedQuantity:payload.countedQuantity,reasonCode:'channel_physical_count',notes:payload.reason,reference:p.external_id,idempotencyKey:operationKey});
 let journal=null;
 if(payload.countedQuantity<l.physical&&l.costed>0){
  const costing=require('../accounting/postgres-costing'),prepared=await costing.prepareIssueInTransaction(db,ctx,{movementId:physical.movementId});
  if(prepared.totalCostMinor!==payload.costMinor)throw new ValidationError('The inventory cost changed after this count was reviewed.');
  const setting=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
  if(!setting||setting.base_currency!==payload.currency)throw new ValidationError('The accounting currency changed after count review.');
  if(prepared.totalCostMinor)journal=await require('../accounting/postgres-ledger').postInTransaction(db,ctx,{sourceType:'channel_physical_count',sourceRecordId:physical.adjustmentId,sourceKey:operationKey,postingDate:payload.postingDate,currency:setting.base_currency,
   description:'Confirmed channel physical count: '+payload.reason,lines:[{accountKey:'INVENTORY_ADJUSTMENTS',debitMinor:prepared.totalCostMinor,creditMinor:0},{accountKey:'INVENTORY_ASSET',debitMinor:0,creditMinor:prepared.totalCostMinor}]});
  await costing.commitIssueInTransaction(db,ctx,prepared,{journalEntryId:journal?.entry.id||null,sourceType:'channel_physical_count',sourceRecordId:physical.adjustmentId});
 }
 const after=await local(db,p);await advance(db,p,after.value,payload.providerValue);
 if(!same(after.value,l.value)&&!same(after.value,payload.providerValue)&&p.mode==='two_way')await queue(db,currentConnection,p,after,payload.providerValue);
 await audit(db,p,'connection.commerce_sync.count_confirmed',{before:l.physical,after:payload.countedQuantity,adjustmentId:physical.adjustmentId,journalEntryId:journal?.entry.id||null});
 return {...physical,positionId:p.id,journalEntryId:journal?.entry.id||null,verified:true};
}
module.exports={prepare,configureInTransaction,reconcile,execute,verifyDelivery,list,local,same,prepareCount,acceptCountInTransaction,publishPriceChangesInTransaction};

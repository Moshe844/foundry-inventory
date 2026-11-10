'use strict';
const {createHash}=require('node:crypto'),{newId}=require('../lib/util'),{hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),native=require('./product-source-native');
const table='stockchief_runtime.agent_product_source_readings',factTable='stockchief_runtime.agent_sourced_product_facts',kind='import.read-product-facts.v1';
const digest=b=>createHash('sha256').update(b).digest('hex');
const tx=(db,fn)=>typeof db.transaction==='function'?db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true}):fn(db);
async function owner(db,ctx){
 if(!(await db.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w",[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the current inventory owner can read and save these private product sources.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}
async function authorize(db,ctx,{automatic=false,enrich=false,preview=false}={}){
 await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,136,automatic?'automatic':'draft');
 if(enrich)await policy.requireWorkspaceJob(db,ctx.workspaceId,129,automatic?'automatic':'draft');
 await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'inventory.core');
 if(!preview){for(const action of ['document.save_product_facts',...(enrich?['catalog.fill_supplier_specs']:[])]){const reason=await policy.stopped(db,ctx.workspaceId,state,action,automatic);if(reason)throw new ValidationError(reason);}if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine product reading is paused. Review the current authority settings.');}
 return state;
}
async function resolve(db,ctx,reference){
 const value=String(reference||'').trim();const rows=(await db.query('SELECT DISTINCT i.id FROM items i LEFT JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE i.workspace_id=$1 AND (i.id=$2 OR lower(i.name)=lower($2) OR lower(i.base_code)=lower($2) OR lower(s.code)=lower($2)) ORDER BY i.id LIMIT 2',[ctx.workspaceId,value])).rows;
 if(rows.length!==1)throw new ValidationError('Choose one exact existing product or SKU; use its SKU when names are shared.');return rows[0].id;
}
async function load(db,ctx,id){
 await owner(db,ctx);const r=(await db.query('SELECT r.*,i.name AS product_name,i.unit_label,j.status AS job_status,j.result AS progress FROM '+table+' r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id LEFT JOIN stockchief_runtime.jobs j ON j.id=r.job_id AND j.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.id=$2',[ctx.workspaceId,id])).rows[0];
 if(!r)throw new NotFoundError('That product reading is not in this inventory.');if(digest(r.content)!==r.source_hash)throw new ValidationError('The saved original needs an integrity review.');return r;
}
async function enqueue(db,ctx,input){
 const automatic=input.automatic===true||input.automatic==='yes',enrich=input.enrich===true||input.enrich==='yes';await authorize(db,ctx,{automatic,enrich});
 const itemId=await resolve(db,ctx,input.itemId||input.productReference),scope=await native.snapshot(db,ctx,itemId);if(!Number(scope.item.is_active)||!scope.skus.some(s=>Number(s.is_active)))throw new ValidationError('Choose a current active product.');
 let buffer=input.buffer,filename=String(input.filename||'Product source.txt').trim(),attachmentId=null,filedId=null,filedKind=null;
 if(input.filedDocument){const f=await require('./agent-filing').load(db,ctx,input.filedDocument);if(f.target_kind!=='item'||f.target_id!==itemId||!['specification','safety_sheet'].includes(f.document_kind))throw new ValidationError('Choose this product’s exact filed specification or safety sheet.');buffer=f.content;filename=f.filename;attachmentId=f.source_attachment_id;filedId=f.id;filedKind=f.document_kind;}
 else if(input.fileAttachment){const f=(await db.query('SELECT id,filename,content,content_hash FROM connection_email_attachments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,input.fileAttachment])).rows[0];if(!f||!Buffer.isBuffer(f.content)||digest(f.content)!==f.content_hash)throw new ValidationError('Choose a saved original attachment with a valid content hash.');buffer=f.content;filename=f.filename;attachmentId=f.id;}
 if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024||filename.length>240||!/^.+\.(pdf|docx|txt|csv|tsv|png|jpe?g|webp|gif|heic|heif|tiff?)$/i.test(filename))throw new ValidationError('Upload the complete original PDF, Word, UTF-8 text, photo or scan, up to 20 MB.');
 const sourceHash=digest(buffer),documentKind=filedKind||input.documentKind||'specification';if(!['specification','safety_sheet'].includes(documentKind))throw new ValidationError('Choose a specification or safety sheet.');
 return tx(db,async c=>{
  await authorize(c,ctx,{automatic,enrich});await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['product-source:'+ctx.workspaceId+':'+itemId+':'+sourceHash]);
  const prior=(await c.query('SELECT id,status FROM '+table+' WHERE workspace_id=$1 AND item_id=$2 AND source_hash=$3 AND identity_hash=$4 FOR UPDATE',[ctx.workspaceId,itemId,sourceHash,scope.identityHash])).rows[0];
  if(prior&&prior.status!=='FAILED')return {id:prior.id,replayed:true};
  const id=prior?.id||newId('product-reading'),attempt=newId('source-attempt'),q={query:(...a)=>c.query(...a),transaction:fn=>fn(c)};
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'product-source:'+id,buffer.length+32768,{finished:true});
  const job=await require('../operations/postgres-job-queue').enqueue(q,{workspaceId:ctx.workspaceId,kind,idempotencyKey:id+':'+attempt,payload:{readingId:id,actorId:ctx.actorId},priority:35,maxAttempts:1});
  const args=[ctx.workspaceId,id,itemId,ctx.actorId,job.job.id,attachmentId,filedId,filename,sourceHash,buffer,documentKind,scope.identityHash,input.targetConfirmed===true||input.targetConfirmed==='yes',automatic,enrich];
  if(prior)await c.query("UPDATE "+table+" SET item_id=$3,source_hash=$9,actor_id=$4,job_id=$5,source_attachment_id=$6,source_filed_id=$7,filename=$8,content=$10,document_kind=$11,identity_hash=$12,target_confirmed=$13,automatic=$14,enrich=$15,status='PENDING',problem=NULL,held_count=0,acknowledged_at=NULL,owns_funding=false,owns_document=false,call_key=NULL,funding_key=NULL,document_key=NULL,credits_used=0,documents_used=0,attempt=attempt+1,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",args);
  else await c.query('INSERT INTO '+table+'(workspace_id,id,item_id,actor_id,job_id,source_attachment_id,source_filed_id,filename,source_hash,content,document_kind,identity_hash,target_confirmed,automatic,enrich) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',args);
  return {id,replayed:false};
 });
}
async function checkSource(c,ctx,r){
 await authorize(c,ctx,{automatic:r.automatic,enrich:r.enrich});if(!Buffer.isBuffer(r.content)||digest(r.content)!==r.source_hash)throw new ValidationError('The saved original failed its content integrity check. No new sourced facts were applied.');const current=await native.snapshot(c,ctx,r.item_id);if(current.identityHash!==r.identity_hash)throw new ValidationError('The product identity, variant selection or stock unit changed. Read a fresh source against the current product.');
 if(r.source_attachment_id){const f=(await c.query('SELECT content,content_hash FROM connection_email_attachments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.source_attachment_id])).rows[0];if(!f||f.content_hash!==r.source_hash||digest(f.content)!==r.source_hash)throw new ValidationError('The original attachment changed or was removed. No sourced facts were applied.');}
 if(r.source_filed_id){const filed=(await c.query('SELECT content FROM stockchief_runtime.agent_filed_documents WHERE workspace_id=$1 AND id=$2 AND source_hash=$3 AND target_kind=\'item\' AND target_id=$4',[ctx.workspaceId,r.source_filed_id,r.source_hash,r.item_id])).rows[0];if(!filed||!Buffer.isBuffer(filed.content)||digest(filed.content)!==r.source_hash)throw new ValidationError('The filed original or its product link changed.');}
 return current;
}
async function fund(c,ctx,r,callKey){
 const ent=require('../commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(c,ctx.workspaceId),creditPolicy=await require('../commercial/ai-credit-policy').policy(c,scope),rate=(await c.query("SELECT units FROM commercial_operation_policies WHERE operation='import_mapping' AND category='ai_work_credits'")).rows[0];if(!rate)throw new ValidationError('Document reading has no configured credit policy.');
 const existingDoc=(await c.query("SELECT idempotency_key FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter='agent_documents' AND status='COMMITTED' AND (idempotency_key=$3 OR detail->>'sourceHash'=$4 OR position($4 in idempotency_key)>0) ORDER BY committed_at,id LIMIT 1",[scope.accountId,ctx.workspaceId,r.source_attachment_id?'attachment:'+r.source_attachment_id+':'+r.source_hash:'',r.source_hash])).rows[0];
 const existingAI=(await c.query("SELECT idempotency_key FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter='ai_work_credits' AND status='COMMITTED' AND detail->>'operation'='import_mapping' AND (detail->>'sourceHash'=$3 OR position($3 in idempotency_key)>0) AND units>=$4 ORDER BY committed_at,id LIMIT 1",[scope.accountId,ctx.workspaceId,r.source_hash,Number(rate.units)*creditPolicy.scale])).rows[0];
 const documentKey=existingDoc?.idempotency_key||ctx.workspaceId+':product-source:'+r.source_hash+':document',key=existingAI?.idempotency_key||ctx.workspaceId+':product-source:'+r.id+':'+newId('funding');
 let ownsDocument=false,ownsFunding=false;
 if(!existingDoc){const held=await ent.reserveUsage(c,scope,{meter:'agent_documents',units:1,idempotencyKey:documentKey,retryReversed:true,detail:{operation:'read_product_source',sourceHash:r.source_hash,job:136}});if(!held.created)throw new ValidationError('This original already has an unfinished document reading. Finish or recover that reading first.');ownsDocument=true;}
 if(!existingAI){await ent.reserveUsage(c,scope,{meter:'ai_work_credits',units:Number(rate.units)*creditPolicy.scale,idempotencyKey:key,detail:{operation:'import_mapping',sourceHash:r.source_hash,job:136,creditPolicy}});ownsFunding=true;}
 await c.query('UPDATE '+table+' SET funding_key=$3,document_key=$4,owns_funding=$5,owns_document=$6,call_key=$7 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,key,documentKey,ownsFunding,ownsDocument,callKey]);
 return {...r,funding_key:key,document_key:documentKey,owns_funding:ownsFunding,owns_document:ownsDocument,call_key:callKey};
}
async function settle(c,ctx,r,success){
 const ent=require('../commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(c,ctx.workspaceId);if(!r.funding_key&&!r.document_key)return {credits:0,documents:0};
 const events=(await c.query("SELECT e.meter,e.status,e.units,e.idempotency_key FROM commercial_usage_events e WHERE e.account_id=$1 AND e.workspace_id=$2 AND e.status='RESERVED' AND ((e.meter='ai_work_credits' AND (e.idempotency_key=$3 AND $5::boolean OR e.idempotency_key<>$3 AND EXISTS(SELECT 1 FROM commercial_model_cost_holds h WHERE h.workspace_id=e.workspace_id AND h.account_id=e.account_id AND h.detail->>'fundingUsageEventId'=e.id AND (h.idempotency_key=$7 OR left(h.idempotency_key,length($7)+1)=$7||':')))) OR (e.meter='agent_documents' AND e.idempotency_key=$4 AND $6::boolean)) ORDER BY e.idempotency_key",[scope.accountId,ctx.workspaceId,r.funding_key,r.document_key,r.owns_funding,r.owns_document,r.call_key])).rows;
 for(const e of events)await ent[success?'commitUsage':'reverseUsage'](c,scope,{meter:e.meter,idempotencyKey:e.idempotency_key,reason:'The complete product-source reading did not finish. Original retained; no new product facts were applied.'});
 if(!success&&r.call_key)await c.query("UPDATE commercial_model_cost_holds SET detail=detail||'{\"customerCreditsConsumed\":false,\"wholeDocumentFailed\":true}'::jsonb WHERE workspace_id=$1 AND account_id=$2 AND (idempotency_key=$3 OR left(idempotency_key,length($3)+1)=$3||':')",[ctx.workspaceId,scope.accountId,r.call_key]);
 return {credits:events.filter(e=>e.meter==='ai_work_credits').reduce((n,e)=>n+Number(e.units),0),documents:events.filter(e=>e.meter==='agent_documents').reduce((n,e)=>n+Number(e.units),0)};
}
async function reviewRows(c,ctx,r,options={}){
 const snapshot=await native.snapshot(c,ctx,r.item_id),rows=native.classify(r.raw_facts,snapshot,{targetConfirmed:r.target_confirmed,...options});
 const saved=(await c.query('SELECT fact_hash FROM '+factTable+' WHERE workspace_id=$1 AND reading_id=$2',[ctx.workspaceId,r.id])).rows;
 const prior=(await c.query(`SELECT fact,sku_id FROM (SELECT id,fact,sku_id FROM ${factTable} WHERE workspace_id=$1 AND item_id=$2 AND reading_id<>$3 UNION ALL SELECT d.id||':'||f.n,f.value||jsonb_build_object('kind',f.value->>'field'),NULL::text FROM stockchief_runtime.agent_filed_documents d CROSS JOIN LATERAL jsonb_array_elements(d.product_facts) WITH ORDINALITY f(value,n) WHERE d.workspace_id=$1 AND d.target_kind='item' AND d.target_id=$2) previous ORDER BY id`,[ctx.workspaceId,r.item_id,r.id])).rows;
 const comparable=v=>native.normalize(v).replace(/\s+/gu,' '),singleKinds=new Set(['manufacturer','model','barcode','mass','length','width','height','dimensions','diameter','thickness','volume','capacity','composition','origin']);
 for(const row of rows){if(row.problem||options.confirmed?.has(row.id))continue;const different=prior.find(p=>(!p.sku_id||!row.skuId||p.sku_id===row.skuId)&&p.fact.kind===row.kind&&(singleKinds.has(row.kind)||comparable(p.fact.label||require('./product-source-reader').labels[p.fact.kind])===comparable(row.label))&&(comparable(p.fact.value)!==comparable(row.value)||comparable(p.fact.unit)!==comparable(row.unit)));if(different)row.problem='A previously saved source gives a different value for this fact. Both originals are preserved; check the exact source and confirm this change before saving it.';}
 const codes=rows.filter(f=>f.native?.field==='barcode'&&!f.native.problem).map(f=>String(f.native.value).toLowerCase());
 const matches=codes.length?(await c.query('SELECT id,lower(barcode) AS barcode FROM skus WHERE workspace_id=$1 AND lower(barcode)=ANY($2::text[])',[ctx.workspaceId,codes])).rows:[];
 for(const row of rows){row.saved=saved.some(s=>s.fact_hash===row.id);if(row.native&&!row.native.problem){const current=snapshot.skus.find(s=>s.id===row.skuId)?.[row.native.field];if(current!=null&&String(current).trim())row.native.problem=String(current)===String(row.native.value)?'Already recorded; no change needed.':'A different native value is already recorded. It was preserved.';if(row.native.field==='barcode'&&matches.some(s=>s.id!==row.skuId&&s.barcode===String(row.native.value).toLowerCase()))row.native.problem='This barcode already identifies another native SKU. It was not copied.';}}
 return {snapshot,rows,reviewHash:hash([r.source_hash,r.raw_facts,r.revision,snapshot.identityHash,snapshot.nativeHash,prior])};
}
async function saveRows(c,ctx,r,options={}){
 const state=await authorize(c,ctx,{automatic:options.automatic===true,enrich:r.enrich}),snapshot=await checkSource(c,ctx,{...r,automatic:options.automatic===true});
 await c.query('SELECT id FROM skus WHERE workspace_id=$1 AND item_id=$2 ORDER BY id FOR UPDATE',[ctx.workspaceId,r.item_id]);
 const view=await reviewRows(c,ctx,r,options);if(options.reviewHash&&options.reviewHash!==view.reviewHash)throw new ValidationError('The product or reading changed after your review. Reload before approving.');
 let added=0,changed=0;
 for(const row of view.rows){
  if(row.problem||row.saved)continue;
  const fact={...row};delete fact.problem;delete fact.saved;delete fact.native;
  const data=JSON.stringify(fact);await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'product-source-fact:'+r.id+':'+row.id,Buffer.byteLength(data)+4096,{finished:true});
  const inserted=await c.query('INSERT INTO '+factTable+'(id,workspace_id,reading_id,item_id,sku_id,fact_hash,fact,saved_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(workspace_id,reading_id,fact_hash) DO NOTHING',[newId('sourced-fact'),ctx.workspaceId,r.id,r.item_id,row.skuId,row.id,data,ctx.actorId]);added+=inserted.rowCount;
 }
 if(r.enrich){for(const row of view.rows){if(row.problem||!row.native||row.native.problem)continue;const n=row.native;
  // Column names are chosen by the native fixed field map, never document text.
  const result=await c.query('UPDATE skus SET '+n.field+'=$3 WHERE workspace_id=$1 AND id=$2 AND '+(n.field==='barcode'?"(barcode IS NULL OR btrim(barcode)='')":n.field+' IS NULL'),[ctx.workspaceId,row.skuId,n.value]);
  if(result.rowCount){changed++;await c.query("INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state) VALUES($1,$2,$3,$4,$5,'fill_supplier_spec','{}',$6::jsonb)",[newId('source-spec'),ctx.workspaceId,ctx.actorId,r.item_id,row.skuId,JSON.stringify({sourceReading:r.id,sourceHash:r.source_hash,field:n.field,value:n.value,page:row.page,quote:row.quote,originalValue:row.value,originalUnit:row.unit})]);}
 }}
 const held=view.rows.filter(f=>f.problem||r.enrich&&f.native?.problem&&!/^Already recorded/.test(f.native.problem)).length;
 if(added||changed)await require('../operations/postgres-security-audit').record(c,ctx,{action:'Complete source-backed product facts saved',reference:r.id,after:{product:snapshot.item.name,sourceHash:r.source_hash,facts:added,nativeFields:changed,held,automatic:options.automatic===true,sourceClaimsAreNotCompliance:true}});
 return {savedFacts:added,nativeFields:changed,held};
}
async function lease(c,job){if(!(await c.query("SELECT 1 FROM stockchief_runtime.jobs WHERE id=$1 AND workspace_id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)",[job.id,job.workspaceId,job.leaseToken])).rowCount)throw new ValidationError('This product reading lost its worker lease. Its original is retained.');}
async function run(job,db,{provider,readSource}={}){
 const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};let r=(await db.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,job.payload.readingId])).rows[0];if(!r)return {removed:true};if(r.job_id!==job.id)throw new ValidationError('This job no longer owns the selected product source.');if(['READY','SAVED'].includes(r.status))return {id:r.id,replayed:true};
 const work=async locked=>{
  try{
   await checkSource(db,ctx,r);await lease(db,job);if(digest(r.content)!==r.source_hash)throw new ValidationError('The saved original failed its content integrity check.');
   const cache=(await db.query('SELECT id,source_pages,raw_facts,issues FROM '+table+" WHERE workspace_id=$1 AND source_hash=$2 AND id<>$3 AND status IN('READY','SAVED') AND jsonb_array_length(raw_facts)>0 ORDER BY created_at,id LIMIT 1",[ctx.workspaceId,r.source_hash,r.id])).rows[0];
   let pages,result;
   if(cache){pages=cache.source_pages;result={facts:cache.raw_facts,issues:[...cache.issues,{page:0,text:'The complete source reading and its paid receipt were reused; no second document or AI charge.'}]};}
   else{
    if(!provider&&!require('../config').ai.configured)throw new ValidationError('Product source reading is not connected yet. Your original is retained; no new reading credits were used.');
    r=await tx(db,async c=>{await checkSource(c,ctx,r);await lease(c,job);const funded=await fund(c,ctx,r,ctx.workspaceId+':product-fact-call:'+r.id+':'+job.leaseToken);await c.query("UPDATE "+table+" SET status='RUNNING',problem=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id]);return funded;});
    try{pages=await(readSource||require('./contract-source').read)({filename:r.filename,buffer:r.content});}catch(e){throw new ValidationError(String(e.message).replace(/contracts?/gi,'document'));}
    provider ||=require('../ai/provider').createProviderForTier('fast');
    const rawFunding=r.funding_key.startsWith(ctx.workspaceId+':')?r.funding_key.slice(ctx.workspaceId.length+1):r.funding_key;
    const model=async(key,request)=>{if(locked)await locked.query('SELECT 1');await checkSource(db,ctx,r);await lease(db,job);return require('../commercial/model').wrap(db,ctx,provider,'import_mapping',r.call_key.slice(ctx.workspaceId.length+1)+':'+key,{chargeCustomer:false,fundingKey:rawFunding,deferCustomerCommit:true}).complete(request);};
    result=await require('./product-source-reader').extract(model,pages,{target:await native.snapshot(db,ctx,r.item_id),onProgress:async progress=>{await lease(db,job);await db.query('UPDATE stockchief_runtime.jobs SET result=$4::jsonb,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND lease_token=$3',[job.id,ctx.workspaceId,job.leaseToken,JSON.stringify(progress)]);}});
   }
   return await tx(db,async c=>{
    await checkSource(c,ctx,r);await lease(c,job);const current=(await c.query('SELECT source_hash,content,status FROM '+table+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,r.id])).rows[0];if(current?.source_hash!==r.source_hash||digest(current.content)!==r.source_hash)throw new ValidationError('The original changed before saving its complete reading.');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'product-source-reading:'+r.id,Buffer.byteLength(JSON.stringify({pages,result}))+32768,{finished:true});
    r={...r,source_pages:pages,raw_facts:result.facts,issues:result.issues};
    await c.query('UPDATE '+table+' SET source_pages=$3::jsonb,raw_facts=$4::jsonb,issues=$5::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.id,JSON.stringify(pages),JSON.stringify(result.facts),JSON.stringify(result.issues)]);
    const applied=r.automatic?await saveRows(c,ctx,r,{automatic:true}):{savedFacts:0,nativeFields:0,held:(await reviewRows(c,ctx,r)).rows.filter(f=>f.problem||r.enrich&&f.native?.problem).length},usage=cache?{credits:0,documents:0}:await settle(c,ctx,r,true);
    await c.query("UPDATE "+table+" SET status=$3,credits_used=$4,documents_used=$5,held_count=$6,acknowledged_at=NULL,problem=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,r.automatic&&applied.savedFacts?'SAVED':'READY',usage.credits,usage.documents,applied.held]);
    const fenced=await c.query("UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('committedProductSource',$4::text),updated_at=now() WHERE id=$1 AND workspace_id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000) RETURNING id",[job.id,ctx.workspaceId,job.leaseToken,r.id]);if(!fenced.rowCount)throw new ValidationError('The product reading lease ended before saving.');
    return {id:r.id,facts:result.facts.length,...applied,credits:usage.credits,documents:usage.documents,reused:Boolean(cache)};
   });
  }catch(error){await tx(db,async c=>{const latest=(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,r.id])).rows[0];if(!latest||['READY','SAVED'].includes(latest.status))return;await settle(c,ctx,latest,false);await c.query("UPDATE "+table+" SET status='FAILED',problem=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,String(error.message).slice(0,1000)]);});throw error;}
 };
 const result=db.withSessionLock?await db.withSessionLock('product-source-reading:'+ctx.workspaceId+':'+r.source_hash,work):await work();if(result?.busy)throw Object.assign(new Error('This original is already being read. Its complete result will be reused when ready.'),{retryable:true});return result;
}
async function approve(db,ctx,id,input){
 return tx(db,async c=>{
  await owner(c,ctx);await c.query('SELECT owner_account_id FROM workspaces WHERE id=$1 FOR UPDATE',[ctx.workspaceId]);
  const r=(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];if(!r||!['READY','SAVED'].includes(r.status))throw new ValidationError('Review a complete finished product reading first.');
  if(input.confirmed!=='yes'||Number(input.revision)!==r.revision)throw new ValidationError('Review and approve this exact complete product-fact batch.');
  if(input.enrich==='yes'){await authorize(c,ctx,{enrich:true});r.enrich=true;await c.query('UPDATE '+table+' SET enrich=true WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);}
  const values=input.confirmedFacts==null?[]:Array.isArray(input.confirmedFacts)?input.confirmedFacts:[input.confirmedFacts],confirmed=new Set(values);if(values.some(v=>!r.raw_facts.some(f=>f.id===v)))throw new ValidationError('Only this source’s displayed facts can be confirmed.');
  const result=await saveRows(c,ctx,r,{confirmed,skuChoices:input.skuChoice||{},reviewHash:input.reviewHash});if(!result.savedFacts&&!result.nativeFields){const view=await reviewRows(c,ctx,r);if(view.rows.some(f=>f.saved))return {id,replayed:true};throw new ValidationError('No unambiguous facts are ready. Check the held values against the original or obtain a clarified source.');}
  await c.query("UPDATE "+table+" SET status='SAVED',revision=revision+1,held_count=$3,acknowledged_at=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,result.held]);return {id,...result};
 });
}
async function recover(c,job){
 const r=(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2 AND job_id=$3 FOR UPDATE',[job.workspaceId,job.payload?.readingId,job.id])).rows[0];if(!r||r.status==='FAILED')return null;if(['READY','SAVED'].includes(r.status))return {recovered:true,id:r.id};
 await settle(c,{workspaceId:job.workspaceId,actorId:r.actor_id},r,false);await c.query("UPDATE "+table+" SET status='FAILED',problem='The complete product reading was interrupted. Your original is retained and newly reserved reading credits were released.',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[job.workspaceId,r.id]);return null;
}
async function screen(db,ctx,{id=null,itemId=null,page=1}={}){
 await owner(db,ctx);const state=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,136,'draft');page=Number(page);if(!Number.isSafeInteger(page)||page<1)throw new ValidationError('Choose a valid product-reading page.');
 const rows=(await db.query('SELECT r.id,r.filename,r.status,r.credits_used,r.documents_used,r.enrich,r.created_at,i.name AS product_name FROM '+table+' r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id WHERE r.workspace_id=$1 AND ($2::text IS NULL OR r.item_id=$2) ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $3',[ctx.workspaceId,itemId,(page-1)*50])).rows;
 const record=id?await load(db,ctx,id):null,view=record&&['READY','SAVED'].includes(record.status)?await reviewRows(db,ctx,record):null;
 const creditPolicy=allowed?await require('../commercial/ai-credit-policy').policy(db,await require('../commercial/entitlements').ownerScopeForWorkspace(db,ctx.workspaceId)):null;
 const rate=allowed?(await db.query("SELECT units FROM commercial_operation_policies WHERE operation='import_mapping'")).rows[0]:null;
 return {labels:require('./product-source-reader').labels,nativeLabels:require('../domain/agent-supplier-specs').labels,allowed,routineIncluded:allowed&&policy.permits(state.plan,136,'automatic'),plan:state.plan,shadow:state.shadow,record,view,rows:rows.slice(0,50),more:rows.length>50,page,itemId,fixedCredits:creditPolicy?.fixedAgentCredits===true,credits:rate?Number(rate.units)*creditPolicy.scale:null};
}
async function forItem(db,ctx,itemId){
 await owner(db,ctx);return(await db.query(`SELECT * FROM (
 SELECT f.id,f.fact,r.filename,r.id AS reading_id,'/autopilot/product-facts/'||r.id AS href,f.saved_at AS at FROM ${factTable} f JOIN ${table} r ON r.workspace_id=f.workspace_id AND r.id=f.reading_id WHERE f.workspace_id=$1 AND f.item_id=$2
 UNION ALL SELECT d.id||':'||f.n,d.product_facts->(f.n::int-1)||jsonb_build_object('kind',f.value->>'field'),d.filename,d.id,'/autopilot/documents/'||d.id,d.facts_recorded_at
 FROM stockchief_runtime.agent_filed_documents d CROSS JOIN LATERAL jsonb_array_elements(d.product_facts) WITH ORDINALITY f(value,n) WHERE d.workspace_id=$1 AND d.target_kind='item' AND d.target_id=$2) facts ORDER BY at DESC NULLS LAST,id LIMIT 51`,[ctx.workspaceId,itemId])).rows;
}

function csvCell(s){s=String(s??'');if(/^[\s\uFEFF]*[=+@-]/u.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
async function csv(db,ctx,id){const r=await load(db,ctx,id);if(!['READY','SAVED'].includes(r.status))throw new ValidationError('Wait for the complete source reading before downloading its facts.');const view=await reviewRows(db,ctx,r);return '\uFEFF'+[['Product','Source','Page / section','Source kind','Field','Original value','Original unit','Status','Review needed','Exact original quote','Exact identity quote','Identity page / section'],...view.rows.map(f=>[r.product_name,r.filename,f.page,f.sourceKind,f.label||require('./product-source-reader').labels[f.kind],f.value,f.unit,f.saved?'Saved':f.problem?'Needs review':'Ready',f.problem||f.native?.problem||'',f.quote,f.identityQuote||'',f.identityPage||''])].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';}
async function review(db,ctx,{page=1,filter=''}={}){
 await owner(db,ctx);page=Number(page);if(!Number.isSafeInteger(page)||page<1)throw new ValidationError('Choose a valid product-fact page.');
 const rows=(await db.query(`WITH sources AS (
 SELECT r.id,r.workspace_id,r.item_id,i.name AS product,r.filename,r.status,r.created_at AS at,
 CASE WHEN jsonb_array_length(r.raw_facts)=0 THEN '[{}]'::jsonb ELSE r.raw_facts END AS data,false AS legacy,'/autopilot/product-facts/'||r.id AS href
 FROM ${table} r JOIN items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id WHERE r.workspace_id=$1
 UNION ALL SELECT d.id,d.workspace_id,d.target_id,d.target_reference,d.filename,'Saved',d.created_at,d.product_facts,true,'/autopilot/documents/'||d.id
 FROM stockchief_runtime.agent_filed_documents d WHERE d.workspace_id=$1 AND d.target_kind='item' AND jsonb_array_length(d.product_facts)>0)
 SELECT s.product AS "Product",s.filename AS "Source",coalesce(f.value->>'label',f.value->>'field',f.value->>'kind','Source reading') AS "Field",
 f.value->>'value' AS "Fact",f.value->>'unit' AS "Original unit",f.value->>'quote' AS "Source quote",f.value->>'page' AS "Original page / section",
 CASE WHEN s.legacy OR EXISTS(SELECT 1 FROM ${factTable} saved WHERE saved.workspace_id=s.workspace_id AND saved.reading_id=s.id AND saved.fact_hash=f.value->>'id') THEN 'Saved' ELSE s.status END AS "Status",s.href AS link
 FROM sources s CROSS JOIN LATERAL jsonb_array_elements(s.data) WITH ORDINALITY f(value,n)
 WHERE ($2='' OR lower(s.product)=lower($2) OR EXISTS(SELECT 1 FROM skus sku WHERE sku.workspace_id=s.workspace_id AND sku.item_id=s.item_id AND lower(sku.code)=lower($2)))
 ORDER BY s.at DESC,s.id,f.n LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 return {rows:rows.slice(0,100),more:rows.length>100,summary:'Reads complete spec and safety sources with exact original quotations and saves verified facts on native products. Growth approves each finished batch; authorized Pro and Custom work without training. Unknown/conflicting facts and OCR-only characters need owner review. Original units and historical quoted facts remain visible. Source claims do not establish legal compliance. Upload or open a complete source in Product source readings.'};
}


async function acknowledge(db,ctx,id){await owner(db,ctx);await db.query('UPDATE '+table+" SET acknowledged_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status IN('READY','SAVED','FAILED')",[ctx.workspaceId,id]);return {id};}
function notices(summary){if(!summary?.n)return [];return [{kind:'order',importance:'Needs You',priority:45,title:summary.n+' product source reading'+(summary.n===1?' needs':'s need')+' review',happened:'A complete source is ready for approval, has held facts or stopped before completion.',why:'Review the complete original quotations, uncertain readings or failure. Existing product facts, stock and source receipts are preserved.',actionLabel:'Review product sources',href:'/autopilot/product-facts',sourceId:'product-source-readings',at:summary.created_at,createdAt:summary.created_at}];}
module.exports={acknowledge,notices,owner,authorize,resolve,enqueue,load,run,approve,recover,screen,forItem,csv,review,reviewRows,kind,table,factTable};

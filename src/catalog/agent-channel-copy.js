'use strict';

const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const table='stockchief_runtime.agent_channel_copy_sets';
const versions='stockchief_runtime.agent_channel_copy_versions';
const runs='stockchief_runtime.agent_channel_copy_runs';
const kind='catalog.channel-copy.v1',action='catalog.write_channel_copy';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});

async function owner(c,ctx,{accountLock=false}={}){
 const found=await c.query("SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF u,w",[ctx.workspaceId,ctx.actorId]);
 if(!found.rowCount)throw new AuthorizationError('Only the current inventory owner can prepare channel copy.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
 if(accountLock)await c.query('SELECT a.id FROM accounts a JOIN workspaces w ON w.owner_account_id=a.id WHERE w.id=$1 FOR UPDATE OF a',[ctx.workspaceId]);
}
async function access(c,ctx,automatic=false){
 await c.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
 const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,128,automatic?'automatic':'draft');
 await require('../commercial/enforcement').workspace(c,ctx.workspaceId,'inventory.core');
 await c.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
 const reason=await policy.stopped(c,ctx.workspaceId,state,action,automatic);
 if(reason)throw new ValidationError(reason);
 if(automatic&&!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)throw new ValidationError('Routine writing is paused. Review StockChief AI authority.');
 return state;
}
function oneLine(value,label,max){
 if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u001f\u007f<>]/.test(value))throw new ValidationError('Enter '+label+' on one plain line, up to '+max+' characters.');
 return value.trim();
}
async function scope(c,ctx,input){
 const label=oneLine(input.label,'a saved copy name',100),channel=oneLine(input.channelName,'your sales channel name',60);
 const limit=Number(input.titleLimit??160),style=input.descriptionStyle||'paragraph',descriptionLimit=Number(input.descriptionLimit??2000),tone=input.tone||'clear',channelStyle=input.channelStyle||'store',language=oneLine(input.language||'English','the writing language',60),all=input.allProducts==='yes';
 if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(descriptionLimit)||descriptionLimit<1||descriptionLimit>10000||!['paragraph','bullets'].includes(style)||!['clear','warm','technical','premium','concise'].includes(tone)||!['store','marketplace','social','wholesale'].includes(channelStyle))throw new ValidationError('Choose a title limit from 1 to 1,000 characters, a description limit from 1 to 10,000, a format, tone and channel style.');
 let ids=input.skuIds;
 if(all)ids=(await c.query('SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 ORDER BY s.id',[ctx.workspaceId])).rows.map(r=>r.id);
 if(!ids){
  const codes=String(input.skuCodes||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!codes.length||new Set(codes).size!==codes.length)throw new ValidationError('Enter distinct exact SKU codes, or choose all active products.');
  const found=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[])',[ctx.workspaceId,codes])).rows;
  if(found.length!==codes.length)throw new ValidationError('Match every product code in this inventory.');
  ids=found.map(r=>r.id);
 }
 if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))throw new ValidationError('Choose distinct products from this inventory.');
 return {label,channel_name:channel,title_limit:limit,description_style:style,include_description:input.includeDescription==='yes',sku_ids:[...ids].sort(),language,tone,channel_style:channelStyle,description_limit:descriptionLimit,all_products:all};
}
function configuration(p){
 return {label:p.label,channel_name:p.channel_name,title_limit:p.title_limit,description_style:p.description_style,include_description:p.include_description,sku_ids:p.sku_ids,language:p.language||'English',tone:p.tone||'clear',channel_style:p.channel_style||'store',description_limit:p.description_limit||2000,all_products:p.all_products||false};
}
async function facts(c,ctx,p){
 const products=[],options=[];
 for(let at=0;at<p.sku_ids.length;at+=500){const ids=p.sku_ids.slice(at,at+500);
 products.push(...(await c.query("SELECT s.id,s.code,s.variant_label,i.name,CASE WHEN $3 THEN i.description ELSE NULL END AS description FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.code,s.id",[ctx.workspaceId,ids,p.include_description])).rows);
 options.push(...(await c.query('SELECT v.sku_id,o.name,v.value FROM sku_option_values v JOIN item_options o ON o.id=v.option_id JOIN skus s ON s.id=v.sku_id AND s.workspace_id=o.workspace_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) ORDER BY s.id,o.position,o.name,v.value',[ctx.workspaceId,ids])).rows);
 }
 if(products.length!==p.sku_ids.length)throw new ValidationError('Review missing, inactive or foreign products separately.');
 const grouped=new Map();
 for(const row of options){if(!grouped.has(row.sku_id))grouped.set(row.sku_id,[]);grouped.get(row.sku_id).push({name:row.name,value:row.value});}
 const source={scope:configuration(p),products:products.map(row=>({...row,options:grouped.get(row.id)||[]}))};
 return {source,sourceHash:hash(source),document:[]};
}
async function get(c,ctx,id,lock=false){
 const p=(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!p)throw new NotFoundError('That saved channel copy is not in this inventory.');
 return p;
}
async function preview(db,ctx,input){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,128,'draft');
 const p=await scope(db,ctx,input),f=await facts(db,ctx,p);
 return {...f,scope:p,credits:await creditQuote(db,ctx),estimatedCredits:await estimateCredits(db,ctx,f.source),id:input.id||null,revision:Number(input.revision||0)};
}
async function record(c,ctx,p,f,automatic){
 const prior=(await c.query('SELECT id FROM '+versions+' WHERE workspace_id=$1 AND copy_id=$2 AND source_hash=$3',[ctx.workspaceId,p.id,f.sourceHash])).rows[0];
 if(prior)return {copyId:p.id,id:prior.id,replayed:true};

 const id=newId('copy-version'),bytes=Buffer.byteLength(JSON.stringify(f))+16384;

 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'channel-copy:'+id,bytes,{finished:true});
 await c.query('INSERT INTO '+versions+'(id,workspace_id,copy_id,source_hash,source_snapshot,document_hash,document,generated_by,automatic) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)',[id,ctx.workspaceId,p.id,f.sourceHash,JSON.stringify(f.source),f.documentHash,JSON.stringify(f.document),ctx.actorId,automatic]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Private channel copy written from recorded product facts',reference:id,after:{copyId:p.id,channel:p.channel_name,ready:f.document.filter(r=>!r.problem).length,needsReview:f.document.filter(r=>r.problem).length,automatic,documentHash:f.documentHash}});
 return {copyId:p.id,id,replayed:false};
}
async function creditQuote(db,ctx){
 const ent=require('../commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),configured=(await db.query("SELECT units FROM commercial_operation_policies WHERE operation='instruction' AND category='ai_work_credits'")).rows[0];
 if(!configured)throw new ValidationError('Writing has no configured credit price.');
 return Number(configured.units)*(await require('../commercial/ai-credit-policy').policy(db,scope)).scale;
}
async function estimateCredits(db,ctx,source){
 const provider=require('../ai/provider').createProviderForTier('fast'),ent=require('../commercial/entitlements'),account=await ent.ownerScopeForWorkspace(db,ctx.workspaceId),p=await require('../commercial/ai-credit-policy').policy(db,account);
 const rates=(await db.query("SELECT DISTINCT ON(operation) operation,cost_per_unit_minor FROM commercial_cost_rates WHERE provider=$1 AND model=$2 AND provider_version='2023-06-01' AND operation=ANY($3::text[]) AND unit='token' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) AND pricing_basis IN ('VERIFIED_PUBLIC','VERIFIED_CONTRACT') ORDER BY operation,effective_from DESC,id DESC",[provider.name,provider.model,['model_input','cache_write_1h','model_output']])).rows;
 const by=new Map(rates.map(r=>[r.operation,Number(r.cost_per_unit_minor)]));if(by.size!==3||!p.budgetMinorPerCredit)return null;
 const budget=require('../commercial/model-cost-budget'),policy=require('../commercial/model').POLICIES.instruction;
 let total=await creditQuote(db,ctx),first=true;
 const add=(chars,output)=>{const maximum=budget.estimateMaximumMinor({system:' '.repeat(4000),prompt:' '.repeat(chars),schema:require('./channel-copy-writer').schema,maxOutputTokens:output},policy,Math.max(by.get('model_input'),by.get('cache_write_1h')),by.get('model_output')).maximumMinor;const needed=Math.max(p.scale,Math.ceil(maximum/p.budgetMinorPerCredit));if(first){total=Math.max(total,needed);first=false;}else total+=needed;};
 for(const page of require('./channel-copy-writer').batches(source.products,{titleLimit:source.scope.title_limit,descriptionLimit:source.scope.description_limit})){
  for(const product of page){let length=(product.description||'').length;while(length>12000){const sections=Math.ceil(length/12000);for(let n=0;n<sections;n++)add(14000,1500);length=sections*6000;if(length>=product.description.length)break;}}
  const input=Buffer.byteLength(JSON.stringify({settings:source.scope,products:page}));for(let attempt=0;attempt<3;attempt++){add(input+5000,7000);add(input+7000*6+5000,1500);}
 }
 return total;
}
async function createRun(c,ctx,p,f,automatic,enqueueWork=true){
 const prior=(await c.query('SELECT * FROM '+runs+' WHERE workspace_id=$1 AND copy_id=$2 AND source_hash=$3 FOR UPDATE',[ctx.workspaceId,p.id,f.sourceHash])).rows[0];
 if(prior&&prior.status!=='FAILED')return {copyId:p.id,runId:prior.id,id:prior.version_id,replayed:true};
 const credits=await creditQuote(c,ctx),id=prior?.id||newId('copy-run'),key='channel-copy:'+id+':'+newId('attempt');
 const sourceBytes=Buffer.byteLength(JSON.stringify(f.source));
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'channel-copy-run:'+id,sourceBytes+p.sku_ids.length*16000+32768,{finished:true});
 const ent=require('../commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(c,ctx.workspaceId),creditPolicy=await require('../commercial/ai-credit-policy').policy(c,scope);
 await ent.reserveUsage(c,scope,{meter:'ai_work_credits',units:credits,idempotencyKey:ctx.workspaceId+':'+key,detail:{operation:'instruction',job:128,creditPolicy}});
 if(prior)await c.query("UPDATE "+runs+" SET status='PENDING',run_token=NULL,document=CASE WHEN resume_progress THEN document ELSE '[]'::jsonb END,progress=CASE WHEN resume_progress THEN progress ELSE 0 END,resume_progress=false,issue=NULL,funding_key=$3,credits=$4,automatic=$5,requested_by=$6,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id,key,credits,automatic,ctx.actorId]);
 else await c.query('INSERT INTO '+runs+'(id,workspace_id,copy_id,source_hash,source_snapshot,automatic,requested_by,credits,funding_key) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)',[id,ctx.workspaceId,p.id,f.sourceHash,JSON.stringify(f.source),automatic,ctx.actorId,credits,key]);
 const queueDb={query:(...a)=>c.query(...a),transaction:fn=>fn(c)};
 if(enqueueWork)await require('../operations/postgres-job-queue').enqueue(queueDb,{workspaceId:ctx.workspaceId,kind,idempotencyKey:key,payload:{copyId:p.id,runId:id},priority:30,maxAttempts:3});
 return {copyId:p.id,runId:id,replayed:false};
}
async function save(db,ctx,input){
 return tx(db,async c=>{
  await owner(c,ctx,{accountLock:true});await access(c,ctx);
  const clean=await scope(c,ctx,input),f=await facts(c,ctx,clean);
  if(input.confirmed!=='yes'||input.sourceHash!==f.sourceHash)throw new ValidationError('Review and approve this exact product scope before writing. Changed facts need a new preview.');
  if(input.credits!=null&&Number(input.credits)!==await creditQuote(c,ctx))throw new ValidationError('The writing credit price changed. Review a new preview first.');
  let p=input.id?await get(c,ctx,input.id,true):(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND label=$2 FOR UPDATE',[ctx.workspaceId,clean.label])).rows[0];
  if(p&&hash(configuration(p))===hash(clean))return createRun(c,ctx,p,f,false);
  if(p&&(!input.id||p.revision!==Number(input.revision)))throw new ValidationError('Reload the current saved copy before changing its scope, or choose a new name.');
  await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'channel-copy-set:'+(p?.id||clean.label),Buffer.byteLength(JSON.stringify(clean))+8192,{finished:true});
  const settings=[clean.label,JSON.stringify(clean.sku_ids),clean.channel_name,clean.title_limit,clean.description_style,clean.include_description,ctx.actorId,clean.language,clean.tone,clean.channel_style,clean.description_limit,clean.all_products];
  if(!p)p=(await c.query('INSERT INTO '+table+'(id,workspace_id,label,sku_ids,channel_name,title_limit,description_style,include_description,authorized_by,language,tone,channel_style,description_limit,all_products) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',[newId('channel-copy'),ctx.workspaceId,...settings])).rows[0];
  else p=(await c.query('UPDATE '+table+' SET label=$3,sku_ids=$4::jsonb,channel_name=$5,title_limit=$6,description_style=$7,include_description=$8,authorized_by=$9,language=$10,tone=$11,channel_style=$12,description_limit=$13,all_products=$14,enabled=false,revision=revision+1,last_issue=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *',[ctx.workspaceId,p.id,...settings])).rows[0];
  return createRun(c,ctx,p,f,false);
 });
}
async function configure(db,ctx,id,input){
 return tx(db,async c=>{
  await owner(c,ctx,{accountLock:true});const p=await get(c,ctx,id,true);
  if(Number(input.revision)!==p.revision)throw new ValidationError('Reload the latest saved channel copy settings.');
  if(input.stop!=='yes'){
   await access(c,ctx,true);
   if(input.confirmed!=='yes')throw new ValidationError('Approve routine private writing for these exact products, source fields and channel settings.');
   await facts(c,ctx,p);
   await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],p.enabled?0:1);
  }
  await c.query('UPDATE '+table+' SET enabled=$3,revision=revision+1,authorized_by=$4,next_check_at=NULL,last_issue=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id,input.stop!=='yes',ctx.actorId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:input.stop==='yes'?'Routine private channel writing stopped':'Routine private channel writing authorized',reference:id});
  return {id};
 });
}
async function settleRun(c,ctx,run,success){
 const ent=require('../commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(c,ctx.workspaceId),key=ctx.workspaceId+':'+run.funding_key;
 const events=(await c.query("SELECT idempotency_key,units,status FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter='ai_work_credits' AND (idempotency_key=$3 OR detail->>'originalFundingKey'=$3)",[scope.accountId,ctx.workspaceId,key])).rows;
 for(const event of events.filter(e=>e.status==='RESERVED'))await ent[success?'commitUsage':'reverseUsage'](c,scope,{meter:'ai_work_credits',idempotencyKey:event.idempotency_key,reason:'The complete channel-writing batch did not finish.'});
 if(!success)await c.query("UPDATE commercial_model_cost_holds SET detail=detail||'{\"customerCreditsConsumed\":false,\"failedWholeAction\":true}'::jsonb WHERE account_id=$1 AND workspace_id=$2 AND left(idempotency_key,length($3)+1)=$3||':'",[scope.accountId,ctx.workspaceId,key]);
 await c.query('UPDATE '+runs+' SET credits=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,run.id,events.filter(e=>!success||e.status!=='REVERSED').reduce((sum,e)=>sum+Number(e.units),0)]);
}
async function approve(db,ctx,runId,input){
 return tx(db,async c=>{
  await owner(c,ctx,{accountLock:true});await access(c,ctx);
  const r=(await c.query('SELECT * FROM '+runs+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,runId])).rows[0];
  if(!r)throw new NotFoundError('That private copy batch is not in this inventory.');
  if(r.status==='APPROVED')return {copyId:r.copy_id,id:r.version_id,replayed:true};
  if(r.status!=='READY'||input.confirmed!=='yes')throw new ValidationError('Review the complete finished batch before approving it.');
  const p=await get(c,ctx,r.copy_id,true),current=await facts(c,ctx,p);
  if(current.sourceHash!==r.source_hash)throw new ValidationError('Product facts or channel settings changed. Prepare a fresh batch before approving.');
  const f={source:r.source_snapshot,sourceHash:r.source_hash,document:r.document,documentHash:hash(r.document)},v=await record(c,ctx,p,f,false);
  await c.query("UPDATE "+runs+" SET status='APPROVED',version_id=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,r.id,v.id]);return v;
 });
}
async function processRun(db,workspaceId,runId,{provider}={}){
 const work=async locked=>{
  let r=(await db.query('SELECT * FROM '+runs+' WHERE workspace_id=$1 AND id=$2',[workspaceId,runId])).rows[0];
  if(!r||['APPROVED','READY','FAILED'].includes(r.status))return {replayed:true,runId,id:r?.version_id};
  const ctx={workspaceId,actorId:r.requested_by},token=newId('copy-execution');
  const current=async()=>{if(locked)await locked.query('SELECT 1');const row=(await db.query('SELECT run_token FROM '+runs+' WHERE workspace_id=$1 AND id=$2',[workspaceId,r.id])).rows[0];if(row?.run_token!==token)throw new ValidationError('This writing attempt no longer owns the saved batch.');};
  try{
   await tx(db,async c=>{await owner(c,ctx);await access(c,ctx,r.automatic);const p=await get(c,ctx,r.copy_id,true);if(r.automatic&&!p.enabled)throw new ValidationError('Routine private writing is stopped.');if((await facts(c,ctx,p)).sourceHash!==r.source_hash)throw new ValidationError('Source facts or writing settings changed. Prepare a fresh batch.');await c.query("UPDATE "+runs+" SET status='RUNNING',run_token=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,r.id,token]);});
   const raw=provider||require('../ai/provider').createProviderForTier('fast'),writer=require('./channel-copy-writer');
   const model=async(key,request)=>{
    await current();
    await owner(db,ctx);await access(db,ctx,r.automatic);
    const p=await get(db,ctx,r.copy_id);if(r.automatic&&!p.enabled)throw new ValidationError('Routine private writing was stopped.');
    return require('../commercial/model').wrap(db,ctx,raw,'instruction',r.funding_key+':'+key,{chargeCustomer:false,fundingKey:r.funding_key,deferCustomerCommit:true}).complete(request);
   };
   const pages=writer.batches(r.source_snapshot.products,{titleLimit:r.source_snapshot.scope.title_limit,descriptionLimit:r.source_snapshot.scope.description_limit}),document=[...r.document];let progress=r.progress;
   for(let n=progress;n<pages.length;n++){
    const products=[];for(const p of pages[n])products.push(await writer.prepareProduct(model,p,'page:'+n+':'+p.id));
    document.push(...await writer.writePage(model,{scope:r.source_snapshot.scope,products},{key:'page:'+n}));await current();
    await tx(db,async c=>{await require('../commercial/storage-capacity').reserve(c,workspaceId,'channel-copy-run:'+r.id,Buffer.byteLength(JSON.stringify(r.source_snapshot))+Buffer.byteLength(JSON.stringify(document))+32768,{finished:true});await c.query('UPDATE '+runs+' SET document=$3::jsonb,progress=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[workspaceId,r.id,JSON.stringify(document),n+1]);});
   }
   await current();return await tx(db,async c=>{
    await owner(c,ctx,{accountLock:true});await access(c,ctx,r.automatic);const active=(await c.query('SELECT run_token FROM '+runs+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,r.id])).rows[0];if(active?.run_token!==token)throw new ValidationError('This writing attempt no longer owns the saved batch.');const p=await get(c,ctx,r.copy_id,true),current=await facts(c,ctx,p);
    if(r.automatic&&!p.enabled)throw new ValidationError('Routine private writing was stopped.');
    if(current.sourceHash!==r.source_hash)throw new ValidationError('Source facts or writing settings changed while the batch was being written. Prepare a fresh batch.');
    if(document.length!==r.source_snapshot.products.length||!document.some(row=>!row.problem))throw new ValidationError('No complete usable product-copy batch was written. Review the source problems before retrying.');
    const f={source:r.source_snapshot,sourceHash:r.source_hash,document,documentHash:hash(document)},v=r.automatic?await record(c,ctx,p,f,true):null;
    await settleRun(c,ctx,r,true);
    await c.query("UPDATE "+runs+" SET status=$3,version_id=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,r.id,r.automatic?'APPROVED':'READY',v?.id||null]);
    await c.query("UPDATE "+table+" SET next_check_at=clock_timestamp()+interval '1 day',last_issue=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,p.id]);
    return {copyId:p.id,runId:r.id,id:v?.id||null,ready:true,replayed:false};
   });
  }catch(e){
   await tx(db,async c=>{const active=(await c.query('SELECT run_token,status FROM '+runs+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,r.id])).rows[0];if(!active||active.run_token&&active.run_token!==token&&active.run_token!==r.run_token||['APPROVED','READY'].includes(active.status))return;await settleRun(c,ctx,r,false);await c.query("UPDATE "+runs+" SET status='FAILED',issue=$3,resume_progress=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,r.id,String(e.message).slice(0,400)+(e.limitKind==='daily_model_attempts'?' Completed internal pages are preserved for continuation after the UTC reset.':''),e.limitKind==='daily_model_attempts']);await c.query("UPDATE "+table+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,r.copy_id,'Batch failed; no complete output delivered and credits released. '+String(e.message).slice(0,400)]);if(e.limitKind==='daily_model_attempts')await c.query("UPDATE "+table+" SET next_check_at=(date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC' WHERE workspace_id=$1 AND id=$2",[workspaceId,r.copy_id]);});
   return {failed:true,runId:r.id,reason:e.message};
  }
 };
 return db.withSessionLock?db.withSessionLock('channel-copy-run:'+workspaceId+':'+runId,work):work();
}
async function failInterrupted(c,workspaceId,copyId,runId){
 const rows=(await c.query('SELECT * FROM '+runs+" WHERE workspace_id=$1 AND copy_id=$2 AND status IN('PENDING','RUNNING') AND ($3::text IS NULL AND automatic OR id=$3) FOR UPDATE SKIP LOCKED",[workspaceId,copyId,runId||null])).rows;
 for(const r of rows){const held=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS held',['channel-copy-run:'+workspaceId+':'+r.id])).rows[0].held;if(!held)continue;await settleRun(c,{workspaceId,actorId:r.requested_by},r,false);await c.query("UPDATE "+runs+" SET status='FAILED',issue='Writing was interrupted. Credits were released; retry this complete batch.',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,r.id]);await c.query("UPDATE "+table+" SET last_issue='Writing was interrupted. Credits were released; retry the complete batch.' WHERE workspace_id=$1 AND id=$2",[workspaceId,copyId]);}
 return {failed:rows.length};
}
async function onCopy(db,workspaceId,id,runId,options={}){
 if(runId)return processRun(db,workspaceId,runId,options);
 try{
  const result=await tx(db,async c=>{
   const initial=(await c.query('SELECT authorized_by FROM '+table+' WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];if(!initial)return {removed:true};
   const ctx={workspaceId,actorId:initial.authorized_by};await owner(c,ctx,{accountLock:true});await access(c,ctx,true);const p=await get(c,ctx,id,true);
   if(!p.enabled)throw new ValidationError('Routine private writing is stopped for this scope.');
   const result=await createRun(c,ctx,p,await facts(c,ctx,p),true,false);
   if(result.replayed)await c.query("UPDATE "+table+" SET next_check_at=clock_timestamp()+interval '1 day' WHERE workspace_id=$1 AND id=$2",[workspaceId,p.id]);
   return result;
  });
  if(result.runId&&!result.id)return processRun(db,workspaceId,result.runId,options);return result;
 }catch(e){if(![400,402,403,404,422].includes(e.status))throw e;await db.query("UPDATE "+table+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,id,String(e.message).slice(0,500)]);return {held:true,reason:e.message};}
}
async function enqueue(db,workspaceId,id,revision){
 const queueDb=typeof db.transaction==='function'?db:{query:(...a)=>db.query(...a),transaction:fn=>fn(db)};
 return require('../operations/postgres-job-queue').enqueue(queueDb,{workspaceId,kind,idempotencyKey:'channel-copy:'+id+':'+revision+':'+Math.floor(Date.now()/900000),payload:{copyId:id},priority:30,maxAttempts:3});
}
async function request(db,ctx,id){
 return tx(db,async c=>{
  await owner(c,ctx);await access(c,ctx,true);
  const p=await get(c,ctx,id,true);
  if(!p.enabled)throw new ValidationError('Enable routine private writing for this exact scope first.');
  return enqueue(c,ctx.workspaceId,p.id,p.revision);
 });
}
async function schedule(db,workspaceId){
 const rows=(await db.query('SELECT id,revision FROM '+table+' WHERE workspace_id=$1 AND enabled AND (next_check_at IS NULL OR next_check_at<=now()) ORDER BY next_check_at NULLS FIRST,id LIMIT 5',[workspaceId])).rows;
 for(const p of rows)await enqueue(db,workspaceId,p.id,p.revision);
 return {queued:rows.length};
}
async function screen(db,ctx,{id=null,page=1,versionId=null}={}){
 await owner(db,ctx);
 const state=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,128,'draft');
 page=Number(page);
 if(!Number.isSafeInteger(page)||page<1||page>10000)throw new ValidationError('Choose a valid copy page.');
 const rows=(await db.query('SELECT p.id,p.label,p.channel_name,p.enabled,p.revision,p.created_at,jsonb_array_length(p.sku_ids) AS product_count,(SELECT count(*)::int FROM '+versions+' v WHERE v.workspace_id=p.workspace_id AND v.copy_id=p.id) AS version_count FROM '+table+' p WHERE p.workspace_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 101 OFFSET $2',[ctx.workspaceId,(page-1)*100])).rows;
 const selected=id?await get(db,ctx,id):null;
 const history=selected?(await db.query('SELECT id,created_at,automatic,exported_at FROM '+versions+' WHERE workspace_id=$1 AND copy_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[ctx.workspaceId,id])).rows:[];
 const selectedVersion=selected?(await db.query('SELECT * FROM '+versions+' WHERE workspace_id=$1 AND copy_id=$2'+(versionId?' AND id=$3':'')+' ORDER BY created_at DESC,id DESC LIMIT 1',versionId?[ctx.workspaceId,id,versionId]:[ctx.workspaceId,id])).rows[0]||null:null;
 const latestRun=selected?(await db.query('SELECT * FROM '+runs+' WHERE workspace_id=$1 AND copy_id=$2 ORDER BY updated_at DESC,id DESC LIMIT 1',[ctx.workspaceId,id])).rows[0]||null:null;
 if(latestRun){const used=(await db.query("SELECT sum(units) AS n FROM commercial_usage_events WHERE (status<>'REVERSED' OR $3::boolean) AND workspace_id=$1 AND meter='ai_work_credits' AND (idempotency_key=$2 OR detail->>'originalFundingKey'=$2)",[ctx.workspaceId,ctx.workspaceId+':'+latestRun.funding_key,latestRun.status==='FAILED'])).rows[0];latestRun.credits=Number(used.n||latestRun.credits);}
 return {allowed,routineIncluded:allowed&&policy.permits(state.plan,128,'automatic'),plan:state.plan,shadow:state.shadow,rows:rows.slice(0,100),more:rows.length>100,page,selected,history,selectedVersion,latestRun,credits:allowed?await creditQuote(db,ctx):null};
}
function csvCell(value){
 let s=String(value??'');
 if(/^[\s\uFEFF]*[=+@-]/u.test(s))s="'"+s;
 return '"'+s.replace(/"/g,'""')+'"';
}
function csv(document){
 return '\uFEFF'+[['Channel','SKU','Title','Description','Status','Review needed'],...document.map(r=>[r.channel,r.sku,r.title,r.description,r.problem?'Needs review':'Ready',r.problem||''])].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
async function download(db,ctx,id){
 return tx(db,async c=>{
  await owner(c,ctx);
  const v=(await c.query('SELECT * FROM '+versions+' WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(!v)throw new NotFoundError('That saved channel copy is not in this inventory.');
  const text=csv(v.document);
  await c.query('UPDATE '+versions+' SET exported_at=coalesce(exported_at,clock_timestamp()) WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
  return text;
 });
}
const definition={id:128,key:'channel-copy',label:'Write product titles and descriptions for sales channels',readPage:async()=>({summary:'AI writes private titles and descriptions for each selected sales channel, in your chosen language, tone, format and length, from recorded names, variants and approved descriptions. Full catalogs are paged internally. Growth approves each finished batch; Pro and Custom can refresh an explicitly authorized scope without training after Watch. Exact credits and complete downloads are shown with every run. Publication remains a separate owner decision.',rows:[{Action:'Open channel copy',link:'/autopilot/channel-copy'}],more:false})};
function notices(row){if(!row?.n)return [];return [{kind:'order',importance:'Needs You',priority:40,title:row.n+' channel copy scope'+(row.n===1?' needs':'s need')+' review',happened:'A routine prepared private product copy or found product rows that need review.',why:'Review ready text or source problems before using the copy. Nothing was published.',actionLabel:'Review channel copy',href:'/autopilot/channel-copy',sourceId:'channel-copy-scopes',at:row.created_at,createdAt:row.created_at}];}
module.exports={preview,save,approve,processRun,failInterrupted,creditQuote,configure,onCopy,schedule,enqueue,request,screen,download,csv,notices,kind,action,definition};

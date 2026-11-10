'use strict';

const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const table='stockchief_runtime.agent_channel_copy_sets';
const versions='stockchief_runtime.agent_channel_copy_versions';
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
 const limit=Number(input.titleLimit??160),style=input.descriptionStyle||'paragraph';
 if(!Number.isSafeInteger(limit)||limit<40||limit>240||!['paragraph','bullets'].includes(style))throw new ValidationError('Choose a title length from 40 to 240 characters and paragraph or bullet descriptions.');
 let ids=input.skuIds;
 if(!ids){
  const codes=String(input.skuCodes||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(!codes.length||codes.length>1000||new Set(codes).size!==codes.length)throw new ValidationError('Enter one to 1,000 distinct exact SKU codes.');
  const found=(await c.query('SELECT id,code FROM skus WHERE workspace_id=$1 AND code=ANY($2::text[])',[ctx.workspaceId,codes])).rows;
  if(found.length!==codes.length)throw new ValidationError('Match every product code in this inventory.');
  ids=found.map(r=>r.id);
 }
 if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))throw new ValidationError('Choose one to 1,000 distinct products.');
 return {label,channel_name:channel,title_limit:limit,description_style:style,include_description:input.includeDescription==='yes',sku_ids:[...ids].sort()};
}
function configuration(p){
 return {label:p.label,channel_name:p.channel_name,title_limit:p.title_limit,description_style:p.description_style,include_description:p.include_description,sku_ids:p.sku_ids};
}
async function facts(c,ctx,p){
 const products=(await c.query("SELECT s.id,left(s.code,501) AS code,left(s.variant_label,501) AS variant_label,left(i.name,501) AS name,CASE WHEN $3 THEN left(i.description,2001) ELSE NULL END AS description,($3 AND char_length(coalesce(i.description,''))>2000) AS description_truncated FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1 ORDER BY s.code,s.id",[ctx.workspaceId,p.sku_ids,p.include_description])).rows;
 if(products.length!==p.sku_ids.length)throw new ValidationError('Review missing, inactive or foreign products separately.');
 const options=(await c.query('SELECT sku_id,name,value FROM (SELECT v.sku_id,left(o.name,501) AS name,left(v.value,501) AS value,row_number() OVER(PARTITION BY v.sku_id ORDER BY o.position,o.name,v.value) AS n FROM sku_option_values v JOIN item_options o ON o.id=v.option_id JOIN skus s ON s.id=v.sku_id AND s.workspace_id=o.workspace_id WHERE s.workspace_id=$1 AND s.id=ANY($2::text[])) bounded WHERE n<=11 ORDER BY sku_id,n',[ctx.workspaceId,p.sku_ids])).rows;
 const grouped=new Map();
 for(const row of options){if(!grouped.has(row.sku_id))grouped.set(row.sku_id,[]);grouped.get(row.sku_id).push({name:row.name,value:row.value});}
 const source={scope:configuration(p),products:products.map(row=>({...row,options:grouped.get(row.id)||[]}))};
 const document=compose(source);
 if(Buffer.byteLength(JSON.stringify(source))+Buffer.byteLength(JSON.stringify(document))>12*1024*1024-32768)throw new ValidationError('This batch is too large. Split it into smaller product groups.');
 return {source,sourceHash:hash(source),document,documentHash:hash(document)};
}
function compose(source){
 return source.products.map(p=>{
  const options=p.options||[],values=options.length?options.map(o=>o.value).join(' / '):p.variant_label;
  const title=p.name+(values?' — '+values:'');
  const description=(p.description||'').replace(/\r\n?/g,'\n');
  let problem=null;
  if([...title].length>source.scope.title_limit)problem='Title exceeds your chosen channel length. Shorten the recorded name or choose a different length.';
  else if(options.length>10||[p.code,p.name,p.variant_label||'',...options.flatMap(o=>[o.name,o.value])].some(s=>String(s).length>500||/[\u0000-\u001f\u007f<>]/.test(String(s))))problem='Review unusual names, product codes or variant values individually.';
  else if(description.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<[^>]*>/.test(description))problem='Review a long description or markup individually; it was not rewritten or stripped.';
  const parts=[description||p.name,...options.map(o=>o.name+': '+o.value),'Product code: '+p.code];
  return {skuId:p.id,sku:p.code,channel:source.scope.channel_name,title:problem?null:title,
   description:problem?null:(source.scope.description_style==='bullets'?parts.map(s=>'• '+s).join('\n'):parts.join('\n\n')),problem};
 });
}
async function get(c,ctx,id,lock=false){
 const p=(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
 if(!p)throw new NotFoundError('That saved channel copy is not in this inventory.');
 return p;
}
async function preview(db,ctx,input){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,128,'draft');
 const p=await scope(db,ctx,input),f=await facts(db,ctx,p);
 return {...f,scope:p,id:input.id||null,revision:Number(input.revision||0)};
}
async function record(c,ctx,p,f,automatic){
 const prior=(await c.query('SELECT id FROM '+versions+' WHERE workspace_id=$1 AND copy_id=$2 AND source_hash=$3',[ctx.workspaceId,p.id,f.sourceHash])).rows[0];
 if(prior)return {copyId:p.id,id:prior.id,replayed:true};
 if(!f.document.some(r=>!r.problem))throw new ValidationError('Every product needs review. Correct the source names or channel settings before preparing this batch.');
 const id=newId('copy-version'),bytes=Buffer.byteLength(JSON.stringify(f))+16384;
 if(bytes>12*1024*1024)throw new ValidationError('This batch is too large. Split it into smaller product groups.');
 await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'channel-copy:'+id,bytes,{finished:true});
 await c.query('INSERT INTO '+versions+'(id,workspace_id,copy_id,source_hash,source_snapshot,document_hash,document,generated_by,automatic) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)',[id,ctx.workspaceId,p.id,f.sourceHash,JSON.stringify(f.source),f.documentHash,JSON.stringify(f.document),ctx.actorId,automatic]);
 await require('../operations/postgres-security-audit').record(c,ctx,{action:'Private channel copy written from recorded product facts',reference:id,after:{copyId:p.id,channel:p.channel_name,ready:f.document.filter(r=>!r.problem).length,needsReview:f.document.filter(r=>r.problem).length,automatic,documentHash:f.documentHash}});
 return {copyId:p.id,id,replayed:false};
}
async function save(db,ctx,input){
 return tx(db,async c=>{
  await owner(c,ctx,{accountLock:true});await access(c,ctx);
  const clean=await scope(c,ctx,input),f=await facts(c,ctx,clean);
  if(input.confirmed!=='yes'||input.sourceHash!==f.sourceHash)throw new ValidationError('Review and approve this exact product scope and prepared copy before saving. Changed facts need a new preview.');
  let p=input.id?await get(c,ctx,input.id,true):(await c.query('SELECT * FROM '+table+' WHERE workspace_id=$1 AND label=$2 FOR UPDATE',[ctx.workspaceId,clean.label])).rows[0];
  if(p&&hash(configuration(p))===hash(clean)){
   const prior=(await c.query('SELECT id FROM '+versions+' WHERE workspace_id=$1 AND copy_id=$2 AND source_hash=$3',[ctx.workspaceId,p.id,f.sourceHash])).rows[0];
   if(prior)return {copyId:p.id,id:prior.id,replayed:true};
  }
  if(p&&(!input.id||p.revision!==Number(input.revision)))throw new ValidationError('Reload the current saved copy before changing its scope, or choose a new name.');
  if(!p){
   const id=newId('channel-copy');
   await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'channel-copy-set:'+id,Buffer.byteLength(JSON.stringify(clean))+8192,{finished:true});
   p=(await c.query('INSERT INTO '+table+'(id,workspace_id,label,sku_ids,channel_name,title_limit,description_style,include_description,authorized_by) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9) RETURNING *',[id,ctx.workspaceId,clean.label,JSON.stringify(clean.sku_ids),clean.channel_name,clean.title_limit,clean.description_style,clean.include_description,ctx.actorId])).rows[0];
  }else{
   await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'channel-copy-set:'+p.id,Buffer.byteLength(JSON.stringify(clean))+8192,{finished:true});
   p=(await c.query('UPDATE '+table+' SET label=$3,sku_ids=$4::jsonb,channel_name=$5,title_limit=$6,description_style=$7,include_description=$8,authorized_by=$9,enabled=$10,revision=revision+1,last_issue=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *',[ctx.workspaceId,p.id,clean.label,JSON.stringify(clean.sku_ids),clean.channel_name,clean.title_limit,clean.description_style,clean.include_description,ctx.actorId,p.enabled&&p.authorized_by===ctx.actorId&&hash(configuration(p))===hash(clean)])).rows[0];
  }
  return record(c,ctx,p,f,false);
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
async function onCopy(db,workspaceId,id){
 try{return await tx(db,async c=>{
  const initial=(await c.query('SELECT authorized_by FROM '+table+' WHERE workspace_id=$1 AND id=$2',[workspaceId,id])).rows[0];
  if(!initial)return {removed:true};
  const ctx={workspaceId,actorId:initial.authorized_by};
  await owner(c,ctx);await access(c,ctx,true);
  const p=await get(c,ctx,id,true);
  if(!p.enabled)throw new ValidationError('Routine private writing is stopped for this scope.');
  const f=await facts(c,ctx,p),result=await record(c,ctx,p,f,true);
  const held=f.document.filter(r=>r.problem).length;
  await c.query("UPDATE "+table+" SET next_check_at=clock_timestamp()+interval '1 day',last_issue=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,id,held?held+' product rows need individual review; the ready rows remain private.':null]);
  return result;
 });}catch(e){
  if(![400,402,403,404,422].includes(e.status))throw e;
  await db.query("UPDATE "+table+" SET next_check_at=clock_timestamp()+interval '15 minutes',last_issue=$3 WHERE workspace_id=$1 AND id=$2",[workspaceId,id,String(e.message).slice(0,500)]);
  return {held:true,reason:e.message};
 }
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
 return {allowed,routineIncluded:allowed&&policy.permits(state.plan,128,'automatic'),plan:state.plan,shadow:state.shadow,rows:rows.slice(0,100),more:rows.length>100,page,selected,history,selectedVersion};
}
function csvCell(value){
 let s=String(value??'');
 if(/^[\s\uFEFF]*[=+@-]/u.test(s))s="'"+s;
 return '"'+s.replace(/"/g,'""')+'"';
}
function csv(document){
 return '\uFEFF'+[['Channel','SKU','Title','Description'],...document.filter(r=>!r.problem).map(r=>[r.channel,r.sku,r.title,r.description])].map(r=>r.map(csvCell).join(',')).join('\r\n')+'\r\n';
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
const definition={id:128,key:'channel-copy',label:'Prepare product titles and descriptions for sales channels',readPage:async()=>({summary:'Prepare bulk private channel copy from recorded product names, variants and separately selected descriptions. Growth approves each batch; Pro and Custom can refresh an explicitly authorized scope without training. No channel publication, creative claims, translation or model-generated marketing is performed.',rows:[{Action:'Open channel copy',link:'/autopilot/channel-copy'}],more:false})};
function notices(row){if(!row?.n)return [];return [{kind:'order',importance:'Needs You',priority:40,title:row.n+' channel copy scope'+(row.n===1?' needs':'s need')+' review',happened:'A routine prepared private product copy or found product rows that need review.',why:'Review ready text or source problems before using the copy. Nothing was published.',actionLabel:'Review channel copy',href:'/autopilot/channel-copy',sourceId:'channel-copy-scopes',at:row.created_at,createdAt:row.created_at}];}
module.exports={preview,save,configure,onCopy,schedule,enqueue,request,screen,download,compose,csv,notices,kind,action,definition};

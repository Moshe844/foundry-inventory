'use strict';

const {createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const storage=require('../commercial/storage-capacity');
const source=require('./exact-variant-source');
const catalogue=require('./exact-variant-catalogue');
const table='stockchief_runtime.agent_variant_imports';
const rowTable='stockchief_runtime.agent_variant_import_rows';
const kind='import.variant-sheet.v1';
const action='import.variants';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const view=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});

async function owner(db,ctx){
  const match=(await db.query(`SELECT w.owner_account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!match)throw new AuthorizationError('Only the current inventory owner can import these private variant sheets.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  return match.owner_account_id;
}

async function authorize(db,ctx,automatic){
  const accountId=await owner(db,ctx);
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[accountId]);
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,130,automatic?'automatic':'draft');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'imports.spreadsheet');
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=130 FOR SHARE',[ctx.workspaceId]);
  const stop=await policy.stopped(db,ctx.workspaceId,account,action,automatic);
  if(stop)throw new ValidationError(stop);
  if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable routine authority before authorizing this exact variant sheet.');
  return account;
}

async function queue(db,ctx,id,stage){
  return (await require('../operations/postgres-job-queue').enqueue(view(db),{workspaceId:ctx.workspaceId,kind,
    idempotencyKey:id+':'+newId(stage),payload:{id,actorId:ctx.actorId,stage},priority:35,maxAttempts:1})).job;
}

async function enqueue(db,ctx,input){
  const automatic=input.automatic==='yes';
  if(automatic&&input.authorized!=='yes')throw new ValidationError('Confirm automatic catalogue authority for this exact original.');
  const name=String(input.filename||'').trim(),bytes=input.buffer;
  if(!source.validText(name,240)||!source.supported.test(name)||!Buffer.isBuffer(bytes)||!bytes.length||
    bytes.length>require('../config').uploads.maxBytes)throw new ValidationError('Choose an intact Excel, ODS, CSV, TSV or text spreadsheet within the upload limit.');
  return tx(db,async c=>{
    await authorize(c,ctx,automatic);
    const sourceHash=digest(bytes);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['variant-original:'+ctx.workspaceId+':'+sourceHash]);
    const prior=(await c.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND source_hash=$2`,[ctx.workspaceId,sourceHash])).rows[0];
    if(prior)return {id:prior.id,replayed:true};
    const id=newId('variant-import');
    await storage.reserve(c,ctx.workspaceId,'variant-original:'+id,bytes.length+8192,{finished:true});
    const job=await queue(c,ctx,id,'read');
    await c.query(`INSERT INTO ${table}(id,workspace_id,actor_id,job_id,filename,source_hash,content,automatic)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,ctx.workspaceId,ctx.actorId,job.id,name,sourceHash,bytes,automatic]);
    return {id,replayed:false};
  });
}

async function load(db,ctx,id,{lock=false,original=false}={}){
  await owner(db,ctx);
  const row=(await db.query(`SELECT v.id,v.actor_id,v.job_id,v.filename,v.source_hash,v.automatic,v.status,v.revision,v.mappings,v.sheets,v.summary,v.review_hash,v.result,v.issue,
    v.created_at,v.updated_at,(SELECT j.status FROM stockchief_runtime.jobs j WHERE j.workspace_id=v.workspace_id AND j.id=v.job_id) AS job_status${original?',v.content':''} FROM ${table} v WHERE v.workspace_id=$1 AND v.id=$2${lock?' FOR UPDATE OF v':''}`,
    [ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('This variant spreadsheet is unavailable in this inventory.');
  if(original&&(!Buffer.isBuffer(row.content)||digest(row.content)!==row.source_hash))
    throw new ValidationError('The saved original failed its integrity check.');
  return row;
}

async function fence(db,job,result=null){
  const args=[job.workspaceId,job.id,job.leaseToken],guard=`WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING'
    AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`;
  const owned=result?await db.query('UPDATE stockchief_runtime.jobs SET result=$4::jsonb,updated_at=now() '+guard+' RETURNING id',[...args,JSON.stringify(result)]):
    await db.query('SELECT id FROM stockchief_runtime.jobs '+guard,args);
  if(!owned.rowCount)throw new ValidationError('The variant worker lost its lease. The original remains available.');
}

async function saveRows(db,ctx,id,rows){
  await db.query(`DELETE FROM ${rowTable} WHERE workspace_id=$1 AND import_id=$2`,[ctx.workspaceId,id]);
  for(let offset=0;offset<rows.length;offset+=500){
    const page=rows.slice(offset,offset+500).map(({preview,...candidate},index)=>({
      row_index:offset+index,source_sheet:candidate.sheet,source_row:candidate.row,part:candidate.part,candidate,preview}));
    const payload=JSON.stringify(page);
    await storage.reserve(db,ctx.workspaceId,'variant-preview:'+id+':'+offset,Buffer.byteLength(payload)+4096,{finished:true});
    await db.query(`INSERT INTO ${rowTable}(workspace_id,import_id,row_index,source_sheet,source_row,part,candidate,preview)
      SELECT $1,$2,r.row_index,r.source_sheet,r.source_row,r.part,r.candidate,r.preview FROM jsonb_to_recordset($3::jsonb)
      r(row_index int,source_sheet int,source_row int,part text,candidate jsonb,preview jsonb)`,[ctx.workspaceId,id,payload]);
  }
}

function snapshot(row,reading){
  return hash([row.source_hash,row.revision,row.mappings,reading.identity]);
}

async function catalogueLock(db,ctx){
  if(!(await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',['catalog:'+ctx.workspaceId])).rows[0].locked)
    throw new ValidationError('Another catalogue update is in progress. Retry this saved variant spreadsheet.');
}

async function admitCatalogue(db,ctx,id,definitions){
  const approved=(await db.query(`SELECT summary->>'writeHash' AS expected FROM ${table}
    WHERE workspace_id=$1 AND id=$2 AND actor_id=$3 AND status='APPLYING' FOR SHARE`,[ctx.workspaceId,id,ctx.actorId])).rows[0];
  if(!approved||approved.expected!==hash(definitions))throw new ValidationError('The exact approved variant batch changed.');
  return true;
}

async function apply(db,ctx,row,reading){
  const definitions=reading.definitions;
  await db.query(`UPDATE ${table} SET status='APPLYING',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,row.id]);
  const created=definitions.length?await require('../domain/postgres-catalog-service')
    .createImportedItemsInTransaction(db,ctx,definitions,{variantImportId:row.id}):[];
  const products=new Map(),createdByCode=new Map();
  for(const [i,result] of created.entries()){
    products.set(result.itemId,{id:result.itemId,name:definitions[i].name,created:!definitions[i].appendToItemId});
    for(const sku of result.skus)createdByCode.set(sku.key,{id:sku.skuId,itemId:result.itemId});
  }
  const affected=[];
  for(const [index,line] of reading.rows.entries()){
    const p=line.preview;
    if(p.action==='existing'&&!products.has(p.itemId))products.set(p.itemId,{id:p.itemId,name:p.product,created:false});
    if(p.action==='create'||p.action==='repeat'){
      const made=createdByCode.get(require('../domain/catalog-identity').codeKey(line.sku));
      if(!made)throw new ValidationError('An exact variant was missing from the committed catalogue batch.');
      affected.push({row_index:index,itemId:made.itemId,skuId:made.id});
    }
  }
  for(let offset=0;offset<affected.length;offset+=500){
    await db.query(`UPDATE ${rowTable} r SET preview=r.preview||jsonb_build_object('itemId',x."itemId",'skuId',x."skuId")
      FROM jsonb_to_recordset($3::jsonb) x(row_index int,"itemId" text,"skuId" text)
      WHERE r.workspace_id=$1 AND r.import_id=$2 AND r.row_index=x.row_index`,
      [ctx.workspaceId,row.id,JSON.stringify(affected.slice(offset,offset+500))]);
  }
  const result={productsCreated:reading.summary.products,existingProducts:reading.summary.existingProducts,variantsCreated:reading.summary.create,
    variantsAlreadyRecorded:reading.summary.existing,repeatRows:reading.summary.repeat,productCount:products.size};
  await require('../operations/postgres-security-audit').record(db,ctx,{action:'Exact spreadsheet variants imported',reference:row.id,
    after:{...result,sourceHash:row.source_hash,automatic:row.automatic}});
  await db.query(`UPDATE ${table} SET status='APPLIED',result=$3::jsonb,issue=NULL,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,row.id,JSON.stringify(result)]);
  return result;
}

async function read(job,db,ctx,row){
  const interpreted=source.read(row.filename,row.content,row.mappings);
  return tx(db,async c=>{
    const current=await load(c,ctx,row.id,{lock:true});
    if(current.job_id!==job.id||current.source_hash!==row.source_hash||current.revision!==row.revision||current.status!=='PENDING')
      throw new ValidationError('The saved source changed while its variants were being read.');
    await authorize(c,ctx,current.automatic);
    await fence(c,job);
    if(current.automatic)await catalogueLock(c,ctx);
    const reading=await catalogue.inspect(c,ctx,interpreted.candidates,interpreted.issues);
    const summary={...reading.summary,writeHash:reading.writeHash,sourceIssues:interpreted.issues,problems:reading.problems};
    await storage.reserve(c,ctx.workspaceId,'variant-mapping:'+row.id,Buffer.byteLength(JSON.stringify({summary,sheets:interpreted.sheets}))+8192,{finished:true});
    await saveRows(c,ctx,row.id,reading.rows);
    await c.query(`UPDATE ${table} SET status='REVIEW',sheets=$3::jsonb,summary=$4::jsonb,review_hash=$5,issue=NULL,
      updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,row.id,JSON.stringify(interpreted.sheets),JSON.stringify(summary),snapshot(current,reading)]);
    const result=current.automatic&&!summary.blocking&&!summary.notes?await apply(c,ctx,current,reading):null;
    const outcome={id:row.id,status:result?'APPLIED':'REVIEW',...(result||{rows:summary.sourceRows,blocking:summary.blocking})};
    await fence(c,job,outcome);
    return outcome;
  });
}

async function run(job,db){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},id=job.payload.id;
  try{
    const row=await tx(db,async c=>{
      const pending=await load(c,ctx,id,{lock:true,original:true});
      if(pending.job_id!==job.id)throw new ValidationError('This job no longer owns the variant spreadsheet.');
      if(['REVIEW','APPLIED'].includes(pending.status))return null;
      await authorize(c,ctx,pending.automatic);
      await fence(c,job);
      return pending;
    });
    if(!row)return {id,replayed:true};
    if(job.payload.stage==='read'&&row.status==='PENDING')return await read(job,db,ctx,row);
    if(job.payload.stage!=='apply'||row.status!=='APPROVED')throw new ValidationError('Approve this exact variant review before importing.');
    const original=source.read(row.filename,row.content,row.mappings);
    return await tx(db,async c=>{
      const current=await load(c,ctx,id,{lock:true,original:true});
      if(current.job_id!==job.id||current.status!=='APPROVED'||current.source_hash!==row.source_hash||
        current.review_hash!==row.review_hash||current.revision!==row.revision)throw new ValidationError('The approved variant sheet changed.');
      await authorize(c,ctx,false);
      await fence(c,job);
      await catalogueLock(c,ctx);
      const reading=await catalogue.inspect(c,ctx,original.candidates,original.issues);
      if(reading.summary.blocking||snapshot(current,reading)!==current.review_hash)
        throw new ValidationError('Catalogue variants changed after approval. Prepare a fresh review of the original.');
      const result={id,status:'APPLIED',...await apply(c,ctx,current,reading)};
      await fence(c,job,result);
      return result;
    });
  }catch(error){
    await tx(db,c=>fail(c,job,error.message));
    throw error;
  }
}

async function fail(db,job,message){
  const row=(await db.query(`SELECT id,status,result FROM ${table} WHERE workspace_id=$1 AND id=$2 AND job_id=$3 FOR UPDATE`,
    [job.workspaceId,job.payload.id,job.id])).rows[0];
  if(!row||row.status==='FAILED')return null;
  if(['REVIEW','APPLIED'].includes(row.status))return {id:row.id,status:row.status,recovered:true,...row.result};
  await db.query(`UPDATE ${table} SET status='FAILED',issue=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
    [job.workspaceId,row.id,String(message||'The variant import stopped. Its original is retained.').slice(0,1500)]);
  return null;
}

async function approve(db,ctx,id,input){
  return tx(db,async c=>{
    await authorize(c,ctx,false);
    const row=await load(c,ctx,id,{lock:true,original:true});
    if(['APPROVED','APPLIED'].includes(row.status))return {id,replayed:true};
    if(row.status!=='REVIEW'||row.review_hash!==input.reviewHash||row.summary.blocking||!row.summary.sourceRows||input.confirmed!=='yes')
      throw new ValidationError('Review and confirm every exact variant and product before approving this sheet.');
    const job=await queue(c,ctx,id,'apply');
    await c.query(`UPDATE ${table} SET status='APPROVED',automatic=false,job_id=$3,actor_id=$4,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,job.id,ctx.actorId]);
    return {id,replayed:false};
  });
}

async function revise(db,ctx,id,input){
  return tx(db,async c=>{
    await authorize(c,ctx,false);
    const row=await load(c,ctx,id,{lock:true,original:true});
    if(!['REVIEW','FAILED'].includes(row.status)||Number(input.revision)!==row.revision)
      throw new ValidationError('Reload this original before preparing a revised review.');
    const mappings=input.mappings||row.mappings;
    const encoded=JSON.stringify(mappings);
    if(!mappings||Array.isArray(mappings)||typeof mappings!=='object'||Buffer.byteLength(encoded)>2000000)
      throw new ValidationError('Choose the exact worksheet mappings for this original.');
    await c.query(`UPDATE stockchief_runtime.jobs SET status='CANCELLED',updated_at=now(),completed_at=now()
      WHERE workspace_id=$1 AND id=$2 AND status IN('PAUSED','PENDING','RETRY')`,[ctx.workspaceId,row.job_id]);
    const job=await queue(c,ctx,id,'read');
    await c.query(`UPDATE ${table} SET status='PENDING',actor_id=$3,job_id=$4,automatic=false,mappings=$5::jsonb,
      review_hash=NULL,issue=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,ctx.actorId,job.id,encoded]);
    return {id};
  });
}

function available(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,130,'draft');}
async function screen(db,ctx,{id,page=1,historyPage=1}={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId),allowed=available(state);
  const stop=allowed?await policy.stopped(db,ctx.workspaceId,state,action,false):null;
  const canAuto=allowed&&!stop&&policy.permits(state.plan,130,'automatic')&&!await policy.stopped(db,ctx.workspaceId,state,action,true)&&
    (await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate;
  page=Number(page);historyPage=Number(historyPage);
  if([page,historyPage].some(n=>!Number.isSafeInteger(n)||n<1||n>1000000))throw new ValidationError('Choose a valid variant history page.');
  const history=(await db.query(`SELECT id,filename,status,created_at,result FROM ${table}
    WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(historyPage-1)*50])).rows;
  const selected=id?await load(db,ctx,id):null;
  const rows=id?(await db.query(`SELECT candidate,preview FROM ${rowTable} WHERE workspace_id=$1 AND import_id=$2 ORDER BY row_index
    LIMIT 51 OFFSET $3`,[ctx.workspaceId,id,(page-1)*50])).rows:[];
  return {allowed,stop,canAuto,selected,history:history.slice(0,50),historyMore:history.length>50,historyPage,
    rows:rows.slice(0,50),more:rows.length>50,page};
}

async function* exportRows(db,ctx,id){
  const batch=await load(db,ctx,id);
  for(const issue of batch.summary.sourceIssues||[])yield [batch.sheets.find(s=>s.index===issue.sheet)?.name||'',issue.row||'','','','','','','','Review',issue.message,'',''];
  let after=-1;
  for(;;){
    const rows=(await db.query(`SELECT row_index,candidate,preview FROM ${rowTable} WHERE workspace_id=$1 AND import_id=$2
      AND row_index>$3 ORDER BY row_index LIMIT 500`,[ctx.workspaceId,id,after])).rows;
    if(!rows.length)return;
    for(const {candidate:p,preview} of rows)yield [batch.sheets.find(s=>s.index===p.sheet)?.name||p.sheet,p.row,p.part,p.name,p.parent,
      p.sku,p.barcode,p.options.map(a=>a.name+'='+a.value).join(' | '),preview.action,(preview.errors||[]).join(' '),preview.itemId||'',preview.skuId||''];
    after=rows.at(-1).row_index;
  }
}

async function readPage(db,ctx,{page,filter}){
  await owner(db,ctx);
  const rows=(await db.query(`SELECT filename AS "Original",status AS "Status",COALESCE(result->>'variantsCreated','') AS "Created",
    COALESCE(result->>'variantsAlreadyRecorded','') AS "Already recorded",'/imports/variants/'||id AS link FROM ${table}
    WHERE workspace_id=$1 AND ($2='' OR lower(filename)=lower($2) OR lower(status)=lower($2))
    ORDER BY created_at DESC,id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
  return {rows:rows.slice(0,100),more:rows.length>100,summary:'Upload a spreadsheet to review its exact SKU and option rows, and open the saved result here.'};
}
const definition={id:130,key:'spreadsheet-variants',label:'Spreadsheet variants',filterLabel:'Original filename or status',readPage};
module.exports={table,kind,definition,available,enqueue,run,fail,recover:fail,approve,revise,screen,load,admitCatalogue,exportRows};

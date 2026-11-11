'use strict';

const {createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const ent=require('../commercial/entitlements');
const storage=require('../commercial/storage-capacity');
const proof=require('./document-target-proof');
const targets=require('./document-filing-targets');
const scopes=require('./document-filing-scopes');
const archive=require('./agent-filing');
const table='stockchief_runtime.agent_document_discoveries';
const filed='stockchief_runtime.agent_filed_documents';
const kind='import.discover-filed-document.v1';
const action='document.discover_filing';
const documentKinds=['other','packing_slip','bill_of_lading','customs','specification','safety_sheet','contract'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const txView=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const lock=(db,key)=>db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
const link=record=>proof.paths[record.kind]+encodeURIComponent(record.id);

async function owner(db,ctx){
  const result=await db.query(`SELECT w.owner_account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId]);
  if(!result.rowCount)throw new AuthorizationError('Only the current inventory owner can open and file these private originals.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  return result.rows[0].owner_account_id;
}

async function authorize(db,ctx,automatic){
  const accountId=await owner(db,ctx);
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[accountId]);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,142,automatic?'automatic':'draft');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'inventory.core');
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id IN(137,142) FOR SHARE',[ctx.workspaceId]);
  const stop=await policy.stopped(db,ctx.workspaceId,state,action,automatic);
  if(stop)throw new ValidationError(stop);
  if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable current routine authority before authorizing automatic filing.');
  return {accountId,workspaceId:ctx.workspaceId,state};
}

function checkedOriginal(row){
  if(!row||!Buffer.isBuffer(row.content)||!row.content.length||row.content.length>20*1024*1024||!row.filename||
    row.filename.length>240||/[\x00-\x1f\x7f]/u.test(row.filename)||digest(row.content)!==row.source_hash)
    throw new ValidationError('Choose an intact original file up to 20 MB.');
  return row;
}

async function attachment(db,ctx,id){
  return (await db.query(`SELECT a.id,a.filename,a.content,a.content_hash AS source_hash,a.mime_type,a.message_id,
    m.connector_id,m.supplier_id,m.trust_status,m.classification,lower(btrim(m.sender)) AS sender,m.received_at
    FROM connection_email_attachments a JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id
    WHERE a.workspace_id=$1 AND a.id=$2 FOR SHARE OF a,m`,[ctx.workspaceId,id])).rows[0];
}

async function origin(db,ctx,source){
  const snapshot={message:source.message_id,connector:source.connector_id,sender:source.sender,trust:source.trust_status,
    classification:source.classification,supplierId:source.supplier_id,receivedAt:String(source.received_at)};
  if(source.trust_status!=='TRUSTED')return snapshot;
  const matches=(await db.query(`SELECT id,'supplier' AS kind FROM suppliers WHERE workspace_id=$1 AND status='active' AND lower(btrim(email))=$2
    UNION ALL SELECT id,'customer' FROM customers WHERE workspace_id=$1 AND record_state='ACTIVE' AND lower(btrim(email))=$2`,
    [ctx.workspaceId,source.sender])).rows;
  const party=matches.length===1&&matches[0].kind===source.classification&&(!source.supplier_id||matches[0].id===source.supplier_id)?matches[0]:null;
  return {...snapshot,partyKind:party?.kind||null,partyId:party?.id||null};
}

async function load(db,ctx,id,lockRow=false){
  await owner(db,ctx);
  const row=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2${lockRow?' FOR UPDATE':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('This original is not in the inventory’s filing history.');
  return checkedOriginal(row);
}

async function sourceCurrent(db,ctx,row,{automatic=false}={}){
  const saved=row.source_identity;
  if(!saved.message)return null;
  if(!row.attachment_id){
    if(automatic)throw new ValidationError('The original mailbox attachment was removed. The saved copy can be checked by the owner.');
    return null;
  }
  const current=checkedOriginal(await attachment(db,ctx,row.attachment_id));
  const now=await origin(db,ctx,current);
  const {scopeId,...previous}=saved;
  if(current.source_hash!==row.source_hash||current.filename!==row.filename||hash(previous)!==hash(now))
    throw new ValidationError('The saved original or sender identity changed. Check the source before starting a new filing.');
  if(automatic&&saved.scopeId)return scopes.current(db,ctx,row,current);
  return null;
}

async function enqueue(db,ctx,input,rule=null){
  const automatic=input.automatic==='yes';
  if(automatic&&!rule&&input.authorized!=='yes')throw new ValidationError('Confirm automatic filing authority for this exact original.');
  if(Boolean(input.buffer)===Boolean(input.fileAttachment))throw new ValidationError('Choose exactly one upload or saved mailbox attachment.');
  return tx(db,async c=>{
    await authorize(c,ctx,automatic);
    const a=input.fileAttachment?checkedOriginal(await attachment(c,ctx,input.fileAttachment)):null;
    const source=a||checkedOriginal({filename:String(input.filename||'').trim(),source_hash:digest(input.buffer),content:input.buffer});
    const identity=a?await origin(c,ctx,a):{uploaded:true};
    if(rule){
      identity.scopeId=rule.id;
      if(identity.partyId!==rule.party_id||identity.partyKind!==rule.party_kind)
        throw new ValidationError('The incoming sender no longer matches the approved scope.');
      await scopes.current(c,ctx,{source_identity:identity,scope_id:rule.id,scope_revision:rule.revision},a);
    }
    const key=a?'attachment:'+a.id+':'+source.source_hash:'upload:'+source.source_hash;
    await lock(c,'document-discovery:'+ctx.workspaceId+':'+key);
    const prior=(await c.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND source_key=$2`,[ctx.workspaceId,key])).rows[0];
    if(prior)return {id:prior.id,replayed:true};
    const id=newId('document-discovery');
    await storage.reserve(c,ctx.workspaceId,'document-discovery-original:'+id,source.content.length+8192,{finished:true});
    const job=await enqueueJob(c,ctx,id);
    await c.query(`INSERT INTO ${table}(id,workspace_id,actor_id,job_id,scope_id,scope_revision,attachment_id,
      source_message_id,source_identity,source_key,source_hash,filename,mime_type,content,automatic)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15)`,
      [id,ctx.workspaceId,ctx.actorId,job.id,rule?.id||null,rule?.revision||null,a?.id||null,a?.message_id||null,JSON.stringify(identity),key,
        source.source_hash,source.filename,source.mime_type||null,source.content,automatic]);
    return {id,replayed:false};
  });
}

async function enqueueJob(db,ctx,id){
  return (await require('../operations/postgres-job-queue').enqueue(txView(db),{workspaceId:ctx.workspaceId,kind,
    idempotencyKey:id+':'+newId('reading'),payload:{id,actorId:ctx.actorId},priority:35,maxAttempts:1})).job;
}

async function retry(db,ctx,id){
  return tx(db,async c=>{
    await authorize(c,ctx,false);
    const row=await load(c,ctx,id,true);
    if(row.status!=='FAILED')throw new ValidationError('Only an interrupted filing review can be retried.');
    await sourceCurrent(c,ctx,row);
    await c.query(`UPDATE stockchief_runtime.jobs SET status='CANCELLED',updated_at=now(),completed_at=now()
      WHERE workspace_id=$1 AND id=$2 AND status IN('PAUSED','PENDING','RETRY')`,[ctx.workspaceId,row.job_id]);
    const job=await enqueueJob(c,ctx,id);
    await c.query(`UPDATE ${table} SET status='PENDING',automatic=false,actor_id=$3,job_id=$4,issue=NULL,dismissed_at=NULL,
      usage_key=NULL,owns_usage=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,ctx.actorId,job.id]);
    return {id};
  });
}

async function fund(db,scope,row){
  const matches=await require('./source-read-receipts').readReceipts(db,scope,row.source_hash);
  const paid=matches.find(x=>x.status==='COMMITTED');
  if(paid)return {key:paid.idempotency_key,owns:false};
  if(matches.length)throw new ValidationError('This original already has a pending document read. Retry after that read finishes.');
  const key='filing-original:'+scope.workspaceId+':'+row.source_hash;
  const reservation=await ent.reserveUsage(db,scope,{meter:'agent_documents',units:1,idempotencyKey:key,retryReversed:true,
    detail:{sourceHash:row.source_hash,discoveryId:row.id}});
  if(!reservation.created)throw new ValidationError('This exact original already has an unsettled document read.');
  return {key,owns:true};
}

async function settle(db,scope,row,commit){
  if(!row.usage_key||!row.owns_usage)return 0;
  const usage={meter:'agent_documents',idempotencyKey:row.usage_key};
  if(commit)await ent.commitUsage(db,scope,usage);
  else await ent.reverseUsage(db,scope,{...usage,reason:'Complete document reading did not finish. The original was retained.'});
  return commit?1:0;
}

async function fence(db,job,result=null){
  const guard=`WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING'
    AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`;
  const params=[job.workspaceId,job.id,job.leaseToken];
  const owned=result?await db.query(`UPDATE stockchief_runtime.jobs SET result=$4::jsonb,updated_at=now() ${guard} RETURNING id`,[...params,JSON.stringify(result)]):
    await db.query('SELECT id FROM stockchief_runtime.jobs '+guard,params);
  if(!owned.rowCount)throw new ValidationError('The document worker lost its lease. The original remains available to retry.');
}

async function read(row){
  return require('./contract-source').read({filename:row.filename,buffer:row.content,filingOriginal:true});
}

async function identify(db,ctx,row,pages,rule){
  const found=proof.inspect(pages,row.source_identity),candidates=[];
  const issues=[...found.issues];
  if(row.source_identity.message&&!row.source_identity.partyId)
    issues.push({reason:'The mailbox original does not identify one current trusted supplier or customer.'});
  if(pages.some(page=>page.sourceKind==='scan'&&page.text.trim()||page.requiresSourceConfirmation))
    issues.push({reason:'Check the scan or structured file directly before relying on its printed references.'});
  for(const ref of found.unique){
    const target=await targets.resolve(db,ctx.workspaceId,ref.targetKind,ref.value,row.source_identity);
    if(!target||target.inactive||rule&&!rule.target_kinds.includes(ref.targetKind)){
      issues.push({page:ref.page,quote:ref.quote,reason:'This printed reference does not identify one current record within the original’s sender and approved scope.'});
      continue;
    }
    candidates.push({...target,page:ref.page,quote:ref.quote,value:ref.value,uncertain:ref.uncertain,href:link(target)});
    if(ref.uncertain)issues.push({page:ref.page,quote:ref.quote,reason:'This reference needs an exact check against the original.'});
  }
  if(found.shippingKinds.length&&!found.titles.some(title=>found.shippingKinds.includes(title.kind)&&!title.uncertain))
    issues.push({reason:'Verify the exact shipping document type on the original.'});
  return {...found,issues,candidates};
}

async function shippingRestriction(db,ctx,scope,documentKind,automatic){
  if(archive.job(documentKind)!==137)return null;
  if(!policy.permits(scope.state.plan,137,automatic?'automatic':'draft'))
    return 'This shipping original requires owner approval under your current plan.';
  return require('../autopilot/job-modes').restriction(db,ctx.workspaceId,137,automatic);
}

async function saveFilings(db,ctx,row,documentKind,records,automatic){
  const text=row.sections.map(p=>'[Original page or section '+p.page+(p.sourceName?' · '+p.sourceName:'')+']\n'+p.text).join('\n\n');
  const ordered=[...new Map(records.map(r=>[r.kind+':'+r.id,r])).values()].sort((a,b)=>(a.kind+':'+a.id).localeCompare(b.kind+':'+b.id));
  const links=[];
  for(const record of ordered){
    await lock(db,'file-document:'+ctx.workspaceId+':'+row.source_hash+':'+record.kind+':'+record.id);
    const existing=(await db.query(`SELECT id FROM ${filed} WHERE workspace_id=$1 AND source_hash=$2 AND target_kind=$3 AND target_id=$4 FOR UPDATE`,
      [ctx.workspaceId,row.source_hash,record.kind,record.id])).rows[0];
    if(existing){
      const prior=await archive.load(db,ctx,existing.id);
      if(prior.document_kind!==documentKind&&prior.document_kind!=='other')
        throw new ValidationError('The exact original is already filed on this record under a different document type. Review its existing filing.');
      if(!prior.discovery_id||prior.document_kind==='other'){
        await storage.reserve(db,ctx.workspaceId,'filed-discovery-proof:'+prior.id,2048,{finished:true});
        await db.query(`UPDATE ${filed} SET discovery_id=COALESCE(discovery_id,$3),document_kind=$4 WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,prior.id,row.id,documentKind]);
      }
      links.push({id:prior.id,kind:record.kind,reference:record.reference,recordHref:link(record),replayed:true});
      continue;
    }
    const id=newId('filed');
    await storage.reserve(db,ctx.workspaceId,'filed-document:'+id,row.content.length+Buffer.byteLength(text)+8192,{finished:true});
    await db.query(`INSERT INTO ${filed}(id,workspace_id,source_attachment_id,source_message_id,source_hash,source_text_hash,
      filename,mime_type,content,extracted_text,document_kind,target_kind,target_id,target_reference,filed_by,discovery_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,[id,ctx.workspaceId,row.attachment_id,row.source_message_id,row.source_hash,
      digest(text),row.filename,row.mime_type,row.content,text,documentKind,record.kind,record.id,record.reference,ctx.actorId,row.id]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Original document filed on exact record',reference:id,
      after:{discoveryId:row.id,sourceHash:row.source_hash,documentKind,targetKind:record.kind,targetId:record.id,automatic}});
    links.push({id,kind:record.kind,reference:record.reference,recordHref:link(record)});
  }
  return links;
}

async function run(job,db,{readSource}={}){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},id=job.payload.id;
  try{
    const initial=await tx(db,async c=>{
      const row=await load(c,ctx,id,true);
      if(row.job_id!==job.id)throw new ValidationError('This job no longer owns the original.');
      if(['REVIEW','FILED'].includes(row.status))return null;
      const scope=await authorize(c,ctx,row.automatic);
      await fence(c,job);
      await sourceCurrent(c,ctx,row,{automatic:row.automatic});
      const receipt=await fund(c,scope,row);
      await c.query(`UPDATE ${table} SET status='RUNNING',usage_key=$3,owns_usage=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,id,receipt.key,receipt.owns]);
      return row;
    });
    if(!initial)return {id,replayed:true};
    let pages=[],readIssue=null;
    try{
      pages=readSource?await readSource(initial):await read(initial);
      if(!pages.some(page=>page.text.trim()))throw new ValidationError('This original has no complete readable text. Check the exact file.');
      if(pages.some(page=>page.sourceKind==='scan'&&!page.text.trim()&&!page.visualObservation))
        throw new ValidationError('A scanned section could not be read completely. Check the exact original.');
    }catch(error){
      if(error.code!=='validation_error')throw error;
      readIssue=String(error.message).replace(/contracts?/gi,'document').slice(0,1500);
      pages=[];
    }
    return await tx(db,async c=>{
      const row=await load(c,ctx,id,true);
      if(row.job_id!==job.id||row.source_hash!==initial.source_hash||row.status!=='RUNNING')
        throw new ValidationError('The original changed before filing finished.');
      const scope=await authorize(c,ctx,row.automatic);
      await fence(c,job);
      const rule=await sourceCurrent(c,ctx,row,{automatic:row.automatic});
      const evidence=readIssue?{issues:[{reason:readIssue}],references:[],candidates:[],shippingKinds:[],documentKind:'other',unreadable:true}:
        await identify(c,ctx,row,pages,rule);
      if(row.automatic){
        const stop=await shippingRestriction(c,ctx,scope,evidence.documentKind,true);
        if(stop)evidence.issues.push({reason:stop});
      }
      const filings=row.automatic&&!evidence.issues.length&&evidence.candidates.length?
        await saveFilings(c,ctx,{...row,sections:pages},evidence.documentKind,evidence.candidates,true):[];
      await storage.reserve(c,ctx.workspaceId,'document-discovery-result:'+id,
        Buffer.byteLength(JSON.stringify({pages,evidence,filings}))+8192,{finished:true});
      const documents=await settle(c,scope,row,!readIssue);
      const status=filings.length?'FILED':'REVIEW';
      await c.query(`UPDATE ${table} SET status=$3,document_kind=$4,sections=$5::jsonb,evidence=$6::jsonb,filings=$7::jsonb,
        documents_used=$8,issue=$9,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,id,status,evidence.documentKind,JSON.stringify(pages),JSON.stringify(evidence),JSON.stringify(filings),documents,
          readIssue||evidence.issues[0]?.reason||null]);
      const result={id,status,links:filings.length,documents};
      await fence(c,job,result);
      return result;
    });
  }catch(error){
    await tx(db,c=>fail(c,job,error.message));
    throw error;
  }
}

async function fail(db,job,message){
  const row=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND job_id=$3 FOR UPDATE`,
    [job.workspaceId,job.payload.id,job.id])).rows[0];
  if(!row||row.status==='FAILED')return null;
  if(['REVIEW','FILED'].includes(row.status))return {id:row.id,status:row.status,recovered:true};
  await settle(db,await ent.ownerScopeForWorkspace(db,job.workspaceId),row,false);
  await db.query(`UPDATE ${table} SET status='FAILED',issue=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
    [job.workspaceId,row.id,String(message||'The filing worker was interrupted. The exact original was retained.').slice(0,1500)]);
  return null;
}

function reviewHash(row){return hash([row.id,row.source_hash,row.revision,row.evidence]);}

async function approve(db,ctx,id,input){
  return tx(db,async c=>{
    const scope=await authorize(c,ctx,false);
    const row=await load(c,ctx,id,true);
    if(row.status==='FILED')return {id,links:row.filings,replayed:true};
    if(row.status!=='REVIEW'||input.reviewHash!==reviewHash(row)||input.confirmed!=='yes')
      throw new ValidationError('Confirm the exact saved original and reviewed targets before filing.');
    await sourceCurrent(c,ctx,row);
    const documentKind=row.evidence.shippingKinds.length===1?row.evidence.shippingKinds[0]:
      row.evidence.shippingKinds.length>1?input.documentKind:row.document_kind!=='other'?row.document_kind:input.documentKind||'other';
    if(!documentKinds.includes(documentKind)||row.evidence.shippingKinds.length&&!row.evidence.shippingKinds.includes(documentKind))
      throw new ValidationError('Choose the exact document type from this original.');
    const stop=await shippingRestriction(c,ctx,scope,documentKind,false);
    if(stop)throw new ValidationError(stop);
    const choices=[...new Set((Array.isArray(input.targets)?input.targets:[input.targets]).filter(Boolean))];
    const candidateKey=r=>r.kind+':'+r.value;
    if(choices.some(choice=>!row.evidence.candidates.some(r=>candidateKey(r)===choice)))
      throw new ValidationError('Choose only targets shown in this exact source review.');
    const refs=row.evidence.candidates.filter(r=>choices.includes(candidateKey(r)));
    const reference=String(input.reference||'').trim();
    const reason=String(input.reason||'').trim();
    if(reason.length>1000||reference.length>120)throw new ValidationError('Use up to 120 characters for the exact identifier and 1,000 for your verification.');
    if(reference&&!refs.some(r=>r.kind===input.targetKind&&proof.normalized(r.value)===proof.normalized(reference)))
      refs.push({kind:input.targetKind,value:reference,uncertain:true});
    if(!refs.length)throw new ValidationError('Choose at least one exact current target.');
    const records=[];
    const clear=row.evidence.references.filter(ref=>!ref.uncertain);
    for(const ref of refs){
      if(archive.job(documentKind)===137&&ref.kind!=='purchase_order')throw new ValidationError('File this shipping original on its exact purchase order.');
      const target=await targets.resolve(c,ctx.workspaceId,ref.kind,ref.value,row.source_identity);
      if(!target||ref.identity&&ref.identity!==target.identity)throw new ValidationError('An exact target changed or does not match the recorded sender.');
      if(clear.length&&!clear.some(e=>e.targetKind===ref.kind&&proof.normalized(e.value)===proof.normalized(ref.value)))
        throw new ValidationError('The original identifies different records. Use its independently printed references.');
      if((ref.uncertain||row.evidence.issues.length||target.inactive)&&reason.length<3)
        throw new ValidationError('Record how you verified the uncertain match against the original.');
      records.push(target);
    }
    const filings=await saveFilings(c,ctx,row,documentKind,records,false);
    const evidence={...row.evidence,ownerReview:{actorId:ctx.actorId,reason:reason||null}};
    await storage.reserve(c,ctx.workspaceId,'document-discovery-approval:'+id,
      Buffer.byteLength(JSON.stringify({filings,reason}))+2048,{finished:true});
    await c.query(`UPDATE ${table} SET status='FILED',document_kind=$3,evidence=$4::jsonb,filings=$5::jsonb,
      revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,id,documentKind,JSON.stringify(evidence),JSON.stringify(filings)]);
    return {id,links:filings,replayed:false};
  });
}

async function dismiss(db,ctx,id){
  await owner(db,ctx);
  await db.query(`UPDATE ${table} SET dismissed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status IN('REVIEW','FAILED')`,[ctx.workspaceId,id]);
}

function available(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,142,'draft');}

async function screen(db,ctx,{id,fileAttachment,page=1}={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId),allowed=available(state);
  const stop=allowed?await policy.stopped(db,ctx.workspaceId,state,action,false):null;
  const autoStop=allowed?await policy.stopped(db,ctx.workspaceId,state,action,true):null;
  const canAuto=allowed&&!stop&&!autoStop&&(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate;
  page=Number(page);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid filing history page.');
  const history=(await db.query(`SELECT id,filename,status,documents_used,created_at,source_message_id FROM ${table}
    WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(page-1)*50])).rows;
  const selected=id?await load(db,ctx,id):null;
  return {allowed,stop,autoStop,canAuto,selected,reviewHash:selected?reviewHash(selected):null,fileAttachment:fileAttachment||'',
    rows:history.slice(0,50),more:history.length>50,page,documentKinds,targetKinds:proof.kinds,
    ...await scopes.choices(db,ctx,{includeOptions:canAuto})};
}

function notices(summary){
  if(!summary?.n)return [];
  return [{kind:'documents',importance:'Needs You',priority:48,title:summary.n+' original'+(Number(summary.n)===1?' needs':'s need')+' filing review',
    happened:'A saved original needs an exact record check or its reading was interrupted.',
    why:'Confirm the source and its PO, customer order or product before filing.',actionLabel:'Review incoming originals',
    href:'/autopilot/document-filing',sourceId:'document-discoveries',at:summary.created_at,createdAt:summary.created_at}];
}

module.exports={table,kind,action,available,owner,authorize,enqueue,run,fail,recover:fail,load,screen,approve,retry,dismiss,notices};

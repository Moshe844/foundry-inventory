'use strict';

const {createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const entitlements=require('../commercial/entitlements');
const proof=require('./shipping-document-proof');
const table='stockchief_runtime.agent_shipping_document_readings';
const filed='stockchief_runtime.agent_filed_documents';
const kind='import.read-shipping-document.v1';
const action='document.read_shipping_original';
const formats=/\.(pdf|docx|html?|txt|csv|tsv|png|jpe?g|webp|gif|bmp|heic|heif|tiff?)$/iu;
const digest=value=>createHash('sha256').update(value).digest('hex');
const tx=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});
const clientView=client=>({query:(...args)=>client.query(...args),transaction:work=>work(client)});

async function owner(db,ctx){
  const member=(await db.query(`SELECT w.owner_account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL) FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!member)throw new AuthorizationError('Only the current inventory owner can read and file these private shipping originals.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  return member.owner_account_id;
}

async function authorize(db,ctx,automatic=false){
  const accountId=await owner(db,ctx);
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[accountId]);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,137,automatic?'automatic':'draft');
  await require('../commercial/enforcement').workspace(db,ctx.workspaceId,'inventory.core');
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
  await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id IN(137,142) FOR SHARE',[ctx.workspaceId]);
  const stop=await policy.stopped(db,ctx.workspaceId,state,action,automatic)||await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,142,automatic);
  if(stop)throw new ValidationError(stop);
  if(automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable current routine authority before authorizing an automatic link from this original.');
  return {accountId,workspaceId:ctx.workspaceId};
}

async function findOrders(db,ctx,values,{byId=false,lock=false}={}){
  if(!values.length)return [];
  return (await db.query(`SELECT p.id,p.po_number,p.supplier_id,p.status,s.name AS supplier FROM purchase_orders p
    JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
    WHERE p.workspace_id=$1 AND ${byId?'p.id':'lower(p.po_number)'}=ANY($2::text[]) ORDER BY p.id${lock?' FOR SHARE OF p,s':''}`,
    [ctx.workspaceId,byId?values:values.map(proof.normalized)])).rows;
}

function orderIdentity(po){return hash([po.id,po.po_number,po.supplier_id]);}
function isCurrent(po){return po&&String(po.status).toUpperCase()!=='CANCELLED';}
async function exactOrder(db,ctx,value){
  if(!value)return null;
  const results=await findOrders(db,ctx,[String(value).trim()],{lock:true});
  if(results.length!==1||!isCurrent(results[0]))throw new ValidationError('Choose one exact, current purchase order number in this inventory.');
  return results[0];
}

function original(source){
  if(!source||!Buffer.isBuffer(source.content)||!source.content.length||source.content.length>20*1024*1024||
    !formats.test(source.filename)||source.filename.length>240||digest(source.content)!==source.source_hash)
    throw new ValidationError('Choose a valid original PDF, Word, HTML, UTF-8 file, photo or scan up to 20 MB.');
  return source;
}

async function attachment(db,ctx,id){
  return (await db.query(`SELECT a.id,a.filename,a.content,a.content_hash AS source_hash,a.message_id,m.supplier_id,m.trust_status,lower(m.sender) AS sender
    FROM connection_email_attachments a JOIN connection_email_messages m ON m.workspace_id=a.workspace_id AND m.id=a.message_id
    WHERE a.workspace_id=$1 AND a.id=$2 FOR SHARE OF a,m`,[ctx.workspaceId,id])).rows[0];
}
function mailIdentity(a){return {message:a.message_id,supplier:a.supplier_id||null,trust:a.trust_status,sender:a.sender};}
async function chooseSource(db,ctx,input){
  const chosen=[Boolean(input.buffer),Boolean(input.fileAttachment),Boolean(input.filedDocument)].filter(Boolean).length;
  if(chosen!==1)throw new ValidationError('Choose exactly one upload, saved attachment or previously filed original.');
  if(input.fileAttachment){
    const a=original(await attachment(db,ctx,input.fileAttachment));
    return {...a,attachment_id:a.id,origin:mailIdentity(a)};
  }
  if(input.filedDocument){
    const d=await require('./agent-filing').load(db,ctx,input.filedDocument);
    if(d.target_kind!=='purchase_order')throw new ValidationError('Choose a shipping original already filed on a purchase order.');
    return original({...d,prior_filing_id:d.id,origin:{filedDocument:d.id,priorOrder:d.target_id},attachment_id:d.source_attachment_id,message_id:d.source_message_id});
  }
  return original({filename:String(input.filename||'').trim(),content:input.buffer,source_hash:digest(input.buffer),origin:{uploaded:true}});
}

async function enqueue(db,ctx,input,{retryId=null}={}){
  const automatic=input.automatic==='yes'||input.automatic===true;
  if(automatic&&input.authorized!=='yes')throw new ValidationError('Explicitly authorize filing clearly proven purchase order links from this exact original.');
  return tx(db,async c=>{
    await authorize(c,ctx,automatic);
    const source=await chooseSource(c,ctx,input),order=await exactOrder(c,ctx,input.purchaseOrder);
    if(order&&source.origin.supplier&&source.origin.trust==='TRUSTED'&&source.origin.supplier!==order.supplier_id)
      throw new ValidationError('This saved supplier original belongs to a different supplier than the selected purchase order.');
    if(order&&source.origin.priorOrder&&source.origin.priorOrder!==order.id)
      throw new ValidationError('Open the previously filed original on its recorded purchase order.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['shipping-document:'+ctx.workspaceId+':'+source.source_hash]);
    const prior=(await c.query(`SELECT id,status FROM ${table} WHERE workspace_id=$1 AND source_hash=$2 FOR UPDATE`,[ctx.workspaceId,source.source_hash])).rows[0];
    if(retryId&&(!prior||prior.id!==retryId||!['FAILED','READY'].includes(prior.status)))throw new ValidationError('Only an unfiled original can be read again.');
    if(prior&&prior.status!=='FAILED'&&!retryId)return {id:prior.id,replayed:true};
    const id=prior?.id||newId('shipping-document');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'shipping-document-original:'+id,source.content.length+8192,{finished:true});
    const queue=await require('../operations/postgres-job-queue').enqueue(clientView(c),{workspaceId:ctx.workspaceId,kind,
      idempotencyKey:id+':'+newId('reading'),payload:{id,actorId:ctx.actorId},priority:35,maxAttempts:1});
    const params=[id,ctx.workspaceId,ctx.actorId,queue.job.id,source.attachment_id||null,source.prior_filing_id||null,
      order?.id||null,order?orderIdentity(order):null,source.message_id||null,JSON.stringify(source.origin),source.filename,source.source_hash,source.content,automatic];
    if(prior)await c.query(`UPDATE ${table} SET requested_by=$3,job_id=$4,attachment_id=$5,prior_filing_id=$6,requested_po_id=$7,requested_po_hash=$8,
      source_message_id=$9,source_origin=$10::jsonb,filename=$11,source_hash=$12,content=$13,automatic=$14,status='PENDING',
      document_usage_key=NULL,owns_document_usage=false,documents_used=0,issue=NULL,dismissed_at=NULL,document_kind=NULL,original_sections='[]',evidence='{}',
      linked_documents='[]',revision=revision+1,updated_at=clock_timestamp()
      WHERE id=$1 AND workspace_id=$2`,params);
    else await c.query(`INSERT INTO ${table}(id,workspace_id,requested_by,job_id,attachment_id,prior_filing_id,requested_po_id,requested_po_hash,
      source_message_id,source_origin,filename,source_hash,content,automatic) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)`,params);
    return {id,replayed:false};
  });
}

async function load(db,ctx,id,lock=false){
  await owner(db,ctx);
  const row=(await db.query(`SELECT r.*,j.status AS job_status FROM ${table} r LEFT JOIN stockchief_runtime.jobs j ON j.workspace_id=r.workspace_id AND j.id=r.job_id
    WHERE r.workspace_id=$1 AND r.id=$2${lock?' FOR UPDATE OF r':''}`,[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That shipping document reading is not in this inventory.');
  return original(row);
}

async function sourceCurrent(db,ctx,row,{pending=false}={}){
  if(row.attachment_id){
    const a=await attachment(db,ctx,row.attachment_id);
    if(!a||!Buffer.isBuffer(a.content)||a.source_hash!==row.source_hash||digest(a.content)!==row.source_hash||row.source_origin.message&&hash(mailIdentity(a))!==hash(row.source_origin))
      throw new ValidationError('The saved original or its sender changed. Review the current source before linking.');
  }else if(pending&&row.source_origin.message)throw new ValidationError('The original attachment was removed before this reading finished. The copied original is retained.');
  if(row.prior_filing_id){
    const prior=await require('./agent-filing').load(db,ctx,row.prior_filing_id);
    if(prior.source_hash!==row.source_hash||prior.target_id!==row.source_origin.priorOrder)throw new ValidationError('The previously filed original or its recorded purchase order changed.');
  }else if(pending&&row.source_origin.filedDocument)throw new ValidationError('The prior filing was removed before this reading finished.');
}

async function requestedOrder(db,ctx,row){
  if(!row.requested_po_hash)return null;
  const [current]=await findOrders(db,ctx,row.requested_po_id?[row.requested_po_id]:[],{byId:true,lock:true});
  if(!isCurrent(current)||orderIdentity(current)!==row.requested_po_hash)throw new ValidationError('The selected purchase order changed. Prepare a fresh original review.');
  return current;
}

async function lease(db,job){
  const owned=(await db.query(`SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND id=$2 AND lease_token=$3
    AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`,[job.workspaceId,job.id,job.leaseToken])).rowCount;
  if(!owned)throw new ValidationError('The original reading worker lost its lease. Retry the saved source.');
}

async function fund(db,scope,row){
  const previous=(await db.query(`SELECT idempotency_key FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2 AND meter='agent_documents'
    AND status='COMMITTED' AND units>=1 AND (detail->>'sourceHash'=$3 OR position($3 in idempotency_key)>0) ORDER BY occurred_at,id LIMIT 1`,
    [scope.accountId,scope.workspaceId,row.source_hash])).rows[0];
  if(previous)return {key:previous.idempotency_key,owns:false};
  const key='shipping-original:'+row.source_hash;
  const reserved=await entitlements.reserveUsage(db,scope,{meter:'agent_documents',units:1,idempotencyKey:key,retryReversed:true,
    detail:{sourceHash:row.source_hash,operation:'read_shipping_original',job:137}});
  if(!reserved.created)throw new ValidationError('This original already has a reading reservation. Recover that reading before trying again.');
  return {key,owns:true};
}

async function settle(db,scope,row,success){
  if(!row.document_usage_key||!row.owns_document_usage)return 0;
  const usage={meter:'agent_documents',idempotencyKey:row.document_usage_key};
  if(success)await entitlements.commitUsage(db,scope,usage);
  else await entitlements.reverseUsage(db,scope,{...usage,reason:'The complete shipping original was not read and filed as requested. Original retained.'});
  return success?1:0;
}

async function identify(db,ctx,row,pages){
  const found=proof.inspect(pages),orders=await findOrders(db,ctx,found.references.map(r=>r.value),{lock:true});
  const expected=await requestedOrder(db,ctx,row);
  const issues=[...found.issues],candidates=[];
  for(const ref of found.references){
    const matches=orders.filter(p=>proof.normalized(p.po_number)===proof.normalized(ref.value)&&isCurrent(p));
    if(matches.length!==1){issues.push({page:ref.page,quote:ref.quote,reason:'The printed reference does not identify one current purchase order in this inventory.'});continue;}
    const po=matches[0],origin=row.source_origin;
    if(origin.supplier&&origin.trust==='TRUSTED'&&origin.supplier!==po.supplier_id){
      issues.push({page:ref.page,quote:ref.quote,reason:'The saved supplier original and the recorded purchase order supplier disagree.'});continue;
    }
    if(origin.priorOrder&&origin.priorOrder!==po.id){issues.push({page:ref.page,quote:ref.quote,reason:'This original was previously filed on a different exact purchase order.'});continue;}
    candidates.push({...ref,id:po.id,reference:po.po_number,supplier:po.supplier,identity:orderIdentity(po)});
  }
  if(expected&&!candidates.some(p=>p.id===expected.id))issues.push({reason:'The original does not independently prove the selected purchase order.'});
  const clearType=Boolean(found.kind)&&found.headings.some(h=>h.kind===found.kind&&!h.uncertain);
  const automaticCandidates=expected?candidates.filter(p=>p.id===expected.id):candidates;
  const canAutomaticallyFile=clearType&&!issues.length&&automaticCandidates.length>0&&candidates.length===found.references.length&&
    automaticCandidates.every(p=>!p.uncertain)&&(!expected||automaticCandidates.length===1);
  return {...found,issues,candidates,expected:expected&&{id:expected.id,reference:expected.po_number,identity:orderIdentity(expected)},
    canAutomaticallyFile,automaticCandidates};
}

async function fileOrders(db,ctx,row,orders,documentKind,automatic){
  const text=row.original_sections.map(p=>'[Original page / section '+p.page+(p.sourceName?' · '+p.sourceName:'')+']\n'+p.text).join('\n\n');
  const linked=[];
  for(const po of orders){
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['file-document:'+ctx.workspaceId+':'+row.source_hash+':purchase_order:'+po.id]);
    const prior=(await db.query(`SELECT id,document_kind,shipping_reading_id FROM ${filed} WHERE workspace_id=$1 AND source_hash=$2 AND target_kind='purchase_order' AND target_id=$3 FOR UPDATE`,[ctx.workspaceId,row.source_hash,po.id])).rows[0];
    if(prior){
      await require('./agent-filing').load(db,ctx,prior.id);
      if(![documentKind,'other'].includes(prior.document_kind))throw new ValidationError('This exact original is already filed on the PO as a different document type. Review the existing filing.');
      if(!prior.shipping_reading_id||prior.document_kind==='other'){
        await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'filed-shipping-proof:'+prior.id,2048,{finished:true});
        await db.query(`UPDATE ${filed} SET document_kind=$3,shipping_reading_id=COALESCE(shipping_reading_id,$4) WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,prior.id,documentKind,row.id]);
        await require('../operations/postgres-security-audit').record(db,ctx,{action:'Original shipping evidence added to existing PO filing',reference:prior.id,
          after:{purchaseOrder:po.po_number,sourceHash:row.source_hash,documentKind,automatic}});
      }
      linked.push({id:prior.id,poId:po.id,reference:po.po_number,replayed:true});continue;
    }
    const id=newId('filed');
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'filed-document:'+id,row.content.length+Buffer.byteLength(text)+8192,{finished:true});
    await db.query(`INSERT INTO ${filed}(id,workspace_id,source_attachment_id,source_message_id,source_hash,source_text_hash,filename,content,extracted_text,
      document_kind,target_kind,target_id,target_reference,filed_by,shipping_reading_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'purchase_order',$11,$12,$13,$14)`,
      [id,ctx.workspaceId,row.attachment_id,row.source_message_id,row.source_hash,digest(text),row.filename,row.content,text,documentKind,po.id,po.po_number,ctx.actorId,row.id]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Original shipping evidence filed on purchase order',reference:id,
      after:{filename:row.filename,documentKind,purchaseOrder:po.po_number,sourceHash:row.source_hash,automatic}});
    linked.push({id,poId:po.id,reference:po.po_number});
  }
  return linked;
}

async function run(job,db,{readSource}={}){
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId},id=job.payload.id;
  try{
    const started=await tx(db,async c=>{
      const row=await load(c,ctx,id,true);
      if(row.job_id!==job.id)throw new ValidationError('This job no longer owns the exact original.');
      if(['READY','FILED'].includes(row.status))return {complete:true,row};
      const scope=await authorize(c,ctx,row.automatic);
      await lease(c,job);await sourceCurrent(c,ctx,row,{pending:true});await requestedOrder(c,ctx,row);
      const funded=await fund(c,scope,row);
      const result=await c.query(`UPDATE ${table} SET status='RUNNING',document_usage_key=$3,owns_document_usage=$4,updated_at=clock_timestamp()
        WHERE workspace_id=$1 AND id=$2 RETURNING *`,[ctx.workspaceId,id,funded.key,funded.owns]);
      return {row:result.rows[0]};
    });
    if(started.complete)return {id,replayed:true};
    let pages;
    try{pages=await (readSource||require('./contract-source').read)({filename:started.row.filename,buffer:started.row.content});}
    catch(error){throw new ValidationError(String(error.message).replace(/contracts?/gi,'shipping document'));}
    if(pages.some(p=>!p.text.trim()&&p.sourceKind==='scan'&&!p.visualObservation))throw new ValidationError('A source page could not be read completely. Retry with a clearer original.');
    return await tx(db,async c=>{
      let row=await load(c,ctx,id,true);
      if(row.job_id!==job.id||row.source_hash!==started.row.source_hash)throw new ValidationError('The original changed before the complete reading was saved.');
      const scope=await authorize(c,ctx,row.automatic);
      await lease(c,job);await sourceCurrent(c,ctx,row,{pending:true});
      const evidence=await identify(c,ctx,row,pages);
      if(evidence.unrelated)throw new ValidationError('This original identifies a different business document type. Use its matching filing workflow.');
      row={...row,original_sections:pages};
      let linked=[];
      if(row.automatic&&evidence.canAutomaticallyFile){
        const orders=await findOrders(c,ctx,evidence.automaticCandidates.map(p=>p.id),{byId:true,lock:true});
        if(orders.length!==evidence.automaticCandidates.length||orders.some(po=>!isCurrent(po)||!evidence.automaticCandidates.some(p=>p.id===po.id&&p.identity===orderIdentity(po))))
          throw new ValidationError('The exact source purchase orders changed before filing.');
        linked=await fileOrders(c,ctx,row,orders,evidence.kind,true);
      }
      await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'shipping-document-reading:'+id,
        Buffer.byteLength(JSON.stringify({pages,evidence,linked}))+8192,{finished:true});
      const documents=await settle(c,scope,row,true),status=linked.length?'FILED':'READY';
      const issue=evidence.issues.map(x=>x.reason).filter((reason,i,list)=>list.indexOf(reason)===i).join(' ');
      await c.query(`UPDATE ${table} SET status=$3,document_kind=$4,original_sections=$5::jsonb,evidence=$6::jsonb,
        linked_documents=$7::jsonb,documents_used=$8,issue=$9,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
        [ctx.workspaceId,id,status,evidence.kind,JSON.stringify(pages),JSON.stringify(evidence),JSON.stringify(linked),documents,issue||null]);
      const fenced=await c.query(`UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('committedShippingDocument',$4::text),updated_at=now()
        WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000) RETURNING id`,
        [ctx.workspaceId,job.id,job.leaseToken,id]);
      if(!fenced.rowCount)throw new ValidationError('The original reading lease expired before saving.');
      return {id,status,links:linked.length,documents};
    });
  }catch(error){
    await tx(db,c=>fail(c,job,error.message));
    throw error;
  }
}

async function fail(db,job,message){
  const row=(await db.query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND id=$2 AND job_id=$3 FOR UPDATE`,[job.workspaceId,job.payload.id,job.id])).rows[0];
  if(!row||row.status==='FAILED')return null;
  if(['READY','FILED'].includes(row.status))return {id:row.id,recovered:true,status:row.status};
  await settle(db,await entitlements.ownerScopeForWorkspace(db,job.workspaceId),row,false);
  await db.query(`UPDATE ${table} SET status='FAILED',issue=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
    [job.workspaceId,row.id,String(message||'The complete reading was interrupted. The original remains available to retry.').slice(0,1500)]);
  return null;
}

async function recover(db,job){return fail(db,job);}
function reviewHash(row){return hash([row.id,row.source_hash,row.revision,row.document_kind,row.requested_po_hash,row.evidence]);}

async function approve(db,ctx,id,input){
  return tx(db,async c=>{
    await authorize(c,ctx);
    const row=await load(c,ctx,id,true);
    if(row.status==='FILED')return {id,links:row.linked_documents,replayed:true};
    if(row.status!=='READY'||input.reviewHash!==reviewHash(row)||input.confirmed!=='yes')
      throw new ValidationError('Review and approve this exact complete original before filing.');
    await sourceCurrent(c,ctx,row);await requestedOrder(c,ctx,row);
    const documentKind=row.document_kind||input.documentKind;
    if(!Object.hasOwn(proof.kinds,documentKind))throw new ValidationError('Confirm whether this original is a bill of lading or customs paper.');
    const ids=[...new Set((Array.isArray(input.purchaseOrderIds)?input.purchaseOrderIds:[input.purchaseOrderIds]).filter(Boolean))];
    if(ids.some(id=>!row.evidence.candidates.some(p=>p.id===id)))throw new ValidationError('Approve only the purchase orders shown in this exact source review.');
    const explicit=await exactOrder(c,ctx,input.purchaseOrder);
    if(explicit&&!ids.includes(explicit.id))ids.push(explicit.id);
    const orders=await findOrders(c,ctx,ids,{byId:true,lock:true});
    if(!orders.length||orders.length!==ids.length||orders.some(po=>!isCurrent(po)))throw new ValidationError('Choose the exact current purchase order links for this original.');
    const proven=row.evidence.references.filter(p=>!p.uncertain),origin=row.source_origin;
    const reason=String(input.matchReason||'').trim();
    if(reason.length>1000)throw new ValidationError('Use up to 1,000 characters for the checked purchase order evidence.');
    for(const po of orders){
      const candidate=row.evidence.candidates.find(p=>p.id===po.id);
      if(candidate&&candidate.identity!==orderIdentity(po))throw new ValidationError('A reviewed purchase order changed. Prepare a new source review.');
      if(proven.length&&!proven.some(ref=>proof.normalized(ref.value)===proof.normalized(po.po_number)))
        throw new ValidationError('The original identifies different purchase orders. Choose the matching exact order from its evidence.');
      if((!candidate||candidate.uncertain)&&reason.length<3)throw new ValidationError('Record how you verified this exact purchase order against the original.');
      if(origin.supplier&&origin.trust==='TRUSTED'&&origin.supplier!==po.supplier_id||origin.priorOrder&&origin.priorOrder!==po.id)
        throw new ValidationError('This original belongs to a different recorded supplier or purchase order.');
    }
    const linked=await fileOrders(c,ctx,row,orders,documentKind,false);
    const approvedEvidence={...row.evidence,ownerReview:{actorId:ctx.actorId,confirmed:true,reason:reason||null}};
    await c.query(`UPDATE ${table} SET status='FILED',document_kind=$3,linked_documents=$4::jsonb,evidence=$5::jsonb,revision=revision+1,updated_at=clock_timestamp()
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,documentKind,JSON.stringify(linked),JSON.stringify(approvedEvidence)]);
    return {id,links:linked,replayed:false};
  });
}

async function retry(db,ctx,id,input){
  const row=await load(db,ctx,id);
  const source=row.prior_filing_id?{filedDocument:row.prior_filing_id}:row.attachment_id?{fileAttachment:row.attachment_id}:{buffer:row.content,filename:row.filename};
  return enqueue(db,ctx,{...source,purchaseOrder:input.purchaseOrder},{retryId:id});
}

async function dismiss(db,ctx,id){
  await owner(db,ctx);
  await db.query(`UPDATE ${table} SET dismissed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND status IN('READY','FAILED')`,[ctx.workspaceId,id]);
}

async function screen(db,ctx,{id,reference,fileAttachment,filedDocument,page=1}={}){
  await owner(db,ctx);
  const state=await policy.accountState(db,ctx.workspaceId),allowed=policy.usesAgentTerms(state)&&policy.permits(state.plan,137,'draft');
  page=Number(page);
  if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid source history page.');
  const rows=(await db.query(`SELECT id,filename,status,document_kind,documents_used,created_at FROM ${table}
    WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 51 OFFSET $2`,[ctx.workspaceId,(page-1)*50])).rows;
  const selected=id?await load(db,ctx,id):null;
  const stop=allowed?(await policy.stopped(db,ctx.workspaceId,state,action,false)||await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,142,false)):null;
  return {allowed,automatic:allowed&&policy.permits(state.plan,137,'automatic'),stop,selected,
    reviewHash:selected?reviewHash(selected):null,rows:rows.slice(0,50),more:rows.length>50,page,
    initial:{reference:reference||'',fileAttachment:fileAttachment||'',filedDocument:filedDocument||''}};
}

function notices(summary){
  if(!summary?.n)return [];
  return [{kind:'purchase',importance:'Needs You',priority:48,title:summary.n+' shipping original'+(summary.n===1?' needs':'s need')+' review',
    happened:'A bill of lading or customs original is ready for a purchase order link or could not be read completely.',
    why:'Check the exact original and purchase order evidence.',actionLabel:'Review shipping originals',href:'/autopilot/shipping-documents',
    sourceId:'shipping-document-readings',at:summary.created_at,createdAt:summary.created_at}];
}

module.exports={table,kind,action,owner,enqueue,load,run,fail,recover,approve,retry,dismiss,screen,notices};

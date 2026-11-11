'use strict';

const {createHash}=require('node:crypto');
const {newId}=require('../lib/util');
const {hash}=require('../pricing/postgres-promotions');
const {AuthorizationError,ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const proof=require('../documents/lot-certificate-proof');
const sources='stockchief_runtime.lot_certificate_sources';
const links='stockchief_runtime.lot_certificate_links';
const rules='stockchief_runtime.lot_certificate_rules';
const requirements='stockchief_runtime.lot_certificate_requirements';
const action='document.link_lot_certificate';
const jobKind='import.link-lot-certificate.v1';
const kinds=['CoA','Safety sheet'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const supported=/\.(pdf|docx|txt|csv|tsv|png|jpe?g|webp|gif|heic|heif|tiff?)$/iu;
const hint=/certificate of analys|certificat d.analysis|certificat d.analyse|certificado de an[aá]lisis|analysenzertifikat|safety (?:data )?sheet|fiche de (?:donn[ée]es de )?s[ée]curit[ée]|ficha de datos de seguridad|sicherheitsdatenblatt|\b(?:coa|msds|sds)\b/iu;
const transaction=(db,work)=>db.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true});

async function owner(db,ctx){
  const row=(await db.query(`SELECT w.owner_account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL) FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can open private lot certificate evidence.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  return row.owner_account_id;
}

async function authorize(db,ctx,{automatic=false,checkModes=true}={}){
  const accountId=await owner(db,ctx);
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE',[accountId]);
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,196,automatic?'automatic':'draft');
  if(checkModes){
    await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[ctx.workspaceId]);
    await db.query('SELECT job_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=196 FOR SHARE',[ctx.workspaceId]);
    const reason=await policy.stopped(db,ctx.workspaceId,state,action,automatic);
    if(reason)throw new ValidationError(reason);
    if(automatic&&!(await require('./postgres-service').getState(db,ctx.workspaceId)).canAutomate)
      throw new ValidationError('Enable current inventory routine authority before automatically linking lot certificates.');
  }
  return state;
}

function certificateKind(value){
  if(!kinds.includes(value))throw new ValidationError('Choose a certificate of analysis or safety sheet.');
  return value;
}

function lotIdentity(lot){return hash([lot.id,lot.sku_id,lot.sku,lot.code]);}

async function findLot(db,ctx,input,lock=false){
  return require('./lot-controls').lookup(db,ctx,input,lock);
}

function validSource(source){
  if(!source||!Buffer.isBuffer(source.content)||!source.content.length||source.content.length>20*1024*1024||
    !source.filename||source.filename.length>240||digest(source.content)!==source.source_hash)
    throw new ValidationError('Choose a valid complete original file up to 20 MB.');
  return source;
}

async function load(db,ctx,id,{lock=false}={}){
  await owner(db,ctx);
  const source=(await db.query('SELECT * FROM '+sources+' WHERE workspace_id=$1 AND id=$2'+(lock?' FOR UPDATE':''),[ctx.workspaceId,id])).rows[0];
  if(!source)throw new NotFoundError('That original certificate is not in this inventory.');
  return validSource(source);
}

async function inputSource(db,ctx,input,lot){
  if(input.sourceId)return load(db,ctx,input.sourceId,{lock:true});
  if(input.filedDocument){
    const source=await require('../documents/agent-filing').load(db,ctx,input.filedDocument);
    if(source.target_kind==='item'&&source.target_id!==lot.item_id)throw new ValidationError('This original is filed on a different product.');
    if(!['safety_sheet','specification','other'].includes(source.document_kind))throw new ValidationError('Choose a filed certificate, specification or safety source.');
    return validSource({...source,filed_document_id:source.id});
  }
  if(input.fileAttachment){
    const source=(await db.query('SELECT id,filename,content,content_hash AS source_hash FROM connection_email_attachments WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.workspaceId,input.fileAttachment])).rows[0];
    if(!source)throw new NotFoundError('That saved attachment is not in this inventory.');
    return validSource({...source,original_attachment_id:source.id});
  }
  return validSource({filename:String(input.filename||'').trim(),content:input.buffer,source_hash:Buffer.isBuffer(input.buffer)?digest(input.buffer):null});
}

async function preserve(db,ctx,source,reviewReason=null){
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['lot-certificate-source:'+ctx.workspaceId+':'+source.source_hash]);
  const prior=(await db.query('SELECT * FROM '+sources+' WHERE workspace_id=$1 AND source_hash=$2 FOR UPDATE',[ctx.workspaceId,source.source_hash])).rows[0];
  if(prior)return validSource(prior);
  const id=newId('lot-cert-source');
  await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'lot-certificate-original:'+id,source.content.length+8192,{finished:true});
  return (await db.query(`INSERT INTO ${sources}(id,workspace_id,filename,source_hash,content,original_attachment_id,filed_document_id,actor_id,review_reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[id,ctx.workspaceId,source.filename,source.source_hash,source.content,
    source.original_attachment_id||null,source.filed_document_id||null,ctx.actorId,reviewReason])).rows[0];
}

async function prepareLink(db,ctx,lot,source,kind,evidence={},automatic=false){
  const existing=(await db.query(`SELECT * FROM ${links} WHERE workspace_id=$1 AND lot_id=$2 AND kind=$3 AND source_id=$4 FOR UPDATE`,[ctx.workspaceId,lot.id,kind,source.id])).rows[0];
  if(existing)return {link:existing,replayed:true};
  const id=newId('lot-cert-link');
  const detail=JSON.stringify(evidence);
  await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'lot-certificate-link:'+id,Buffer.byteLength(detail)+8192,{finished:true});
  const state=automatic?'LINKED':'DRAFT';
  const link=(await db.query(`INSERT INTO ${links}(id,workspace_id,lot_id,source_id,kind,expires_on,proof,identity_hash,state,automatic,prepared_by,linked_by,linked_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,CASE WHEN $10 THEN $11 END,CASE WHEN $10 THEN clock_timestamp() END) RETURNING *`,
    [id,ctx.workspaceId,lot.id,source.id,kind,evidence.expiresOn||null,detail,lotIdentity(lot),state,automatic,ctx.actorId])).rows[0];
  await db.query(`UPDATE ${sources} SET dismissed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND dismissed_at IS NULL`,[ctx.workspaceId,source.id]);
  if(automatic)await auditLink(db,ctx,lot,source,link);
  return {link,replayed:false};
}

async function auditLink(db,ctx,lot,source,link){
  await require('../operations/postgres-security-audit').record(db,ctx,{action:'Original lot certificate linked',reference:link.id,
    after:{sku:lot.sku,lot:lot.code,kind:link.kind,sourceHash:source.source_hash,expiresOn:link.expires_on,automatic:link.automatic}});
}

async function prepare(db,ctx,input){
  return transaction(db,async c=>{
    await authorize(c,ctx);
    const lot=await findLot(c,ctx,input,true),kind=certificateKind(input.kind);
    const source=await preserve(c,ctx,await inputSource(c,ctx,input,lot));
    const result=await prepareLink(c,ctx,lot,source,kind);
    return {id:result.link.id,replayed:result.replayed};
  });
}

async function draft(db,ctx,id,lock=false){
  await owner(db,ctx);
  const row=(await db.query(`SELECT d.*,l.code AS lot,s.code AS sku,l.sku_id,src.filename,src.source_hash,src.review_reason,d.expires_on::text AS expiry
    FROM ${links} d JOIN lots l ON l.workspace_id=d.workspace_id AND l.id=d.lot_id JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN ${sources} src ON src.workspace_id=d.workspace_id AND src.id=d.source_id WHERE d.workspace_id=$1 AND d.id=$2`+(lock?' FOR UPDATE OF d,l':''),[ctx.workspaceId,id])).rows[0];
  if(!row)throw new NotFoundError('That certificate review is not in this inventory.');
  return {...row,reviewHash:hash([row.id,row.state,row.source_hash,row.revision,row.sku_id,row.sku,row.lot,row.kind,row.expiry,row.proof])};
}

async function approve(db,ctx,id,input){
  return transaction(db,async c=>{
    await authorize(c,ctx);
    const row=await draft(c,ctx,id,true);
    if(row.state==='LINKED')return {id,replayed:true};
    if(row.state!=='DRAFT'||input.confirmed!=='yes'||input.reviewHash!==row.reviewHash)
      throw new ValidationError('Review and approve the current exact original and lot before linking.');
    const lot=await findLot(c,ctx,row,true),source=await load(c,ctx,row.source_id,{lock:true});
    if(row.identity_hash!==lotIdentity(lot))throw new ValidationError('The recorded product or lot changed. Prepare a fresh source review.');
    const expiresOn=input.expiryMode==='dated'?proof.date(input.expiresOn):null;
    if(!['dated','none'].includes(input.expiryMode)||input.expiryMode==='none'&&input.expiresOn)
      throw new ValidationError('Confirm the exact printed expiry or confirm the source has no stated expiry.');
    const checked={...row.proof,ownerConfirmed:true,ownerExpiryMode:input.expiryMode};
    if(row.expiry!==expiresOn){checked.proposedExpiry=row.expiry;checked.correctedExpiry=expiresOn;}
    const linked=(await c.query(`UPDATE ${links} SET state='LINKED',expires_on=$3,proof=$4::jsonb,linked_by=$5,linked_at=clock_timestamp(),revision=revision+1
      WHERE workspace_id=$1 AND id=$2 RETURNING *`,[ctx.workspaceId,id,expiresOn,JSON.stringify(checked),ctx.actorId])).rows[0];
    await auditLink(c,ctx,lot,source,linked);
    return {id,replayed:false};
  });
}

async function revoke(db,ctx,id,input){
  return transaction(db,async c=>{
    await owner(c,ctx);
    const row=await draft(c,ctx,id,true),reason=String(input.reason||'').trim();
    if(row.state==='REVOKED')return {id,replayed:true};
    if(input.reviewHash!==row.reviewHash||reason.length<3||reason.length>500)throw new ValidationError('Review this exact certificate and give the reason for withdrawing it.');
    await c.query(`UPDATE ${links} SET state='REVOKED',revoked_at=clock_timestamp(),revoke_reason=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,reason]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Lot certificate link withdrawn',reference:id,after:{sku:row.sku,lot:row.lot,reason}});
    return {id,replayed:false};
  });
}

async function requirement(db,ctx,input){
  return transaction(db,async c=>{
    await authorize(c,ctx,{checkModes:false});
    const lot=await findLot(c,ctx,input,true),kind=certificateKind(input.kind);
    if(!['yes','no'].includes(input.required))throw new ValidationError('Choose whether this certificate is required for this exact SKU.');
    if(input.required==='yes'){
      await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'lot-certificate-requirement:'+lot.sku_id+':'+kind,2048,{finished:true});
      await c.query(`INSERT INTO ${requirements}(workspace_id,sku_id,kind) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[ctx.workspaceId,lot.sku_id,kind]);
    }else await c.query(`DELETE FROM ${requirements} WHERE workspace_id=$1 AND sku_id=$2 AND kind=$3`,[ctx.workspaceId,lot.sku_id,kind]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Lot certificate requirement reviewed',reference:lot.sku_id,after:{kind,required:input.required==='yes'}});
  });
}

async function sourceIdentity(db,workspaceId,skuId,supplierId,connectorId){
  return (await db.query(`SELECT supplier.id AS supplier_id,supplier.name AS supplier_name,lower(supplier.email) AS sender,
    c.id AS connector_id,c.display_name AS mailbox,c.provider_account_id,sku.id AS sku_id,sku.code AS sku,si.supplier_sku
    FROM supplier_items si JOIN suppliers supplier ON supplier.workspace_id=si.workspace_id AND supplier.id=si.supplier_id
    JOIN skus sku ON sku.workspace_id=si.workspace_id AND sku.id=si.sku_id JOIN items i ON i.workspace_id=sku.workspace_id AND i.id=sku.item_id
    JOIN workspace_connectors c ON c.workspace_id=si.workspace_id AND c.id=$4
    WHERE si.workspace_id=$1 AND si.sku_id=$2 AND si.supplier_id=$3 AND si.is_active=1 AND sku.is_active=1 AND i.is_active=1
    AND supplier.status='active' AND btrim(supplier.email)<>'' AND c.status='connected' AND c.paused_at IS NULL
    AND c.provider_type IN('gmail','microsoft365') AND c.provider_account_id IS NOT NULL FOR SHARE OF si,supplier,sku,i,c`,[workspaceId,skuId,supplierId,connectorId])).rows[0]||null;
}

async function configure(db,ctx,input){
  return transaction(db,async c=>{
    await owner(c,ctx);
    if(input.stop==='yes'){
      const stopped=await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND enabled`,[ctx.workspaceId,input.id,Number(input.revision)||0]);
      if(!stopped.rowCount)throw new ValidationError('The saved certificate scope changed. Reload before stopping it.');
      return {stopped:true};
    }
    const mode=input.mode==='automatic'?'automatic':'draft';
    await authorize(c,ctx,{automatic:mode==='automatic'});
    const lot=await findLot(c,ctx,input,true);
    const selected=[...new Set(Array.isArray(input.kinds)?input.kinds:[input.kinds])].map(certificateKind).sort();
    const identity=await sourceIdentity(c,ctx.workspaceId,lot.sku_id,input.supplierId,input.connectorId);
    if(!identity||input.confirmed!=='yes')throw new ValidationError('Confirm the exact SKU, existing linked supplier, connected mailbox and certificate types.');
    const prior=(await c.query(`SELECT id,revision,enabled FROM ${rules} WHERE workspace_id=$1 AND sku_id=$2 AND supplier_id=$3 AND connector_id=$4 FOR UPDATE`,[ctx.workspaceId,lot.sku_id,identity.supplier_id,identity.connector_id])).rows[0];
    if(prior&&(prior.enabled||input.revision!=null&&input.revision!=='')&&Number(input.revision)!==prior.revision)throw new ValidationError('Review the current saved scope before changing it. Stop it to replace the authority.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    const id=prior?.id||newId('lot-cert-rule');
    await require('../commercial/storage-capacity').reserve(c,ctx.workspaceId,'lot-certificate-rule:'+id,8192,{finished:true});
    await c.query(`INSERT INTO ${rules}(id,workspace_id,sku_id,supplier_id,connector_id,kinds,source_identity,authorized_by,mode)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT(workspace_id,sku_id,supplier_id,connector_id)
      DO UPDATE SET kinds=EXCLUDED.kinds,source_identity=EXCLUDED.source_identity,authorized_by=EXCLUDED.authorized_by,mode=EXCLUDED.mode,
      enabled=true,revision=lot_certificate_rules.revision+1,effective_at=clock_timestamp()`,[id,ctx.workspaceId,lot.sku_id,identity.supplier_id,identity.connector_id,selected,JSON.stringify(identity),ctx.actorId,mode]);
    await require('../operations/postgres-security-audit').record(c,ctx,{action:'Lot certificate mailbox scope approved',reference:id,after:{identity,kinds:selected,mode}});
    return {id};
  });
}

async function mailContext(db,workspaceId,messageId){
  const message=(await db.query(`SELECT m.id,m.subject,m.supplier_id,lower(m.sender) AS sender,m.connector_id,m.received_at FROM connection_email_messages m
    JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    WHERE m.workspace_id=$1 AND m.id=$2 AND m.trust_status='TRUSTED' AND m.classification='supplier'
    AND c.status='connected' AND c.paused_at IS NULL AND c.provider_account_id IS NOT NULL`,[workspaceId,messageId])).rows[0];
  if(!message)return null;
  const matching=(await db.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND supplier_id=$2 AND connector_id=$3 AND enabled
    AND effective_at<=$4::timestamptz ORDER BY id`,[workspaceId,message.supplier_id,message.connector_id,message.received_at])).rows;
  return {message,matching};
}

async function queueMessage(db,workspaceId,messageId){
  const context=await mailContext(db,workspaceId,messageId);
  if(!context?.matching.length)return {queued:0};
  const files=(await db.query(`SELECT id,filename,content_hash,extracted_text FROM connection_email_attachments
    WHERE workspace_id=$1 AND message_id=$2 ORDER BY id`,[workspaceId,messageId])).rows;
  let queued=0;
  for(const file of files){
    if(!hint.test(file.filename+'\n'+context.message.subject)&&!proof.heading(file.extracted_text).length)continue;
    const result=await require('../operations/postgres-job-queue').enqueue(db,{workspaceId,kind:jobKind,
      idempotencyKey:'lot-certificate:'+file.id+':'+file.content_hash,payload:{messageId,attachmentId:file.id},priority:35,maxAttempts:2});
    if(result.created)queued++;
  }
  return {queued};
}

async function onAttachment(db,workspaceId,messageId,attachmentId,job=null){
  const context=await mailContext(db,workspaceId,messageId);
  if(!context?.matching.length)return {skipped:true};
  const {message}=context;
  const eligible=[];
  for(const rule of context.matching){
    const ctx={workspaceId,actorId:rule.authorized_by};
    try{await authorize(db,ctx,{automatic:rule.mode==='automatic'});}catch(error){if(['forbidden','entitlement_required','validation_error'].includes(error.code))continue;throw error;}
    eligible.push(rule);
  }
  if(!eligible.length)return {skipped:true};
  const file=(await db.query(`SELECT id,filename,content,content_hash AS source_hash,extracted_text,extraction_status FROM connection_email_attachments
    WHERE workspace_id=$1 AND message_id=$2 AND id=$3`,[workspaceId,messageId,attachmentId])).rows[0];
  if(!file||!hint.test(file.filename+'\n'+message.subject)&&!proof.heading(file.extracted_text).length)return {skipped:true};
  // Attachment processing already accounts for this original. Linking reuses it.
  validSource(file);
  const canRead=file.extraction_status==='READABLE'&&supported.test(file.filename);
  let result,targets=[];
  if(!canRead)result={links:[],reason:'Open the complete original and confirm the exact lot and expiry. The incoming file needs manual source review.'};
  else{
    try{
      const pages=await require('../documents/contract-source').read({filename:file.filename,buffer:file.content});
      const codes=proof.lotCodes(pages);
      if(codes.length)targets=(await db.query(`SELECT l.id,l.code,l.sku_id,s.code AS sku,si.supplier_sku
        FROM lots l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
        JOIN supplier_items si ON si.workspace_id=l.workspace_id AND si.sku_id=l.sku_id AND si.supplier_id=$3 AND si.is_active=1
        WHERE l.workspace_id=$1 AND l.sku_id=ANY($2::text[]) AND l.code=ANY($4::text[])`,
        [workspaceId,eligible.map(r=>r.sku_id),message.supplier_id,codes])).rows;
      result=proof.parse(pages,targets);
    }catch(error){
      if(error.code!=='validation_error')throw error;
      result={links:[],reason:'Check the complete original. Its exact certificate and lot evidence could not be verified automatically.'};
    }
  }
  return transaction(db,async c=>{
    if(job&&!(await c.query("SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000) FOR UPDATE",[workspaceId,job.id,job.leaseToken])).rowCount)throw new ValidationError('The certificate review worker lost its lease. The original remains in the mailbox.');
    const current=await mailContext(c,workspaceId,messageId);
    const fresh=(await c.query('SELECT content,content_hash FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 AND id=$3 FOR SHARE',[workspaceId,messageId,attachmentId])).rows[0];
    if(!current||current.message.sender!==message.sender||!fresh||fresh.content_hash!==file.source_hash||digest(fresh.content)!==file.source_hash)return {skipped:true};
    const active=[];
    for(const rule of eligible){
      const now=(await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1 AND id=$2 AND enabled AND revision=$3 FOR SHARE`,[workspaceId,rule.id,rule.revision])).rows[0];
      if(!now||!current.matching.some(r=>r.id===now.id))continue;
      const ctx={workspaceId,actorId:now.authorized_by};
      try{await authorize(c,ctx,{automatic:now.mode==='automatic'});}catch(error){if(['forbidden','entitlement_required','validation_error'].includes(error.code))continue;throw error;}
      const identity=await sourceIdentity(c,workspaceId,now.sku_id,now.supplier_id,now.connector_id);
      if(identity&&hash(identity)===hash(now.source_identity)&&identity.sender===current.message.sender)active.push(now);
    }
    if(!active.length)return {skipped:true};
    const ctx={workspaceId,actorId:active[0].authorized_by};
    const staged=[];
    for(const evidence of result.links){
      const rule=active.find(r=>r.sku_id===evidence.skuId&&r.kinds.includes(evidence.kind));
      if(!rule)continue;
      const lot=(await c.query(`SELECT l.*,s.code AS sku FROM lots l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
        WHERE l.workspace_id=$1 AND l.id=$2 FOR UPDATE OF l`,[workspaceId,evidence.lotId])).rows[0];
      const prior=targets.find(r=>r.id===lot?.id);
      if(!prior||lotIdentity(lot)!==lotIdentity(prior))continue;
      const conflictingSupplier=(await c.query(`SELECT 1 FROM purchase_order_receipt_lines rl
        JOIN purchase_order_receipts rr ON rr.workspace_id=rl.workspace_id AND rr.id=rl.receipt_id
        JOIN purchase_orders po ON po.workspace_id=rr.workspace_id AND po.id=rr.purchase_order_id
        WHERE rl.workspace_id=$1 AND rl.lot_id=$2 AND po.supplier_id<>$3
        UNION ALL SELECT 1 FROM stockchief_runtime.agent_direct_lots dl
        JOIN stockchief_runtime.agent_direct_dispatch_lines line ON line.workspace_id=dl.workspace_id AND line.id=dl.dispatch_line_id
        JOIN stockchief_runtime.agent_direct_dispatches dispatch ON dispatch.workspace_id=line.workspace_id AND dispatch.id=line.dispatch_id AND dispatch.state='APPLIED'
        JOIN stockchief_runtime.agent_direct_orders route ON route.workspace_id=dispatch.workspace_id AND route.id=dispatch.direct_order_id
        JOIN purchase_orders po ON po.workspace_id=route.workspace_id AND po.id=route.purchase_order_id
        WHERE dl.workspace_id=$1 AND dl.lot_id=$2 AND po.supplier_id<>$3 LIMIT 1`,[workspaceId,lot.id,rule.supplier_id])).rowCount;
      if(conflictingSupplier)continue;
      if(!(await c.query(`SELECT 1 FROM ${requirements} WHERE workspace_id=$1 AND sku_id=$2 AND kind=$3 FOR SHARE`,[workspaceId,lot.sku_id,evidence.kind])).rowCount)continue;
      staged.push({lot,evidence,rule});
    }
    const reason=staged.length===result.links.length&&staged.length?null:result.reason||'Review the original against the current exact lot, requirement and owner-authorized certificate scope.';
    const saved=await preserve(c,ctx,{...file,original_attachment_id:file.id},reason);
    if(reason){
      if(saved.review_reason==null)await c.query(`UPDATE ${sources} SET review_reason=$3 WHERE workspace_id=$1 AND id=$2`,[workspaceId,saved.id,reason]);
      return {held:true,sourceId:saved.id};
    }
    const done=[];
    for(const {lot,evidence,rule} of staged){
      done.push(await prepareLink(c,{workspaceId,actorId:rule.authorized_by},lot,saved,evidence.kind,{...evidence,
        supplierId:rule.supplier_id,connectorId:rule.connector_id,messageId,attachmentId:file.id,ruleId:rule.id,ruleRevision:rule.revision},rule.mode==='automatic'));
    }
    return {sourceId:saved.id,linked:done.filter(r=>!r.replayed&&r.link.state==='LINKED').length,drafted:done.filter(r=>!r.replayed&&r.link.state==='DRAFT').length};
  });
}

async function dismiss(db,ctx,id){await owner(db,ctx);await db.query(`UPDATE ${sources} SET dismissed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND review_reason IS NOT NULL AND dismissed_at IS NULL`,[ctx.workspaceId,id]);}

module.exports={sources,links,rules,requirements,action,jobKind,kinds,owner,authorize,load,prepare,draft,approve,revoke,requirement,configure,onAttachment,queueMessage,dismiss};

'use strict';

const crypto=require('node:crypto');
const express=require('express');
const imports=require('../../imports/postgres-service');
const progress=require('../../imports/postgres-progress');
const fields=require('../../imports/fields');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const config=require('../../config');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const { newId,trimOrNull }=require('../../lib/util');
const { ValidationError }=require('../../domain/errors');

const PAGE_SIZE=50;
const sourceUploads=require('../../imports/postgres-source-uploads');

async function importJob(database,workspaceId,id){
  return (await database.query(`SELECT status,lease_expires_at FROM stockchief_runtime.jobs
    WHERE workspace_id=$1 AND kind='import.execute-approved' AND payload->>'planId'=$2
    ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId,id])).rows[0]||null;
}

async function locations(database,workspaceId){
  return (await database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name,id`,
    [workspaceId])).rows;
}

function createPostgresImportsRouter(database,{provider=null}={}){
  const router=express.Router();
  router.use('/imports',requireAuth);
  router.use('/imports',(req,_res,next)=>{
    if(['GET','HEAD'].includes(req.method)&&!require('../../actions/financial-visibility').costs(req.user))
      return next(new (require('../../domain/errors').AuthorizationError)('Purchase permissions are required to view source files and their costs.'));
    return next();
  });
  async function renderStart(req,res){const policy=require('../../commercial/agent-plan'),state=await policy.accountState(database,req.ctx.workspaceId),scope={accountId:state.accountId,workspaceId:req.ctx.workspaceId},creditPolicy=await require('../../commercial/ai-credit-policy').policy(database,scope),readingPolicy=(await database.query("SELECT units FROM commercial_operation_policies WHERE operation='import_mapping'")).rows[0];return res.page('imports/start',{
    handwritingPageCredits:Number(readingPolicy?.units||0)*creditPolicy.scale,
    handwritingAllowed:policy.usesAgentTerms(state)&&policy.permits(state.plan,139,'draft'),
    variantsAllowed:require('../../imports/agent-exact-variant-import').available(state),
    migrationAllowed:(await require('../../onboarding/postgres-cutover').planAccess(database,req.ctx)).allowed,
    title:'File imports and results',nav:'imports',recent:await progress.list(database,req.ctx.workspaceId,{limit:20}),
    sourceUploads:await sourceUploads.list(database,req.ctx.workspaceId),
    locations:await locations(database,req.ctx.workspaceId),aiConfigured:Boolean(provider||config.ai.configured),canOperate:true,
    usageKey:newId('importpreview'),uploadLimitBytes:config.uploads.maxBytes,
  });}
  router.get('/imports/start',asyncRoute(renderStart));
  router.get('/imports',asyncRoute(renderStart));
  const variantImports=require('../../imports/agent-exact-variant-import'),variantPath='/imports/variants';
  async function variantsPage(req,res){
    const screen=await variantImports.screen(database,req.ctx,{...req.query,id:req.params.id||null});
    return res.set('Cache-Control','private, no-store').page('imports/variant-sheet',{
      title:'Spreadsheet variants',nav:'imports',screen,backTo:{href:'/imports',label:'File imports'}});
  }
  router.get(variantPath,requireOwner,asyncRoute(variantsPage));
  router.post(variantPath,requireOwner,asyncRoute(async(req,res)=>{
    const files=(req.files||[]).filter(f=>f.field==='file');
    if(files.length!==1)throw new ValidationError('Choose one original spreadsheet.');
    const result=await variantImports.enqueue(database,req.ctx,{...req.body,filename:files[0].filename,buffer:files[0].buffer});
    res.redirect(303,variantPath+'/'+result.id);
  }));
  router.get(variantPath+'/:id/original',requireOwner,asyncRoute(async(req,res)=>{
    const saved=await variantImports.load(database,req.ctx,req.params.id,{original:true});
    res.set('Cache-Control','private, no-store').type('application/octet-stream').attachment(saved.filename).send(saved.content);
  }));
  router.get(variantPath+'/:id/results.csv',requireOwner,asyncRoute(async(req,res)=>{
    await variantImports.load(database,req.ctx,req.params.id);
    const csv=require('../../reports/exports'),columns=['Worksheet','Row','Part','Product','Product code','SKU','Barcode','Options','Result','Issue','Product record','SKU record'];
    async function* report(){
      yield csv.csvHeader({columns});
      for await(const row of variantImports.exportRows(database,req.ctx,req.params.id)){
        const record=Object.fromEntries(columns.map((column,index)=>[column,row[index]]));
        yield csv.csvRows({columns,rows:[record]});
      }
    }
    res.set('Cache-Control','private, no-store').type('text/csv').attachment('variant-review.csv');
    await require('node:stream/promises').pipeline(require('node:stream').Readable.from(report()),res);
  }));
  router.get(variantPath+'/:id',requireOwner,asyncRoute(variantsPage));
  router.post(variantPath+'/:id/approve',requireOwner,asyncRoute(async(req,res)=>{
    await variantImports.approve(database,req.ctx,req.params.id,req.body);
    res.redirect(303,variantPath+'/'+req.params.id);
  }));
  router.post(variantPath+'/:id/review-again',requireOwner,asyncRoute(async(req,res)=>{
    await variantImports.revise(database,req.ctx,req.params.id,{revision:req.body.revision});
    res.redirect(303,variantPath+'/'+req.params.id);
  }));
  router.post(variantPath+'/:id/map',requireOwner,asyncRoute(async(req,res)=>{
    const batch=await variantImports.load(database,req.ctx,req.params.id);
    const sheet=batch.sheets.find(s=>s.index===Number(req.body.sheetIndex));
    if(!sheet)throw new ValidationError('Choose an exact worksheet from this source.');
    const all=value=>[].concat(value||[]).map(Number);
    const named=(indices,prior)=>indices.map(index=>({index,label:prior.find(a=>a.index===index)?.label||sheet.columns.find(c=>c.index===index)?.name}));
    const axes=named(all(req.body.axes),sheet.mapping.axes),matrix=named(all(req.body.matrix),sheet.mapping.matrix);
    const pairs=Object.keys(req.body).filter(key=>/^pairName_\d+$/u.test(key)).map(key=>({
      nameIndex:req.body[key],index:req.body[key.replace('pairName_','pairValue_')]})).filter(p=>p.nameIndex!==''||p.index!=='');
    if(req.body.mode==='skip'&&req.body.confirmSkip!=='yes')throw new ValidationError('Confirm that this worksheet contains no variants to import.');
    if(matrix.length&&req.body.confirmMatrix!=='yes')throw new ValidationError('Confirm that the selected cells contain exact variant SKUs.');
    await variantImports.revise(database,req.ctx,req.params.id,{revision:req.body.revision,mappings:{...batch.mappings,[sheet.index]:{
      mode:req.body.mode,parent:req.body.parent,name:req.body.name,sku:req.body.sku,barcode:req.body.barcode,
      axes,pairs,matrix,matrixName:req.body.matrixName,fillParent:req.body.fillParent==='yes'
    }}});
    res.redirect(303,variantPath+'/'+req.params.id);
  }));
  router.get('/imports/uploads/:id',asyncRoute(async(req,res)=>{
    const upload=await sourceUploads.get(database,req.ctx.workspaceId,req.params.id);
    if(upload.ready)return res.redirect(303,upload.previewHref);
    return res.page('imports/source-upload',{title:'Reading '+upload.sourceName,nav:'imports',sourceUpload:upload,ownSectionTabs:true,suppressBack:true});
  }));
  router.get('/imports/uploads/:id/progress',asyncRoute(async(req,res)=>{
    res.set('Cache-Control','no-store');return res.json(await sourceUploads.get(database,req.ctx.workspaceId,req.params.id));
  }));
  router.post('/imports/uploads/:id/retry',asyncRoute(async(req,res)=>{
    try{await sourceUploads.retry(database,req.ctx,req.params.id);req.flash('success','File check queued from the saved source. Nothing is being imported.');}
    catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);}
    return res.redirect(303,'/imports/uploads/'+req.params.id);
  }));
  router.get('/imports/:id/progress',asyncRoute(async(req,res)=>{
    const state=await progress.get(database,req.ctx.workspaceId,req.params.id);
    res.set('Cache-Control','no-store');return res.json(state);
  }));
  router.get('/imports/:id/revision-progress',asyncRoute(async(req,res)=>{
    await imports.get(database,req.ctx.workspaceId,req.params.id);
    res.set('Cache-Control','no-store');return res.json(await require('../../imports/postgres-preview-revisions').latest(database,req.ctx.workspaceId,req.params.id));
  }));
  router.post('/imports',asyncRoute(async(req,res)=>{
    const wantsJson=String(req.get('accept') || '').includes('application/json');
    const files=(req.files || []).filter((entry)=>['file','files'].includes(entry.field));
    const pasted=trimOrNull(req.body.pasted);
    if(files.length>1)throw new ValidationError('Choose one business file at a time so each preview can be reconciled independently.');
    const file=files[0] || null;
    if(!file && !pasted)throw new ValidationError('Choose a file, or paste your data.');
    const source=file?.buffer||Buffer.from(pasted,'utf8');const sourceHash=crypto.createHash('sha256').update(source).digest('hex');
    // File uploads are durable even when submitted by an older open browser
    // tab. They must not depend on refreshed markup or a JavaScript header.
    if(file||req.body.prepareAsync==='yes'||String(req.get('prefer')||'').includes('respond-async')){
      const upload=await sourceUploads.enqueue(database,req.ctx,{buffer:file?.buffer,text:file?undefined:pasted,filename:file?.filename,
        readingMode:trimOrNull(req.body.readingMode),
        requestKey:trimOrNull(req.body.uploadKey),defaultLocationId:trimOrNull(req.body.defaultLocationId),
        usageKey:require('../../imports/usage-key').analysisUsageKey(sourceHash,req.body.usageKey)});
      if(wantsJson)return res.status(202).json({ok:true,location:upload.href});
      return res.redirect(303,upload.href);
    }
    const plan=await imports.analyse(database,req.ctx,{buffer:file?.buffer,text:file?undefined:pasted,
      filename:file?.filename,defaultLocationId:trimOrNull(req.body.defaultLocationId),provider,
      usageKey:require('../../imports/usage-key').analysisUsageKey(sourceHash,req.body.usageKey)});
    if(wantsJson)return res.status(201).json({ok:true,location:`/imports/${plan.id}`});
    return res.redirect(303,`/imports/${plan.id}`);
  }));
  router.get('/imports/:id/source',asyncRoute(async(req,res)=>{
    const plan=await imports.get(database,req.ctx.workspaceId,req.params.id),source=(await database.query('SELECT source_hash,source_content FROM import_source_snapshots WHERE workspace_id=$1 AND import_id=$2',[req.ctx.workspaceId,plan.id])).rows[0];
    if(!source||crypto.createHash('sha256').update(source.source_content).digest('hex')!==plan.sourceHash||source.source_hash!==plan.sourceHash)throw new ValidationError('The original source is unavailable or failed its integrity check. Upload the original again before approving.');
    const b=source.source_content,pdf=b.subarray(0,5).toString()==='%PDF-',png=b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),jpeg=b[0]===255&&b[1]===216,codec=require('../../imports/image-codecs').kind(b),kind=codec?[codec==='heic'?'image/heic':'image/tiff',codec]:pdf?['application/pdf','pdf']:png?['image/png','png']:jpeg?['image/jpeg','jpg']:['application/octet-stream','bin'];
    res.set({'Content-Type':kind[0],'Content-Disposition':(pdf||png||jpeg?'inline':'attachment')+'; filename="original-source.'+kind[1]+'"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Referrer-Policy':'no-referrer'});res.send(b);
  }));
  async function renderPreview(req,res,{reviewError=null}={}){
    const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
    if(req.method==='GET'&&!reviewError&&req.query.review!=='draft'&&plan.status==='READY'&&plan.approvalStatus==='AWAITING_APPROVAL'&&plan.planVersion===1){
      const approved=(await database.query(`SELECT id FROM import_plans WHERE workspace_id=$1 AND source_hash=$2 AND id<>$3
        AND approval_status='APPROVED' AND records_invalid=0 AND records_valid>0 AND status IN ('READY','SUCCEEDED')
        AND source_kind=$4 AND sheet_index=$5 AND records_detected=$6 AND default_location_id IS NOT DISTINCT FROM $7
        AND COALESCE(transformations::jsonb->>'dataset','inventory')=$8
        ORDER BY CASE WHEN status='SUCCEEDED' THEN 0 ELSE 1 END,approved_at DESC,created_at DESC,id DESC LIMIT 1`,[req.ctx.workspaceId,plan.sourceHash,plan.id,plan.sourceKind,plan.sheetIndex,plan.recordsDetected,plan.defaultLocationId,plan.transformations.dataset||'inventory'])).rows[0];
      if(approved){req.flash('success','You already approved this file. Showing its saved import and current progress. The separate unapproved draft is still saved.');return res.redirect(303,'/imports/'+encodeURIComponent(approved.id)+'?fromDraft='+encodeURIComponent(plan.id)+'#main');}
    }
    const draftId=typeof req.query.fromDraft==='string'&&/^imp_[a-z0-9]{1,128}$/.test(req.query.fromDraft)?req.query.fromDraft:null;
    const relatedDraft=draftId?(await database.query("SELECT id FROM import_plans WHERE workspace_id=$1 AND id=$2 AND source_hash=$3 AND approval_status='AWAITING_APPROVAL' AND status='READY'",[req.ctx.workspaceId,draftId,plan.sourceHash])).rows[0]||null:null;
    const page=Math.max(1,Number(req.query.page)||1);
    const allowed=['VALID','INVALID','EXCLUDED','SKIPPED','IMPORTED','FAILED'];
    const filter=allowed.includes(req.query.rows)?req.query.rows:null;
    const savedSummary=require('../../imports/tracking-review').savedSummary(plan);
    const frozenPreview=plan.status==='READY'&&['AWAITING_APPROVAL','APPROVED'].includes(plan.approvalStatus)&&plan.recordsValid+plan.recordsInvalid===plan.recordsDetected;
    const [rows,counts,duplicatePlans,run,locationRows,sampleRows,missingLocation,missingAccounting]=await Promise.all([
      imports.rowsFor(database,req.ctx.workspaceId,plan.id,{status:filter,limit:PAGE_SIZE,offset:(page-1)*PAGE_SIZE}),
      frozenPreview?Promise.resolve(Object.fromEntries([['VALID',plan.recordsValid],['INVALID',plan.recordsInvalid]].filter(([,count])=>count>0))):imports.counts(database,req.ctx.workspaceId,plan.id),imports.duplicates(database,req.ctx.workspaceId,plan),
      imports.report(database,req.ctx.workspaceId,plan.id),locations(database,req.ctx.workspaceId),
      imports.rowsFor(database,req.ctx.workspaceId,plan.id,{limit:8,offset:0}),
      savedSummary&&Number.isSafeInteger(savedSummary.missingLocationRows)&&savedSummary.missingLocationRows>=0
        ?Promise.resolve({rows:savedSummary.missingLocationRows?[{}]:[]}):plan.status==='READY'&&!plan.defaultLocationId&&plan.recordsInvalid>0
        ?database.query(`SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2
          AND status='INVALID' AND problems::jsonb @> '[{"code":"no_location"}]'::jsonb LIMIT 1`,
        [req.ctx.workspaceId,plan.id]):Promise.resolve({rows:[]}),
      plan.status==='READY'&&plan.recordsInvalid>0?database.query(`SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='INVALID' AND problems::jsonb @> '[{"code":"accounting_not_ready"}]'::jsonb LIMIT 1`,[req.ctx.workspaceId,plan.id]):Promise.resolve({rows:[]}),
    ]);
    const mappingRows=plan.sourceColumns.map((column)=>({index:column.index,column:column.name,
      field:Object.keys(plan.fieldMappings).find((key)=>plan.fieldMappings[key]===column.index) || null,
      samples:[...new Set(sampleRows.map((row)=>String(row.raw?.[column.index]??'').trim())
        .filter(Boolean))].slice(0,3).map((value)=>value.slice(0,80))}));
    const [runJob,importProgress,trackingQuestion,previewRevision,receivingReceipt]=await Promise.all([importJob(database,req.ctx.workspaceId,plan.id),progress.get(database,req.ctx.workspaceId,plan.id),
      require('../../imports/tracking-review').read(database,req.ctx.workspaceId,plan),require('../../imports/postgres-preview-revisions').latest(database,req.ctx.workspaceId,plan.id),
      database.query("SELECT result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='purchase_order.receive' AND idempotency_key=$2 AND status='COMPLETED'",[req.ctx.workspaceId,'receiving-document:'+plan.sourceHash]).then(r=>r.rows[0]?.result||null)]);
    const approvalReview=require('../../imports/approval-review').review(plan,{trackingQuestion,previewRevision,duplicatePlans,receivingReceipt,
      missingLocationRows:missingLocation.rows.length>0,missingAccountingSetup:missingAccounting.rows.length>0,
      needsNumberAnswer:plan.fieldMappings.quantity===undefined&&!plan.transformations.confirmCatalogOnly&&mappingRows.some(row=>(plan.transformations.unmappedNumericColumns||[]).includes(row.column))});
    if(receivingReceipt)return res.page('imports/receiving-source',{title:'Recorded delivery document',nav:'purchasing',plan,rows,page,pageSize:PAGE_SIZE,receivingReceipt,
      backTo:{href:'/purchasing/orders/'+receivingReceipt.purchaseOrderId,label:'Purchase order'}});
    const receivingCandidate=req.user?.role==='owner'&&plan.status==='READY'&&plan.approvalStatus==='AWAITING_APPROVAL'&&
      plan.transformations.dataset!=='suppliers'&&(!plan.transformations.handwriting||plan.transformations.handwriting.purpose==='delivery');
    const receivingPolicy=require('../../commercial/agent-plan');
    const receivingState=receivingCandidate?await receivingPolicy.accountState(database,req.ctx.workspaceId):null;
    const receivingOffer=receivingState&&receivingPolicy.usesAgentTerms(receivingState)?{
      allowed:receivingPolicy.permits(receivingState.plan,43,'draft'),
      needsReading:(plan.sourceKind==='image'||plan.transformations.visualSource)&&!plan.transformations.imageReadingConfirmed
    }:null;
    return res.page(plan.transformations.dataset==='suppliers'?'imports/supplier-preview':'imports/postgres-preview',
      {title:`Import ${plan.sourceName}`,nav:'imports',ownSectionTabs:true,suppressBack:true,plan,rows,counts,analysisNoticeMessage:require('../../imports/analysis-notice').message(),
      columnAccess:plan.transformations.columnTemplate?await require('../../imports/agent-column-mapping').access(database,req.ctx):null,
      duplicatePlans,run,locations:locationRows,mappingRows,fieldOptions:fields.FIELDS,page,pageSize:PAGE_SIZE,filter,relatedDraft,
      missingLocationRows:missingLocation.rows.length>0,
      missingLocationCount:savedSummary&&Number.isSafeInteger(savedSummary.missingLocationRows)?savedSummary.missingLocationRows:null,
      missingAccountingSetup:missingAccounting.rows.length>0,
      locationKinds:require('../../domain/constants').LOCATION_KINDS,runJob,importProgress,trackingQuestion,previewRevision,reviewError,approvalReview,receivingOffer,
    });
  }
  router.get('/imports/:id',asyncRoute((req,res)=>renderPreview(req,res)));
  router.post('/imports/:id/receiving-form',requireOwner,asyncRoute(async(req,res)=>{
    await require('../../commercial/agent-plan').requireWorkspaceJob(database,req.ctx.workspaceId,43,'draft');
    const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
    if(plan.transformations.dataset==='suppliers'||plan.transformations.handwriting&&plan.transformations.handwriting.purpose!=='delivery')
      throw new ValidationError('Choose an original supplier delivery-note preview.');
    if(plan.transformations.handwriting)await require('../../imports/handwritten-table').authorize(database,req.ctx);
    const ref=typeof req.body.purchaseOrder==='string'?req.body.purchaseOrder.trim().replace(/^#/,''):'';const orders=(await database.query('SELECT po_number FROM purchase_orders WHERE workspace_id=$1 AND (id=$2 OR lower(po_number)=lower($2)) LIMIT 2',[req.ctx.workspaceId,ref])).rows;if(orders.length!==1)throw new ValidationError('Enter one exact purchase order number from this inventory.');
    const p=await require('../../assistant/postgres-service').prepareAction(database,req.ctx,'Prepare the receiving form from this reviewed original delivery note',{action:'purchase_order.receive_from_document',recordReference:orders[0].po_number,sourceImport:plan.id,receivingBasis:req.body.receivingBasis});
    if(!p.proposal?.id)throw new ValidationError(p.answer||'Choose the exact placed purchase order and the written quantity units.');return res.redirect(303,'/actions/'+p.proposal.id);
  }));
  router.post('/imports/:id/previous-mapping',asyncRoute(async(req,res)=>{
    await require('../../imports/agent-column-mapping').apply(database,req.ctx,req.params.id,req.body);
    req.flash('success','The earlier column mapping was submitted for this preview. Review the updated rows before importing.');
    return res.redirect(303,'/imports/'+req.params.id);
  }));
  router.post('/imports/:id/reanalyse',asyncRoute(async(req,res)=>{
    const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
    if(plan.status!=='READY'||plan.approvalStatus!=='AWAITING_APPROVAL'||req.body.integrityHash!==plan.integrityHash)
      throw new ValidationError('This preview changed or was approved. Reopen it before reading its source again.');
    const source=(await database.query(`SELECT source_hash,source_content FROM import_source_snapshots
      WHERE workspace_id=$1 AND import_id=$2`,[req.ctx.workspaceId,plan.id])).rows[0];
    if(!source)throw new ValidationError('This older preview has no saved original file. Upload it again to prepare a new preview.');
    if(crypto.createHash('sha256').update(source.source_content).digest('hex')!==source.source_hash||source.source_hash!==plan.sourceHash)
      throw new ValidationError('The saved source failed its integrity check. Nothing was imported.');
    const selected=String(req.body.sheetIndex??'');
    if(selected!==''&&(!/^\d+$/.test(selected)||Number(selected)>=plan.transformations.sheetCount))
      throw new ValidationError('Choose an actual worksheet from this source.');
    const revised=await imports.analyse(database,req.ctx,{buffer:source.source_content,filename:plan.sourceName,
      ...(selected!==''?{sheetIndex:Number(selected),allowModel:false}:{}),
      sourceContext:plan.transformations.sourceContext,provider,
      usageKey:require('../../imports/usage-key').analysisUsageKey(plan.sourceHash)});
    return res.redirect(303,`/imports/${revised.id}`);
  }));
  router.post('/imports/:id/location',asyncRoute(async(req,res)=>{
    try{await require('../../imports/postgres-inline-location').create(database,req.ctx,req.params.id,{name:req.body.name,kind:req.body.kind,expectedHash:req.body.integrityHash});req.flash('success','Location added and selected. Review the updated preview before importing.');}
    catch(error){if(!(error instanceof ValidationError))throw error;res.status(error.status||400);return renderPreview(req,res,{reviewError:error.message});}
    return res.redirect(303,'/imports/'+req.params.id+'#import-approval-review');
  }));
  router.post('/imports/:id/revise',asyncRoute(async(req,res)=>{
    try{
      const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
      const locationMappings=Object.fromEntries([...plan.conflicts.map((conflict,index)=>
        [conflict.text,trimOrNull(req.body[`location_${index}`])]),...(plan.transformations.proposedLocations||[]).map((row,index)=>
        [row.source,trimOrNull(req.body[`new_location_${index}_match`])])].filter((entry)=>entry[1]));
      const quantityOverrides=Object.fromEntries(Object.entries(req.body).filter(([key,value])=>
        /^quantity_\d+$/.test(key)&&trimOrNull(value)).map(([key,value])=>[key.slice(9),String(value).trim()]));
      const codeOverrides=Object.fromEntries(Object.entries(req.body).filter(([key])=>/^image_code_\d+$/.test(key)).map(([key,value])=>[key.slice(11),String(value).trim()]));
      const imageCellOverrides={};for(const [key,value] of Object.entries(req.body)){const m=key.match(/^image_cell_(\d+)_(\d+)$/);if(m)(imageCellOverrides[m[1]]||={})[m[2]]=String(value);}
      const moneyOverrides={};for(const [key,value] of Object.entries(req.body)){const m=key.match(/^image_money_(unitCost|sellingPrice)_(\d+)$/);if(m)(moneyOverrides[m[2]]||={})[m[1]]=String(value).trim();}
      const hasFieldMappings=plan.sourceColumns.some((column)=>
        Object.hasOwn(req.body,`mapping_${column.index}`));
      const choices=hasFieldMappings?plan.sourceColumns
        .map((column)=>[trimOrNull(req.body[`mapping_${column.index}`]),column.index])
        .filter(([field])=>field):[];
      if(new Set(choices.map(([field])=>field)).size!==choices.length)
        throw new ValidationError('Two source columns cannot have the same import meaning.');
      const fieldMappings=hasFieldMappings?Object.fromEntries(choices):undefined;
      const revision=await require('../../imports/postgres-preview-revisions').queue(database,req.ctx,plan.id,{expectedHash:trimOrNull(req.body.integrityHash),
        proposedLocations:Object.fromEntries((plan.transformations.proposedLocations||[]).map((row,index)=>[row.source,{
          name:trimOrNull(req.body[`new_location_${index}_name`])||row.name,
          kind:trimOrNull(req.body[`new_location_${index}_kind`])||row.kind,
        }])),
        locationMappings,quantityOverrides,documentRowRoles:Object.fromEntries(Object.entries(req.body).filter(([key,value])=>/^document_role_\d+$/.test(key)&&value).map(([key,value])=>[key.slice(14),value])),fieldMappings,...(Object.keys(codeOverrides).length?{codeOverrides}:{}),...(Object.keys(moneyOverrides).length?{moneyOverrides}:{}),confirmImageReading:req.body.confirmImageReading==='yes',
        ...(Object.keys(imageCellOverrides).length?{imageCellOverrides}:{}),
        ...(req.body.confirmImageReading==='yes'?{reviewedRowNumbers:[...new Set([...Object.keys(codeOverrides),...Object.keys(imageCellOverrides)])]}:{}),
        trackingReview:Object.hasOwn(req.body,'tracking_serial')||Object.hasOwn(req.body,'tracking_lot')
          ?Object.fromEntries(['serial','lot'].filter(mode=>Object.hasOwn(req.body,'tracking_'+mode)).map(mode=>[mode,req.body['tracking_'+mode]])):undefined,
        confirmTrackingChange:req.body.confirmTrackingChange==='yes',
        defaultLocationId:Object.hasOwn(req.body,'defaultLocationId')?trimOrNull(req.body.defaultLocationId):undefined,
        confirmCatalogOnly:Object.hasOwn(req.body,'confirmCatalogOnly')?req.body.confirmCatalogOnly==='yes':undefined,
        confirmWorksheetScope:Object.hasOwn(req.body,'confirmWorksheetScope')?req.body.confirmWorksheetScope==='yes':undefined,
        importMode:Object.hasOwn(req.body,'importMode')?req.body.importMode:undefined,
        allowPartialImport:Object.hasOwn(req.body,'allowPartialImport')?req.body.allowPartialImport==='yes':undefined});
      req.flash('success',revision.queued?'Preview update saved. You can leave this page and return to its progress. No stock or value is being imported.':revision.plan.revisionUnchanged?'Those tracking choices are already in effect. No recalculation was needed. Missing serial or lot identifiers still need to be supplied before import.':'Preview corrected and recalculated. Review all rows again before approving.');
    }catch(error){if(!(error instanceof ValidationError))throw error;res.status(error.status||400);return renderPreview(req,res,{reviewError:error.message});}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/approve-and-run',asyncRoute(async(req,res)=>{
    try{const result=await imports.approveAndQueue(database,req.ctx,req.params.id,trimOrNull(req.body.integrityHash));
      req.flash('success',result.created?'Approved and queued. You can leave this page and return to the saved progress.':'This approved import is already queued or completed.');
    }catch(error){if(!(error instanceof ValidationError))throw error;res.status(error.status||400);return renderPreview(req,res,{reviewError:error.message});}
    return res.redirect(303,'/imports/'+req.params.id);
  }));
  router.post('/imports/:id/approve',asyncRoute(async(req,res)=>{
    try {await imports.approve(database,req.ctx,req.params.id,trimOrNull(req.body.integrityHash));
      req.flash('success','Preview approved. Nothing has been created yet.');}
    catch(error){if(!(error instanceof ValidationError))throw error;res.status(error.status||400);return renderPreview(req,res,{reviewError:error.message});}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/run',asyncRoute(async(req,res)=>{
    try {
      const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
      const queued=await imports.queueExecution(database,req.ctx,plan.id,trimOrNull(req.body.integrityHash)||plan.integrityHash);
      req.flash('success',queued.created?'Import queued. You can leave this page; progress and the verified result are saved here.':'This import is already queued. StockChief will not create a second run.');
    } catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/retry',asyncRoute(async(req,res)=>{
    try{
      const queued=await imports.retryExecution(database,req.ctx,req.params.id,trimOrNull(req.body.integrityHash),trimOrNull(req.body.executionId));
      req.flash('success',queued.created?'Retry queued for the same approved file. No second copy will be started.':'That retry is already saved.');
    }catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/cancel',asyncRoute(async(req,res)=>{
    await imports.cancel(database,req.ctx,req.params.id);req.flash('success','Import cancelled. No inventory changed.');
    return res.redirect(303,'/imports');
  }));
  return router;
}

module.exports={createPostgresImportsRouter};

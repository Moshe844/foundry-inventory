'use strict';

const crypto=require('node:crypto');
const express=require('express');
const imports=require('../../imports/postgres-service');
const progress=require('../../imports/postgres-progress');
const fields=require('../../imports/fields');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const config=require('../../config');
const { requireAuth,asyncRoute }=require('../middleware');
const { newId,trimOrNull }=require('../../lib/util');
const { ValidationError }=require('../../domain/errors');

const PAGE_SIZE=50;

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
  async function renderStart(req,res){return res.page('imports/start',{
    title:'File imports and results',nav:'imports',recent:await progress.list(database,req.ctx.workspaceId,{limit:20}),
    locations:await locations(database,req.ctx.workspaceId),aiConfigured:Boolean(provider||config.ai.configured),canOperate:true,
    usageKey:newId('importpreview'),uploadLimitBytes:config.uploads.maxBytes,
  });}
  router.get('/imports/start',asyncRoute(renderStart));
  router.get('/imports',asyncRoute(renderStart));
  router.get('/imports/:id/progress',asyncRoute(async(req,res)=>{
    const state=await progress.get(database,req.ctx.workspaceId,req.params.id);
    res.set('Cache-Control','no-store');return res.json(state);
  }));
  router.post('/imports',asyncRoute(async(req,res)=>{
    const wantsJson=String(req.get('accept') || '').includes('application/json');
    const files=(req.files || []).filter((entry)=>['file','files'].includes(entry.field));
    const pasted=trimOrNull(req.body.pasted);
    if(files.length>1)throw new ValidationError('Choose one business file at a time so each preview can be reconciled independently.');
    const file=files[0] || null;
    if(!file && !pasted)throw new ValidationError('Choose a file, or paste your data.');
    const source=file?.buffer||Buffer.from(pasted,'utf8');const sourceHash=crypto.createHash('sha256').update(source).digest('hex');
    const plan=await imports.analyse(database,req.ctx,{buffer:file?.buffer,text:file?undefined:pasted,
      filename:file?.filename,defaultLocationId:trimOrNull(req.body.defaultLocationId),provider,
      usageKey:require('../../imports/usage-key').analysisUsageKey(sourceHash,req.body.usageKey)});
    if(wantsJson)return res.status(201).json({ok:true,location:`/imports/${plan.id}`});
    return res.redirect(303,`/imports/${plan.id}`);
  }));
  async function renderPreview(req,res,{reviewError=null}={}){
    const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
    const page=Math.max(1,Number(req.query.page)||1);
    const allowed=['VALID','INVALID','IMPORTED','FAILED'];
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
    const [runJob,importProgress,trackingQuestion]=await Promise.all([importJob(database,req.ctx.workspaceId,plan.id),progress.get(database,req.ctx.workspaceId,plan.id),
      require('../../imports/tracking-review').read(database,req.ctx.workspaceId,plan)]);
    return res.page(plan.transformations.dataset==='suppliers'?'imports/supplier-preview':'imports/postgres-preview',
      {title:`Import ${plan.sourceName}`,nav:'imports',plan,rows,counts,
      duplicatePlans,run,locations:locationRows,mappingRows,fieldOptions:fields.FIELDS,page,pageSize:PAGE_SIZE,filter,
      missingLocationRows:missingLocation.rows.length>0,
      missingAccountingSetup:missingAccounting.rows.length>0,
      locationKinds:require('../../domain/constants').LOCATION_KINDS,runJob,importProgress,trackingQuestion,reviewError,
    });
  }
  router.get('/imports/:id',asyncRoute((req,res)=>renderPreview(req,res)));
  router.post('/imports/:id/revise',asyncRoute(async(req,res)=>{
    try{
      const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
      const locationMappings=Object.fromEntries([...plan.conflicts.map((conflict,index)=>
        [conflict.text,trimOrNull(req.body[`location_${index}`])]),...(plan.transformations.proposedLocations||[]).map((row,index)=>
        [row.source,trimOrNull(req.body[`new_location_${index}_match`])])].filter((entry)=>entry[1]));
      const quantityOverrides=Object.fromEntries(Object.entries(req.body).filter(([key,value])=>
        /^quantity_\d+$/.test(key)&&trimOrNull(value)).map(([key,value])=>[key.slice(9),String(value).trim()]));
      const codeOverrides=Object.fromEntries(Object.entries(req.body).filter(([key])=>/^image_code_\d+$/.test(key)).map(([key,value])=>[key.slice(11),String(value).trim()]));
      const moneyOverrides={};for(const [key,value] of Object.entries(req.body)){const m=key.match(/^image_money_(unitCost|sellingPrice)_(\d+)$/);if(m)(moneyOverrides[m[2]]||={})[m[1]]=String(value).trim();}
      const hasFieldMappings=plan.sourceColumns.some((column)=>
        Object.hasOwn(req.body,`mapping_${column.index}`));
      const choices=hasFieldMappings?plan.sourceColumns
        .map((column)=>[trimOrNull(req.body[`mapping_${column.index}`]),column.index])
        .filter(([field])=>field):[];
      if(new Set(choices.map(([field])=>field)).size!==choices.length)
        throw new ValidationError('Two source columns cannot have the same import meaning.');
      const fieldMappings=hasFieldMappings?Object.fromEntries(choices):undefined;
      await imports.revise(database,req.ctx,plan.id,{expectedHash:trimOrNull(req.body.integrityHash),
        proposedLocations:Object.fromEntries((plan.transformations.proposedLocations||[]).map((row,index)=>[row.source,{
          name:trimOrNull(req.body[`new_location_${index}_name`])||row.name,
          kind:trimOrNull(req.body[`new_location_${index}_kind`])||row.kind,
        }])),
        locationMappings,quantityOverrides,documentRowRoles:Object.fromEntries(Object.entries(req.body).filter(([key,value])=>/^document_role_\d+$/.test(key)&&value).map(([key,value])=>[key.slice(14),value])),fieldMappings,...(Object.keys(codeOverrides).length?{codeOverrides}:{}),...(Object.keys(moneyOverrides).length?{moneyOverrides}:{}),confirmImageReading:req.body.confirmImageReading==='yes',
        trackingReview:Object.hasOwn(req.body,'tracking_serial')||Object.hasOwn(req.body,'tracking_lot')
          ?Object.fromEntries(['serial','lot'].filter(mode=>Object.hasOwn(req.body,'tracking_'+mode)).map(mode=>[mode,req.body['tracking_'+mode]])):undefined,
        confirmTrackingChange:req.body.confirmTrackingChange==='yes',
        defaultLocationId:Object.hasOwn(req.body,'defaultLocationId')?trimOrNull(req.body.defaultLocationId):undefined,
        confirmCatalogOnly:Object.hasOwn(req.body,'confirmCatalogOnly')?req.body.confirmCatalogOnly==='yes':undefined,
        confirmWorksheetScope:Object.hasOwn(req.body,'confirmWorksheetScope')?req.body.confirmWorksheetScope==='yes':undefined,
        importMode:Object.hasOwn(req.body,'importMode')?req.body.importMode:undefined,
        allowPartialImport:Object.hasOwn(req.body,'allowPartialImport')?req.body.allowPartialImport==='yes':undefined});
      req.flash('success','Preview corrected and recalculated. Review all rows again before approving.');
    }catch(error){if(!(error instanceof ValidationError))throw error;res.status(error.status||400);return renderPreview(req,res,{reviewError:error.message});}
    return res.redirect(303,`/imports/${req.params.id}`);
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

'use strict';

const crypto=require('node:crypto');
const express=require('express');
const imports=require('../../imports/postgres-service');
const fields=require('../../imports/fields');
const entitlements=require('../../entitlements/postgres-service');
const commercialControl=require('../../commercial/control-service');
const config=require('../../config');
const { requireAuth,asyncRoute }=require('../middleware');
const { newId,trimOrNull }=require('../../lib/util');
const { ValidationError }=require('../../domain/errors');

const PAGE_SIZE=50;

async function locations(database,workspaceId){
  return (await database.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND is_active=1 ORDER BY name,id`,
    [workspaceId])).rows;
}

function createPostgresImportsRouter(database,{provider=null}={}){
  const router=express.Router();
  router.use('/imports',requireAuth);
  async function renderStart(req,res){return res.page('imports/start',{
    title:'Bring your data in',nav:'imports',recent:await imports.list(database,req.ctx.workspaceId,10),
    locations:await locations(database,req.ctx.workspaceId),aiConfigured:Boolean(provider||config.ai.configured),canOperate:true,
    usageKey:newId('importpreview'),
  });}
  router.get('/imports/start',asyncRoute(renderStart));
  router.get('/imports',asyncRoute(renderStart));
  router.post('/imports',asyncRoute(async(req,res)=>{
    const wantsJson=String(req.get('accept') || '').includes('application/json');
    const files=(req.files || []).filter((entry)=>['file','files'].includes(entry.field));
    const pasted=trimOrNull(req.body.pasted);
    if(files.length>1)throw new ValidationError('Choose one inventory file at a time so each preview can be reconciled independently.');
    const file=files[0] || null;
    if(!file && !pasted)throw new ValidationError('Choose a file, or paste your data.');
    const source=file?.buffer||Buffer.from(pasted,'utf8');const sourceHash=crypto.createHash('sha256').update(source).digest('hex');
    const plan=await imports.analyse(database,req.ctx,{buffer:file?.buffer,text:file?undefined:pasted,
      filename:file?.filename,defaultLocationId:trimOrNull(req.body.defaultLocationId),provider,
      usageKey:require('../../imports/usage-key').analysisUsageKey(sourceHash,req.body.usageKey)});
    if(wantsJson)return res.status(201).json({ok:true,location:`/imports/${plan.id}`});
    return res.redirect(303,`/imports/${plan.id}`);
  }));
  router.get('/imports/:id',asyncRoute(async(req,res)=>{
    const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
    const page=Math.max(1,Number(req.query.page)||1);
    const allowed=['VALID','INVALID','IMPORTED','FAILED'];
    const filter=allowed.includes(req.query.rows)?req.query.rows:null;
    const [rows,counts,duplicatePlans,run,locationRows]=await Promise.all([
      imports.rowsFor(database,req.ctx.workspaceId,plan.id,{status:filter,limit:PAGE_SIZE,offset:(page-1)*PAGE_SIZE}),
      imports.counts(database,req.ctx.workspaceId,plan.id),imports.duplicates(database,req.ctx.workspaceId,plan),
      imports.report(database,req.ctx.workspaceId,plan.id),locations(database,req.ctx.workspaceId),
    ]);
    const mappingRows=plan.sourceColumns.map((column)=>({index:column.index,column:column.name,
      field:Object.keys(plan.fieldMappings).find((key)=>plan.fieldMappings[key]===column.index) || null}));
    return res.page('imports/postgres-preview',{title:`Import ${plan.sourceName}`,nav:'imports',plan,rows,counts,
      duplicatePlans,run,locations:locationRows,mappingRows,fieldOptions:fields.FIELDS,page,pageSize:PAGE_SIZE,filter,
    });
  }));
  router.post('/imports/:id/revise',asyncRoute(async(req,res)=>{
    try{
      const plan=await imports.get(database,req.ctx.workspaceId,req.params.id);
      const locationMappings=Object.fromEntries(plan.conflicts.map((conflict,index)=>
        [conflict.text,trimOrNull(req.body[`location_${index}`])]).filter((entry)=>entry[1]));
      const quantityOverrides=Object.fromEntries(Object.entries(req.body).filter(([key,value])=>
        /^quantity_\d+$/.test(key)&&trimOrNull(value)).map(([key,value])=>[key.slice(9),String(value).trim()]));
      const hasFieldMappings=plan.sourceColumns.some((column)=>
        Object.hasOwn(req.body,`mapping_${column.index}`));
      const choices=hasFieldMappings?plan.sourceColumns
        .map((column)=>[trimOrNull(req.body[`mapping_${column.index}`]),column.index])
        .filter(([field])=>field):[];
      if(new Set(choices.map(([field])=>field)).size!==choices.length)
        throw new ValidationError('Two source columns cannot have the same import meaning.');
      const fieldMappings=hasFieldMappings?Object.fromEntries(choices):undefined;
      await imports.revise(database,req.ctx,plan.id,{expectedHash:trimOrNull(req.body.integrityHash),
        locationMappings,quantityOverrides,fieldMappings,
        confirmCatalogOnly:req.body.confirmCatalogOnly==='yes'});
      req.flash('success','Preview corrected and recalculated. Review all rows again before approving.');
    }catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/approve',asyncRoute(async(req,res)=>{
    try {await imports.approve(database,req.ctx,req.params.id,trimOrNull(req.body.integrityHash));
      req.flash('success','Preview approved. Nothing has been created yet.');}
    catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/run',asyncRoute(async(req,res)=>{
    try {
      const result=await imports.execute(database,req.ctx,req.params.id);
      if(result.duplicate){req.flash('warning','This exact source was already imported. StockChief did not apply it again.');
        return res.redirect(303,`/imports/${result.planId}`);}
      req.flash('success',`Imported and verified ${result.rowsImported} rows and ${result.units} opening units.`);
    } catch(error){if(!(error instanceof ValidationError))throw error;req.flash('error',error.message);}
    return res.redirect(303,`/imports/${req.params.id}`);
  }));
  router.post('/imports/:id/cancel',asyncRoute(async(req,res)=>{
    await imports.cancel(database,req.ctx,req.params.id);req.flash('success','Import cancelled. No inventory changed.');
    return res.redirect(303,'/imports');
  }));
  return router;
}

module.exports={createPostgresImportsRouter};

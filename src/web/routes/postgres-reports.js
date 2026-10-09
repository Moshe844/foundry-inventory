'use strict';

const express=require('express');
const registry=require('../../reports/postgres-registry');
const reports=require('../../reports/postgres-service');
const reportExports=require('../../reports/exports');
const permissions=require('../../actions/permissions');
const {requireAuth,asyncRoute}=require('../middleware');
const {ValidationError}=require('../../domain/errors');

function source(body){
  if(body.definition){try{return JSON.parse(body.definition);}catch{throw new ValidationError('The report definition was invalid.');}}
  const dataset=registry.get(body.dataset);
  const rawColumns=Array.isArray(body.columns)?body.columns:body.columns?[body.columns]:[];
  const filters=[];
  for(const row of Object.values(body.filters||{}))if(row&&row.field&&(row.value||row.operator==='is_null'))filters.push(row);
  const groups=Array.isArray(body.groups)?body.groups.filter(Boolean):body.groups?[body.groups]:body.group?[body.group]:[];
  return {dataset:body.dataset,title:body.title||dataset?.label,columns:rawColumns,
    groups,dateGrain:body.dateGrain,aggregate:body.aggregate,measure:body.measure,
    filters,sort:body.sort,direction:body.direction,chart:body.chart};
}
async function actorFor(database,ctx){
  const row=(await database.query(`SELECT u.id,u.role,u.permissions,a.email FROM users u
    JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2`,
  [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new ValidationError('This inventory membership is unavailable.');
  return row;
}
function createPostgresReportsRouter(database){
  const router=express.Router();router.use('/reports',requireAuth);
  router.get('/reports',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const datasets=registry.list(actor),saved=await reports.list(database,req.ctx,actor);
    return res.page('reports/index',{title:'Reports',nav:'accounting',datasets,saved});
  }));
  router.get('/reports/from-ask/:interactionId',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const row=(await database.query(`SELECT intent->'reportConfig' AS definition
      FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
    [req.ctx.workspaceId,req.ctx.actorId,req.params.interactionId])).rows[0];
    if(!row?.definition)throw new ValidationError('That Ask report is unavailable.');
    const draft=reports.normalize(row.definition,actor);
    const datasets=registry.list(actor),dataset=datasets.find((entry)=>entry.key===draft.dataset);
    if(!dataset)throw new ValidationError('That report dataset is unavailable.');
    return res.page('reports/builder',{title:'Customize Ask report',nav:'accounting',
      datasets,dataset,saved:null,draft});
  }));
  router.get('/reports/builder',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const draft=req.query.draft==='1'&&req.session.reportDraft?.workspaceId===req.ctx.workspaceId
      ?reports.normalize(req.session.reportDraft.definition,actor):null;
    const datasets=registry.list(actor),key=String(draft?.dataset||req.query.dataset||datasets[0]?.key||'');
    const dataset=datasets.find((entry)=>entry.key===key);
    if(!dataset)return res.status(404).page('error',{title:'Dataset unavailable',status:404,
      message:'This report dataset is unavailable to your account.'});
    const saved=req.query.saved?await reports.load(database,req.ctx,actor,String(req.query.saved)):null;
    return res.page('reports/builder',{title:saved?'Edit report':'Build a report',nav:'accounting',
      datasets,dataset,saved,draft});
  }));
  router.post('/reports/run',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);const spec=source(req.body);
    const result=await reports.run(database,req.ctx,actor,spec,{limit:201});
    req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:result.config};
    return res.page('reports/result',{title:result.config.title,nav:'accounting',result,saved:null});
  }));
  router.post('/reports/drilldown',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    let values;try{values=JSON.parse(String(req.body.groupValues||''));}
    catch{throw new ValidationError('Choose a valid report group.');}
    const spec=reports.drilldownSpec(source(req.body),values,actor);
    const result=await reports.run(database,req.ctx,actor,spec,{limit:201});
    req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:result.config};
    return res.page('reports/result',{title:result.config.title,nav:'accounting',result,saved:null});
  }));
  router.post('/reports/save',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);permissions.assertCan(actor,permissions.VIEW,'save a report');
    const saved=await reports.save(database,req.ctx,actor,source(req.body),{
      id:req.body.id||null,schedule:{frequency:req.body.frequency,hour:req.body.hour,
        recipient:req.body.recipient||actor.email}});
    req.flash('success','Report template saved.');return res.redirect(303,`/reports/saved/${saved.id}`);
  }));
  router.get('/reports/saved/:id',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const saved=await reports.load(database,req.ctx,actor,req.params.id);
    const result=await reports.run(database,req.ctx,actor,saved.definition,{limit:201});
    return res.page('reports/result',{title:saved.title,nav:'accounting',result,saved});
  }));
  router.get('/reports/saved/:id/export.:format',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const saved=await reports.load(database,req.ctx,actor,req.params.id);
    const format=req.params.format;
    if(!['csv','xlsx','pdf'].includes(format))throw new ValidationError('That export format is unavailable.');
    const result=await reports.run(database,req.ctx,actor,saved.definition,{limit:5001});
    if(result.hasMore)throw new ValidationError('This export exceeds 5,000 rows. Narrow its filters first.');
    const output=await reportExports[format](result);
    const mime={csv:'text/csv; charset=utf-8',
      xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf'};
    res.set('Content-Type',mime[format]);
    res.set('Content-Disposition',`attachment; filename="stockchief-report-${saved.id}.${format}"`);
    res.set('Cache-Control','private, no-store');return res.send(output);
  }));
  return router;
}
module.exports={createPostgresReportsRouter};

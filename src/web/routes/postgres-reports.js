'use strict';

const express=require('express');
const registry=require('../../reports/postgres-registry');
const composed=require('../../reports/postgres-composed');
const reports=require('../../reports/postgres-service');
const reportExports=require('../../reports/exports');
const permissions=require('../../actions/permissions');
const {requireAuth,asyncRoute}=require('../middleware');
const {ValidationError}=require('../../domain/errors');

function source(body){
  if(body.definition){try{return JSON.parse(body.definition);}catch{throw new ValidationError('The report definition was invalid.');}}
  if(body.dataset==='composed')return {dataset:'composed',title:body.title,dimension:body.dimension,
    metrics:Object.values(body.metrics||{}).filter((row)=>row?.dataset).map((row)=>({
      alias:row.alias,dataset:row.dataset,aggregate:row.aggregate,measure:row.measure,
      filters:Object.values(row.filters||{}).filter((filter)=>filter?.field
        &&(filter.value||filter.operator==='is_null'))})),
    formula:body.formula,formulaLabel:body.formulaLabel,formulaUnit:body.formulaUnit,
    resultFilters:Object.values(body.resultFilters||{}).filter((filter)=>filter?.field
      &&(filter.value||['is_null','not_null'].includes(filter.operator))),
    chart:body.chart,chartMeasure:body.chartMeasure,sort:body.sort,
    direction:body.direction,layout:body.layout};
  const dataset=registry.get(body.dataset);
  const rawColumns=Array.isArray(body.columns)?body.columns:body.columns?[body.columns]:[];
  const filters=[];
  for(const row of Object.values(body.filters||{}))if(row&&row.field&&(row.value||row.operator==='is_null'))filters.push(row);
  const groups=Array.isArray(body.groups)?body.groups.filter(Boolean):body.groups?[body.groups]:body.group?[body.group]:[];
  return {dataset:body.dataset,title:body.title||dataset?.label,columns:rawColumns,
    groups,dateGrain:body.dateGrain,aggregate:body.aggregate,measure:body.measure,
    summary:body.summary==='on'||body.summary===true,
    filters,sort:body.sort,direction:body.direction,chart:body.chart,layout:body.layout};
}
function previewSchedule(body){
  const frequency=['none','daily','weekly'].includes(body.frequency)?body.frequency:'none';
  const hour=Number(body.hour);
  if(frequency!=='none'&&(body.hour==null||body.hour===''||!Number.isInteger(hour)
    ||hour<0||hour>23))throw new ValidationError('Choose a UTC delivery hour from 0 to 23.');
  return {frequency,hour:Number.isInteger(hour)&&hour>=0&&hour<24?hour:9};
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
    return res.page('reports/index',{title:'Reports',nav:'accounting',datasets,saved,
      compositions:composed.dimensions(actor)});
  }));
  router.get('/reports/from-ask/:interactionId',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const row=(await database.query(`SELECT intent->'reportConfig' AS definition
      FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
    [req.ctx.workspaceId,req.ctx.actorId,req.params.interactionId])).rows[0];
    if(!row?.definition)throw new ValidationError('That Ask report is unavailable.');
    const draft=reports.normalize(row.definition,actor);
    if(draft.dataset==='composed')return res.page('reports/compose',{title:'Customize Ask report',
      nav:'accounting',saved:null,draft,draftSchedule:null,
      dimensions:composed.dimensions(actor),dimension:composed.dimensions(actor)
        .find((entry)=>entry.key===draft.dimension)});
    const datasets=registry.list(actor),dataset=datasets.find((entry)=>entry.key===draft.dataset);
    if(!dataset)throw new ValidationError('That report dataset is unavailable.');
    return res.page('reports/builder',{title:'Customize Ask report',nav:'accounting',
      datasets,dataset,saved:null,draft,draftSchedule:null});
  }));
  router.get('/reports/from-ask/:interactionId/run',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const row=(await database.query(`SELECT intent->'reportConfig' AS definition
      FROM stockchief_runtime.assistant_interactions
      WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,
    [req.ctx.workspaceId,req.ctx.actorId,req.params.interactionId])).rows[0];
    if(!row?.definition)throw new ValidationError('That Ask report is unavailable.');
    const result=await reports.run(database,req.ctx,actor,row.definition,{limit:201});
    req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:result.config,schedule:null};
    req.session.reportParentDraft=null;
    return res.page('reports/result',{title:result.config.title,nav:'accounting',result,saved:null,
      pageHref:'/reports/run',draftSchedule:null,
      backTo:{href:'/ask',label:'Ask StockChief'}});
  }));
  router.get('/reports/builder',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const draft=req.query.draft==='1'&&req.session.reportDraft?.workspaceId===req.ctx.workspaceId
      ?reports.normalize(req.session.reportDraft.definition,actor):null;
    if(draft?.dataset==='composed'||req.query.dataset==='composed')
      return res.redirect(303,`/reports/compose${draft?'?draft=1':''}`);
    const draftSchedule=draft?req.session.reportDraft.schedule||null:null;
    const datasets=registry.list(actor),key=String(draft?.dataset||req.query.dataset||datasets[0]?.key||'');
    const dataset=datasets.find((entry)=>entry.key===key);
    if(!dataset)return res.status(404).page('error',{title:'Dataset unavailable',status:404,
      message:'This report dataset is unavailable to your account.'});
    const saved=req.query.saved?await reports.load(database,req.ctx,actor,String(req.query.saved)):null;
    return res.page('reports/builder',{title:saved?'Edit report':'Build a report',nav:'accounting',
      datasets,dataset,saved,draft,draftSchedule});
  }));
  router.get('/reports/compose',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx),dimensions=composed.dimensions(actor);
    const saved=req.query.saved?await reports.load(database,req.ctx,actor,String(req.query.saved)):null;
    if(saved&&saved.definition.dataset!=='composed')throw new ValidationError('That is not a combined report.');
    const draft=!saved&&req.query.draft==='1'&&req.session.reportDraft?.workspaceId===req.ctx.workspaceId
      ?reports.normalize(req.session.reportDraft.definition,actor):null;
    const selection=saved?.definition||draft;
    const dimension=dimensions.find((entry)=>entry.key===(req.query.dimension||selection?.dimension))||dimensions[0];
    if(!dimension)throw new ValidationError('No governed shared identifiers are available to this account.');
    return res.page('reports/compose',{title:saved?'Edit combined report':'Combine datasets',
      nav:'accounting',saved,draft,dimensions,dimension,
      draftSchedule:draft?req.session.reportDraft.schedule||null:null});
  }));
  router.get('/reports/run',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const detail=req.query.view==='detail';
    const prior=!detail&&req.session.reportParentDraft?.workspaceId===req.ctx.workspaceId
      ?req.session.reportParentDraft:req.session.reportDraft;
    if(prior?.workspaceId!==req.ctx.workspaceId)return res.redirect(303,'/reports');
    const result=await reports.run(database,req.ctx,actor,prior.definition,{limit:201,offset:req.query.offset});
    if(!detail){req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:result.config,
      schedule:prior.schedule||null};
      req.session.reportParentDraft=null;}
    return res.page('reports/result',{title:result.config.title,nav:'accounting',result,saved:null,
      pageHref:detail?'/reports/run?view=detail':'/reports/run',
      draftSchedule:prior.schedule||null,
      backTo:detail?{href:'/reports/run',label:'Report'}:{href:'/reports',label:'Reports'}});
  }));
  router.post('/reports/run',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);const spec=source(req.body);
    const result=await reports.run(database,req.ctx,actor,spec,{limit:201});
    const draftSchedule=previewSchedule(req.body);
    req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:result.config,schedule:draftSchedule};
    req.session.reportParentDraft=null;
    return res.page('reports/result',{title:result.config.title,nav:'accounting',result,saved:null,
      pageHref:'/reports/run',draftSchedule});
  }));
  router.post('/reports/drilldown',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    let values;try{values=JSON.parse(String(req.body.groupValues||''));}
    catch{throw new ValidationError('Choose a valid report group.');}
    const spec=reports.drilldownSpec(source(req.body),values,actor,req.body.sourceAlias||null);
    const result=await reports.run(database,req.ctx,actor,spec,{limit:201});
    const draftSchedule=req.session.reportDraft?.workspaceId===req.ctx.workspaceId
      ?req.session.reportDraft.schedule||null:null;
    req.session.reportParentDraft={workspaceId:req.ctx.workspaceId,
      definition:reports.normalize(source(req.body),actor),schedule:draftSchedule};
    req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:result.config,schedule:null};
    return res.redirect(303,'/reports/run?view=detail');
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
    const result=await reports.run(database,req.ctx,actor,saved.definition,{limit:201,offset:req.query.offset});
    return res.page('reports/result',{title:saved.title,nav:'accounting',result,saved,
      pageHref:`/reports/saved/${saved.id}`,draftSchedule:null});
  }));
  router.get('/reports/saved/:id/export.:format',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const saved=await reports.load(database,req.ctx,actor,req.params.id);
    const format=req.params.format;
    if(!['csv','xlsx','pdf'].includes(format))throw new ValidationError('That export format is unavailable.');
    if(format==='csv'){
      const total=await reports.countAtMost(database,req.ctx,actor,saved.definition,100000);
      if(total>100000)throw new ValidationError('This CSV exceeds 100,000 rows. Narrow its filters first.');
      res.set('Content-Type','text/csv; charset=utf-8');
      res.set('Content-Disposition',`attachment; filename="stockchief-report-${saved.id}.csv"`);
      res.set('Cache-Control','private, no-store');
      let offset=0,started=false;
      try{
        do{
          const page=await reports.run(database,req.ctx,actor,saved.definition,{limit:1001,offset});
          if(!started){res.write(reportExports.csvHeader(page));started=true;}
          if(page.rows.length){
            const wrote=res.write(reportExports.csvRows(page));
            if(!wrote)await new Promise((resolve)=>{const done=()=>{
              res.off('drain',done);res.off('close',done);resolve();};
              res.once('drain',done);res.once('close',done);});
          }
          offset+=page.rows.length;
          if(!page.hasMore||res.destroyed)break;
        }while(true);
        if(!res.destroyed)res.end();
      }catch(error){if(res.headersSent)res.destroy(error);else throw error;}
      return;
    }
    const limit=format==='xlsx'?20001:5001;
    const result=await reports.run(database,req.ctx,actor,saved.definition,{limit});
    if(result.hasMore)throw new ValidationError(`This ${format.toUpperCase()} export exceeds ${limit-1} rows. Narrow its filters first or use CSV.`);
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

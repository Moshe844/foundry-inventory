'use strict';

const express=require('express');
const registry=require('../../reports/postgres-registry');
const composed=require('../../reports/postgres-composed');
const reports=require('../../reports/postgres-service');
const builderEntry=require('../../reports/builder-entry');
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
function previewSchedule(body,defaultZone){return require('../../reports/local-schedule').normalize(body,defaultZone);}
async function actorFor(database,ctx){
  const row=(await database.query(`SELECT u.id,u.role,u.permissions,a.email FROM users u
    JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2`,
  [ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new ValidationError('This inventory membership is unavailable.');
  return row;
}
async function builderChoices(database,ctx,actor){
  const datasets=registry.list(actor),entitlements=require('../../commercial/entitlements');
  const needed=[...new Set(datasets.map(item=>registry.get(item.key)?.commercialCapability).filter(Boolean))];
  const scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);
  const states=needed.length?await entitlements.capabilityStates(database,scope,needed):new Map();
  return {datasets,unavailableSources:datasets.filter(item=>{
    const required=registry.get(item.key)?.commercialCapability;
    return required&&!states.get(required)?.enabled;
  }).map(item=>item.key)};
}
async function requireBuilderSource(database,ctx,key){
  const required=registry.get(key)?.commercialCapability;
  if(!required)return;
  const entitlements=require('../../commercial/entitlements');
  await entitlements.assertCapability(database,await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId),required);
}
function createPostgresReportsRouter(database){
  const router=express.Router();router.use('/reports',requireAuth,asyncRoute(async(req,res,next)=>{res.locals.reportBusinessTimeZone=(await require('../../lib/business-time').forWorkspace(database,req.ctx.workspaceId)).timeZone;res.locals.reportActionKey=require('../../lib/util').newId('report-action');res.locals.reportRelativePeriods=require('../../reports/relative-dates').periods;next();}));
  router.get('/reports',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const datasets=registry.list(actor),saved=await reports.list(database,req.ctx,actor),business=require('../../reports/business-reports'),businessContext=await business.context(database,req.ctx,req.query),businessCards=await business.cards(database,req.ctx,actor,req.query);
    return res.page('reports/index',{title:'Reports',nav:'accounting',datasets,saved,businessContext,businessCards,
      compositions:composed.dimensions(actor)});
  }));
  router.get('/reports/business/:key',asyncRoute(async(req,res)=>{const actor=await actorFor(database,req.ctx),report=await require('../../reports/business-reports').run(database,req.ctx,actor,req.params.key,req.query);return res.page('reports/business',{title:report.definition.title,nav:'accounting',room:true,report});}));
  router.get('/reports/business/:key/customize',asyncRoute(async(req,res)=>{const actor=await actorFor(database,req.ctx),report=await require('../../reports/business-reports').run(database,req.ctx,actor,req.params.key,req.query);req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition:report.result.config,schedule:req.query.weekly==='1'?{frequency:'weekly',hour:8,minute:0,weekday:1,timeZone:res.locals.reportBusinessTimeZone,recipient:actor.email}:null};return res.redirect(303,'/reports/builder?draft=1');}));
  router.get('/reports/business/:key/export.csv',asyncRoute(async(req,res)=>{const actor=await actorFor(database,req.ctx),report=await require('../../reports/business-reports').run(database,req.ctx,actor,req.params.key,req.query);if(await reports.countAtMost(database,req.ctx,actor,report.result.config,100000)>100000)throw new ValidationError('This export has more than 100,000 rows. Narrow the dates or filters before exporting.');res.set('Content-Type','text/csv; charset=utf-8');res.set('Content-Disposition','attachment; filename="stockchief-'+report.definition.key+'.csv"');res.set('Cache-Control','private, no-store');let offset=0,started=false;do{const part=await reports.run(database,req.ctx,actor,report.result.config,{limit:1001,offset});await require('../../reports/business-reports').enrich(database,req.ctx,report.definition.key,part);if(!started){res.write(reportExports.csvHeader(part));started=true;}res.write(reportExports.csvRows(part));offset+=part.rows.length;if(!part.hasMore)break;if(offset>=100000)break;}while(!res.destroyed);return res.end();}));
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
    await requireBuilderSource(database,req.ctx,draft.dataset);
    const {datasets,unavailableSources}=await builderChoices(database,req.ctx,actor),dataset=datasets.find((entry)=>entry.key===draft.dataset);
    if(!dataset)throw new ValidationError('That report dataset is unavailable.');
    return res.page('reports/builder',{title:'Customize Ask report',nav:'accounting',
      datasets,dataset,saved:null,draft,draftSchedule:null,builderEntry,unavailableSources});
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
  router.get('/reports/template/:key',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const chosen=builderEntry.template(req.params.key);
    if(!chosen)throw new ValidationError('Choose an available report starting point.');
    await requireBuilderSource(database,req.ctx,chosen.definition.dataset);
    const definition=reports.normalize({...chosen.definition,title:chosen.name},actor);
    req.session.reportDraft={workspaceId:req.ctx.workspaceId,definition,schedule:null};
    return res.redirect(303,'/reports/builder?draft=1');
  }));
  router.get('/reports/describe',asyncRoute(async(req,res)=>{
    const description=String(req.query.q||'').trim();
    if(!description)return res.redirect(303,'/reports/builder');
    if(description.length>1800)throw new ValidationError('Describe the report in 1,800 characters or fewer.');
    // This uses the existing metered and governed Ask path. The model proposes
    // a definition; only PostgreSQL supplies the resulting numbers.
    return res.redirect(303,'/ask?q='+encodeURIComponent('Build a custom report: '+description)+'&send=1');
  }));
  router.get('/reports/builder',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    const draft=req.query.draft==='1'&&req.session.reportDraft?.workspaceId===req.ctx.workspaceId
      ?reports.normalize(req.session.reportDraft.definition,actor):null;
    if(draft?.dataset==='composed'||req.query.dataset==='composed')
      return res.redirect(303,`/reports/compose${draft?'?draft=1':''}`);
    const draftSchedule=draft?req.session.reportDraft.schedule||null:null;
    const {datasets,unavailableSources}=await builderChoices(database,req.ctx,actor);
    const key=String(draft?.dataset||req.query.dataset||datasets.find(item=>!unavailableSources.includes(item.key))?.key||'');
    await requireBuilderSource(database,req.ctx,key);
    const dataset=datasets.find((entry)=>entry.key===key);
    if(!dataset)return res.status(404).page('error',{title:'Dataset unavailable',status:404,
      message:'This report dataset is unavailable to your account.'});
    const saved=req.query.saved?await reports.load(database,req.ctx,actor,String(req.query.saved)):null;
    return res.page('reports/builder',{title:saved?'Edit report':'Build a report',nav:'accounting',
      datasets,dataset,saved,draft,draftSchedule,builderEntry,unavailableSources});
  }));
  router.post('/reports/preview',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);
    try{
      const started=performance.now();
      const result=await reports.run(database,req.ctx,actor,source(req.body),{limit:31});
      return res.json({ok:true,columns:result.columns,labels:result.columnLabels,
        rows:result.displayRows,hasMore:result.hasMore,returned:result.rows.length,
        links:result.rows.map(row=>row.href||null),groups:result.config.groups,
        groupValues:result.config.groups.length?result.rows.map(row=>result.config.groups.map(key=>row[key])):[],
        definition:result.config,elapsedMs:Math.round(performance.now()-started)});
    }catch(error){
      if(error instanceof ValidationError)return res.status(422).json({ok:false,message:error.message});
      if(/statement timeout|canceling statement/i.test(String(error.message||'')))
        return res.status(422).json({ok:false,message:'This report is taking too long. Narrow the dates or add a filter and try again.'});
      throw error;
    }
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
    const draftSchedule=previewSchedule(req.body,res.locals.reportBusinessTimeZone);
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
    await new Promise((resolve,reject)=>req.session.save(error=>error?reject(error):resolve()));
    return res.redirect(303,'/reports/run?view=detail');
  }));
  router.post('/reports/save',asyncRoute(async(req,res)=>{
    const actor=await actorFor(database,req.ctx);permissions.assertCan(actor,permissions.VIEW,'save a report');
    const saved=await reports.save(database,req.ctx,actor,source(req.body),{
      id:req.body.id||null,expectedRevision:req.body.expectedRevision??null,schedule:{frequency:req.body.frequency,hour:req.body.hour,minute:req.body.minute,weekday:req.body.weekday,timeZone:req.body.timeZone||res.locals.reportBusinessTimeZone,recipient:req.body.recipient||actor.email}});
    req.flash('success','Report template saved.');return res.redirect(303,`/reports/saved/${saved.id}`);
  }));
  for(const [path,action]of [['send-now','send_now'],['pause','pause'],['resume','resume'],['delete','delete']])router.post('/reports/saved/:id/'+path,asyncRoute(async(req,res)=>{const actor=await actorFor(database,req.ctx);if(action==='delete'&&req.body.confirmed!=='yes')throw new ValidationError('Confirm deletion of this saved report.');const result=await require('../../reports/postgres-delivery-controls').change(database,req.ctx,actor,req.params.id,{...req.body,action});req.flash('success',action==='send_now'?(result.replayed?'That exact delivery is already queued or recorded.':'Report delivery queued to your account email.'):action==='delete'?'Saved report deleted; delivery history retained.':action==='pause'?'Future report delivery paused.':'Report delivery resumed.');if(result.alreadySending)req.flash('info',result.alreadySending+' email delivery is already in progress and may finish.');res.redirect(303,action==='delete'?'/reports':'/reports/saved/'+req.params.id);}));
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

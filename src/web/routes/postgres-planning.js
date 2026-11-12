'use strict';

const express = require('express');
const permissions = require('../../actions/permissions');
const planning = require('../../forecasting/postgres-planning-service');
const { requireAuth, requireOwner, requirePermission, asyncRoute } = require('../middleware');
const {requireCapability}=require('../commercial-middleware');
function selectedPosition(input){
  if(!input.position)return input;
  let pair;try{pair=JSON.parse(input.position);}catch{}
  if(!Array.isArray(pair)||pair.length!==2||!pair.every(id=>typeof id==='string'))throw new (require('../../domain/errors').ValidationError)('Choose a product and location.');
  return {...input,skuId:pair[0],locationId:pair[1]};
}

function createPostgresPlanningRouter(database) {
  const router = express.Router();
  router.use('/planning', requireAuth,requireCapability(database,'forecasting.basic'));
  router.get('/planning', asyncRoute(async (req, res) => {
    const agent=require('../../commercial/agent-plan');
    const [overview,state]=await Promise.all([planning.overview(database,req.ctx.workspaceId,{afterSkuId:req.query.after||null}),agent.accountState(database,req.ctx.workspaceId)]);
    const agentTerms=agent.usesAgentTerms(state),manageRules=agentTerms&&req.user.role==='owner'&&agent.permits(state.plan,120,'automatic',{trained:true});
    const rules=req.user.role==='owner'?(await database.query('SELECT sku_id,location_id,ceiling,revision,profile_key FROM stockchief_runtime.location_reorder_rules WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',
      [req.ctx.workspaceId,[...new Set(overview.rows.map(r=>r.sku_id))]])).rows:[];
    const safetyPreview=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,150,'draft');
    const safetyRoutine=safetyPreview&&req.user.role==='owner'&&agent.permits(state.plan,150,'automatic');
    const safetyRules=safetyRoutine?(await database.query(`SELECT r.location_id,r.class,r.service_level,l.name FROM stockchief_runtime.class_service_levels r
      JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id WHERE r.workspace_id=$1 ORDER BY l.name,r.class`,[req.ctx.workspaceId])).rows:[];
    const recommendations=agentTerms?overview.recommendations.filter(r=>r.kind!=='reorder_point'||!r.evidence.locationId):overview.recommendations;
    const reorderRefresh=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,21,'suggest');
    const demandForecasts=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,144,'suggest');
    return res.page('planning/postgres-index',{title:'What happens next',nav:'inventory',room:true,...overview,recommendations,agentTerms,manageRules,rules,safetyPreview,safetyRoutine,safetyRules,reorderRefresh,demandForecasts,planLocksReorder:agentTerms&&state.plan==='starter',
      mayAccept:row=>!agentTerms||permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,row.kind==='safety_stock'?150:row.evidence.locationId?120:21,'draft'),
      canOperate:permissions.can(req.user,permissions.OPERATE),canAdmin:permissions.can(req.user,permissions.ADMIN)});
  }));
  router.get('/planning/location-reorder',requireOwner,asyncRoute(async(req,res)=>{
    const view={title:'Location reorder points',nav:'inventory'};
    const plan=require('../../commercial/agent-plan'),state=await plan.accountState(database,req.ctx.workspaceId);
    const included=plan.permits(state.plan,120,'draft');
    if((!included||!plan.usesAgentTerms(state))&&req.accepts('html')){
      return res.page('autopilot/agent-plan-locked',{...view,tier:'Growth',
        reviewTerms:included,backTo:{href:'/planning',label:'Planning'}});
    }
    if(included&&plan.usesAgentTerms(state)&&!req.query.position&&!req.query.skuId&&!req.query.locationId)
      return res.redirect(303,'/planning#location-rules');
    const model=await require('../../forecasting/location-reorder-rules').page(database,req.ctx,selectedPosition(req.query));
    return res.page('planning/location-reorder',{...view,model});
  }));
  router.post('/planning/location-reorder/approve',asyncRoute(async(req,res)=>{
    const result=await require('../../forecasting/location-reorder-rules').approve(database,req.ctx,req.body);
    req.flash('success',result.replayed?'That location reorder example was already recorded.':'Saved the location reorder point and target.');
    return res.redirect(303,'/planning/location-reorder?skuId='+encodeURIComponent(req.body.skuId)+'&locationId='+encodeURIComponent(req.body.locationId));
  }));
  router.post('/planning/location-reorder-rules',requireAuth,asyncRoute(async(req,res)=>{
    const input=selectedPosition(req.body);
    await require('../../forecasting/location-reorder-rules').configure(database,req.ctx,input);
    req.flash('success',req.body.remove==='1'?'Automatic reorder rule removed.':'Automatic reorder limits saved.');
    if(input.remove!=='1'&&input.skuId&&input.locationId)
      return res.redirect(303,'/planning/location-reorder?skuId='+encodeURIComponent(input.skuId)+'&locationId='+encodeURIComponent(input.locationId));
    return res.redirect(303,'/planning#location-rules');
  }));
  const refresh=()=>require('../../forecasting/agent-reorder-refresh'),refreshPath='/planning/reorder-refresh';
  const manageReorders=requirePermission(permissions.MANAGE_REPLENISHMENT,'review reorder settings');
  router.get(refreshPath,manageReorders,asyncRoute(async(req,res)=>{
    const view={title:'Keep reorder points up to date',nav:'inventory'};
    const agent=require('../../commercial/agent-plan'),state=await agent.accountState(database,req.ctx.workspaceId);
    if(!agent.usesAgentTerms(state)&&req.accepts('html'))return res.page('autopilot/agent-plan-locked',{...view,tier:'Starter',
      reviewTerms:agent.permits(state.plan,refresh().JOB,'suggest'),backTo:{href:'/planning',label:'Planning'}});
    try{
      const model=await refresh().page(database,req.ctx,{number:req.query.page||1});
      return res.page('planning/reorder-refresh',{...view,model});
    }catch(error){
      if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
      res.status(402);
      return res.page('autopilot/locked',{...view,message:error.message});
    }
  }));
  router.post(refreshPath+'/check',manageReorders,asyncRoute(async(req,res)=>{
    const result=await refresh().requestCheck(database,req.ctx);
    req.flash('success',result.queued?'StockChief will check every stocked product shortly.':'A check is already on its way.');
    return res.redirect(303,refreshPath);
  }));
  router.post(refreshPath+'/approve-all',manageReorders,asyncRoute(async(req,res)=>{
    const result=await refresh().approveAll(database,req.ctx);
    req.flash('success','Approved '+result.approved+' change'+(result.approved===1?'':'s')+'.'+(result.held.length?' '+result.held.length+' need a fresh check: '+result.held[0].reason:''));
    return res.redirect(303,refreshPath);
  }));
  router.post(refreshPath+'/locks',manageReorders,asyncRoute(async(req,res)=>{
    const result=await refresh().setLock(database,req.ctx,selectedPosition(req.body));
    req.flash('success',result.locked?'Locked. StockChief will leave these settings alone.':'Unlocked. The next check includes these settings.');
    return res.redirect(303,refreshPath+'#locks');
  }));
  router.post(refreshPath+'/rule',requireAuth,asyncRoute(async(req,res)=>{
    const result=await refresh().configure(database,req.ctx,req.body);
    req.flash('success',result.stopped?'StockChief will ask you about every change.':'Limit saved. Changes inside it happen on their own.');
    return res.redirect(303,refreshPath+'#rule');
  }));
  for(const [action,message] of [['approve','Change approved and saved.'],['decline','Kept the current settings.'],['undo','Earlier reorder point and target restored.']]){
    router.post(refreshPath+'/:id/'+action,manageReorders,asyncRoute(async(req,res)=>{
      const result=await refresh()[action](database,req.ctx,req.params.id);
      req.flash('success',result.replayed?'That was already done.':message);
      return res.redirect(303,refreshPath);
    }));
  }
  const forecast=()=>require('../../forecasting/agent-demand-forecast'),forecastPath='/planning/forecasts';
  router.get(forecastPath,manageReorders,asyncRoute(async(req,res)=>{
    const view={title:'Demand forecasts',nav:'inventory'};
    const agent=require('../../commercial/agent-plan'),state=await agent.accountState(database,req.ctx.workspaceId);
    if(!agent.usesAgentTerms(state)&&req.accepts('html'))return res.page('autopilot/agent-plan-locked',{...view,tier:'Starter',
      reviewTerms:agent.permits(state.plan,forecast().JOB,'suggest'),backTo:{href:'/planning',label:'Planning'}});
    try{
      const model=await forecast().page(database,req.ctx,{number:req.query.page||1});
      return res.page('planning/forecasts',{...view,model});
    }catch(error){
      if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
      res.status(402);
      return res.page('autopilot/locked',{...view,message:error.message});
    }
  }));
  router.post(forecastPath+'/check',manageReorders,asyncRoute(async(req,res)=>{
    const result=await forecast().requestCheck(database,req.ctx);
    req.flash('success',result.queued?'StockChief will refresh every forecast shortly.':'A forecast is already on its way.');
    return res.redirect(303,forecastPath);
  }));
  router.post(forecastPath+'/approve-all',manageReorders,asyncRoute(async(req,res)=>{
    const result=await forecast().approveAll(database,req.ctx);
    req.flash('success','Planning now uses '+result.approved+' approved forecast'+(result.approved===1?'':'s')+'.');
    return res.redirect(303,forecastPath);
  }));
  router.post(forecastPath+'/approve',manageReorders,asyncRoute(async(req,res)=>{
    const result=await forecast().approve(database,req.ctx,req.body.skuId);
    req.flash('success',result.replayed?'That forecast was already approved.':'Planning now uses this forecast.');
    return res.redirect(303,forecastPath);
  }));
  router.post(forecastPath+'/use',manageReorders,asyncRoute(async(req,res)=>{
    const result=await forecast().setExcluded(database,req.ctx,req.body);
    req.flash('success',result.status==='EXCLUDED'?'Planning uses plain sales history for this product.':'The forecast can plan this product again.');
    return res.redirect(303,forecastPath+'#forecasts');
  }));
  router.get('/planning/safety-stock',requirePermission(permissions.MANAGE_REPLENISHMENT,'review safety stock'),asyncRoute(async(req,res)=>{
    const view={title:'Review safety stock',nav:'inventory'};
    try{
      const result=await require('../../forecasting/agent-safety-stock').preview(database,req.ctx,selectedPosition(req.query));
      return res.page('planning/safety-stock',{...view,result});
    }catch(error){
      if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
      res.status(402);
      return res.page('autopilot/locked',{...view,message:error.message});
    }
  }));
  router.post('/planning/safety-stock',requirePermission(permissions.MANAGE_REPLENISHMENT,'approve safety stock'),asyncRoute(async(req,res)=>{
    const result=await require('../../forecasting/agent-safety-stock').approve(database,req.ctx,req.body);
    const unit=result.unit==='unit'?'units':result.unit;
    req.flash('success','Safety stock saved at '+result.units+' '+unit+'.');return res.redirect(303,'/planning#safety-stock');
  }));
  router.post('/planning/safety-stock/class',requireAuth,asyncRoute(async(req,res)=>{
    await require('../../forecasting/agent-safety-stock').setClassRule(database,req.ctx,req.body);
    req.flash('success',req.body.remove==='1'?'Class service level removed.':'Class service level saved.');return res.redirect(303,'/planning#safety-stock');
  }));
  router.post('/planning/recommendations/:id/accept', requirePermission(permissions.OPERATE,'change replenishment policy'),
    asyncRoute(async (req,res) => {
      const result=await planning.decide(database,req.ctx,req.params.id,'accept');
      req.flash('success',result.replayed?'That recommendation was already decided.':'Applied and recorded.');
      return res.redirect(303,'/planning#recommendations');
    }));
  router.post('/planning/recommendations/:id/decline', requirePermission(permissions.OPERATE,'decline replenishment policy'),
    asyncRoute(async (req,res) => {
      const result=await planning.decide(database,req.ctx,req.params.id,'decline');
      req.flash('success',result.replayed?'That recommendation was already decided.':'Kept the current policy and recorded the decision.');
      return res.redirect(303,'/planning#recommendations');
    }));
  router.post('/planning/goals', requirePermission(permissions.ADMIN,'change planning goals'), asyncRoute(async(req,res) => {
    await planning.saveGoals(database,req.ctx,req.body);req.flash('success','Planning goals saved. They do not grant execution authority.');
    return res.redirect(303,'/planning#goals');
  }));
  return router;
}

module.exports = { createPostgresPlanningRouter };

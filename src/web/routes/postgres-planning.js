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
    const safetyStock=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,150,'draft');
    const runOut=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,151,'automatic');
    const recommendations=agentTerms?overview.recommendations.filter(r=>r.kind!=='reorder_point'||!r.evidence.locationId):overview.recommendations;
    const reorderRefresh=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,21,'suggest');
    const demandForecasts=agentTerms&&permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,144,'suggest');
    // Job 203: the value of excess stock is a cost, and the total held is a valuation.
    const seesCosts=require('../../actions/financial-visibility').costs(req.user),seesValue=permissions.can(req.user,permissions.VIEW_ACCOUNTING);
    if(!seesCosts)overview.excess=overview.excess.map(row=>({...row,excessValueMinor:null,costMinor:null}));
    if(!seesValue)overview.heldMinor=null;
    return res.page('planning/postgres-index',{title:'What happens next',nav:'inventory',room:true,...overview,recommendations,seesCosts,agentTerms,manageRules,rules,safetyStock,runOut,reorderRefresh,demandForecasts,planLocksReorder:agentTerms&&state.plan==='starter',
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
  router.post(forecastPath+'/similar',manageReorders,asyncRoute(async(req,res)=>{
    const result=await require('../../forecasting/agent-launch-forecast').choose(database,req.ctx,req.body);
    req.flash('success',result.replayed?'That similar item was already chosen.':result.status==='ASK'?'Cleared. StockChief will look for similar items again.':'Similar item saved. The new product is forecast from it.');
    return res.redirect(303,forecastPath+'#new-products');
  }));
  router.post(forecastPath+'/new/approve',manageReorders,asyncRoute(async(req,res)=>{
    const result=await require('../../forecasting/agent-launch-forecast').approve(database,req.ctx,req.body.skuId);
    req.flash('success',result.replayed?'That forecast was already approved.':'Planning now uses this new product forecast.');
    return res.redirect(303,forecastPath+'#new-products');
  }));
  for(const [action,message] of [['approve','Planning now follows this trend.'],['dismiss','Dismissed. Planning goes back to the forecast.']]){
    router.post(forecastPath+'/trends/:id/'+action,manageReorders,asyncRoute(async(req,res)=>{
      const result=await require('../../forecasting/agent-demand-trends')[action](database,req.ctx,req.params.id);
      req.flash('success',result.replayed?'That was already done.':message);
      return res.redirect(303,forecastPath+'#trends');
    }));
  }
  router.post(forecastPath+'/use',manageReorders,asyncRoute(async(req,res)=>{
    const result=await forecast().setExcluded(database,req.ctx,req.body);
    req.flash('success',result.status==='EXCLUDED'?'Planning uses plain sales history for this product.':'The forecast can plan this product again.');
    return res.redirect(303,forecastPath+'#forecasts');
  }));
  const runout=()=>require('../../forecasting/agent-runout'),runoutPath='/planning/run-out';
  router.get(runoutPath,manageReorders,asyncRoute(async(req,res)=>{
    const view={title:'When stock runs out',nav:'inventory'};
    const agent=require('../../commercial/agent-plan'),state=await agent.accountState(database,req.ctx.workspaceId);
    if(!agent.usesAgentTerms(state)&&req.accepts('html'))return res.page('autopilot/agent-plan-locked',{...view,tier:'Starter',
      reviewTerms:agent.permits(state.plan,runout().JOB,'suggest'),backTo:{href:'/planning',label:'Planning'}});
    try{
      const model=await runout().page(database,req.ctx,{number:req.query.page||1});
      // Job 203: gross margin is for people who see accounting.
      if(!permissions.can(req.user,permissions.VIEW_ACCOUNTING)){
        const hide=r=>({...r,unit_margin_minor:null,daily_margin_minor:null,lost_margin_minor:null});
        Object.assign(model,{flagged:model.flagged.map(hide),later:model.later.map(hide),marginHidden:true});
      }
      return res.page('planning/run-out',{...view,model});
    }catch(error){
      if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
      res.status(402);
      return res.page('autopilot/locked',{...view,message:error.message});
    }
  }));
  router.post(runoutPath+'/check',manageReorders,asyncRoute(async(req,res)=>{
    const result=await runout().requestCheck(database,req.ctx);
    req.flash('success',result.queued?'StockChief will check every item shortly.':'A check is already on its way.');
    return res.redirect(303,runoutPath);
  }));
  const safety=()=>require('../../forecasting/agent-safety-stock'),safetyPath='/planning/safety-stock';
  router.get(safetyPath,manageReorders,asyncRoute(async(req,res)=>{
    const view={title:'Safety stock',nav:'inventory'};
    try{
      const model=await safety().page(database,req.ctx,{number:req.query.page||1});
      return res.page('planning/safety-stock',{...view,model});
    }catch(error){
      if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
      res.status(402);
      return res.page('autopilot/locked',{...view,message:error.message});
    }
  }));
  router.post(safetyPath+'/targets',requireAuth,asyncRoute(async(req,res)=>{
    const result=await safety().setTarget(database,req.ctx,req.body);
    req.flash('success',result.removed?'Target removed.':result.saved?'Target saved. The next daily check uses it.':'That target was already saved.');
    return res.redirect(303,safetyPath+'#targets');
  }));
  router.post(safetyPath+'/check',manageReorders,asyncRoute(async(req,res)=>{
    const result=await forecast().requestCheck(database,req.ctx);
    req.flash('success',result.queued?'StockChief will check safety stock with the forecasts shortly.':'A check is already on its way.');
    return res.redirect(303,safetyPath);
  }));
  router.post(safetyPath+'/approve-all',manageReorders,asyncRoute(async(req,res)=>{
    const result=await safety().approveAll(database,req.ctx);
    req.flash('success','Approved '+result.approved+' change'+(result.approved===1?'':'s')+'.'+(result.held.length?' '+result.held.length+' need a fresh check: '+result.held[0].reason:''));
    return res.redirect(303,safetyPath);
  }));
  for(const [action,message] of [['approve','Safety stock saved. The reorder point builds on it.'],['decline','Kept the current safety stock.'],['undo','Earlier safety stock restored.']]){
    router.post(safetyPath+'/:id/'+action,manageReorders,asyncRoute(async(req,res)=>{
      const result=await safety()[action](database,req.ctx,req.params.id);
      req.flash('success',result.replayed?'That was already done.':message);
      return res.redirect(303,safetyPath);
    }));
  }
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

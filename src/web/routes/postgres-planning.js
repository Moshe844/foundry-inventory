'use strict';

const express = require('express');
const permissions = require('../../actions/permissions');
const planning = require('../../forecasting/postgres-planning-service');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');
const {requireCapability}=require('../commercial-middleware');

function createPostgresPlanningRouter(database) {
  const router = express.Router();
  router.use('/planning', requireAuth,requireCapability(database,'forecasting.basic'));
  router.get('/planning', asyncRoute(async (req, res) => {
    const agent=require('../../commercial/agent-plan');
    const [overview,state]=await Promise.all([planning.overview(database,req.ctx.workspaceId,{afterSkuId:req.query.after||null}),agent.accountState(database,req.ctx.workspaceId)]);
    const agentTerms=agent.usesAgentTerms(state),manageRules=agentTerms&&req.user.role==='owner'&&agent.permits(state.plan,120,'automatic',{trained:true});
    const rules=manageRules?(await database.query('SELECT sku_id,location_id,ceiling FROM stockchief_runtime.location_reorder_rules WHERE workspace_id=$1 AND sku_id=ANY($2::text[])',
      [req.ctx.workspaceId,[...new Set(overview.rows.map(r=>r.sku_id))]])).rows:[];
    return res.page('planning/postgres-index',{title:'What happens next',nav:'inventory',room:true,...overview,agentTerms,manageRules,rules,planLocksReorder:agentTerms&&state.plan==='starter',
      mayAccept:row=>!agentTerms||permissions.can(req.user,permissions.MANAGE_REPLENISHMENT)&&agent.permits(state.plan,row.kind==='safety_stock'?150:row.evidence.locationId?120:21,'draft'),
      canOperate:permissions.can(req.user,permissions.OPERATE),canAdmin:permissions.can(req.user,permissions.ADMIN)});
  }));
  router.post('/planning/location-reorder-rules',requireAuth,asyncRoute(async(req,res)=>{
    let input=req.body;
    if(input.position){let pair;try{pair=JSON.parse(input.position);}catch{}
      if(!Array.isArray(pair)||pair.length!==2||!pair.every(id=>typeof id==='string'))throw new (require('../../domain/errors').ValidationError)('Choose a product and location.');
      input={...input,skuId:pair[0],locationId:pair[1]};}
    await require('../../forecasting/location-reorder-rules').configure(database,req.ctx,input);
    req.flash('success',req.body.remove==='1'?'Automatic reorder rule removed.':'Automatic reorder limits saved.');
    return res.redirect(303,'/planning#location-rules');
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

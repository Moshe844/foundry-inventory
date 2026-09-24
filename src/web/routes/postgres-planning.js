'use strict';

const express = require('express');
const permissions = require('../../actions/permissions');
const planning = require('../../forecasting/postgres-planning-service');
const { requireAuth, requirePermission, asyncRoute } = require('../middleware');

function createPostgresPlanningRouter(database) {
  const router = express.Router();
  router.use('/planning', requireAuth);
  router.get('/planning', asyncRoute(async (req, res) => res.page('planning/postgres-index', {
    title:'What happens next',nav:'inventory',room:true,...await planning.overview(database,req.ctx.workspaceId),
    canOperate:permissions.can(req.user,permissions.OPERATE),canAdmin:permissions.can(req.user,permissions.ADMIN),
  })));
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

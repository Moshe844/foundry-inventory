'use strict';

const express=require('express');
const autonomy=require('../../autopilot/postgres-service');
const { requireAuth,asyncRoute }=require('../middleware');

function createPostgresAutopilotRouter(database){
  const router=express.Router();
  router.get('/autopilot',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-settings',{
    title:'What StockChief does',nav:'autopilot',backTo:{href:'/settings',label:'Settings'},
    ...(await autonomy.dashboard(database,req.ctx.workspaceId))})));
  router.post('/autopilot/mode',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.setMode(database,req.ctx,req.user,req.body.mode);req.flash('success','StockChief authority was updated.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/routine-authority',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.configureRoutine(database,req.ctx,req.user,req.body);
    req.flash('success','Saved versioned routine-work authority. Anything outside these exact limits still asks first.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/pause',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.pause(database,req.ctx,req.user,req.body.reason);req.flash('success','Automatic work is paused.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/resume',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.resume(database,req.ctx,req.user);req.flash('success','StockChief is watching again. Old work will not be replayed.');
    return res.redirect(303,'/autopilot');
  }));
  router.post('/autopilot/run',requireAuth,asyncRoute(async(req,res)=>{
    const result=await autonomy.run(database,req.ctx);req.flash('success',
      `Check complete — ${result.planned} prepared, ${result.executed} completed automatically, ${result.waiting} waiting for you.`);
    return res.redirect(303,'/autopilot');
  }));
  router.get('/autopilot/work/:id',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-work',{
    title:'Review StockChief’s decision',nav:'autopilot',backTo:{href:'/needs-you',label:'Needs you'},
    item:await autonomy.getWork(database,req.ctx.workspaceId,req.params.id)})));
  router.post('/autopilot/work/:id/approve',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.approve(database,req.ctx,req.user,req.params.id);req.flash('success','Done, verified, and recorded without replaying it twice.');
    return res.redirect(303,`/autopilot/work/${req.params.id}`);
  }));
  router.post('/autopilot/work/:id/cancel',requireAuth,asyncRoute(async(req,res)=>{
    await autonomy.cancel(database,req.ctx,req.user,req.params.id);req.flash('success','Discarded. Nothing was executed.');
    return res.redirect(303,'/needs-you');
  }));
  return router;
}

module.exports={createPostgresAutopilotRouter};

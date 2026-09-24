'use strict';

const express=require('express');
const autonomy=require('../../autopilot/postgres-service');
const assistant=require('../../assistant/postgres-service');
const monitoring=require('../../operations/postgres-monitoring');
const { requireAuth,asyncRoute }=require('../middleware');

function createPostgresAutopilotRouter(database){
  const router=express.Router();
  router.get('/autopilot',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-settings',{
    title:'What StockChief does',nav:'autopilot',backTo:{href:'/settings',label:'Settings'},
    ...(await autonomy.dashboard(database,req.ctx.workspaceId))})));
  router.get('/autopilot/daily',requireAuth,(req,res)=>res.redirect(302,'/needs-you'));
  router.get('/autopilot/history',requireAuth,asyncRoute(async(req,res)=>{const recent=(await autonomy.dashboard(database,req.ctx.workspaceId)).recent;
    const groups={automatic:[],prepared:[],needsYou:[],blocked:[]};
    for(const item of recent){item.executionStatus=item.execution_status;item.approvalRequirement=item.approval_requirement;
      item.errorMessage=item.error_message;item.createdAt=item.created_at;item.completedAt=item.completed_at;
      if(item.executionStatus==='COMPLETED')groups[item.approvalRequirement==='NONE'?'automatic':'prepared'].push(item);
      else if(['FAILED','CANCELLED','REFUSED'].includes(item.executionStatus))groups.blocked.push(item);else groups.needsYou.push(item);}
    const describe=(item)=>{const action=item.recommendedAction||{};const subject=action.displayName||action.itemName||item.category||'business work';
      return {headline:item.executionStatus==='COMPLETED'?`Completed ${subject}`:`Review ${subject}`,
        detail:item.policyEvaluation?.reason||item.errorMessage||'The evidence and exact limits are recorded on this work item.'};};
    return res.page('autopilot/history',{title:"StockChief's work",nav:'autopilot',groups,operations:[],evaluations:[],describe});
  }));
  router.get('/autopilot/misses',requireAuth,asyncRoute(async(req,res)=>res.page('autopilot/postgres-misses',{
    title:'Report an Ask problem',nav:'ask',room:true,interactions:await assistant.listInteractions(database,req.ctx.workspaceId,30)})));
  router.post('/autopilot/misses',requireAuth,asyncRoute(async(req,res)=>{
    const interactions=await assistant.listInteractions(database,req.ctx.workspaceId,100);
    const turn=interactions.find((entry)=>entry.id===req.body.interactionId);
    if(!turn)throw new Error('Choose a recent Ask StockChief response from this inventory.');
    await monitoring.raise(database,{workspaceId:req.ctx.workspaceId,severity:'WARNING',kind:'assistant.reported_miss',
      title:'Ask StockChief response reported by owner',detail:`Question: ${turn.message}\nAnswer: ${turn.answer}\nOwner note: ${String(req.body.note||'').trim()||'No note supplied.'}`,
      fingerprint:`assistant.reported_miss:${turn.id}`});
    req.flash('success','Problem recorded with the exact question and answer. StockChief did not learn a new rule silently.');
    return res.redirect(303,'/autopilot/misses');
  }));
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

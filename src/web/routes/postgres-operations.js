'use strict';

const express=require('express');
const config=require('../../config');
const readiness=require('../../operations/postgres-readiness');
const jobs=require('../../operations/postgres-job-queue');
const monitoring=require('../../operations/postgres-monitoring');
const {requireOwner,asyncRoute}=require('../middleware');
const {NotFoundError}=require('../../domain/errors');

function createPostgresOperationsRouter(database){
  const router=express.Router();router.use('/settings/operations',requireOwner);
  router.get('/settings/operations',asyncRoute(async(req,res)=>{
    const [state,deadJobs,alerts,runs]=await Promise.all([
      readiness.snapshot(database,req.ctx.workspaceId,{env:'production'}),
      jobs.listDead(database,req.ctx.workspaceId),
      database.query(`SELECT * FROM operational_alerts WHERE workspace_id=$1 AND status<>'RESOLVED'
        ORDER BY last_seen_at DESC,id DESC LIMIT 100`,[req.ctx.workspaceId]),
      database.query(`SELECT * FROM production_certification_runs WHERE workspace_id=$1
        ORDER BY started_at DESC,id DESC LIMIT 20`,[req.ctx.workspaceId]),
    ]);
    return res.page('settings/postgres-operations',{title:'Production operations',nav:'settings',room:true,
      backTo:{href:'/settings',label:'Settings'},readiness:state,deadJobs,alerts:alerts.rows,runs:runs.rows});
  }));
  router.post('/settings/operations/jobs/:id/retry',asyncRoute(async(req,res)=>{
    const job=await jobs.retryDead(database,req.params.id,req.ctx.workspaceId,{by:req.user.id});
    if(!job)throw new NotFoundError('No dead-lettered job with that id belongs to this inventory.');
    req.flash('success','The job is queued for one controlled retry.');return res.redirect(303,'/settings/operations#dead-letters');
  }));
  router.post('/settings/operations/alerts/test',asyncRoute(async(req,res)=>{
    await monitoring.raise(database,{workspaceId:req.ctx.workspaceId,severity:'WARNING',kind:'certification.injected',
      title:'StockChief production alert test',detail:'Intentional alert for responder qualification.',
      fingerprint:`certification.injected:${Date.now()}`});
    req.flash(config.operations.alertWebhookUrl?'success':'warn',config.operations.alertWebhookUrl
      ?'The test alert is recorded for external delivery qualification.':'The alert is recorded, but no external alert webhook is configured.');
    return res.redirect(303,'/settings/operations#alerts');
  }));
  router.post('/settings/operations/alerts/:id/resolve',asyncRoute(async(req,res)=>{
    const result=await database.query(`UPDATE operational_alerts SET status='RESOLVED',resolved_at=$3
      WHERE workspace_id=$1 AND id=$2 AND status<>'RESOLVED' RETURNING id`,[req.ctx.workspaceId,req.params.id,new Date().toISOString()]);
    if(!result.rows.length)throw new NotFoundError('That operational alert was not found in this inventory.');
    req.flash('success','The incident is resolved; its evidence remains recorded.');return res.redirect(303,'/settings/operations#alerts');
  }));
  router.post('/settings/operations/certify',asyncRoute(async(req,res)=>{
    const result=await readiness.certify(database,req.ctx.workspaceId);
    req.flash(result.ok?'success':'warn',result.ok?`Certification ${result.id} passed.`:
      `Certification ${result.id} remains blocked by ${result.blockers.join(', ')}.`);
    return res.redirect(303,'/settings/operations#certification');
  }));
  return router;
}

module.exports={createPostgresOperationsRouter};

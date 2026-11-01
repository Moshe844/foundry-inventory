'use strict';

const express=require('express');
const jobs=require('../../operations/postgres-job-queue');
const providerEffects=require('../../operations/postgres-provider-effects');
const {requireOwner,asyncRoute}=require('../middleware');
const {NotFoundError}=require('../../domain/errors');

function createPostgresOperationsRouter(database){
  const router=express.Router();router.use('/settings/operations',requireOwner);
  router.get('/settings/operations',asyncRoute(async(req,res)=>{
    const deadJobs=await jobs.listDead(database,req.ctx.workspaceId),groups=new Map();
    for(const job of deadJobs){const kind=job.kind.startsWith('import.')?'imports':job.kind.startsWith('report.')?'reports':job.kind.startsWith('connection.')||job.kind.startsWith('connector.')?'connections':'other';groups.set(kind,(groups.get(kind)||0)+1);}
    const labels={imports:{title:'Some file imports could not finish',href:'/imports',action:'Review imports'},reports:{title:'Some reports could not finish',href:'/reports',action:'Review reports'},connections:{title:'A connection needs attention',href:'/settings/connections',action:'Review connections'},other:{title:'Some background work needs attention',href:'/support',action:'Contact support'}};
    return res.page('settings/background-issues',{title:'Work needing attention',nav:'settings',room:true,backTo:{href:'/settings',label:'Settings'},issues:[...groups].map(([kind,count])=>({...labels[kind],count}))});
  }));
  router.get('/settings/operations/provider-effects/:id',asyncRoute(async(req,res)=>{
    const effect=await providerEffects.get(database,req.ctx.workspaceId,req.params.id);
    return res.page('settings/postgres-provider-effect',{title:'Provider outcome review',nav:'settings',room:true,
      backTo:{href:'/needs-you',label:'Needs you'},effect});
  }));
  router.post('/settings/operations/provider-effects/:id/verify',asyncRoute(async(req,res)=>{
    try{await require('../../accounting/postgres-integration-sync').verifyExistingExport(database,req.ctx,req.params.id);req.flash('success','The existing provider record matches the canonical journal. Nothing was resent.');}
    catch(error){req.flash('warn','Verification is still pending. No operation was resent. '+(Number(error.status)<500?error.message:'Try verifying again when the provider is available.'));}
    return res.redirect(303,'/settings/operations/provider-effects/'+encodeURIComponent(req.params.id));
  }));
  router.post('/settings/operations/jobs/:id/retry',asyncRoute(async(req,res)=>{
    const job=await jobs.retryDead(database,req.params.id,req.ctx.workspaceId,{by:req.user.id});
    if(!job)throw new NotFoundError('No dead-lettered job with that id belongs to this inventory.');
    req.flash('success','The job is queued for one controlled retry.');return res.redirect(303,'/settings/operations#dead-letters');
  }));
  return router;
}

module.exports={createPostgresOperationsRouter};

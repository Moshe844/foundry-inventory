'use strict';

const express=require('express');
const assistant=require('../../assistant/postgres-service');
const { requireAuth,asyncRoute }=require('../middleware');

function createPostgresAskRouter(database,options={}){
  const router=express.Router();
  router.use(['/ask','/actions'],requireAuth);
  router.get('/ask',asyncRoute(async(req,res)=>{
    const startedAt=req.session.postgresAskStartedAt||null;
    const interactions=(await assistant.listInteractions(database,req.ctx.workspaceId,100))
      .filter((turn)=>!startedAt||String(turn.created_at)>=startedAt);
    return res.page('attention/postgres-ask',{title:'Ask StockChief',nav:'ask',room:true,interactions,
      prefill:String(req.query.q || req.query.about || '').slice(0,2000)});
  }));
  router.post('/ask/new',(req,res)=>{
    req.session.postgresAskStartedAt=new Date().toISOString();
    req.flash('success','New conversation started. Earlier conversations remain in the audit history.');
    return res.redirect(303,'/ask');
  });
  router.post('/ask',asyncRoute(async(req,res)=>{
    await assistant.ask(database,req.ctx,req.body.message,{provider:options.provider});
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/foundry/tell',requireAuth,asyncRoute(async(req,res)=>{
    await assistant.ask(database,req.ctx,req.body.message,{provider:options.provider});
    return res.redirect(303,'/ask#latest');
  }));
  router.post('/ask/leave-the-rest',asyncRoute(async(req,res)=>{
    delete req.session.assistantQueue;
    const back=typeof req.body.back==='string'&&req.body.back.startsWith('/')&&!req.body.back.startsWith('//')
      ?req.body.back:'/ask';
    return res.redirect(303,back);
  }));
  router.get('/actions/:id',asyncRoute(async(req,res)=>res.page('attention/postgres-proposal',{
    title:'Review prepared change',nav:'ask',proposal:await assistant.getProposal(database,req.ctx.workspaceId,req.params.id),
  })));
  router.post('/actions/:id/approve',asyncRoute(async(req,res)=>{
    const result=await assistant.executeProposal(database,req.ctx,req.params.id);
    req.flash('success',result.replayed?'That change had already been completed.':'The approved change was completed.');
    return res.redirect(303,`/actions/${req.params.id}`);
  }));
  router.post('/actions/:id/cancel',asyncRoute(async(req,res)=>{
    await assistant.cancelProposal(database,req.ctx,req.params.id);
    req.flash('success','The prepared change was discarded. Nothing changed.');
    return res.redirect(303,'/ask');
  }));
  return router;
}

module.exports={createPostgresAskRouter};

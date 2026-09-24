'use strict';

const express = require('express');
const paths = require('../../onboarding/postgres-paths');
const auth = require('../../domain/postgres-auth-service');
const exploration = require('../../onboarding/postgres-exploration');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

function createPostgresOnboardingRouter(database) {
  const router = express.Router();
  router.use('/onboarding', requireAuth);
  router.get('/onboarding', asyncRoute(async (req,res) => {
    const state = await paths.ensure(database,req.ctx.workspaceId);
    const products = await database.query('SELECT 1 FROM items WHERE workspace_id=$1 AND is_active=1 LIMIT 1',
      [req.ctx.workspaceId]);
    if(state.isComplete && products.rows.length && req.query.add!=='1')return res.redirect(303,'/inventory');
    const entry=await exploration.state(database,req.ctx.workspaceId,req.account.id);
    return res.page('onboarding/start',{title:'Get your inventory into StockChief',nav:'inventory',state,
      paths:paths.PATHS,sourceOptions:paths.SOURCE_OPTIONS,recommendation:null,recommendedOption:null,
      sourcePrompt:null,description:'',canOperate:true,suppressBack:true,onboardingEntry:entry,
      importAction:'/imports',importFieldName:'file',importMultiple:false,importOptionsHref:'/imports'});
  }));
  router.post('/onboarding/name',requireOwner,asyncRoute(async(req,res)=>{
    await auth.renameWorkspace(database,req.ctx,req.body.name);
    req.flash('success','Inventory name saved.');
    return res.redirect(303,'/onboarding');
  }));
  router.post('/onboarding/choose',asyncRoute(async(req,res)=>{
    const state=await paths.choose(database,req.ctx.workspaceId,trimOrNull(req.body.path),{
      chosenBy:'customer',reason:req.body.reason,describedAs:req.body.describedAs,
    });
    return res.redirect(303,state.step);
  }));
  router.post('/onboarding/skip',asyncRoute(async(req,res)=>{
    await paths.setStatus(database,req.ctx.workspaceId,'abandoned');
    await exploration.skip(database,req.ctx.workspaceId);
    return res.redirect(303,'/inventory');
  }));
  router.post('/onboarding/sample/dismiss',requireOwner,asyncRoute(async(req,res)=>{
    await exploration.dismiss(database,req.ctx.workspaceId);
    const destination=String(req.body.returnTo || '/inventory');
    return res.redirect(303,/^\/(?!\/)[^\\\u0000-\u0020\u007f]*$/.test(destination)?destination:'/inventory');
  }));
  router.post('/onboarding/sample/load',requireOwner,asyncRoute(async(req,res)=>{
    req.session.workspaceId=await exploration.load(database,req.ctx,req.user,req.account.id);
    return req.session.save(()=>res.redirect(303,'/inventory'));
  }));
  router.post('/onboarding/sample/clear',requireOwner,asyncRoute(async(req,res)=>{
    const originId=await exploration.clear(database,req.ctx,req.user,req.account.id);
    req.session.workspaceId=originId;
    req.flash('success','Sample inventory cleared. Your real inventory is unchanged.');
    return req.session.save(()=>res.redirect(303,'/inventory'));
  }));
  router.post('/onboarding/describe',asyncRoute(async(req,res)=>{
    const description=trimOrNull(req.body.description) || '';
    const inferred=paths.recommendFromDescription(description);
    const recommendationResult=inferred && ['messy','mailbox'].includes(inferred.path)
      ? {...inferred,path:'spreadsheet',reason:'you can start with an exported file and add ongoing sources later'}:inferred;
    const recommendedOption=recommendationResult
      ? paths.SOURCE_OPTIONS.find((option)=>option.id===recommendationResult.path) || null:null;
    const recommendation=recommendationResult && recommendedOption
      ? {...recommendationResult,label:recommendedOption.label}:null;
    return res.page('onboarding/start',{title:'Get your inventory into StockChief',nav:'inventory',
      state:await paths.ensure(database,req.ctx.workspaceId),paths:paths.PATHS,sourceOptions:paths.SOURCE_OPTIONS,
      recommendation,recommendedOption,description,canOperate:true,suppressBack:true,
      onboardingEntry:await exploration.state(database,req.ctx.workspaceId,req.account.id),
      sourcePrompt:recommendation?`StockChief recommends this because ${recommendation.reason}. You can still choose any other source below.`:
        (description?'That describes the business, but not its actual products or quantities. Choose where those records live.':null),
      importAction:'/imports',importFieldName:'file',importMultiple:false,importOptionsHref:'/imports'});
  }));
  router.get('/onboarding/system',requireOwner,(req,res)=>res.redirect(303,'/settings/connections'));
  router.get('/onboarding/migrations/new',(req,res)=>res.redirect(303,'/imports'));
  return router;
}

module.exports = { createPostgresOnboardingRouter };

'use strict';

const express=require('express');
const auth=require('../../domain/postgres-auth-service');
const { requireAccount,asyncRoute }=require('../middleware');

function sessionCall(req,method){return new Promise((resolve,reject)=>req.session[method]((error)=>error?reject(error):resolve()));}
function safeNext(value){return typeof value==='string'&&value.startsWith('/')&&!value.startsWith('//')?value:'/';}

function createPostgresWorkspacesRouter(database){
  const router=express.Router();
  const allowance={unlimited:true,exceeded:false,used:0,limit:null,planId:null};
  router.use('/inventories',requireAccount);
  router.use('/inventories',(req,res,next)=>req.account.plan==='commercial_pending'
    ?res.redirect(req.account.email_verified_at?'/complete-signup':'/verify-email/pending'):next());
  router.get('/inventories',asyncRoute(async(req,res)=>res.page('workspaces/list',{
    title:'Your inventories',nav:'inventories',suppressBack:true,workspaces:res.locals.workspaces,
    currentWorkspaceId:req.workspace?.id||null,layoutOnboardingEntry:null,
    allowance:await capacity(req),postgresMode:true,
  })));
  const capacity=async req=>{const meter=await require('../../entitlements/postgres-service').meterState(database,{accountId:req.account.id,workspaceId:null},'workspaces');const limit=meter.hardLimit??meter.included;return {used:meter.capacityUsed??meter.used,limit,unlimited:limit===null,exceeded:limit!==null&&(meter.capacityUsed??meter.used)>=limit,planId:null};};
  router.get('/inventories/new',asyncRoute(async(req,res)=>res.page('workspaces/new',{
    title:'New inventory',nav:'inventories',backTo:{href:'/inventories',label:'Your inventories'},form:{},
    layoutOnboardingEntry:null,allowance:await capacity(req),error:null,
  })));
  router.post('/inventories',asyncRoute(async(req,res)=>{
    try{
      const created=await auth.createWorkspace(database,req.account.id,{name:req.body.name});
      req.session.workspaceId=created.workspaceId;
      req.session.flash=[{type:'success',message:'This inventory is ready. Choose where its records come from.'}];
      await sessionCall(req,'save');return res.redirect(303,'/onboarding');
    }catch(error){
      if(error.status&&error.status<500)return res.status(error.status).page('workspaces/new',{
        title:'New inventory',nav:'inventories',backTo:{href:'/inventories',label:'Your inventories'},form:req.body,
        error:error.message,layoutOnboardingEntry:null,allowance:await capacity(req),
      });
      throw error;
    }
  }));
  router.post('/inventories/switch',asyncRoute(async(req,res)=>{
    const workspaceId=String(req.body.workspaceId||'');
    await auth.rememberWorkspace(database,req.account.id,workspaceId);
    req.session.workspaceId=workspaceId;await sessionCall(req,'save');
    return res.redirect(303,safeNext(req.body.next));
  }));
  router.get('/inventories/:id/delete',asyncRoute(async(req,res)=>res.page('workspaces/postgres-delete',{
    title:'Delete inventory',nav:'inventories',review:await require('../../domain/postgres-workspace-removal').describe(database,req.account.id,req.params.id),error:null,
  })));
  router.post('/inventories/:id/delete',asyncRoute(async(req,res)=>{
    try{
      const result=await require('../../domain/postgres-workspace-removal').remove(database,req.account.id,req.params.id,req.body);
      if(req.session.workspaceId===req.params.id)req.session.workspaceId=await auth.defaultWorkspaceFor(database,req.account.id);
      req.flash('success',`${result.name} was deleted from the account. Existing business history is retained.`);
      await sessionCall(req,'save');return res.redirect(303,'/inventories');
    }catch(error){if(!error.status||error.status>=500)throw error;return res.status(error.status).page('workspaces/postgres-delete',{
      title:'Delete inventory',nav:'inventories',review:await require('../../domain/postgres-workspace-removal').describe(database,req.account.id,req.params.id),error:error.message,
    });}
  }));
  return router;
}

module.exports={createPostgresWorkspacesRouter};

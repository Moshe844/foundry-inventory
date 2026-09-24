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
  router.get('/inventories',asyncRoute(async(req,res)=>res.page('workspaces/list',{
    title:'Your inventories',nav:'inventories',suppressBack:true,workspaces:res.locals.workspaces,
    currentWorkspaceId:req.workspace?.id||null,layoutOnboardingEntry:null,
    allowance:{...allowance,used:res.locals.workspaces.length},
  })));
  router.get('/inventories/new',(req,res)=>res.page('workspaces/new',{
    title:'New inventory',nav:'inventories',backTo:{href:'/inventories',label:'Your inventories'},form:{},
    layoutOnboardingEntry:null,allowance,error:null,
  }));
  router.post('/inventories',asyncRoute(async(req,res)=>{
    try{
      const created=await auth.createWorkspace(database,req.account.id,{name:req.body.name});
      req.session.workspaceId=created.workspaceId;
      req.session.flash=[{type:'success',message:'This inventory is ready. Choose where its records come from.'}];
      await sessionCall(req,'save');return res.redirect(303,'/onboarding');
    }catch(error){
      if(error.status&&error.status<500)return res.status(error.status).page('workspaces/new',{
        title:'New inventory',nav:'inventories',backTo:{href:'/inventories',label:'Your inventories'},form:req.body,
        error:error.message,layoutOnboardingEntry:null,allowance,
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
  return router;
}

module.exports={createPostgresWorkspacesRouter};

'use strict';
const express=require('express');
const {asyncRoute}=require('../middleware');
const service=require('../../connections/postgres-shopify-public-install');
const config=require('../../config');
const COOKIE='stockchief_shopify_install';
function cookie(req){const raw=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='));return raw?raw.slice(COOKIE.length+1):'';}
function createRouter(database,{publicOrigin}={}){
 const router=express.Router(),path=service.PATH;
 router.use(path,(req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
 const origin=req=>publicOrigin==='request'?`${req.protocol}://${req.get('host')}`:(publicOrigin||config.connections.publicOrigin);
 async function show(req,res,error=null){
   let installation=null,choices=[];
   try{installation=await service.read(database,cookie(req));if(req.account)choices=await service.choices(database,req.account,installation);}catch(problem){error=problem.message;}
   return res.status(error?400:200).render('connections/shopify-public',{layout:false,title:'Connect Shopify',installation,choices,account:req.account||null,error,csrfToken:res.locals.csrfToken,assetVersion:res.locals.assetVersion});
 }
 router.get(path+'/install',asyncRoute(async(req,res)=>{
   try{
     const target=origin(req);if(!target)throw new Error('The StockChief production address is not configured.');
     const result=await service.begin(database,req.query,target);
     res.cookie(COOKIE,result.cookie,{httpOnly:true,secure:req.app.get('env')==='production',sameSite:'lax',path,maxAge:service.TTL_MS});
     return res.redirect(303,result.redirectUrl);
   }catch(error){return res.status(error.status||400).render('connections/shopify-public',{layout:false,title:'Connect Shopify',installation:null,choices:[],account:req.account||null,error:error.message,csrfToken:res.locals.csrfToken,assetVersion:res.locals.assetVersion});}
 }));
 router.get(path+'/callback',asyncRoute(async(req,res)=>{
   try{return res.redirect(303,await service.complete(database,cookie(req),req.query));}
   catch(error){return show(req,res,error.message);}
 }));
 router.get(path+'/connect',asyncRoute(async(req,res)=>show(req,res)));
 router.post(path+'/connect',asyncRoute(async(req,res)=>{
   if(!req.account)return res.redirect(303,'/login?next='+encodeURIComponent(path+'/connect'));
   try{
     const connection=await service.attach(database,req.account,cookie(req),String(req.body.workspaceId||''),{requestOrigin:origin(req)});
     req.session.workspaceId=connection.workspace_id;
     return res.redirect(303,'/settings/connections/'+encodeURIComponent(connection.id));
   }catch(error){return show(req,res,error.message);}
 }));
 return router;
}
module.exports={createRouter};

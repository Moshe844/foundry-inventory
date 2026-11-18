'use strict';
const express=require('express');
const {asyncRoute}=require('../middleware');
const service=require('../../connections/postgres-shopify-public-install');
const config=require('../../config');
const {AuthenticationError}=require('../../domain/errors');
const COOKIE='stockchief_shopify_install';
const STORE_COOKIE='stockchief_shopify_store';
function cookie(req){const raw=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='));return raw?raw.slice(COOKIE.length+1):'';}
function createRouter(database,{publicOrigin}={}){
 const router=express.Router(),path=service.PATH;
 router.use(path,(req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});next();});
 const origin=req=>publicOrigin==='request'?`${req.protocol}://${req.get('host')}`:(publicOrigin||config.connections.publicOrigin);
 async function recoveryShop(req){
   const valid=s=>typeof s==='string'&&/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s);
   // This hint only routes the browser back through Shopify authentication. It
   // never supplies ownership proof, a plan, or permission to activate billing.
   if(req.query.shop!==undefined)return valid(req.query.shop)?req.query.shop:null;
   const hint=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(STORE_COOKIE+'='))?.slice(STORE_COOKIE.length+1);
   if(valid(hint))return hint;
   if(!req.account?.email_verified_at)return null;
   const binding=await require('../../commercial/postgres-shopify-billing').get(database,req.account.id);
   if(valid(binding?.shop))return binding.shop;
   const rows=(await database.query(`SELECT DISTINCT c.provider_account_id AS shop FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id
     WHERE w.owner_account_id=$1 AND c.provider_type='shopify' AND c.status='connected' AND c.config::jsonb->>'shopifyProfile'='public' LIMIT 2`,[req.account.id])).rows;
   return rows.length===1&&valid(rows[0].shop)?rows[0].shop:null;
 }
 async function show(req,res,error=null){
   let installation=null,choices=[],shopifyBilling=null;
   try{installation=await service.read(database,cookie(req));if(req.query.shop&&req.query.shop!==installation.shop)throw new AuthenticationError('This Shopify return belongs to another store.');if(req.account){shopifyBilling=await require('../../commercial/postgres-shopify-billing').installationState(database,req.account,installation);choices=await service.choices(database,req.account,installation);}}catch(problem){
     if(req.path===path+'/connect'&&problem instanceof AuthenticationError){const shop=await recoveryShop(req);if(shop)return res.redirect(303,require('../../commercial/shopify-billing').recoveryUrl(shop));}
     error=problem.message;
   }
   return res.status(error?400:200).render('connections/shopify-public',{layout:false,title:'Connect Shopify',installation,choices,shopifyBilling,account:req.account||null,error,csrfToken:res.locals.csrfToken,assetVersion:res.locals.assetVersion});
 }
 router.get(path+'/install',asyncRoute(async(req,res)=>{
   try{
     const target=origin(req);if(!target)throw new Error('The StockChief production address is not configured.');
     const result=await service.begin(database,req.query,target);
     req.session.shopifyInstallReturn=path+'/connect';
     res.cookie(COOKIE,result.cookie,{httpOnly:true,secure:req.app.get('env')==='production',sameSite:'lax',path,maxAge:service.TTL_MS});
     res.cookie(STORE_COOKIE,req.query.shop,{httpOnly:true,secure:req.app.get('env')==='production',sameSite:'lax',path,maxAge:30*86400000});
     return res.redirect(303,result.redirectUrl);
   }catch(error){return res.status(error.status||400).render('connections/shopify-public',{layout:false,title:'Connect Shopify',installation:null,choices:[],account:req.account||null,error:error.message,csrfToken:res.locals.csrfToken,assetVersion:res.locals.assetVersion});}
 }));
 router.get(path+'/callback',asyncRoute(async(req,res)=>{
   try{return res.redirect(303,await service.complete(database,cookie(req),req.query));}
   catch(error){return show(req,res,error.message);}
 }));
 router.get(path+'/connect',asyncRoute(async(req,res)=>show(req,res)));
 router.post(path+'/billing/start',asyncRoute(async(req,res)=>{
   if(!req.account)return res.redirect(303,'/login?next='+encodeURIComponent(path+'/connect'));
   try{return res.redirect(303,await require('../../commercial/postgres-shopify-billing').startInstallation(database,req.account,await service.read(database,cookie(req))));}
   catch(error){return show(req,res,error.message);}
 }));
 router.post(path+'/connect',asyncRoute(async(req,res)=>{
   if(!req.account)return res.redirect(303,'/login?next='+encodeURIComponent(path+'/connect'));
   try{
     const connection=await service.attach(database,req.account,cookie(req),String(req.body.workspaceId||''),{requestOrigin:origin(req)});
     req.session.workspaceId=connection.workspace_id;
     delete req.session.shopifyInstallReturn;
     return res.redirect(303,'/settings/connections/'+encodeURIComponent(connection.id));
   }catch(error){return show(req,res,error.message);}
 }));
 return router;
}
module.exports={createRouter};

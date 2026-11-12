'use strict';

// Job 125: stock across the Custom account's inventories, combined for the
// person looking. Each figure is kept current by the worker; nothing here
// recalculates them. Lower plans see the plan lock.
const express=require('express');
const permissions=require('../../actions/permissions');
const {requireAuth,requirePermission,asyncRoute}=require('../middleware');

// Only the page's own filter, search and page number come from the address.
const choices=query=>({filter:typeof query.filter==='string'?query.filter:undefined,q:typeof query.q==='string'?query.q:undefined,
  page:typeof query.page==='string'?query.page:undefined});
const TYPES=Object.freeze({xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pdf:'application/pdf'});

function createPostgresInventoryRollupRouter(database){
  const router=express.Router(),rollup=()=>require('../../reports/agent-inventory-rollup'),base='/inventory/combined';
  const viewer=requirePermission(permissions.VIEW,'see stock');
  const view={title:'All inventories together',nav:'inventory',backTo:{href:'/inventory',label:'Stock'}};
  // An account still on its older terms sees the shared plan card, as on the
  // other Agent pages; an account on the Agent terms below Custom sees the lock.
  const olderTerms=async(req,res)=>{
    if(!req.accepts('html'))return false;
    const agent=require('../../commercial/agent-plan'),state=await agent.accountState(database,req.ctx.workspaceId);
    if(agent.usesAgentTerms(state))return false;
    res.page('autopilot/agent-plan-locked',{...view,tier:'Custom',reviewTerms:agent.permits(state.plan,rollup().JOB,'suggest')});
    return true;
  };
  const locked=(req,res,error)=>{
    if(error.code!=='entitlement_required'||!req.accepts('html'))throw error;
    res.status(402);return res.page('autopilot/locked',{...view,message:error.message});
  };
  router.get(base,requireAuth,viewer,asyncRoute(async(req,res)=>{
    if(await olderTerms(req,res))return;
    try{return res.page('inventory/combined',{...view,model:await rollup().model(database,req.ctx,choices(req.query))});}
    catch(error){return locked(req,res,error);}
  }));
  router.get(base+'/product',requireAuth,viewer,asyncRoute(async(req,res)=>{
    if(await olderTerms(req,res))return;
    if(typeof req.query.key!=='string'||!req.query.key)return res.redirect(303,base);
    try{const model=await rollup().product(database,req.ctx,req.query.key);
      return res.page('inventory/combined-product',{...view,title:model.product.product,backTo:{href:base,label:'All inventories together'},model});}
    catch(error){return locked(req,res,error);}
  }));
  router.get(base+'/export.:format',requireAuth,viewer,asyncRoute(async(req,res)=>{
    if(!Object.hasOwn(TYPES,req.params.format))return res.status(404).end();
    try{
      const {file,name}=await rollup().exportFile(database,req.ctx,req.params.format,choices(req.query));
      res.set('Content-Type',TYPES[req.params.format]);
      res.set('Content-Disposition',`attachment; filename="${name}"`);
      res.set('Cache-Control','private, no-store');
      return res.send(file);
    }catch(error){
      if(error.code==='validation_error'&&req.accepts('html')){req.flash('error',error.message);return res.redirect(303,base);}
      return locked(req,res,error);
    }
  }));
  router.post(base+'/update',requireAuth,viewer,asyncRoute(async(req,res)=>{
    const result=await rollup().requestUpdate(database,req.ctx,String(req.body.inventoryId||''));
    req.flash('success',result.current?'This inventory already updates on its own.':result.queued?`StockChief will update ${result.name} in a moment.`:'An update is already on its way.');
    return res.redirect(303,base);
  }));
  return router;
}

module.exports={createPostgresInventoryRollupRouter};

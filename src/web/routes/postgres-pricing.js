'use strict';

const express=require('express');
const pricing=require('../../pricing/postgres-service');
const {ValidationError}=require('../../domain/errors');
const {requireAuth,requireOwner,asyncRoute}=require('../middleware');

function createPostgresPricingRouter(database){
  const router=express.Router();router.use('/pricing',requireAuth);
  router.get('/pricing/new',asyncRoute(async(req,res)=>{
    if(!req.query.skuId){
      const q=String(req.query.q||'').trim().slice(0,160);
      const skus=(await database.query(`SELECT s.id,s.code,s.variant_label,i.name FROM skus s
        JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
        WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1
          AND ($2='' OR i.name ILIKE '%'||$2||'%' OR s.code ILIKE '%'||$2||'%')
        ORDER BY i.name,s.position,s.id LIMIT 51`,[req.ctx.workspaceId,q])).rows;
      return res.page('pricing/select-product',{title:'Change selling prices',nav:'inventory',q,skus:skus.slice(0,50),hasMore:skus.length>50});
    }
    const sku=await pricing.requireSku(database,req.ctx.workspaceId,req.query.skuId);
    return res.page('pricing/new',{title:'Set selling price',nav:'inventory',sku,screenGuide:null,
      current:await pricing.currentPrice(database,req.ctx.workspaceId,sku.id),
      purchaseCost:await pricing.purchaseCost(database,req.ctx.workspaceId,sku.id)});
  }));
  router.post('/pricing/proposals',requireOwner,asyncRoute(async(req,res)=>{
    const proposal=await pricing.createPriceProposal(database,req.ctx,{skuId:req.body.skuId,amount:req.body.amount,
      currency:req.body.currency,sourceText:`Set from inventory screen: ${req.body.amount} ${req.body.currency}`});
    return res.redirect(303,`/pricing/proposals/${proposal.id}`);
  }));
  router.get('/pricing/proposals/:id',asyncRoute(async(req,res)=>res.page('pricing/proposal',{
    title:'Review selling price',nav:'inventory',screenGuide:null,
    proposal:await pricing.getPriceProposal(database,req.ctx.workspaceId,req.params.id)})));
  router.post('/pricing/proposals/:id/approve',requireOwner,asyncRoute(async(req,res)=>{
    try{
      const proposal=await pricing.approvePriceProposal(database,req.ctx,req.params.id,req.body.integrityHash);
      req.flash('success',proposal.amount_minor===null?`${proposal.displayName} no longer has a selling price.`:
        `${proposal.displayName} now sells for ${proposal.proposedFormatted}.`);
      return res.redirect(303,`/inventory/${proposal.item_id}#pricing`);
    }catch(error){
      if(!(error instanceof ValidationError))throw error;
      return res.status(409).page('pricing/proposal',{title:'Review selling price',nav:'inventory',screenGuide:null,
        proposal:await pricing.getPriceProposal(database,req.ctx.workspaceId,req.params.id),error:error.message});
    }
  }));
  router.post('/pricing/proposals/:id/cancel',requireOwner,asyncRoute(async(req,res)=>{
    const proposal=await pricing.cancelPriceProposal(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','The selling price was not changed.');return res.redirect(303,`/inventory/${proposal.item_id}#pricing`);
  }));
  router.get('/pricing/purchase-costs/new',asyncRoute(async(req,res)=>{
    const sku=await pricing.requireSku(database,req.ctx.workspaceId,req.query.skuId);
    return res.page('pricing/postgres-purchase-cost-new',{title:'Set purchase cost',nav:'inventory',sku,
      current:await pricing.purchaseCost(database,req.ctx.workspaceId,sku.id),
      sellingPrice:await pricing.currentPrice(database,req.ctx.workspaceId,sku.id)});
  }));
  router.post('/pricing/purchase-costs/proposals',requireOwner,asyncRoute(async(req,res)=>{
    const proposal=await pricing.createPurchaseCostProposal(database,req.ctx,{skuId:req.body.skuId,amount:req.body.amount,
      currency:req.body.currency,sourceText:`Set from inventory screen: ${req.body.amount} ${req.body.currency}`});
    return res.redirect(303,`/pricing/purchase-costs/proposals/${proposal.id}`);
  }));
  router.get('/pricing/purchase-costs/proposals/:id',asyncRoute(async(req,res)=>res.page('pricing/postgres-purchase-cost-proposal',{
    title:'Review purchase cost',nav:'inventory',proposal:await pricing.getPurchaseCostProposal(database,req.ctx.workspaceId,req.params.id)})));
  router.post('/pricing/purchase-costs/proposals/:id/approve',requireOwner,asyncRoute(async(req,res)=>{
    try{
      const proposal=await pricing.approvePurchaseCostProposal(database,req.ctx,req.params.id,req.body.integrityHash);
      req.flash(proposal.belowCost?'warn':'success',proposal.belowCost?
        `${proposal.displayName} now sells below its current purchase cost.`:`${proposal.displayName} purchase cost was updated.`);
      return res.redirect(303,`/inventory/${proposal.item_id}#pricing`);
    }catch(error){
      if(!(error instanceof ValidationError))throw error;
      return res.status(409).page('pricing/postgres-purchase-cost-proposal',{title:'Review purchase cost',nav:'inventory',
        proposal:await pricing.getPurchaseCostProposal(database,req.ctx.workspaceId,req.params.id),error:error.message});
    }
  }));
  router.post('/pricing/purchase-costs/proposals/:id/cancel',requireOwner,asyncRoute(async(req,res)=>{
    const proposal=await pricing.cancelPurchaseCostProposal(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','The purchase cost was not changed.');return res.redirect(303,`/inventory/${proposal.item_id}#pricing`);
  }));
  router.use((error,req,res,next)=>{
    if(!(error instanceof ValidationError))return next(error);
    let target='/inventory';
    try{const back=new URL(req.get('referer')||'',`${req.protocol}://${req.get('host')}`);
      if(back.host===req.get('host'))target=`${back.pathname}${back.search}`;}
    catch{}
    req.flash('error',error.message);return res.redirect(303,target);
  });
  return router;
}

module.exports={createPostgresPricingRouter};

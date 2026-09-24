'use strict';

const express=require('express');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const accounts=require('../../shipping/postgres-accounts');
const shipping=require('../../shipping/postgres-service');
const providerRegistry=require('../../shipping/provider');
const legacyAccounts=require('../../shipping/accounts');

function createPostgresShippingRouter(database,options={}){
  const router=express.Router();
  router.use(['/settings/shipping','/fulfilment'],requireAuth);
  router.get('/settings/shipping',asyncRoute(async(req,res)=>{
    const account=await accounts.describe(database,req.ctx.workspaceId);
    return res.page('shipping/postgres-settings',{
      title:'Shipping setup',nav:'settings',room:true,backTo:{href:'/settings/connections',label:'Connections'},
      account,providers:accounts.PROVIDERS,
      webhookUrl:`${res.locals.origin}/webhooks/shipping/${account.provider||':provider'}/${req.ctx.workspaceId}`,
    });
  }));
  router.post('/settings/shipping/account',requireOwner,asyncRoute(async(req,res)=>{
    const verify=options.verifyAccount||legacyAccounts.verifyInput;
    await verify({provider:req.body.provider,apiKey:req.body.apiKey});
    const account=await accounts.connect(database,req.ctx,req.body);
    req.flash('success',account.testMode?'Sandbox postage account connected. No real postage can be charged.':
      'This inventory’s own postage account is connected.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.post('/settings/shipping/account/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    await accounts.disconnect(database,req.ctx);
    req.flash('success','Postage account disconnected and its encrypted credentials removed.');
    return res.redirect(303,'/settings/shipping');
  }));
  router.get('/fulfilment/:id',asyncRoute(async(req,res)=>res.page('sales/postgres-shipment',{
    title:'Shipment',nav:'fulfilment',room:true,backTo:{href:'/orders',label:'Orders'},
    state:await shipping.state(database,req.ctx.workspaceId,req.params.id),
  })));
  router.post('/fulfilment/:id/packages',asyncRoute(async(req,res)=>{
    await shipping.setPackages(database,req.ctx,req.params.id,[{weightGrams:req.body.weightGrams,
      lengthMm:req.body.lengthMm,widthMm:req.body.widthMm,heightMm:req.body.heightMm}]);
    req.flash('success','Measured package details saved.');
    return res.redirect(303,`/fulfilment/${req.params.id}`);
  }));
  router.post('/fulfilment/:id/quote',asyncRoute(async(req,res)=>{
    await shipping.quote(database,req.ctx,req.params.id,{provider:options.providerResolver?
      options.providerResolver((await accounts.forWorkspace(database,req.ctx.workspaceId))?.provider):undefined});
    req.flash('success','Live rates refreshed. No postage was purchased.');
    return res.redirect(303,`/fulfilment/${req.params.id}#rates`);
  }));
  router.post('/fulfilment/:id/buy',requireOwner,asyncRoute(async(req,res)=>{
    const queued=await shipping.queueLabelPurchase(database,req.ctx,req.params.id,req.body.rateId,
      {idempotencyKey:req.body.idempotencyKey});
    req.flash('success',queued.replayed?'That label request is already being verified. StockChief did not submit it twice.':
      'Label purchase queued. StockChief will record it only after the carrier confirms the charge and tracking number.');
    return res.redirect(303,`/fulfilment/${req.params.id}#label`);
  }));
  router.post('/fulfilment/:id/handoff',asyncRoute(async(req,res)=>{
    await shipping.handoff(database,req.ctx,req.params.id,{idempotencyKey:req.body.idempotencyKey});
    req.flash('success','Carrier handoff recorded. Inventory, order, and accounting now reflect the goods leaving.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  router.post('/fulfilment/:id/tracking/refresh',asyncRoute(async(req,res)=>{
    const account=await accounts.forWorkspace(database,req.ctx.workspaceId);
    await shipping.refreshTracking(database,req.ctx,req.params.id,{provider:options.providerResolver?
      options.providerResolver(account.provider):providerRegistry.get(account.provider)});
    req.flash('success','Carrier tracking checked. Duplicate scans were ignored.');
    return res.redirect(303,`/fulfilment/${req.params.id}#tracking`);
  }));
  return router;
}

module.exports={createPostgresShippingRouter};

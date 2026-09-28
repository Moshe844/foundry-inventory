'use strict';

const express=require('express');
const stripe=require('../../commercial/stripe-billing');
const commercial=require('../../commercial/service');

function createPostgresCommercialWebhooks(database,options={}){const router=express.Router();const provider=options.provider||stripe;
  router.post('/webhooks/stockchief-billing/stripe',express.raw({type:'application/json',limit:'1mb'}),async(req,res)=>{
    try{const event=provider.verifyEvent(req.body,req.headers,options.providerOptions||{});await commercial.handleBillingEvent(database,event);
      if(event.type==='invoice.upcoming'){const customer=typeof event.data?.object?.customer==='string'
        ?event.data.object.customer:event.data?.object?.customer?.id;if(customer){await commercial.prepareOverageCharges(database,customer);
          await commercial.deliverOverageCharges(database,customer,provider,options.providerOptions||{});}}
      return res.status(200).json({received:true});}catch(error){return res.status(error.status||400).json({error:{code:error.code||'billing_webhook_failed',message:error.message}});}});
  return router;}

module.exports={createPostgresCommercialWebhooks};

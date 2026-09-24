'use strict';

const express=require('express');
const paymentProviders=require('../../payments');
const payments=require('../../payments/postgres-collection');
const { asyncRoute }=require('../middleware');
const { ValidationError }=require('../../domain/errors');

function createPostgresPaymentWebhooks(database,options={}){
  const router=express.Router();
  router.post('/webhooks/payments/:provider',express.raw({type:'application/json',limit:'1mb'}),asyncRoute(async(req,res)=>{
    const providerName=String(req.params.provider||'').toLowerCase();
    const provider=options.providerResolver?options.providerResolver(providerName):paymentProviders.get(providerName);
    const raw=Buffer.isBuffer(req.body)?req.body.toString('utf8'):String(req.body||'');
    const secret=typeof options.webhookSecret==='function'?options.webhookSecret(providerName):
      (options.webhookSecret||process.env.STRIPE_WEBHOOK_SECRET);
    const event=provider.verifyEvent(raw,req.headers,{webhookSecret:secret});
    const providerAccountId=String(event?.account||'').trim();
    if(!providerAccountId)throw new ValidationError('That payment event does not identify the merchant account it belongs to.');
    const matches=await database.query(`SELECT workspace_id FROM payment_connect_accounts
      WHERE provider=$1 AND provider_account_id=$2`,[providerName,providerAccountId]);
    if(matches.rows.length!==1)throw new ValidationError('No single StockChief inventory owns that payment-provider account.');
    const result=await payments.receiveVerifiedEvent(database,matches.rows[0].workspace_id,providerName,event,{provider});
    return res.status(200).json({ok:true,...result});
  }));
  return router;
}

module.exports={createPostgresPaymentWebhooks};

'use strict';

const crypto=require('node:crypto');
const express=require('express');
const accounts=require('../../shipping/postgres-accounts');
const shipping=require('../../shipping/postgres-service');
const providers=require('../../shipping/provider');

function createPostgresShippingWebhooks(database,options={}){
  const router=express.Router();
  router.post('/webhooks/shipping/:provider/:workspaceId',express.raw({type:'*/*',limit:'1mb'}),async(req,res)=>{
    const providerName=String(req.params.provider||'').toLowerCase();
    try{
      const account=await accounts.forWorkspace(database,req.params.workspaceId);
      if(!account||account.provider!==providerName)return res.status(404).json({error:'No matching postage account.'});
      const provider=options.providerResolver?options.providerResolver(providerName):providers.get(providerName);
      const raw=Buffer.isBuffer(req.body)?req.body:Buffer.from(String(req.body||''),'utf8');
      const event=await provider.verifyEvent(raw,req.headers,{webhookSecret:account.webhookSecret});
      const result=await shipping.receiveProviderEvent(database,{workspaceId:req.params.workspaceId,actorId:null},
        providerName,event,{provider,externalEventId:crypto.createHash('sha256').update(raw).digest('hex')});
      return res.status(200).json({ok:true,...result});
    }catch(error){
      const status=[400,401,404].includes(Number(error.status))?Number(error.status):500;
      return res.status(status).json({error:status===500?'StockChief could not safely apply that carrier event.':error.message});
    }
  });
  return router;
}

module.exports={createPostgresShippingWebhooks};

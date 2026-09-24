'use strict';

const crypto=require('node:crypto');
const express=require('express');
const connections=require('../../connections/postgres-service');
const ingestion=require('../../connections/postgres-event-ingestion');
const credentials=require('../../connections/postgres-credential-store');
const providersDefault=require('../../connections/providers/registry');
const jobs=require('../../operations/postgres-job-queue');
const config=require('../../config');
const {safeEqual}=require('../../connections/providers/common');
const {DomainError}=require('../../domain/errors');

function digest(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}

async function wakeMailbox(database,connection,sourceKey){
  return jobs.enqueue(database,{workspaceId:connection.workspace_id,kind:'mailbox.poll',
    idempotencyKey:`mailbox-wake:${connection.id}:${sourceKey}`,payload:{connectorId:connection.id},
    priority:20,maxAttempts:5});
}

function apiError(res,error,fallback){
  if(!(error instanceof DomainError))console.error('[postgres-connections] unexpected provider webhook error',error);
  return res.status(error instanceof DomainError?error.status:500).json({error:{code:error.code||'error',
    message:error instanceof DomainError?error.message:fallback}});
}

function createPostgresConnectionsApi(database,options={}){
  const router=express.Router();
  const providers=options.providers||providersDefault;
  router.get('/events/schema',async(req,res)=>{
    try{
      await connections.authenticate(database,req.get('authorization'));
      return res.json({name:'StockChief normalized PostgreSQL event contract',version:'1.0',endpoint:'/api/v1/events',
        legacyEndpoint:'/api/v1/feed/events',legacyMaximumEvents:ingestion.LEGACY_MAX_BATCH,
        authentication:'Authorization: Bearer <connection token>',maximumEvents:ingestion.MAX_BATCH,
        idempotency:'eventId is required and immutable within one connection. Exact retries return replayed=true.',
        supportedEventTypes:[...new Set(Object.values(ingestion.TYPES))]});
    }catch(error){return res.status(error instanceof DomainError?error.status:500).json({error:{code:error.code||'error',message:error.message}});}
  });
  router.post('/events',async(req,res)=>{
    try{
      const auth=await connections.authenticate(database,req.get('authorization'));
      const result=await ingestion.ingestBatch(database,auth,req.body||{});
      return res.status(result.needsMapping?207:200).json(result);
    }catch(error){
      if(!(error instanceof DomainError))console.error('[postgres-connections] unexpected event error',error);
      return res.status(error instanceof DomainError?error.status:500).json({error:{code:error.code||'error',
        message:error instanceof DomainError?error.message:'The external event could not be processed.'}});
    }
  });
  router.post('/connections/gmail/webhooks',async(req,res)=>{
    try{
      const expected=config.connections.gmail.pubsubVerificationToken;
      if(!expected||!safeEqual(String(req.query.token||''),expected))return res.status(401).json({error:{
        code:'webhook_authentication_failed',message:'Gmail push notification was not authenticated.'}});
      let notice={};try{notice=JSON.parse(Buffer.from(req.body?.message?.data||'','base64').toString('utf8'));}catch{}
      const email=String(notice.emailAddress||'').trim().toLowerCase();
      if(!email)return res.status(202).json({received:true,mailboxes:0,scheduled:0});
      const rows=(await database.query(`SELECT * FROM workspace_connectors WHERE provider_type='gmail'
        AND lower(provider_account_id)=lower($1) AND status='connected' AND paused_at IS NULL ORDER BY id`,[email])).rows;
      const source=String(req.body?.message?.messageId||notice.historyId||digest(JSON.stringify(req.body||{})));
      let scheduled=0;
      for(const connection of rows)if((await wakeMailbox(database,connection,`gmail:${source}`)).created)scheduled+=1;
      return res.status(202).json({received:true,mailboxes:rows.length,scheduled});
    }catch(error){return apiError(res,error,'The Gmail notification could not be scheduled.');}
  });
  router.post('/connections/microsoft365/webhooks/:connectorId?',async(req,res)=>{
    if(req.query.validationToken!==undefined)return res.type('text/plain').status(200).send(String(req.query.validationToken));
    try{
      const adapter=providers.get('microsoft365');
      if(!adapter?.verifyWebhook)return res.status(503).json({error:{code:'provider_unavailable',
        message:'Microsoft 365 webhook verification is not configured.'}});
      const notifications=Array.isArray(req.body?.value)?req.body.value:[];
      let rows;
      if(req.params.connectorId)rows=(await database.query(`SELECT * FROM workspace_connectors WHERE id=$1
        AND provider_type='microsoft365' AND status='connected' AND paused_at IS NULL`,[req.params.connectorId])).rows;
      else rows=(await database.query(`SELECT * FROM workspace_connectors WHERE provider_type='microsoft365'
        AND status='connected' AND paused_at IS NULL ORDER BY id`)).rows;
      let matched=0;let scheduled=0;
      for(const connection of rows){
        const secret=await credentials.get(database,connection.workspace_id,connection.id,'provider');
        if(!secret)continue;
        const relevant=notifications.filter((notice)=>!notice.subscriptionId||notice.subscriptionId===secret.subscriptionId);
        if(!relevant.length)continue;
        adapter.verifyWebhook({body:{value:relevant},credentials:secret,connection});
        const source=digest(JSON.stringify(relevant));
        if((await wakeMailbox(database,connection,`microsoft365:${source}`)).created)scheduled+=1;
        matched+=1;
      }
      return res.status(202).json({received:true,mailboxes:matched,scheduled});
    }catch(error){return apiError(res,error,'The Microsoft 365 notification could not be scheduled.');}
  });
  return router;
}

module.exports={createPostgresConnectionsApi};

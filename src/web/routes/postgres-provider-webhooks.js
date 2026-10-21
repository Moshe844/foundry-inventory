'use strict';

const express=require('express');
const config=require('../../config');
const {DomainError}=require('../../domain/errors');
const credentials=require('../../connections/postgres-credential-store');
const ingestion=require('../../connections/postgres-event-ingestion');
const webhookInbox=require('../../connections/postgres-webhook-inbox');
const providersDefault=require('../../connections/providers/registry');
const commercial=require('../../commercial/entitlements');
const commercialContext=require('../../commercial/context');
const {newId}=require('../../lib/util');

async function normalize(database,adapter,connection,input){
  const scope=await commercial.ownerScopeForWorkspace(database,connection.workspace_id);
  await commercial.assertCapability(database,scope,'connections.commerce');
  return commercialContext.run({database,scope,requestId:newId('verified-webhook')},()=>adapter.normalizeWebhook(input));
}

function requestOrigin(req,configured){
  const origin=configured==='request'?`${req.protocol}://${req.get('host')}`
    :(configured||config.connections.publicOrigin||`${req.protocol}://${req.get('host')}`);
  return String(origin).replace(/\/$/,'');
}

function parseBody(raw){
  if(!raw.length)return {};
  try{return JSON.parse(raw.toString('utf8'));}
  catch{const error=new Error('The provider webhook body is not valid JSON.');error.status=400;throw error;}
}

function apiError(res,error){
  if(!(error instanceof DomainError)&&Number(error.status)!==400)console.error('[postgres-provider-webhook] unexpected error',error);
  const status=error instanceof DomainError?error.status:(Number(error.status)===400?400:500);
  return res.status(status).json({error:{code:error.code||'provider_webhook_error',
    message:status===500?'StockChief could not safely apply that provider event.':error.message}});
}

function createPostgresProviderWebhooks(database,options={}){
  const router=express.Router();
  const providers=options.providers||providersDefault;
  router.post('/api/v1/connections/woocommerce/callback',express.json({limit:'16kb'}),async(req,res)=>{
    try{const connection=await require('../../connections/postgres-application-authorization').complete(database,'woocommerce',req.body||{},requestOrigin(req,options.publicOrigin),{providers,publicOrigin:requestOrigin(req,options.publicOrigin)});
      return res.status(200).json({connected:true,connectionId:connection.id});
    }catch(error){
      // Provider exceptions can contain the submitted credentials or their
      // request headers. Never serialize or log an authorization exception.
      const known=error instanceof DomainError;
      const status=known?error.status:([400,401,403,404,409,422,429,503].includes(Number(error.status))?Number(error.status):500);
      return res.status(status).json({error:{code:known?error.code:'store_authorization_failed',
        message:known?error.message:'The store could not verify this authorization. Check the public store address, API access and read/write permission, then try connecting again.'}});
    }
  });
  const handler=async(req,res)=>{
    try{
      const providerType=String(req.params.providerType||'').toLowerCase();
      const rows=(await database.query(`SELECT * FROM workspace_connectors WHERE id=$1 AND provider_type=$2
        AND status='connected' AND paused_at IS NULL`,[req.params.connectorId,providerType])).rows;
      if(!rows.length)return res.status(404).json({error:{code:'connection_not_found',
        message:`No active ${providerType} connection matched this webhook.`}});
      const connection={...rows[0],config:typeof rows[0].config==='string'?JSON.parse(rows[0].config||'{}'):(rows[0].config||{})};
      const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(String(req.body||''),'utf8');
      // WooCommerce's documented activation ping has no business payload or
      // signature. Acknowledge liveness only; never record it as verified work.
      if(providerType==='woocommerce'&&!req.headers['x-wc-webhook-signature']
          &&/^webhook_id=[1-9][0-9]*$/.test(rawBody.toString('utf8')))
        return res.status(200).json({ping:true,businessEvent:false});
      const adapter=providers.get(providerType);
      if(!adapter?.verifyWebhook||!adapter?.normalizeWebhook)return res.status(503).json({error:{code:'provider_unavailable',
        message:`${providerType} webhook handling is not configured.`}});
      const providerCredentials=await credentials.get(database,connection.workspace_id,connection.id,'provider');
      if(!providerCredentials)return res.status(409).json({error:{code:'credentials_missing',
        message:'Reconnect this provider before accepting its events.'}});
      const body=parseBody(rawBody);
      const webhookUrl=`${requestOrigin(req,options.publicOrigin)}${req.originalUrl}`;
      adapter.verifyWebhook({headers:req.headers,rawBody,webhookUrl,credentials:providerCredentials,connection,body});
      const receipt=await webhookInbox.receive(database,connection,{headers:req.headers,rawBody,body});
      // Acknowledge only after the encrypted receipt and durable job commit.
      // Provider API reads and business execution belong to the worker, so
      // slow upstream services cannot hold webhook delivery open or lose work.
      if(receipt.status==='COMPLETED')return res.status(200).json({received:true,receiptId:receipt.receiptId,
        processingStatus:'COMPLETED',accepted:0,replayed:(receipt.result?.results||[]).length,needsMapping:0});
      return res.status(202).json({received:true,receiptId:receipt.receiptId,processingStatus:receipt.status,accepted:0,replayed:0,needsMapping:0});
    }catch(error){return apiError(res,error);}
  };
  for(const providerType of ['shopify','square','woocommerce'])router.post(
    `/api/v1/connections/:providerType(${providerType})/webhooks/:connectorId`,
    express.raw({type:'*/*',limit:'1mb'}),handler);
  // Square subscriptions belong to the application, not individual merchants.
  // One signed destination serves any number of authorized merchant connections;
  // the merchant identity is authenticated again before tenant-scoped retention.
  // Existing connector-specific destinations remain supported during migration.
  router.post('/api/v1/connections/square/webhooks',express.raw({type:'*/*',limit:'1mb'}),async(req,res)=>{
    try{
      const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(String(req.body||''),'utf8'),body=parseBody(rawBody);
      if(typeof body.merchant_id!=='string'||!body.merchant_id||body.merchant_id.length>160)return res.status(400).json({error:{code:'merchant_identity_required',message:'The Square merchant identity is missing.'}});
      const rows=(await database.query(`SELECT c.* FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.provider_type='square' AND c.provider_account_id=$1 AND c.status='connected' AND c.paused_at IS NULL AND w.deletion_requested_at IS NULL`,[body.merchant_id])).rows;
      if(!rows.length)return res.status(200).json({received:true,ignored:true});
      const adapter=providers.get('square');if(!adapter?.verifyWebhook||!adapter?.normalizeWebhook)return res.status(503).json({error:{code:'provider_unavailable',message:'Square event handling is not configured.'}});
      const verified=[];for(const row of rows){const connection={...row,config:typeof row.config==='string'?JSON.parse(row.config||'{}'):(row.config||{})},providerCredentials=await credentials.get(database,row.workspace_id,row.id,'provider');if(!providerCredentials)continue;
        try{adapter.verifyWebhook({headers:req.headers,rawBody,body,webhookUrl:`${requestOrigin(req,options.publicOrigin)}${req.originalUrl}`,credentials:providerCredentials,connection});verified.push(connection);}
        catch(error){if(!(error instanceof DomainError))throw error;}
      }
      if(!verified.length)return res.status(401).json({error:{code:'invalid_provider_signature',message:'This Square event did not pass signature and merchant verification.'}});
      const receipts=[];for(const connection of verified){const receipt=await webhookInbox.receive(database,connection,{headers:req.headers,rawBody,body});receipts.push({id:receipt.receiptId,status:receipt.status});}
      return res.status(receipts.every(r=>r.status==='COMPLETED')?200:202).json({received:true,receipts});
    }catch(error){return apiError(res,error);}
  });
  router.post('/api/v1/connections/clover/webhooks',express.raw({type:'*/*',limit:'1mb'}),async(req,res)=>{
    try{
      const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(String(req.body||''),'utf8');
      const body=parseBody(rawBody);
      if(Object.hasOwn(body,'verificationCode')){
        if(Object.keys(body).length!==1)return res.status(400).json({error:{code:'invalid_verification_challenge',
          message:'Webhook verification must not include business events.'}});
        await require('../../connections/postgres-webhook-verification').retain(database,{provider:'clover',
          appId:config.connections.clover.clientId,environment:config.connections.clover.environment,code:body.verificationCode});
        return res.status(200).json({verificationCode:body.verificationCode});
      }
      const adapter=providers.get('clover');
      if(!adapter?.verifyWebhook||!adapter?.normalizeWebhook)return res.status(503).json({error:{code:'provider_unavailable',
        message:'Clover webhook handling is not configured.'}});
      const totals={accepted:0,replayed:0,needsMapping:0,ignored:0,results:[],merchants:0};
      for(const [merchantId,updates] of Object.entries(body.merchants||{})){
        const rows=(await database.query(`SELECT * FROM workspace_connectors WHERE provider_type='clover'
          AND provider_account_id=$1 AND status='connected' AND paused_at IS NULL ORDER BY updated_at DESC`,
        [merchantId])).rows;
        if(!rows.length){totals.ignored+=Array.isArray(updates)?updates.length:1;continue;}
        for(const row of rows){
          const connection={...row,config:typeof row.config==='string'?JSON.parse(row.config||'{}'):(row.config||{})};
          const providerCredentials=await credentials.get(database,connection.workspace_id,connection.id,'provider');
          if(!providerCredentials)continue;
          const merchantBody={...body,merchants:{[merchantId]:updates}};
          adapter.verifyWebhook({headers:req.headers,rawBody,body:merchantBody,
            webhookUrl:`${requestOrigin(req,options.publicOrigin)}${req.originalUrl}`,credentials:providerCredentials,connection});
          const events=await normalize(database,adapter,connection,{headers:req.headers,rawBody,body:merchantBody,
            credentials:providerCredentials,connection});
          const auth={workspaceId:connection.workspace_id,connectorId:connection.id,
            actorId:connection.authorized_by_user_id,displayName:connection.display_name,providerType:'clover'};
          const result=events.length?await ingestion.ingestBatch(database,auth,{events}):
            {accepted:0,replayed:0,needsMapping:0,results:[]};
          totals.accepted+=Number(result.accepted||0);totals.replayed+=Number(result.replayed||0);
          totals.needsMapping+=Number(result.needsMapping||0);totals.results.push(...(result.results||[]));totals.merchants+=1;
        }
      }
      return res.status(totals.needsMapping?207:200).json({received:true,...totals});
    }catch(error){return apiError(res,error);}
  });
  return router;
}

module.exports={createPostgresProviderWebhooks};

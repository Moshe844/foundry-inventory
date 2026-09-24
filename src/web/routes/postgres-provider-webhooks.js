'use strict';

const express=require('express');
const config=require('../../config');
const {DomainError}=require('../../domain/errors');
const credentials=require('../../connections/postgres-credential-store');
const ingestion=require('../../connections/postgres-event-ingestion');
const providersDefault=require('../../connections/providers/registry');

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
  const handler=async(req,res)=>{
    try{
      const providerType=String(req.params.providerType||'').toLowerCase();
      const rows=(await database.query(`SELECT * FROM workspace_connectors WHERE id=$1 AND provider_type=$2
        AND status='connected' AND paused_at IS NULL`,[req.params.connectorId,providerType])).rows;
      if(!rows.length)return res.status(404).json({error:{code:'connection_not_found',
        message:`No active ${providerType} connection matched this webhook.`}});
      const connection={...rows[0],config:typeof rows[0].config==='string'?JSON.parse(rows[0].config||'{}'):(rows[0].config||{})};
      const adapter=providers.get(providerType);
      if(!adapter?.verifyWebhook||!adapter?.normalizeWebhook)return res.status(503).json({error:{code:'provider_unavailable',
        message:`${providerType} webhook handling is not configured.`}});
      const providerCredentials=await credentials.get(database,connection.workspace_id,connection.id,'provider');
      if(!providerCredentials)return res.status(409).json({error:{code:'credentials_missing',
        message:'Reconnect Square before accepting provider events.'}});
      const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(String(req.body||''),'utf8');
      const body=parseBody(rawBody);
      const webhookUrl=`${requestOrigin(req,options.publicOrigin)}${req.originalUrl}`;
      adapter.verifyWebhook({headers:req.headers,rawBody,webhookUrl,credentials:providerCredentials,connection,body});
      const events=await adapter.normalizeWebhook({headers:req.headers,rawBody,body,
        credentials:providerCredentials,connection});
      if(!events.length)return res.status(200).json({received:true,accepted:0,replayed:0,needsMapping:0,results:[]});
      const auth={workspaceId:connection.workspace_id,connectorId:connection.id,
        actorId:connection.authorized_by_user_id,displayName:connection.display_name,providerType};
      const result=await ingestion.ingestBatch(database,auth,{events});
      return res.status(result.needsMapping?207:200).json({received:true,...result});
    }catch(error){return apiError(res,error);}
  };
  for(const providerType of ['shopify','square','woocommerce'])router.post(
    `/api/v1/connections/:providerType(${providerType})/webhooks/:connectorId`,
    express.raw({type:'*/*',limit:'1mb'}),handler);
  router.post('/api/v1/connections/clover/webhooks',express.raw({type:'*/*',limit:'1mb'}),async(req,res)=>{
    try{
      const rawBody=Buffer.isBuffer(req.body)?req.body:Buffer.from(String(req.body||''),'utf8');
      const body=parseBody(rawBody);
      if(body.verificationCode)return res.status(200).json({verificationCode:body.verificationCode});
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
          const events=await adapter.normalizeWebhook({headers:req.headers,rawBody,body:merchantBody,
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

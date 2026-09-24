'use strict';

const crypto=require('node:crypto');
const express=require('express');
const { requireAuth,requireOwner,asyncRoute }=require('../middleware');
const connections=require('../../connections/postgres-service');
const providerService=require('../../connections/postgres-provider-service');
const defaultProviders=require('../../connections/providers/registry');
const jobs=require('../../operations/postgres-job-queue');
const accountingSync=require('../../accounting/postgres-integration-sync');
const publicApi=require('../../connections/postgres-public-api');

function safeOrigin(value,fallback){
  try{return new URL(value).origin;}catch{return fallback;}
}

function oauthReturnPage(res,input){
  const returnOrigin=safeOrigin(input.returnOrigin,input.requestOrigin);
  const returnPath=input.connection?.id
    ? `/settings/connections/${encodeURIComponent(input.connection.id)}`:'/settings/connections';
  return res.status(input.connected?200:400).page('connections/oauth-return',{
    title:`${input.providerName||'Connection'} · StockChief`,layout:false,outcome:{
      connected:Boolean(input.connected),providerName:input.providerName||'Connection',message:input.message,
      workspaceId:input.connection?.workspace_id||null,returnUrl:`${returnOrigin}${returnPath}`,
      returnOrigin,returnPath,
    },
  });
}

function createPostgresConnectionsRouter(database,options={}){
  const router=express.Router();
  const registry=options.providers||defaultProviders;
  const callbackProviders=new Set((registry.catalog?registry.catalog():[]).map((provider)=>provider.type));

  async function renderConnections(req,res,apiToken=null){
    const launchTicket=crypto.randomBytes(24).toString('base64url');
    req.session.connectionLaunch={ticket:launchTicket,workspaceId:req.ctx.workspaceId,expiresAt:Date.now()+5*60000};
    return res.page('connections/postgres-index',{
      title:'Connections',nav:'connections',room:true,backTo:{href:'/settings',label:'Settings'},launchTicket,
      connections:await connections.list(database,req.ctx.workspaceId),providerCatalog:registry.catalog(),
      apiToken,apiClients:await publicApi.list(database,req.ctx.workspaceId),
    });
  }

  router.get('/settings/connections/:provider/callback',asyncRoute(async(req,res)=>{
    const providerType=String(req.params.provider||'').toLowerCase();
    if(!callbackProviders.has(providerType))return res.status(404).send('Connection provider not found.');
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    let context=null;
    let metadata=null;
    try{
      context=await providerService.callbackContext(database,req.query.state,providerType);
      metadata=registry.get(providerType)?.metadata();
      const connection=await providerService.completeOAuth(database,providerType,req.query,requestOrigin,{providers:registry,
        publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
      return oauthReturnPage(res,{connected:true,providerName:metadata?.name,connection,
        returnOrigin:context.returnOrigin,requestOrigin,message:`${metadata?.name||'The account'} is connected to this inventory.`});
    }catch(error){
      return oauthReturnPage(res,{connected:false,providerName:metadata?.name||'Connection',
        connection:context?.connection,returnOrigin:context?.returnOrigin,requestOrigin,
        message:error.message||'The connection was not completed.'});
    }
  }));

  router.use('/settings/connections',requireAuth);
  router.get('/settings/connections',asyncRoute(async(req,res)=>{
    const apiToken=req.session.newPublicApiToken||null;
    delete req.session.newPublicApiToken;
    return renderConnections(req,res,apiToken);
  }));
  router.get('/settings/connections/:provider/launch',requireOwner,asyncRoute(async(req,res)=>{
    const launch=req.session.connectionLaunch;
    delete req.session.connectionLaunch;
    if(!launch||launch.workspaceId!==req.ctx.workspaceId||launch.expiresAt<Date.now()
        ||typeof req.query.ticket!=='string'||req.query.ticket.length!==launch.ticket.length
        ||!crypto.timingSafeEqual(Buffer.from(req.query.ticket),Buffer.from(launch.ticket))){
      return res.status(403).send('This connection window expired. Return to Connections and try again.');
    }
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const started=await providerService.beginAuthorization(database,req.ctx,{providerType:req.params.provider,
      popup:'1'},requestOrigin,{providers:registry,
      publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
    return res.redirect(303,started.redirectUrl);
  }));
  router.get('/settings/connections/:id',asyncRoute(async(req,res)=>{
    const newConnectionToken=req.session.newConnectionToken||null;
    delete req.session.newConnectionToken;
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    const adapter=registry.get(connection.provider_type);
    if(adapter?.integrationClass==='accounting'){
      let current=await accountingSync.state(database,req.ctx.workspaceId,connection.id);
      if(!current&&connection.config?.verifiedFact){await accountingSync.initialize(database,connection,req.ctx.actorId,
        connection.config.verifiedFact);current=await accountingSync.state(database,req.ctx.workspaceId,connection.id);}
      connection.accounting=current;
      if(current&&adapter.listPostingParties){const missingTypes=[...new Set(current.pendingEntries
        .flatMap((entry)=>entry.missingParties).flatMap((line)=>[
          line.customer_id&&!line.external_customer_id?'customer':null,
          line.supplier_id&&!line.external_supplier_id?'supplier':null]).filter(Boolean))];
        if(missingTypes.length){connection.accounting.externalParties={};
          try{const providerCredentials=await providerService.loadProviderCredentials(database,connection,adapter);
            for(const partyType of missingTypes)connection.accounting.externalParties[partyType]=
              await adapter.listPostingParties({credentials:providerCredentials,partyType});
          }catch(error){connection.accounting.externalPartiesError=error.message;}}
      }
    }
    return res.page('connections/postgres-detail',{
      title:'Connection',nav:'connections',room:true,backTo:{href:'/settings/connections',label:'Connections'},
      connection,newConnectionToken,canDiscover:Boolean(registry.get(connection.provider_type)?.discover),
    });
  }));
  router.post('/settings/connections/:id/accounting/authority',requireOwner,asyncRoute(async(req,res)=>{
    await accountingSync.chooseAuthority(database,req.ctx,req.params.id,req.body.authority);
    req.flash('success',req.body.authority==='POST'
      ?'Posting requested. Exact account mapping and a matching shadow comparison are still required.'
      :'This connection remains read-only.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/map-account',requireOwner,asyncRoute(async(req,res)=>{
    await accountingSync.mapAccount(database,req.ctx,req.params.id,req.body);
    req.flash('success','Exact posting account mapping saved. No journal was exported.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/map-party',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    const adapter=registry.get(connection.provider_type);const partyType=String(req.body.partyType||'').toLowerCase();
    if(!adapter?.listPostingParties)throw new Error('This accounting provider does not require posting-party mappings.');
    const providerCredentials=await providerService.loadProviderCredentials(database,connection,adapter);
    const choices=await adapter.listPostingParties({credentials:providerCredentials,partyType});
    const external=choices.find((row)=>String(row.externalId)===String(req.body.externalId));
    if(!external)throw new Error(`That ${partyType} is not present in the provider’s current list.`);
    await accountingSync.mapParty(database,req.ctx,req.params.id,{...req.body,partyType,external,
      version:external.version});
    req.flash('success',`Exact ${partyType} posting identity saved. No journal was exported.`);
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/shadow',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    const adapter=registry.get(connection.provider_type);
    const providerCredentials=await providerService.loadProviderCredentials(database,connection,adapter);
    const result=await accountingSync.shadow(database,req.ctx,req.params.id,adapter,providerCredentials,{asOf:req.body.asOf});
    req.flash(result.status==='MATCHED'?'success':'warn',result.status==='MATCHED'
      ?'Shadow comparison matched exactly. Posting still requires one explicit enable step.'
      :`${result.differences.length} accounting difference(s) remain. Nothing was exported.`);
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/enable',requireOwner,asyncRoute(async(req,res)=>{
    await accountingSync.enableWrites(database,req.ctx,req.params.id);
    req.flash('success','Governed journal posting enabled for this inventory and this provider account.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/accounting/export',requireOwner,asyncRoute(async(req,res)=>{
    const result=await accountingSync.queuePending(database,req.ctx,req.params.id,{});
    req.flash('success',result.queued
      ?`${result.queued} journal export${result.queued===1?'':'s'} queued. The worker—not this browser—will call the provider.`
      :'No ready journal needed export.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:provider/authorize',requireOwner,asyncRoute(async(req,res)=>{
    const requestOrigin=`${req.protocol}://${req.get('host')}`;
    const started=await providerService.beginAuthorization(database,req.ctx,{...req.body,
      providerType:req.params.provider},requestOrigin,{providers:registry,
      publicOrigin:options.publicOrigin==='request'?requestOrigin:options.publicOrigin});
    return res.redirect(303,started.redirectUrl);
  }));
  router.post('/settings/connections/custom',requireOwner,asyncRoute(async(req,res)=>{
    const created=await connections.createFeed(database,req.ctx,req.body);
    req.session.newConnectionToken=created.token;
    req.flash('success','Connection created. Copy its token now; StockChief will not show it again.');
    return res.redirect(303,`/settings/connections/${created.connection.id}`);
  }));
  router.post('/settings/connections/api-clients',requireOwner,asyncRoute(async(req,res)=>{
    const apiToken=await publicApi.create(database,req.ctx,{name:req.body.name,scopes:req.body.scopes});
    res.locals.flash.push({type:'success',message:'API client created. Copy its token now; StockChief will not show it again.'});
    return renderConnections(req,res,apiToken);
  }));
  router.post('/settings/connections/api-clients/:id/revoke',requireOwner,asyncRoute(async(req,res)=>{
    await publicApi.revoke(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','API client revoked immediately. Its token no longer works.');
    return res.redirect(303,'/settings/connections#developer-api');
  }));
  router.post('/settings/connections/:id/pause',requireOwner,asyncRoute(async(req,res)=>{
    await connections.pause(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','Connection paused. StockChief will not process new work from it.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/resume',requireOwner,asyncRoute(async(req,res)=>{
    await connections.resume(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','Connection resumed.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  router.post('/settings/connections/:id/refresh',requireOwner,asyncRoute(async(req,res)=>{
    const connection=await connections.get(database,req.ctx.workspaceId,req.params.id);
    if(!registry.get(connection.provider_type)?.discover)throw new Error('This connection does not expose provider catalogue discovery.');
    const bucket=Math.floor(Date.now()/60000);
    await jobs.enqueue(database,{workspaceId:req.ctx.workspaceId,kind:'provider.catalog-sync',
      idempotencyKey:`provider-catalog-sync:${connection.id}:manual:${bucket}`,
      payload:{connectorId:connection.id,source:'manual'},priority:25,maxAttempts:5});
    return res.redirect(303,`/settings/connections/${connection.id}?refresh=queued`);
  }));
  router.post('/settings/connections/:id/disconnect',requireOwner,asyncRoute(async(req,res)=>{
    await connections.disconnect(database,req.ctx.workspaceId,req.params.id);
    req.flash('success','Connection disconnected. Credentials were removed; mappings and audit history remain.');
    return res.redirect(303,`/settings/connections/${req.params.id}`);
  }));
  return router;
}

module.exports={createPostgresConnectionsRouter};

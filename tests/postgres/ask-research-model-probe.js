'use strict';

// Opt-in synthetic model probe. Never uses a production workspace or mailbox.
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const assistant=require('../../src/assistant/postgres-service');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const {newId,nowIso}=require('../../src/lib/util');

(async()=>{
  if(!config.ai.configured){console.log('Real model unavailable in this environment.');return;}
  const cluster=await startCluster();
  const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-research-model-probe'});
  try{
    await migratePostgres(database);
    const business=await auth.createBusiness(database,{businessName:'Synthetic Research Business',
      name:'Synthetic Owner',email:'research-probe@example.test',password:'research-probe-password'});
    const ctx={workspaceId:business.workspaceId,actorId:business.userId};
    const place=await locations.createLocation(database,ctx,{name:'North Stockroom',kind:'stockroom'});
    const item=await catalog.createItem(database,ctx,{name:'Blue Work Glove',baseCode:'GLOVE',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:7,
      reference:'OPENING-GLOVES',idempotencyKey:'research-probe-opening'});
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    for(const question of [
      'What product do I actually have, how many, and where?',
      'Did we record any customer sales or orders yet?',
      'What is its selling price?',
      'What happened to the gloves in the stockroom?',
    ]){
      const result=await assistant.ask(database,ctx,question,{provider,usageKey:`probe-${question.length}`});
      console.log(JSON.stringify({question,status:result.status,answer:result.answer,views:result.researchViews||[],
        evidence:result.rows?.length||0}));
      assert.notEqual(result.status,'PREPARED','read-only questions must never prepare a change');
    }
    const email=await assistant.ask(database,ctx,'Email a supplier named Orbit Supply and ask when they can deliver.',
      {provider,usageKey:'probe-unknown-supplier-email'});
    console.log(JSON.stringify({question:'Email unknown supplier',status:email.status,answer:email.answer,
      missing:email.awaitingField}));
    assert.equal(email.status,'CLARIFY');
    assert.equal(email.awaitingField,'recipientEmail');
    const purchase=await assistant.ask(database,ctx,'Whatever I have in stock, get 20 more.',
      {provider,usageKey:'probe-stocked-replenishment'});
    console.log(JSON.stringify({question:'Get 20 more of stocked product',status:purchase.status,
      answer:purchase.answer,action:purchase.intent.action,sku:purchase.intent.sku}));
    assert.equal(purchase.intent.action,'create_purchase_order');
    assert.equal(purchase.intent.sku,'GLOVE');
    const connectorId=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,
       expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
      VALUES($1,$2,$3,'Synthetic mailbox','gmail',$4,'{}','connected',$5,$6,5,'CONNECTED',$7,'probe-mailbox',
        'business@example.test',$8,$8)`,[connectorId,ctx.workspaceId,`gmail:${connectorId}`,JSON.stringify(['business mail']),
      JSON.stringify(['mail:read','mail:send']),`connection_credentials:${connectorId}`,ctx.actorId,at]);
    const drafted=await assistant.ask(database,ctx,
      'Email glove-buyer@example.test and say we recieved seven gloves, will confirm thursday.',
      {provider,usageKey:'probe-email-polish'});
    assert.equal(drafted.status,'PREPARED');
    const proposal=await assistant.getProposal(database,ctx.workspaceId,drafted.proposal.id);
    console.log(JSON.stringify({question:'Draft one email',status:drafted.status,
      recipient:proposal.payload.recipientEmail,subject:proposal.payload.subject,body:proposal.payload.body,
      polished:proposal.payload.draftPolished}));
    assert.equal(proposal.payload.recipientEmail,'glove-buyer@example.test');
    assert.equal(proposal.payload.draftPolished,true);
    assert.doesNotMatch(proposal.payload.body,/recieved/i);
  }finally{await database.close();cluster.stop();}
})().catch((error)=>{console.error(error);process.exitCode=1;});

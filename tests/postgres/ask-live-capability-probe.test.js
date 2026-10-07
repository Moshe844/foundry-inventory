'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const config=require('../../src/config');
const {createProviderUnobserved}=require('../../src/ai/provider');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const commerce=require('../../src/operations/postgres-commerce');
const pricing=require('../../src/pricing/postgres-service');
const assistant=require('../../src/assistant/postgres-service');

test('live model chooses registered capabilities for wording absent from the implementation',
  {skip:process.env.STOCKCHIEF_ASK_LIVE_PROBE!=='1',timeout:240000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-capability-live-probe'});
    await migratePostgres(database);context.after(async()=>{await database.close();cluster.stop();});
    const business=await auth.createBusiness(database,{businessName:'Cedar Workshop',name:'Workshop Owner',
      email:'cedar-workshop@example.test',password:'test-password-only'});
    const scope={workspaceId:business.workspaceId,actorId:business.userId};
    await locations.createLocation(database,scope,{name:'Cedar Store',kind:'warehouse'});
    const item=await catalog.createItem(database,scope,{name:'Blue Work Glove',trackingMode:'quantity'});
    await commerce.createSupplier(database,scope,{name:'Cedar Supply',email:'cedar-supply@example.test'});
    await pricing.setPurchaseCost(database,scope,{skuId:item.skuIds[0],amount:'4.00',currency:'USD',source:'test'});
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const read=await assistant.ask(database,scope,'What is the whole place holding right now?',
      {provider,usageKey:'live-capability-read'});
    assert.ok(['read.inventory_summary','read.inventory'].includes(read.intent?.controlPlane?.capability),JSON.stringify({
      status:read.status,answer:read.answer,intent:read.intent}));
    assert.equal(read.status,'ANSWERED');
    const action=await assistant.ask(database,scope,'A case of eleven gloves just arrived; put the receipt on the books.',
      {provider,usageKey:'live-capability-receipt'});
    assert.equal(action.intent?.controlPlane?.capability,'inventory.receive',JSON.stringify({
      status:action.status,answer:action.answer,intent:action.intent}));
    assert.equal(action.status,'PREPARED',JSON.stringify({answer:action.answer,intent:action.intent}));
    const total=(await database.query('SELECT COALESCE(SUM(on_hand),0) AS units FROM balances WHERE workspace_id=$1',
      [scope.workspaceId])).rows[0];
    assert.equal(Number(total.units),0);
    const externalOrder=await assistant.ask(database,scope,
      'We need more Blue Work Gloves. Get another batch coming.',
      {provider,usageKey:'live-capability-external-order'});
    assert.ok(['CLARIFY','PREPARED'].includes(externalOrder.status),JSON.stringify(externalOrder));
    if(externalOrder.status==='PREPARED'){
      assert.equal(externalOrder.intent?.controlPlane?.capability,'purchase_order.create');
      assert.match(externalOrder.answer,/draft/i);
      assert.match(externalOrder.answer,/Nothing has changed yet/i);
    }else assert.equal(externalOrder.proposal,undefined);
    const replenishment=await assistant.ask(database,scope,
      'Please prepare a purchase order for more Blue Work Gloves for my approval.',
      {provider,usageKey:'live-capability-replenishment'});
    assert.equal(replenishment.intent?.controlPlane?.capability,'purchase_order.create',
      JSON.stringify({status:replenishment.status,answer:replenishment.answer,intent:replenishment.intent}));
    assert.ok(['CLARIFY','PREPARED'].includes(replenishment.status),JSON.stringify(replenishment));
    if(replenishment.status==='PREPARED')assert.match(replenishment.answer,/draft.*Nothing has changed yet/i);
    else assert.match(replenishment.answer,/how many|quantity|could not confidently/i);
    assert.equal((await database.query('SELECT COUNT(*)::int AS n FROM purchase_orders WHERE workspace_id=$1',
      [scope.workspaceId])).rows[0].n,0,'A prepared draft must never be mistaken for a placed order.');
  });

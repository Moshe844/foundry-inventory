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
    await catalog.createItem(database,scope,{name:'Blue Work Glove',trackingMode:'quantity'});
    const provider=createProviderUnobserved(config.ai.provider,config.ai.tier('fast'));
    const read=await assistant.ask(database,scope,'What is the whole place holding right now?',
      {provider,usageKey:'live-capability-read'});
    assert.equal(read.intent?.controlPlane?.capability,'read.inventory_summary',JSON.stringify({
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
  });

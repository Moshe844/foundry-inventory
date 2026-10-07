'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const assistant=require('../../src/assistant/postgres-service');

test('Ask research reads real inventory positions, stock history and prices within one business only',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-research-tools'});
    await migratePostgres(database);
    context.after(async()=>{await database.close();cluster.stop();});
    const first=await auth.createBusiness(database,{businessName:'Research One',name:'First Owner',
      email:'research-one@example.test',password:'research-password'});
    const second=await auth.createBusiness(database,{businessName:'Research Two',name:'Second Owner',
      email:'research-two@example.test',password:'research-password'});
    const owner={workspaceId:first.workspaceId,actorId:first.userId};
    const other={workspaceId:second.workspaceId,actorId:second.userId};
    const place=await locations.createLocation(database,owner,{name:'North Stockroom',kind:'stockroom'});
    const item=await catalog.createItem(database,owner,{name:'Blue Work Glove',baseCode:'GLOVE',trackingMode:'quantity'});
    await inventory.receive(database,owner,{skuId:item.skuIds[0],locationId:place.id,quantity:7,
      reference:'OPENING-GLOVES',idempotencyKey:'opening-gloves'});
    const positions=await assistant.lookup(database,owner,{view:'inventory_positions',search:'Blue Work Glove'});
    assert.equal(positions.rows.length,1);
    assert.equal(positions.rows[0].location,'North Stockroom');
    assert.equal(positions.rows[0].onHand,7);
    const changes=await assistant.lookup(database,owner,{view:'inventory_movements',search:'Blue Work Glove'});
    assert.equal(changes.rows.length,1);
    assert.equal(changes.rows[0].change,7);
    assert.equal(changes.rows[0].reference,'OPENING-GLOVES');
    const prices=await assistant.lookup(database,owner,{view:'prices',search:'Blue Work Glove'});
    assert.equal(prices.rows[0].sellingPrice,'Not recorded');
    const costs=await assistant.lookup(database,owner,{view:'purchase_costs',search:'Blue Work Glove'});
    assert.equal(costs.rows[0].purchaseCost,'Not recorded');
    const supplierItems=await assistant.lookup(database,owner,{view:'supplier_items',search:'Blue Work Glove'});
    assert.equal(supplierItems.rows.length,0);
    for(const view of ['inventory_positions','inventory_movements','prices','purchase_costs','supplier_items']){
      const result=await assistant.lookup(database,other,{view,search:'Blue Work Glove'});
      assert.equal(result.rows.length,0,`${view} must never read another business`);
    }
  });

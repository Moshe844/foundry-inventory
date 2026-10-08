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
const costing=require('../../src/accounting/postgres-costing');
const assistant=require('../../src/assistant/postgres-service');
const research=require('../../src/assistant/postgres-research');
const control=require('../../src/assistant/postgres-control-plane');

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
    const opening=await inventory.receive(database,owner,{skuId:item.skuIds[0],locationId:place.id,quantity:7,
      reference:'OPENING-GLOVES',idempotencyKey:'opening-gloves'});
    await database.transaction((client)=>costing.receiveInTransaction(client,owner,{
      movementId:opening.movementId,totalCostMinor:126,unitCostMinor:18,
      sourceType:'opening_inventory',sourceRecordId:opening.movementId}));
    const summary=await assistant.lookup(database,owner,{view:'inventory_summary'});
    assert.deepEqual(summary.rows,[{products:1,skus:1,onHand:7,productsEver:1}]);
    assert.match(summary.answer,/7 units on hand/);
    const otherSummary=await assistant.lookup(database,other,{view:'inventory_summary'});
    assert.deepEqual(otherSummary.rows,[{products:0,skus:0,onHand:0,productsEver:0}]);
    const grounded=await research.research(database,owner,'How many units are on hand in this inventory?',{
      plannedQueries:[{view:'inventory_summary',search:null,timeframe:'all_time'}],
      answerProvider:{complete(){throw new Error('A single verified inventory summary needs no model synthesis.');}},
      lookup:assistant.lookup,
    });
    assert.equal(grounded.status,'ANSWERED');
    assert.match(grounded.answer,/7 units on hand/);
    assert.deepEqual(grounded.researchViews,['inventory_summary']);
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
    const valuation=await assistant.lookup(database,owner,{view:'inventory_valuation',search:'Blue Work Glove'});
    assert.equal(valuation.rows[0].inventoryBookCost,'$1.26');
    assert.equal(valuation.rows[0].averageRecordedUnitCost,'$0.18');
    assert.equal(valuation.rows[0].costedUnits,7);
    const costChanges=await assistant.lookup(database,owner,{view:'inventory_cost_movements',search:'Blue Work Glove'});
    assert.equal(costChanges.rows[0].bookCostChange,'$1.26');
    assert.equal(costChanges.rows[0].recordedUnitCost,'$0.18');
    assert.equal(costChanges.rows[0].change,7);
    const seen=[];
    const badPlanner={complete:async(request)=>{
      if(request.schemaName==='stockchief_capability_plan')return {data:{steps:[{capability:'read.inventory_summary',
        arguments:[],dependsOn:[],continuesPending:false}],clarifyingQuestion:'',closestAlternative:''}};
      if(request.schemaName==='stockchief_capability_answer'){
        const evidence=JSON.parse(request.prompt).evidence;
        seen.push(...evidence.map((entry)=>entry.capability));
        return {data:{answer:'7 gloves were recorded at $0.18 each, for $1.26 of book cost.',
          supported:true,usedSteps:[1,2,3],additionalReads:[]}};
      }
      throw new Error(`Unexpected model stage: ${request.schemaName}`);
    }};
    const groundedSku=await control.run(assistant,database,owner,
      'For GLOVE, what is its quantity and recorded book cost?',{provider:badPlanner});
    assert.equal(groundedSku.outcomes[0].result.status,'ANSWERED');
    assert.ok(seen.includes('read.inventory_valuation'));
    assert.ok(seen.includes('read.inventory_cost_movements'));
    assert.ok(seen.includes('read.inventory'));
    await inventory.receive(database,owner,{skuId:item.skuIds[0],locationId:place.id,quantity:2,
      reference:'UNCOSTED-ARRIVAL',idempotencyKey:'uncosted-arrival'});
    const physical=await assistant.lookup(database,owner,{view:'inventory',search:'GLOVE'});
    assert.equal(physical.rows[0].onHand,9);
    assert.equal(physical.rows[0].costedUnits,7);
    assert.equal(physical.rows[0].unitsMissingCost,2);
    assert.match(physical.answer,/2 on-hand units have no recorded inventory cost/);
    const supplierItems=await assistant.lookup(database,owner,{view:'supplier_items',search:'Blue Work Glove'});
    assert.equal(supplierItems.rows.length,0);
    for(const view of ['inventory_positions','inventory_movements','inventory_valuation',
      'inventory_cost_movements','prices','purchase_costs','supplier_items']){
      const result=await assistant.lookup(database,other,{view,search:'Blue Work Glove'});
      assert.equal(result.rows.length,0,`${view} must never read another business`);
    }
  });

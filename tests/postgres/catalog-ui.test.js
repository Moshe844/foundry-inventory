'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');

function csrfFrom(html){
  const value=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if(!value)throw new Error('No CSRF token in response');
  return value;
}

async function register(agent,email,businessName){
  const page=await agent.get('/register');
  return agent.post('/register').type('form').send({_csrf:csrfFrom(page.text),name:'Catalog Owner',
    businessName,email,password:'catalog-password'});
}

test('PostgreSQL rendered UI completes onboarding, catalog, location and stock truth without SQLite',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-catalog-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-catalog-ui-secret'});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});

    const agent=request.agent(app);
    const registration=await register(agent,'catalog-owner@example.test','Harbour Clothing');
    assert.equal(registration.status,302);
    assert.equal(registration.headers.location,'/onboarding');

    const onboardingPage=await agent.get('/onboarding');
    assert.equal(onboardingPage.status,200);
    assert.match(onboardingPage.text,/Move from files/);
    assert.match(onboardingPage.text,/Connect another system/);
    assert.match(onboardingPage.text,/Enter it manually/);
    assert.doesNotMatch(onboardingPage.text,/Use several sources/);
    assert.doesNotMatch(onboardingPage.text,/Use email attachments/);
    assert.match(onboardingPage.text,/value="Harbour Clothing"/);

    const choose=await agent.post('/onboarding/choose').type('form').send({_csrf:csrfFrom(onboardingPage.text),path:'fresh'});
    assert.equal(choose.status,303);
    assert.equal(choose.headers.location,'/inventory/new');

    const locationsPage=await agent.get('/locations');
    assert.equal(locationsPage.status,200);
    assert.match(locationsPage.text,/No locations yet/);
    const location=await agent.post('/locations').type('form').send({_csrf:csrfFrom(locationsPage.text),
      name:'Main Warehouse',kind:'warehouse',address:'12 Depot Road\nMonroe, NY 10950',pickSequence:'0'});
    assert.equal(location.status,303);

    const newItem=await agent.get('/inventory/new');
    assert.equal(newItem.status,200);
    const created=await agent.post('/inventory').type('form').send({_csrf:csrfFrom(newItem.text),name:'Trail Shoe',
      baseCode:'SHOE',unitLabel:'pair',trackingMode:'quantity',hasVariants:'1',
      'options[0][name]':'Colour','options[0][values]':'Black, White',
      'options[1][name]':'Size','options[1][values]':'8, 9'});
    assert.equal(created.status,303);
    assert.match(created.headers.location,/^\/inventory\/item_/);
    const itemId=created.headers.location.split('/').pop();

    const detail=await agent.get(created.headers.location);
    assert.equal(detail.status,200);
    assert.match(detail.text,/Trail Shoe/);
    assert.match(detail.text,/4 variants/);
    assert.match(detail.text,/SHOE-BLACK-8/);
    const identity=(await database.query(`SELECT w.id AS workspace_id,l.id AS location_id,s.id AS sku_id
      FROM workspaces w JOIN locations l ON l.workspace_id=w.id JOIN skus s ON s.workspace_id=w.id
      WHERE w.name='Harbour Clothing' AND l.name='Main Warehouse' AND s.code='SHOE-BLACK-8'`)).rows[0];
    assert.ok(identity);

    const received=await agent.post(`/inventory/${itemId}/receive`).type('form').send({_csrf:csrfFrom(detail.text),
      skuId:identity.sku_id,locationId:identity.location_id,quantity:'7',reference:'OPENING-1',
      idempotencyKey:'catalog-ui-opening-one'});
    assert.equal(received.status,303);
    const afterReceipt=await agent.get(`/inventory/${itemId}`);
    assert.match(afterReceipt.text,/>7<\/span><span class="rm-stat__d">pairs on hand/);
    assert.match(afterReceipt.text,/OPENING-1/);

    const issued=await agent.post(`/inventory/${itemId}/issue`).type('form').send({_csrf:csrfFrom(afterReceipt.text),
      skuId:identity.sku_id,locationId:identity.location_id,quantity:'2',reasonCode:'sold',reference:'SO-UI-1',
      idempotencyKey:'catalog-ui-issue-one'});
    assert.equal(issued.status,303);
    const inventoryPage=await agent.get('/inventory');
    assert.equal(inventoryPage.status,200);
    assert.match(inventoryPage.text,/Trail Shoe/);
    assert.match(inventoryPage.text,/>5<\/strong>/);
    const truth=(await database.query(`SELECT b.on_hand,o.status FROM balances b
      JOIN workspace_onboarding o ON o.workspace_id=b.workspace_id
      WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=$3`,
    [identity.workspace_id,identity.sku_id,identity.location_id])).rows[0];
    assert.equal(truth.on_hand,'5');
    assert.equal(truth.status,'ready');

    const stranger=request.agent(app);
    await register(stranger,'other-owner@example.test','Other Business');
    const hidden=await stranger.get(`/inventory/${itemId}`);
    assert.equal(hidden.status,404);
    assert.doesNotMatch(hidden.text,/Trail Shoe/);
  });

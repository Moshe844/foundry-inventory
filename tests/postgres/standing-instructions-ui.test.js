'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');

function change(domain,values={}){return {domain,operation:'set',sku:'',supplier:'',location:'',sourceLocation:'',
  reorderPoint:-1,targetStock:-1,safetyStock:-1,leadTimeDays:-1,unitsPerPurchaseUnit:-1,
  minimumOrderQuantity:-1,orderMultiple:-1,maximumQuantity:-1,maximumValue:-1,weeklyValue:-1,daysOfStock:-1,
  preferTransferBeforePurchasing:false,guardMode:'',guardComparator:'',guardThreshold:-1,
  guardReleaseCondition:'',...values};}
function json(value){return typeof value==='string'?JSON.parse(value):value;}

const provider={async complete(input){
  if(input.schemaName==='stockchief_postgres_request')return {data:{intent:'instruction',view:null,action:null,
    search:null,sku:null,location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,reason:null,reference:null}};
  if(input.schemaName==='postgres_operating_instruction')return {data:{understood:true,
    summary:'Keep Rule Widget replenished within bounded automatic authority',clarifyingQuestion:'',unsupportedReason:'',changes:[
      change('replenishment',{sku:'RULE-1',reorderPoint:8,targetStock:20,safetyStock:3}),
      change('transfer_authority',{sourceLocation:'Main Warehouse',location:'Overflow Warehouse',maximumQuantity:5}),
      change('purchase_authority',{supplier:'Acme Supply',maximumValue:500,weeklyValue:1500}),
      change('operating_preference',{preferTransferBeforePurchasing:true}),
    ]}};
  throw new Error(`Unexpected model schema ${input.schemaName}`);
}};

test('real Chromium approves one free-form PostgreSQL standing instruction without prompt-based authority',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,
      {applicationName:'stockchief-postgres-standing-instructions'});await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-standing-instruction-secret',aiProvider:provider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();
      await new Promise((resolve)=>server.close(resolve));await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Rule Business');await page.getByLabel('Your name').fill('Rule Owner');
    await page.getByLabel('Work email').fill('rules@example.test');await page.getByLabel('Password').fill('rules-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='rules@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    await locations.createLocation(database,ctx,{name:'Overflow Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Rule Widget',baseCode:'RULE-1',trackingMode:'quantity',unitLabel:'unit'});
    const at='2026-09-23T00:00:00.000Z';await database.query(`INSERT INTO suppliers
      (id,workspace_id,name,status,currency,created_at,updated_at) VALUES('rule-supplier',$1,'Acme Supply','active','USD',$2,$2)`,
    [ctx.workspaceId,at]);
    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill(
      'Keep Rule Widget replenished, transfer before buying, and automatically handle only the exact limits I stated.');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/Nothing is in force yet/);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM reorder_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM automation_policies WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    await Promise.all([page.waitForURL(/\/operating-instructions\/oin_/),page.getByRole('link',{name:'Review prepared change'}).click()]);
    const review=await page.locator('main').innerText();assert.match(review,/reorder at 8, target 20, safety stock 3/);
    assert.match(review,/automatic transfers up to 5 units/);assert.match(review,/\$500\.00 each and \$1500\.00 per rolling seven days/);
    assert.match(review,/Prefer transfers before purchasing/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve standing rule'}).click()]);
    assert.match(await page.locator('main').innerText(),/In force/);
    const reorder=(await database.query(`SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2`,
      [ctx.workspaceId,item.skuIds[0]])).rows[0];
    assert.equal(Number(reorder.reorder_point),8);assert.equal(Number(reorder.target_stock),20);assert.equal(Number(reorder.safety_stock),3);
    const policies=(await database.query(`SELECT allowed_action_types,maximum_quantity,maximum_value,thresholds
      FROM automation_policies WHERE workspace_id=$1 AND enabled=1 AND approved_at IS NOT NULL ORDER BY created_at`,[ctx.workspaceId])).rows;
    assert.equal(policies.length,2);assert.deepEqual(policies.map((row)=>json(row.allowed_action_types)),[['transfer'],['approve_purchase_order']]);
    assert.equal(Number(policies[0].maximum_quantity),5);assert.equal(Number(policies[1].maximum_value),500);
    assert.equal(Number(json(policies[1].thresholds).maxValuePerWeek),1500);
    assert.equal((await database.query(`SELECT mode FROM workspace_autopilot WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0].mode,
      'POLICY_AUTOMATED');
    assert.equal(JSON.parse((await database.query(`SELECT value FROM operational_preferences WHERE workspace_id=$1
      AND key='prefer_transfer_before_purchasing'`,[ctx.workspaceId])).rows[0].value),true);
    await page.goto(`${base}/what-you-told-me`);const transcript=await page.locator('main').innerText();
    assert.match(transcript,/Keep Rule Widget replenished within bounded automatic authority/);
    assert.match(transcript,/1 standing rule/);assert.deepEqual(errors,[]);
  });

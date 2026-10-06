'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const {newId,nowIso}=require('../../src/lib/util');
const {fixture}=require('../helpers/postgres-model-fixture');

function csrfFrom(html){const token=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];if(!token)throw new Error('Missing CSRF token');return token;}

test('PostgreSQL Home leads with the owner briefing and never credits a human movement to StockChief',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-home-ui'});
    await migratePostgres(database);
    const aiProvider=fixture({name:'home-test-model',model:'fixture',async complete(request){
      const message=JSON.parse(request.prompt).message;
      return {data:{intent:'lookup',view:/products/i.test(message)?'inventory_summary':'needs_you',search:null},usage:{}};
    }});
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-home-secret',aiProvider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);
    const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrfFrom(registration.text),name:'Alex Rivera',
      businessName:'Rivera Supply',email:'home-owner@example.test',password:'home-password'});
    const firstDay=await agent.get('/');
    assert.equal(firstDay.status,200);
    assert.match(firstDay.text,/StockChief is ready\. Your inventory isn’t here yet/);
    assert.match(firstDay.text,/No business check yet/);
    assert.match(firstDay.text,/Add your inventory/);
    assert.match(firstDay.text,/Ask or tell StockChief\./);
    assert.doesNotMatch(firstDay.text,/Everything is under control/);
    assert.doesNotMatch(firstDay.text,/Check overdue/);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='home-owner@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'White Medium',baseCode:'WM',trackingMode:'quantity',unitLabel:'unit'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:48,
      reference:'OPENING-COUNT',idempotencyKey:'home-opening-count'});
    const response=await agent.get('/');
    assert.equal(response.status,200,response.text.slice(0,700));
    assert.match(response.text,/Good (?:morning|afternoon|evening), Alex/);
    assert.match(response.text,/Ask or tell StockChief\./);
    assert.match(response.text,/Needs you/);
    assert.match(response.text,/Coming up/);
    assert.match(response.text,/StockChief noticed/);
    assert.match(response.text,/StockChief has not checked them yet/);
    assert.doesNotMatch(response.text,/White Medium inventory changed/);
    assert.match(response.text,/\/home\.css\?/);
    assert.match(response.text,/Your inventory is here\. Let’s do the first check/);
    assert.match(response.text,/First check needed/);
    assert.match(response.text,/Pause automatic work/);
    assert.doesNotMatch(response.text,/Nothing needs you\./);
    const check=await agent.post('/autopilot/run').type('form').send({_csrf:csrfFrom(response.text),returnToHome:'1'});
    assert.equal(check.status,303);
    assert.equal(check.headers.location,'/');
    const checkedHome=await agent.get('/');
    assert.match(checkedHome.text,/Everything is under control/);
    assert.match(checkedHome.text,/Last checked just now/);
    const at=nowIso();
    await database.query(`INSERT INTO attention_items
      (id,workspace_id,fingerprint,category,severity,priority_score,title,concise_summary,explanation,recommendation,
       affected_entity_type,item_id,confidence,status,detection_rule_version,first_detected_at,last_evaluated_at)
      VALUES($1,$2,$3,'inventory_shortage','important',85,'White Medium needs a decision',
       'Stock is below the threshold','A purchase needs approval','Review the prepared work','item',$4,'high','OPEN','home-test-1',$5,$5)`,
    [newId('attention'),ctx.workspaceId,'home-test-need',item.id,at]);
    await database.query(`INSERT INTO work_items
      (id,workspace_id,category,source,recommended_action,approval_requirement,execution_status,
       verification_status,idempotency_key,outcome,created_at,completed_at)
      VALUES($1,$2,'replenishment_plan','postgres_autopilot',$3,'NONE','COMPLETED','VERIFIED',$4,$5,$6,$6)`,
    [newId('wi'),ctx.workspaceId,JSON.stringify({type:'purchase',displayName:'Blue Large',quantity:12,
      supplierName:'ABC Supply'}),'home-test-completed',JSON.stringify({poNumber:'PO-HOME-1'}),at]);
    const supplier=await commerce.createSupplier(database,ctx,{name:'ABC Supply'});
    await database.query(`INSERT INTO purchase_orders
      (id,workspace_id,po_number,supplier_id,status,expected_date,expected_date_source,
       created_by_user_id,created_at,updated_at)
      VALUES($1,$2,'PO-HOME-2',$3,'ORDERED',$4,'manual',$5,$6,$6)`,
    [newId('po'),ctx.workspaceId,supplier.id,new Date(Date.now()+2*86400000).toISOString().slice(0,10),ctx.actorId,at]);
    const activeHome=await agent.get('/');
    assert.equal(activeHome.status,200,activeHome.text.slice(0,700));
    assert.match(activeHome.text,/White Medium needs a decision/);
    assert.match(activeHome.text,/<strong>handled 1 thing<\/strong>/);
    assert.match(activeHome.text,/Blue Large: purchase order approved/);
    assert.match(activeHome.text,/not yet sent/);
    assert.match(activeHome.text,/ABC Supply delivery expected/);
    const pause=await agent.post('/autopilot/pause').type('form').send({_csrf:csrfFrom(activeHome.text),returnToHome:'1'});
    assert.equal(pause.status,303);
    assert.equal(pause.headers.location,'/');
    const pausedHome=await agent.get('/');
    assert.match(pausedHome.text,/StockChief is paused/);
    assert.match(pausedHome.text,/Resume StockChief/);
    assert.doesNotMatch(pausedHome.text,/Pause automatic work/);
    const resume=await agent.post('/autopilot/resume').type('form').send({_csrf:csrfFrom(pausedHome.text),returnToHome:'1'});
    assert.equal(resume.status,303);
    assert.equal(resume.headers.location,'/');
    const count=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom((await agent.get('/')).text),
      message:'How many products do we have?'});
    assert.equal(count.status,303);
    const counted=await agent.get('/ask');
    assert.match(counted.text,/You have 1 active product in StockChief, across 1 SKU/);
    const attention=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(counted.text),
      message:'What needs my attention?'});
    assert.equal(attention.status,303);
    const answered=await agent.get('/ask');
    assert.match(answered.text,/1 thing needs your attention/);
    assert.match(answered.text,/White Medium needs a decision/);
    assert.doesNotMatch(answered.text,/What needs my attention\?[\s\S]{0,350}1 SKU matched/);
  });

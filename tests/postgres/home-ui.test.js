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

function csrfFrom(html){const token=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];if(!token)throw new Error('Missing CSRF token');return token;}

test('PostgreSQL Home leads with the owner briefing and never credits a human movement to StockChief',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-home-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-home-secret'});
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
    assert.match(firstDay.text,/Ask or tell StockChief anything/);
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
    assert.match(response.text,/Ask or tell StockChief anything/);
    assert.match(response.text,/Needs you/);
    assert.match(response.text,/Coming up/);
    assert.match(response.text,/StockChief noticed/);
    assert.match(response.text,/No new work was completed by StockChief in the last 24 hours/);
    assert.doesNotMatch(response.text,/White Medium inventory changed/);
    assert.match(response.text,/\/home\.css\?/);
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
  });

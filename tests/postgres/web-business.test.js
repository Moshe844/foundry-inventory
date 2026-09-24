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

test('PostgreSQL web executes an authenticated inventory command without SQLite',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-web-test'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-web-test-secret'});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});

    const anonymous=await request(app).post('/api/v1/business/inventory/receive').send({});
    assert.equal(anonymous.status,403);
    const agent=request.agent(app);
    const register=await agent.get('/register');
    const created=await agent.post('/register').type('form').send({_csrf:csrfFrom(register.text),
      name:'Web Owner',businessName:'Postgres Web Inventory',email:'web-owner@example.test',password:'web-password'});
    assert.equal(created.status,302);
    const home=await agent.get('/onboarding');
    assert.equal(home.status,200);
    assert.match(home.text,/Add your inventory/);
    const workspaceId=(await database.query(`SELECT w.id FROM workspaces w JOIN accounts a
      ON a.id=w.owner_account_id WHERE a.email='web-owner@example.test'`)).rows[0].id;
    const membership=(await database.query(`SELECT id FROM users WHERE workspace_id=$1`,[workspaceId])).rows[0].id;
    const at='2026-09-23T12:00:00.000Z';
    await database.query(`INSERT INTO locations(id,workspace_id,name,kind,is_active,created_at)
      VALUES('web-main',$1,'Main warehouse','warehouse',1,$2)`,[workspaceId,at]);
    await database.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,is_active,created_at,updated_at)
      VALUES('web-item',$1,'Web item','WEB','quantity',1,$2,$2)`,[workspaceId,at]);
    await database.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_default,is_active,created_at)
      VALUES('web-sku',$1,'web-item','WEB-1',1,1,$2)`,[workspaceId,at]);

    const receive=await agent.post('/api/v1/business/inventory/receive')
      .set('x-csrf-token',csrfFrom(home.text)).send({skuId:'web-sku',locationId:'web-main',quantity:12,
        reference:'WEB-OPEN',idempotencyKey:'web-receive-one'});
    assert.equal(receive.status,201);
    assert.equal(receive.body.result.balanceAfter,12);
    const replay=await agent.post('/api/v1/business/inventory/receive')
      .set('x-csrf-token',csrfFrom(home.text)).send({skuId:'web-sku',locationId:'web-main',quantity:12,
        reference:'WEB-OPEN',idempotencyKey:'web-receive-one'});
    assert.equal(replay.body.result.replayed,true);
    assert.equal((await database.query(`SELECT on_hand FROM balances WHERE workspace_id=$1
      AND sku_id='web-sku' AND location_id='web-main'`,[workspaceId])).rows[0].on_hand,'12');
    assert.equal((await database.query(`SELECT actor_user_id FROM movements WHERE workspace_id=$1`,[workspaceId])).rows[0].actor_user_id,
      membership);
  });

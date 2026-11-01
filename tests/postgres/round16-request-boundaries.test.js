'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const csrf=html=>{const value=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];assert(value);return value;};
test('invalid API cursors stay JSON errors and old tabs cannot write into a switched inventory',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'round16-boundaries'});
 f.cleanup(()=>app.locals.sessionStore.close());const agent=request.agent(app);
 const login=await agent.get('/login').set('X-Forwarded-Proto','https');
 for(const [header,expected] of [['x-frame-options','DENY'],['x-content-type-options','nosniff'],['referrer-policy','strict-origin-when-cross-origin']])assert.equal(login.headers[header],expected);
 assert.match(login.headers['content-security-policy'],/frame-ancestors 'none'/);assert.match(login.headers['strict-transport-security'],/max-age=/);
 await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password}).expect(302);
 const first=await agent.get('/settings'),oldToken=csrf(first.text);
 const second=await require('../../src/domain/postgres-auth-service').createWorkspace(db,f.owner.accountId,{name:'Second inventory'});
 const inventories=await agent.get('/inventories');
 await agent.post('/inventories/switch').type('form').send({_csrf:csrf(inventories.text),workspaceId:second.workspaceId}).expect(303);
 const refused=await agent.post('/settings/workspace').set('Accept','application/json').type('form').send({_csrf:oldToken,name:'Wrong inventory rename'});
 assert.equal(refused.status,409);assert.equal(refused.body.error.code,'inventory_context_changed');
 assert.deepEqual((await db.query('SELECT name FROM workspaces WHERE id=ANY($1) ORDER BY name',[[ctx.workspaceId,second.workspaceId]])).rows.map(r=>r.name),['Second inventory','Shipping operation fixture']);
 const fresh=await agent.get('/settings');await agent.post('/settings/workspace').type('form').send({_csrf:csrf(fresh.text),name:'Correct inventory rename'}).expect(303);
 assert.equal((await db.query('SELECT name FROM workspaces WHERE id=$1',[second.workspaceId])).rows[0].name,'Correct inventory rename');
 const client=await require('../../src/connections/postgres-public-api').create(db,ctx,{name:'Read client',scopes:['inventory:read']});
 for(let n=0;n<8;n++){
  const invalid=await request(app).get('/api/v1/public/inventory?cursor=abc').set('Authorization','Bearer '+client.token);
  assert.equal(invalid.status,400);assert.match(invalid.headers['content-type'],/json/);assert.equal(invalid.body.error.code,'invalid_cursor');
  await request(app).get('/healthz').expect(200);
 }
 const valid=await request(app).get('/api/v1/public/inventory').set('Authorization','Bearer '+client.token);assert.equal(valid.status,200);assert(valid.body.data.length);
 const anonymous=request.agent(app),company=await anonymous.get('/auth/company');
 for(let n=0;n<2;n++)await anonymous.post('/auth/company/start').type('form').set('Referer','http://127.0.0.1/auth/company').send({_csrf:csrf(company.text),company:'not-a-company'}).expect(303);
 for(const path of ['/register','/login','/forgot-password']){const page=await anonymous.get(path);assert.doesNotMatch(page.text,/Check your company sign-in code/);}
 const notice=await anonymous.get('/auth/company');assert.equal((notice.text.match(/Check your company sign-in code/g)||[]).length,1);
 assert.doesNotMatch((await anonymous.get('/auth/company')).text,/Check your company sign-in code/);
});

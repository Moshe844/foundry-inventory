'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),express=require('express'),{randomUUID}=require('node:crypto');

test('public inventory pagination rejects malformed sizes without SQL errors, lost scope or usage charges',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status)
  VALUES($1,$2,'pro',(SELECT id FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE'),'ACTIVE')
  ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),f.owner.accountId]);
 const api=require('../../src/connections/postgres-public-api'),token=(await api.create(db,ctx,{name:'Pagination reader',scopes:['inventory:read']})).token;
 const app=express();app.locals.database=db;app.use('/api/v1/public',require('../../src/web/routes/postgres-public-api').createPostgresPublicApi(db));
 const call=query=>request(app).get('/api/v1/public/inventory').query(query).set('Authorization','Bearer '+token);
 const initial=await call({limit:1}).expect(200);assert.equal(initial.body.data.length,1);
 const committed=async()=>Number((await db.query("SELECT coalesce(sum(units),0) n FROM commercial_usage_events WHERE account_id=$1 AND meter='api_requests' AND status='COMMITTED'",[f.owner.accountId])).rows[0].n);
 const before=await committed();
 for(const limit of ['1.5','not-a-number','NaN','Infinity','-1','0','1e3','9007199254740992']){
  const result=await call({limit}).expect(400);assert.match(result.headers['content-type'],/json/);
  assert.equal(result.body.error.code,'invalid_page_size');assert.match(result.body.error.message,/whole number/);
  assert.doesNotMatch(JSON.stringify(result.body),/22P02|postgres|numutils|SQL/i);
 }
 for(const suffix of ['?limit=1&limit=2','?limit[value]=1']){
  const result=await request(app).get('/api/v1/public/inventory'+suffix).set('Authorization','Bearer '+token).expect(400);
  assert.equal(result.body.error.code,'invalid_page_size');
 }
 const cursor=await call({cursor:'abc'}).expect(400);assert.equal(cursor.body.error.code,'invalid_cursor');
 assert.equal(await committed(),before,'Rejected requests reverse reserved API allowance.');
 for(const query of [{},{limit:''},{limit:'500'},{limit:'501'}]){
  const valid=await call(query).expect(200);assert.equal(valid.body.data.length,1);assert.equal(valid.body.data[0].skuId,f.item.skuIds[0]);
 }
 const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other inventory',email:randomUUID()+'@example.test',password:'Other!'+randomUUID()});
 const otherItem=await require('../../src/domain/postgres-catalog-service').createItem(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},{name:'Foreign item',baseCode:'FOREIGN',trackingMode:'quantity'});
 const last=await call({limit:1}).expect(200);assert(!last.text.includes(otherItem.skuIds[0]));
 assert.equal(await f.balance(),4,'Pagination never changes physical stock.');
 const original=db.query,logged=t.mock.method(console,'error',()=>{});
 try{
  db.query=async(sql,...values)=>{if(sql.startsWith('SELECT sku.id AS'))throw Object.assign(new Error('Private database detail'),{code:'22P02'});return original.call(db,sql,...values);};
  const failure=await call({limit:1}).expect(500);assert.equal(failure.body.error.code,'internal_error');
  assert.doesNotMatch(failure.text,/22P02|Private database detail/);assert.equal(logged.mock.calls.length,1);
 }finally{db.query=original;logged.mock.restore();}
 await call({limit:1}).expect(200);
});

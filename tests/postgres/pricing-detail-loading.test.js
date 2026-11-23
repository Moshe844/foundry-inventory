'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const count=(html,name)=>(html.match(new RegExp(' '+name+'=','g'))||[]).length;

test('compact pricing preserves every price, allowance and duty through ordinary public detail pages',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'compact-pricing-check'});
 f.cleanup(()=>app.locals.sessionStore.close());
 const offer=require('../../src/commercial/public-offer'),plans=offer.comparison(await require('../../src/commercial/service').listPlans(db));
 const policy=require('../../src/commercial/agent-plan'),jobs=require('../../src/commercial/agent-plan-v3.json');
 const snapshot=async()=>JSON.stringify((await db.query('SELECT id,account_id,plan_id,plan_version_id,status FROM account_subscriptions ORDER BY id')).rows);
 const before=await snapshot();
 for(const interval of ['monthly','annual']){
  const response=await request(app).get('/pricing?interval='+interval).expect(200),html=response.text;
  assert(Buffer.byteLength(html)<100000,'Initial pricing HTML must stay below 100 KB instead of preloading every duty.');
  assert.equal(count(html,'data-plan-job'),0);assert.equal(count(html,'data-agent-job'),0);
  assert.equal(count(html,'data-plan-dialog'),4);
  assert.match(response.headers['content-security-policy'],/script-src 'self';/);
  assert.equal(response.headers['referrer-policy'],'no-referrer');
  assert.match(html,/<meta name="referrer" content="no-referrer">/);
  assert(html.includes('href="https://moshe844.github.io/stockchief-status/"'));
  for(const plan of plans){
   assert(html.includes('data-monthly-minor="'+(plan.monthly_amount_minor??'')+'"'));
   assert(html.includes('data-annual-minor="'+(plan.annual_amount_minor??'')+'"'));
   assert(html.includes('/pricing/plan/'+plan.id+'?interval='+interval),'No-script fallback exists for '+plan.id);
   const detail=await request(app).get('/pricing/plan/'+plan.id+'?interval='+interval).expect(200);
   assert(detail.text.includes('data-plan-inline'));assert(detail.text.includes('data-plan-content'));
   const featureIds=[...detail.text.matchAll(/data-plan-feature="([^"]+)"/g)].map(m=>m[1]);
   assert.deepEqual(featureIds,plan.features.map(feature=>feature.capability));
   const actual=[...detail.text.matchAll(/data-plan-job="(\d+)" data-mode="([^"]+)"/g)].map(m=>({id:Number(m[1]),mode:m[2]}));
   assert.deepEqual(actual,jobs.filter(job=>policy.allowance(plan.id,job.id)!=='excluded').map(job=>({id:job.id,mode:policy.allowance(plan.id,job.id)})));
   assert.match(detail.text,/Automatic actions are blocked for the first 14 days/);
   assert.equal(detail.headers['cache-control'],'no-store');
  }
  const comparison=await request(app).get('/pricing/compare?interval='+interval).expect(200);
  assert.equal(count(comparison.text,'data-agent-job'),214);assert.equal(count(comparison.text,'data-agent-mode'),856);
  assert.equal((comparison.text.match(/ data-comparison-group(?:\s|>)/g)||[]).length,19);
  assert(comparison.text.includes('data-comparison-fragment'));
  t.diagnostic(interval+' initial pricing: '+Buffer.byteLength(html)+' bytes');
 }
 await request(app).get('/pricing/plan/unknown').expect(404);
 const sitemap=await request(app).get('/sitemap.xml').set('Host','untrusted.example').expect(200);
 assert.match(sitemap.headers['content-type'],/application\/xml/);assert(sitemap.text.includes('https://app.stockchiefhq.com/pricing'));
 assert.doesNotMatch(sitemap.text,/untrusted|login|settings|inventory|billing|token/);
 const status=await request(app).get('/status').expect(200);assert(status.text.includes('Open independent service status'));
 assert.equal(await snapshot(),before,'Reading details never activates or changes a subscription.');
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const {PRICED_MODEL,pricedUsage}=require('../helpers/postgres-model-fixture');

test('AI report extras execute exact totals and any-of treats SQL wildcards as literal customer text',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;await f.subscribe('pro');
 const reports=require('../../src/reports/postgres-service'),ask=require('../../src/reports/postgres-ask'),actor={role:'owner'};
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second warehouse',kind:'warehouse'});
 await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:f.item.skuIds[0],locationId:location.id,quantity:3,unitCost:'1.00',currency:'USD',idempotencyKey:'report-extra-stock'});
 const plan={dataset:'stock',title:'Recorded value and units by product',columns:[],groups:['product'],aggregate:'sum',measure:'recorded_cost_minor',
  extras:[{aggregate:'sum',measure:'on_hand'},{aggregate:'count_distinct',measure:'location'}],filters:[],sort:'on_hand',direction:'desc',chart:'bar',compare:'none',topN:0};
 const result=await ask.prepare(db,ctx,'Recorded inventory value, units and distinct warehouses by product',{provider:{async complete(input){
  if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''}};
  assert(input.providerSchema.required.includes('extras'));assert(input.providerSchema.required.includes('compare'));assert(input.providerSchema.required.includes('topN'));
  return {data:plan};
 }}});
 assert(result.reportConfig);assert.equal(result.rows.length,1);
 const executed=await reports.run(db,ctx,actor,result.reportConfig);
 assert.equal(Number(executed.rows[0].total),700);assert.equal(Number(executed.rows[0].total_on_hand),7);assert.equal(Number(executed.rows[0].distinct_count_location),2);
 assert.equal(result.reportConfig.sort,'total_on_hand');assert(result.reportConfig.filters.some(filter=>filter.field==='currency'&&filter.value==='USD'));
 const commerce=require('../../src/operations/postgres-commerce');
 const wanted=['Café 100%','Under_score','Back\\slash'];for(const name of [...wanted,'Café 100X','UnderXscore','Backslash'])await commerce.createCustomer(db,ctx,{name});
 const definition={dataset:'customers',title:'Selected customers',columns:['customer'],groups:[],aggregate:'count',measure:'',filters:[{field:'customer',operator:'any_of',value:wanted.join(', ')}],sort:'customer',direction:'asc',chart:'table'};
 const chosen=await reports.run(db,ctx,actor,definition);assert.deepEqual(chosen.rows.map(row=>row.customer).sort(),wanted.slice().sort());
 assert.equal((await reports.run(db,{...ctx,workspaceId:'another-inventory'},actor,definition)).rows.length,0);
 assert.throws(()=>reports.normalize({...definition,dataset:'stock',filters:[{field:'on_hand',operator:'any_of',value:'1,2'}]},actor));
});

test('building progress is session-private, a completed draft retains extras, and an edit keeps prior filters',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;await f.subscribe('pro');
 let releasePlan,announcePlan,hold=true,lastPrior=null;
 const started=new Promise(resolve=>{announcePlan=resolve;}),held=new Promise(resolve=>{releasePlan=resolve;});t.after(()=>releasePlan());
 const plan={dataset:'stock',title:'Units and maximum stock',columns:[],groups:['product'],aggregate:'sum',measure:'on_hand',
  extras:[{aggregate:'maximum',measure:'on_hand'}],filters:[{field:'product',operator:'contains',value:'Parcel'}],sort:'total',direction:'desc',chart:'bar',compare:'none',topN:0};
 const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
  if(input.schemaName==='stockchief_governed_report_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
  lastPrior=JSON.parse(input.prompt).previousReport;
  if(hold){announcePlan();await held;}return {data:{...plan,title:hold?plan.title:'Changed stock report'},usage:pricedUsage()};
 }};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:provider});t.after(()=>app.locals.sessionStore.close());
 const login=async agent=>{const page=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:f.csrf(page.text),email:f.email,password:f.password}).expect(302);};
 const owner=request.agent(app),other=request.agent(app);await login(owner);await login(other);
 const page=await owner.get('/reports/builder').expect(200),buildId='private-build-'+randomUUID();
 const building=owner.post('/reports/describe').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),q:'Units and maximum stock by product containing Parcel',buildId}).then(response=>response);
 await started;
 const progress=await owner.get('/reports/describe/progress').query({id:buildId}).expect(200);assert.equal(progress.body.stage,'choosing');assert.match(progress.headers['cache-control'],/no-store/);
 assert.equal((await other.get('/reports/describe/progress').query({id:buildId}).expect(200)).body.stage,null,'Another session cannot inspect the same build identifier');
 releasePlan();const built=await building;assert.equal(built.status,200);assert.equal(built.body.ok,true);assert.equal(built.body.creditsUsed,0);
 const draft=await owner.get('/reports/builder?draft=1').expect(200);assert.match(draft.text,/Units and maximum stock/);
 assert.equal((await owner.get('/reports/describe/progress').query({id:buildId}).expect(200)).body.stage,'ready');
 hold=false;const changed=await owner.post('/reports/describe').set('Accept','application/json').type('form').send({_csrf:f.csrf(draft.text),q:'Rename this report Changed stock report',buildId:'edit-'+randomUUID()}).expect(200);
 assert.equal(lastPrior.title,plan.title);assert.deepEqual(lastPrior.filters,plan.filters);assert.deepEqual(lastPrior.extras,plan.extras);
 assert.equal(changed.body.title,'Changed stock report');assert.match((await owner.get('/reports/builder?draft=1').expect(200)).text,/Changed stock report/);
});

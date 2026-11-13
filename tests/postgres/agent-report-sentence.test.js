'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const unescape=text=>text.replaceAll('&#34;','"').replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&#39;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>');

// Job 154: a report from one sentence, alone on every plan. The sentence is
// shown with a preview before anything is saved; a saved report runs its exact
// definition again; a sentence that cannot be built is refused with sentences
// that can; reports use no AI credits. The model is a test fake: the live model's
// reading of real sentences is the one check that remains.
test('a report is built from one sentence on every plan, previewed before saving, saved exactly and refused with examples when it cannot be built',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx,subscribe,workflows}=f,ws=ctx.workspaceId;
 const ent=require('../../src/commercial/entitlements'),reports=require('../../src/reports/postgres-service'),scope={accountId:f.owner.accountId,workspaceId:ws};
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const actor=(await db.query('SELECT role,permissions FROM users WHERE id=$1',[ctx.actorId])).rows[0];
 // The fake model reads the sentence as a monthly line chart of stock movement; a
 // second model call checks that fit. Either can be told to disagree.
 const monthly={dataset:'movements',title:'Units received by month',dateGrain:'month',columns:[],groups:['occurred_on'],aggregate:'sum',measure:'quantity_delta',filters:[],sort:'occurred_on',direction:'asc',chart:'line'};
 let proposal=monthly,aligned=true;const calls=[];
 const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){calls.push(input.schemaName);
  if(input.schemaName==='stockchief_governed_report_fit')return {usage:pricedUsage(),data:{aligned,reason:aligned?'':'The report does not measure what was asked.'}};
  if(input.schemaName==='stockchief_governed_report_composed_edit')return {usage:pricedUsage(),data:{chart:'table',sort:'profit',direction:'desc',resultFilters:[]}};
  return {usage:pricedUsage(),data:proposal};}};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),aiProvider:provider});
 t.after(()=>app.locals.sessionStore.close());
 const owner=request.agent(app),login=await owner.get('/login');
 await owner.post('/login').type('form').send({_csrf:f.csrf(login.text),email:f.email,password:f.password}).expect(302);
 const describe=async q=>{const page=await owner.get('/reports/builder').expect(200);return owner.post('/reports/describe').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),q});};
 const saved=async()=>Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.report_templates WHERE workspace_id=$1 AND deleted_at IS NULL',[ws])).rows[0].n);
 const credits=async()=>(await ent.meterState(db,scope,'ai_work_credits')).used;
 const sentence='Units received by month as a line chart';

 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);proposal=monthly;aligned=true;
  const [usedBefore,savedBefore]=[await credits(),await saved()];
  // One sentence builds the report. Reports use no AI credits.
  const built=await describe(sentence);
  assert.equal(built.status,200,tier+' '+JSON.stringify(built.body));assert.equal(built.body.ok,true);
  assert.equal(built.body.creditsUsed,0,tier+' reports use no credits');assert.equal(await credits(),usedBefore,tier);
  // A clear preview before saving: the sentence, the report it became, and nothing saved yet.
  const builder=await owner.get(built.body.url.split('#')[0]).expect(200);
  assert.match(builder.text,new RegExp('data-report-sentence>Built from “'+sentence+'”\\. Check the preview below\\. Nothing is saved or emailed until you press Save report\\.'),tier);
  assert.match(builder.text,/value="Units received by month"/,tier);
  const preview=await owner.get('/reports/run').expect(200);
  const definition=JSON.parse(unescape(/name="definition" value="([^"]+)"/.exec(preview.text)[1]));
  assert.equal(definition.dataset,'movements');assert.equal(definition.dateGrain,'month');assert.equal(definition.chart,'line');
  assert.equal(await saved(),savedBefore,tier+' nothing is saved before Save report');
  // Saving keeps the exact definition, with an emailed schedule, and every run reads it again.
  const save=await owner.post('/reports/save').type('form').send({_csrf:f.csrf(preview.text),definition:JSON.stringify(definition),frequency:'weekly',hour:'8',minute:'0',weekday:'1'});
  assert.equal(save.status,303,tier);const id=save.headers.location.split('/').at(-1);
  const stored=await reports.load(db,ctx,actor,id);
  assert.deepEqual(stored.definition,definition,tier+' the saved report is exactly the previewed one');
  assert.equal(stored.schedule_frequency,'weekly');assert.ok(stored.next_send_at,tier+' the report is emailed on its schedule');
  const first=await reports.run(db,ctx,actor,stored.definition);
  const total=rows=>rows.reduce((sum,row)=>sum+Number(row.total),0);
  // New stock arrives: the saved report, run again, counts it.
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:'sentence-po-'+tier,lines:[{skuId:f.item.skuIds[0],quantityUnits:5,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'sentence-approve-'+tier});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'sentence-place-'+tier});
  await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'sentence-receive-'+tier,reference:'SENTENCE-'+tier,lines:[{lineId:po.lineIds[0],quantity:5,locationId:f.location.id}]});
  const again=await reports.run(db,ctx,actor,(await reports.load(db,ctx,actor,id)).definition);
  assert.equal(total(again.rows),total(first.rows)+5,tier+' the saved report re-runs on current records');
  const page=await owner.get('/reports/saved/'+id).expect(200);assert.match(page.text,/Units received by month/);
  for(const format of ['xlsx','pdf'])assert.equal((await owner.get('/reports/saved/'+id+'/export.'+format)).status,200,tier+' '+format);

  // A sentence it cannot turn into a report is refused, with sentences that can be built here.
  aligned=false;const usedRefused=await credits(),savedRefused=await saved();
  const refused=await describe('Show me the vibes of the warehouse');
  assert.equal(refused.status,422,tier);assert.equal(refused.body.ok,false);assert.equal(refused.body.creditsUsed,0);
  assert.ok(refused.body.examples.length>=2,tier+' '+JSON.stringify(refused.body));
  assert.deepEqual(refused.body.examples,await require('../../src/reports/build-availability').examples(db,ctx,actor),tier+' the examples are sentences this plan can build');
  assert.match(refused.body.message,/For example: “[^”]+”/);assert.match(refused.body.message,/No AI credits were used\. Nothing was saved\.$/);
  assert.equal(await credits(),usedRefused,tier+' a refused sentence costs nothing');assert.equal(await saved(),savedRefused,tier);
 }

 // Ask answers the same way: the refusal offers the buildable sentences as one-tap choices.
 aligned=false;
 const asked=await require('../../src/reports/postgres-ask').prepare(db,ctx,'Show me the vibes of the warehouse',{provider});
 assert.equal(asked.status,'CLARIFY');assert.match(asked.answer,/You could ask for one of these instead\./);
 assert.deepEqual(asked.choices.map(choice=>choice.value),await require('../../src/reports/build-availability').examples(db,ctx,actor));

 // A report that needs records the plan does not include shows the plan, not an error page.
 aligned=true;proposal={dataset:'composed',title:'Sales, cost and profit by product',dimension:'sku',metrics:[['sales','revenue_minor'],['cost','cogs_minor'],['profit','gross_profit_minor']].map(([alias,measure])=>({alias,dataset:'posted_sales_activity',aggregate:'sum',measure,filters:[{field:'currency',operator:'equals',value:'USD'}]})),columns:[],groups:[],aggregate:'sum',measure:'',filters:[],chart:'table',sort:'profit',direction:'desc'};
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  // Whether this plan includes every source the combined report reads.
  const included=await reports.assertWritableCapabilities(db,ctx,proposal,actor).then(()=>true,error=>{if(error.code!=='entitlement_required')throw error;return false;});
  const combined=await describe('Sales, cost and profit by product sorted by profit, in US dollars');
  if(included){assert.equal(combined.status,200,tier+' '+JSON.stringify(combined.body));assert.equal(combined.body.creditsUsed,0);}
  else{assert.equal(combined.status,402,tier+' '+JSON.stringify(combined.body));assert.match(combined.body.message,/^That report needs records your plan does not include\./);
   assert.match(combined.body.message,/No AI credits were used\. Nothing was saved\.$/);assert.equal(combined.body.creditsUsed,0);}
  t.diagnostic(tier+' combined sales report: '+(included?'built':'plan lock shown'));
 }

 // With no model available, sentences are not suggested; templates and the builder remain.
 const offline=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 t.after(()=>offline.locals.sessionStore.close());
 const other=request.agent(offline),otherLogin=await other.get('/login');
 await other.post('/login').type('form').send({_csrf:f.csrf(otherLogin.text),email:f.email,password:f.password}).expect(302);
 if(!require('../../src/config').ai.configured){
  const page=await other.get('/reports/builder').expect(200);
  const none=await other.post('/reports/describe').set('Accept','application/json').type('form').send({_csrf:f.csrf(page.text),q:sentence});
  assert.equal(none.status,422);assert.deepEqual(none.body.examples,[]);assert.match(none.body.message,/unavailable right now/);
 }
 // The builder's examples are only sentences this person and plan can build.
 const landing=await owner.get('/reports/builder').expect(200),offered=[...landing.text.matchAll(/data-report-example>([^<]+)</g)].map(match=>match[1]);
 assert.ok(offered.length>=2&&offered.length<=4,JSON.stringify(offered));
 const buildable=await require('../../src/reports/build-availability').examples(db,ctx,actor);
 assert.deepEqual(offered,buildable,'The builder offers the same buildable sentences as a refusal');
 assert.ok(calls.length>0);
});

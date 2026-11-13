'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const request=require('supertest');

// Job 203: costs and margins never leave StockChief to a role that may not see
// them. Costs need purchasing or accounting access; margins, profit and stock
// value need accounting access. This walks every way a figure can leave: pages
// added recently, report pages and their PDF and spreadsheet downloads, count
// worksheets and their CSV, emails (the monthly ROI report, alerts passed to
// someone else) and Ask. The owner keeps every figure. Hiding is enforced on
// every plan; the role review page is Growth and above.
test('a role without cost access gets no cost, margin or stock value through pages, downloads, emails or Ask',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId,sku=f.item.skuIds[0];
 const P=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service'),assistant=require('../../src/assistant/postgres-service');
 const prices=require('../../src/pricing/postgres-service');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.transaction(c=>prices.setPurchaseCostsInTransaction(c,ctx,[{skuId:sku,amountMinor:6791,currency:'USD'}]));
 await db.transaction(c=>prices.setPricesInTransaction(c,ctx,[{skuId:sku,amountMinor:9900,currency:'USD'}]));
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 t.after(()=>app.locals.sessionStore.close());
 async function member(name,grant){
  const email=randomUUID()+'@example.test',home=await auth.createBusiness(db,{name,businessName:name+' home',email,password:f.password}),id='member-'+randomUUID();
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,$4,'staff',$5,now()::text)`,[id,ws,home.accountId,name,P.encodeGrant(grant)]);
  const agent=request.agent(app),login=await agent.get('/login');
  await agent.post('/login').type('form').send({_csrf:f.csrf(login.text),email,password:f.password}).expect(302);
  const list=await agent.get('/inventories').expect(200);
  await agent.post('/inventories/switch').type('form').send({_csrf:f.csrf(list.text),workspaceId:ws}).expect(303);
  return {ctx:{workspaceId:ws,actorId:id},agent,email,name,grant};
 }
 // Counts stock and sees sales and transfers: no purchasing or accounting access, so no costs.
 const counter=await member('Counter',[P.VIEW,P.ADJUST,P.VIEW_SALES,P.VIEW_TRANSFERS]);
 // Plans reorders: purchase costs (purchasing access) but no accounting, so no margins or stock value.
 const planner=await member('Planner',[P.VIEW,P.MANAGE_REPLENISHMENT]);

 // Records that carry figures: a count worksheet whose extra unit takes the saved $67.91 cost,
 // a count review, an inventory finding and a run-out estimate with its lost gross margin.
 const campaigns=require('../../src/operations/postgres-count-campaigns');
 const sheet=await campaigns.create(db,ctx,{locationId:f.location.id,title:'Shelf count'});
 const opened=await campaigns.page(db,ctx,sheet.id);
 await campaigns.save(db,ctx,sheet.id,{revision:opened.campaign.revision,lines:[{skuId:sku,locationId:f.location.id,quantity:'41'}]});
 const review=await require('../../src/operations/postgres-count-reviews').prepare(db,ctx,{locationId:f.location.id,lines:[{skuId:sku,quantity:'35'}]});
 await db.query(`INSERT INTO attention_items(id,workspace_id,fingerprint,category,severity,priority_score,title,concise_summary,explanation,recommendation,affected_entity_type,confidence,status,detection_rule_version,first_detected_at,last_evaluated_at,item_id,sku_id)
  VALUES('valued-finding',$1,'valued-finding','low_stock','important',50,'Finding with value','Review','Evidence','Review','sku','high','OPEN','fixture',now(),now(),$2,$3)`,[ws,f.item.itemId,sku]);
 await db.query(`INSERT INTO stockchief_runtime.agent_runout_estimates(workspace_id,sku_id,as_of,available,daily_demand,demand_basis,runout_date,before_delivery,days_short,units_short,currency,unit_margin_minor,daily_margin_minor,lost_margin_minor,reason)
  VALUES($1,$2,current_date,2,1,'HISTORY',current_date+2,true,5,5,'USD',3109,3109,15545,'Runs out in 2 days. No delivery is due and no lead time is recorded.')`,[ws,sku]);
 const hidden=['$67.91','67.91','$155.45','$31.09','Known cost','Recorded stock value involved','Stock value change','of gross margin lost','each day without stock costs','Inventory at recorded cost','Money tied up in stock'];
 const clean=(text,where,list=hidden)=>{for(const s of list)assert.ok(!text.includes(s),where+' shows '+s+': '+text.slice(Math.max(0,text.indexOf(s)-160),text.indexOf(s)+60));};
 const valuation=['$155.45','$31.09','of gross margin lost','each day without stock costs','Known cost','Recorded stock value involved','Inventory at recorded cost'];
 const reviewKeys=require('../../src/autopilot/job-reviews').definitions.map(d=>d.key);
 const reports=['/autopilot/reviews/month-end-stock','/autopilot/reviews/month-end-stock/download','/autopilot/reviews/margin-change','/autopilot/reviews/board-pack',
  '/autopilot/reviews/roi-report','/autopilot/reviews/roi-report/download','/autopilot/reviews/stock-health','/autopilot/reviews/service-levels','/autopilot/reviews/service-levels/download',
  ...['board-pack','quarterly-supplier-pack','year-end-stocktake'].map(k=>'/autopilot/reviews/'+k+'/download')];

 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  const s=counter.agent;
  // Pages: quantities stay, figures go.
  const overview=await s.get('/inventory/overview').expect(200);clean(overview.text,tier+' overview');assert.match(overview.text,/On hand/);
  const planning=await s.get('/planning');if(planning.status===200)clean(planning.text,tier+' planning');
  clean((await s.get('/needs-you/findings').expect(200)).text,tier+' findings');
  const worksheet=await s.get('/warehouse/counts/campaigns/'+sheet.id).expect(200);clean(worksheet.text,tier+' worksheet');
  const csv=await s.get('/warehouse/counts/campaigns/'+sheet.id+'/export').expect(200);clean(csv.text,tier+' worksheet CSV');assert.match(csv.text,/Unit cost/);
  clean((await s.get('/warehouse/counts/reviews/'+review.id).expect(200)).text,tier+' count review');
  for(const item of await require('../../src/projections/postgres-service').needs(db,ws,counter.ctx.actorId))
   clean(JSON.stringify([item.title,item.happened,item.why,item.moneyValue??'']),tier+' Needs you '+item.sourceId);
  // Purchase costs without accounting: no margins and no stock value.
  const runout=await planner.agent.get('/planning/run-out');if(runout.status===200){clean(runout.text,tier+' run-out',valuation);assert.match(runout.text,/Runs out in 2 days/);}
  for(const path of ['/inventory/overview','/needs-you/findings','/planning']){const r=await planner.agent.get(path);if(r.status===200)clean(r.text,tier+' planner '+path,valuation);}
  for(const item of await require('../../src/projections/postgres-service').needs(db,ws,planner.ctx.actorId))
   clean(JSON.stringify([item.title,item.happened,item.why,item.moneyValue??'']),tier+' planner Needs you '+item.sourceId,valuation);
  // Report pages and every PDF and spreadsheet download are the owner's alone.
  for(const path of [...reports,...reviewKeys.map(k=>'/autopilot/reviews/'+k)]){
   const r=await s.get(path);assert.ok(r.status===403||r.status===302||r.status===303,tier+' '+path+' answered '+r.status);clean(r.text,tier+' '+path);
  }
  const combined=await s.get('/inventory/combined');if(combined.status===200)clean(combined.text,tier+' combined inventory');
  // Ask: financial reads and agent reviews refuse; stock reads keep working.
  for(const view of ['inventory_valuation','inventory_cost_movements','purchase_costs','business_analysis','sales_activity'])
   await assert.rejects(assistant.lookup(db,counter.ctx,{view,timeframe:'all_time'}),e=>e.code==='forbidden',tier+' Ask '+view);
  assert.ok((await assistant.lookup(db,counter.ctx,{view:'inventory_positions',timeframe:'all_time'})).rows.length);
  await assert.rejects(require('../../src/autopilot/job-reviews').run(db,counter.ctx,require('../../src/autopilot/cost-alerts').key),/owner/,tier+' cost and margin alerts');
 }
 assert.equal(require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review').ownerOnly,true,'Ask reads agent reviews for the owner only.');

 // The owner keeps every figure.
 const ownerPage=async path=>(await browser.get(path).expect(200)).text;
 assert.match(await ownerPage('/inventory/overview'),/Known cost/);
 assert.match(await ownerPage('/needs-you/findings'),/Recorded stock value involved/);
 assert.match(await ownerPage('/warehouse/counts/campaigns/'+sheet.id),/Stock value change/);
 assert.match((await browser.get('/warehouse/counts/campaigns/'+sheet.id+'/export').expect(200)).text,/67\.91/);
 assert.match(await ownerPage('/warehouse/counts/reviews/'+review.id),/Stock value change/);
 assert.match(await ownerPage('/planning'),/Inventory at recorded cost/);
 assert.match(await ownerPage('/planning/run-out'),/\$155\.45<\/strong> of gross margin lost/);

 // Emails. The monthly ROI report's money caught goes only to addresses that may see costs.
 process.env.RESEND_API_KEY=process.env.RESEND_API_KEY||'test-key';process.env.FOUNDRY_FROM_EMAIL=process.env.FOUNDRY_FROM_EMAIL||'reports@example.test';
 const buyer=await member('Buyer',[P.VIEW,P.VIEW_PURCHASING]);
 await db.query(`INSERT INTO notification_email_settings(workspace_id,enabled,minimum_severity,recipients,created_at,updated_at) VALUES($1,1,'all',$2,now()::text,now()::text)
  ON CONFLICT(workspace_id) DO UPDATE SET enabled=1,minimum_severity='all',recipients=excluded.recipients`,[ws,JSON.stringify([counter.email,buyer.email,f.email])]);
 const report={name:'October 2026',month:'2026-10',actions:3,hours:2,measuredHours:0,estimatedHours:2,pricePerHour:24950,plan:{monthly:49900,currency:'USD'},
  tasks:[{label:'Purchase orders drafted',count:3,minutesEach:40,basis:'standard'}],
  totals:[{currency:'USD',amount:31416,comparable:true,timesPlan:0.63,kinds:[{label:'Supplier price increases caught',amount:31416,count:1}]}]};
 assert.equal(await db.transaction(c=>require('../../src/reports/agent-roi-report').email(c,ctx,report)),3);
 const credentials=require('../../src/connections/credentials');
 const sent=Object.fromEntries((await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='system.email-send' AND idempotency_key LIKE 'roi-report-email:%'",[ws])).rows
  .map(r=>credentials.decrypt({...r.payload.sealed,auth_tag:r.payload.sealed.authTag})).map(m=>[m.to,m.text+m.html]));
 assert.ok(!sent[counter.email.toLowerCase()].includes('$314.16'),'A role without cost access gets the hours only.');
 assert.match(sent[counter.email.toLowerCase()],/saving about 2 hours/);
 for(const address of [buyer.email,f.email])assert.match(sent[address.toLowerCase()],/\$314\.16/,'Purchasing access and the owner see the money caught.');
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[buyer.ctx.actorId,P.encodeGrant([P.VIEW])]);
 const delivered=[];
 const handler=require('../../src/operations/postgres-runtime-handlers').create(undefined,{emailSender:async message=>{
   delivered.push(message.to);return {provider:'test',externalId:'disclosure-'+delivered.length};
 }})['system.email-send'];
 const queued=(await db.query("SELECT id,idempotency_key,payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND idempotency_key LIKE 'roi-report-email:%'",[ws])).rows;
 for(const job of queued)await handler({...job,workspaceId:ws,idempotencyKey:job.idempotency_key},db);
 assert.deepEqual(delivered.sort(),[counter.email.toLowerCase(),f.email.toLowerCase()].sort(),'Revoking access before delivery withholds the financial email.');
 await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[buyer.ctx.actorId,P.encodeGrant(buyer.grant)]);
 // Alerts passed on to someone else (job 172) need every permission the item needs, including seeing its costs.
 const escalations=require('../../src/autopilot/escalations');
 const people=[{id:'landed',name:'Landed clerk',role:'staff',permissions:P.encodeGrant([P.VIEW,P.ALLOCATE_LANDED_COST]),warehouse_location_ids:null},
  {id:'books',name:'Bookkeeper',role:'staff',permissions:P.encodeGrant([P.VIEW,P.ALLOCATE_LANDED_COST,P.VIEW_ACCOUNTING]),warehouse_location_ids:null}];
 assert.deepEqual(escalations.chain({permission:[P.ALLOCATE_LANDED_COST,P.VIEW_ACCOUNTING].join(','),amount_minor:null,currency:null},people).map(p=>p.name),['Bookkeeper']);
 const desk=require('../../src/autopilot/approval-desk');
 assert.deepEqual(desk.item({key:'proposal:x',kind:'landed_cost',permission:P.ALLOCATE_LANDED_COST,readPermission:P.VIEW_ACCOUNTING,title:'Add delivery costs',reason:'',href:'/actions/x',amountMinor:500,currency:'USD',person:{role:'owner'}}).requiredPermissions,
  [P.ALLOCATE_LANDED_COST,P.VIEW_ACCOUNTING],'An approval carries the permission to see it, so it is never passed to someone who may not.');

 // The role review shows who sees what: Growth and above.
 const reviews=require('../../src/autopilot/job-reviews');
 await subscribe('starter');await assert.rejects(reviews.run(db,ctx,'financial-permissions'),e=>e.code==='entitlement_required');
 for(const tier of ['growth','pro','enterprise']){await subscribe(tier);
  const rows=(await reviews.run(db,ctx,'financial-permissions')).rows;
  assert.deepEqual(['Purchase costs','Accounting and margins'].map(k=>rows.find(r=>r['Team member']==='Counter')[k]),['Hidden','Hidden'],tier);
  assert.deepEqual(['Purchase costs','Accounting and margins'].map(k=>rows.find(r=>r['Team member']==='Buyer')[k]),['Allowed','Hidden'],tier);}
});

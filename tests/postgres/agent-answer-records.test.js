'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const decision=(action,extra={})=>({action,progress:'Checking the recorded business details.',query:'',steps:[],answer:'',evidence:[],...extra});

// Job 153: every kind of Ask answer links to the records it used, filtered to
// what it counted, and only to pages the asking person may open (job 203).
// Alone on every plan: Starter, Growth, Pro and Custom.
test('every kind of Ask answer links to the records behind it, filtered to what it counted, for the people who may see them',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe,workflows}=f,ws=ctx.workspaceId;
 const assistant=require('../../src/assistant/postgres-service'),answerSources=require('../../src/assistant/answer-sources');
 const registry=require('../../src/assistant/postgres-capability-registry').registry,P=require('../../src/actions/permissions');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 // A fulfilled order leaves an invoice owed. A draft placed the same day is not counted.
 const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'records-sale',lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:9000}]});
 await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:'records-confirm'});
 await workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:'records-fulfill',lines:[{lineId:sale.lineIds[0],quantity:3,locationId:f.location.id}]});
 const draft=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'records-draft',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:9000}]});
 const number=async id=>(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[id])).rows[0].order_number;
 const [saleNumber,draftNumber]=[await number(sale.salesOrderId),await number(draft.salesOrderId)];
 const invoice=(await db.query('SELECT invoice_number FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ws,sale.salesOrderId])).rows[0].invoice_number;
 const stored=async id=>(await db.query('SELECT intent FROM stockchief_runtime.assistant_interactions WHERE id=$1',[id])).rows[0].intent.presentation.sources;
 const opens=async(agent,href,who='owner')=>{const page=await agent.get(href);assert.equal(page.status,200,who+' opens '+href);return page.text;};
 const html=href=>href.replaceAll('&','&amp;');

 // 1. A direct read, on every plan: each customer opens exactly the open invoices counted for them.
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  const owed=await assistant.ask(db,ctx,'Who owes me money?',{requestKey:'owed-'+tier,conversationId:'chat_owed_'+tier,usageKey:'owed-'+tier});
  assert.match(owed.answer,/\$270\.00/,tier);
  const links=await stored(owed.interactionId);
  const party=links.find(link=>link.kind==='record'&&link.href==='/money/invoices?party=fixture-customer');
  assert.ok(party,tier+': '+JSON.stringify(links));assert.equal(party.label,'Receiver');
  assert.ok(links.some(link=>link.kind==='page'&&link.href==='/money/invoices'),tier+' the whole list is linked too');
  assert.match(await opens(browser,party.href),new RegExp(invoice),tier+' the linked list holds the invoice the answer counted');
  const page=await opens(browser,'/ask?chat=chat_owed_'+tier);
  assert.ok(page.includes('href="/money/invoices?party=fixture-customer"'),tier+' the answer table links the customer to their invoices');
 }

 // 2. An operational review read in Ask: the filtered review and each record it listed.
 await subscribe('pro');
 const review=registry.get('read.agent_review'),reviewArgs={agentJob:'stock-by-location',search:code};
 const reviewed={status:'ANSWERED',answer:'Stock is recorded at Dispatch.',...await review.prepare(null,db,ctx,'Where is it stocked?',reviewArgs)};
 const reviewAnswer=await assistant.recordCapabilityOutcome(db,{...ctx,conversationId:'chat_review'},'Where is '+code+' stocked?',
  {step:{contract:review,dependsOn:[]},args:reviewArgs,result:reviewed,provenance:{}});
 const reviewLinks=await stored(reviewAnswer.interactionId);
 assert.deepEqual(reviewLinks.map(link=>[link.kind,link.href]),[['page','/autopilot/reviews/stock-by-location?filter='+encodeURIComponent(code)],['record','/inventory/'+f.item.itemId]]);
 assert.equal(reviewLinks[1].label,code);
 for(const link of reviewLinks)await opens(browser,link.href);
 const reviewPage=await opens(browser,'/ask?chat=chat_review');
 assert.match(reviewPage,/data-answer-sources/);assert.match(reviewPage,/Records behind this answer/);
 for(const link of reviewLinks)assert.ok(reviewPage.includes('href="'+html(link.href)+'"'),'The answer shows '+link.href);

 // 3. Several reads joined into one written answer keep every read's records.
 const plane=require('../../src/assistant/postgres-control-plane'),step=name=>({contract:registry.get(name),args:{},dependsOn:[]});
 const orders={status:'ANSWERED',...await assistant.lookup(db,ctx,{view:'sales_orders',timeframe:'all_time'})};
 const writer={complete:async()=>({data:{answer:'Stock is at Dispatch and one order was shipped.',supported:true,usedSteps:[0,1],additionalReads:[]}}),
  verifyComplete:async()=>({data:{grounded:true,reason:''}})};
 const [joined]=await plane.synthesizeReads(writer,'Where is the stock and which orders shipped?',
  [{step:step('read.agent_review'),args:reviewArgs,provenance:{},result:reviewed},{step:step('read.sales_orders'),args:{},provenance:{},result:orders}],{catalogue:registry});
 assert.equal(joined.result.answer,'Stock is at Dispatch and one order was shipped.');
 const joinedHrefs=joined.result.sources.map(link=>link.href);
 for(const href of ['/autopilot/reviews/stock-by-location?filter='+encodeURIComponent(code),'/inventory/'+f.item.itemId,'/orders/'+sale.salesOrderId])
  assert.ok(joinedHrefs.includes(href),'The joined answer keeps '+href+': '+JSON.stringify(joinedHrefs));

 // 4. A business summary links each figure to the list filtered the way it counted.
 const facts=await assistant.capabilityService({nativeFacts:true}).lookup(db,ctx,{view:'business_analysis',timeframe:'all_time'});
 const orderFact=facts.rows.find(row=>row.id==='customerOrders'),ordersLink=facts.sources.find(link=>link.href.startsWith('/orders?'));
 assert.equal(ordersLink.href,'/orders?from='+orderFact.periods.current.from+'&to='+orderFact.periods.current.to);
 assert.equal(orderFact.currentCount,1,'The draft is not counted');
 const placed=await opens(browser,ordersLink.href);
 assert.match(placed,new RegExp('data-placed-filter><strong>Placed [^<]+ · '+orderFact.currentCount+'</strong>'),'The list counts what the answer counted');
 assert.ok(placed.includes(saleNumber)&&!placed.includes(draftNumber),'The counted order is listed; the draft is not');
 assert.ok(facts.sources.some(link=>link.href.startsWith('/accounting/reports/profit-and-loss?from='))||!facts.rows.some(row=>row.id==='postedFinancialsCurrent'));

 // 5. A report answer links to the exact report, run again with its source records.
 const actor=(await db.query('SELECT role,permissions FROM users WHERE id=$1',[ctx.actorId])).rows[0];
 const reports=require('../../src/reports/postgres-service');
 const spec=reports.normalize({dataset:'stock',title:'Stock by location',columns:['product','sku','location','on_hand'],groups:[],aggregate:'count',measure:'',filters:[],sort:'product',direction:'asc',chart:'table'},actor);
 const run=await reports.run(db,ctx,actor,spec,{limit:51});
 const reportAnswer=await assistant.recordCapabilityOutcome(db,{...ctx,conversationId:'chat_report'},'Stock by location',
  {step:{contract:registry.get('read.custom_report'),dependsOn:[]},args:{},provenance:{},result:{status:'ANSWERED',answer:'Stock by location: 1 matching record.',rows:run.displayRows,columns:run.columns,reportConfig:spec}});
 const reportLinks=await stored(reportAnswer.interactionId);
 assert.equal(reportLinks[0].href,'/reports/from-ask/'+reportAnswer.interactionId+'/run');
 assert.ok(!reportLinks.some(link=>link.href==='/reports/from-ask/'+reportAnswer.interactionId),'The report editor is not a record');
 assert.match(await opens(browser,reportLinks[0].href),new RegExp(code));

 // 6. An answer from the agent that investigates links only the reads it cited, checked again at the finish.
 const flags={flag:process.env.STOCKCHIEF_ADAPTIVE_ASK,workspaces:process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES};
 t.after(()=>{for(const [key,value] of [['STOCKCHIEF_ADAPTIVE_ASK',flags.flag],['STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES',flags.workspaces]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
 process.env.STOCKCHIEF_ADAPTIVE_ASK='1';process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=ws;
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);if(tier==='enterprise')await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',1000,'Funded Custom contract allowance') ON CONFLICT DO NOTHING",[randomUUID(),f.owner.accountId]);
  const plan=[decision('operate',{steps:[{capability:'read.inventory_positions',arguments:[],dependsOn:[]},{capability:'read.locations',arguments:[],dependsOn:[]}]}),
   decision('finish',{answer:'**17 units** of the parcel item are on hand at Dispatch.',evidence:[0]})];
  const model={name:'anthropic',model:PRICED_MODEL,async complete(request){
   if(['stockchief_adaptive_verification','stockchief_goal_authority_fit'].includes(request.schemaName))return {usage:pricedUsage(),data:{complete:true,grounded:true,reason:''}};
   return {usage:pricedUsage(),data:plan.shift()||decision('ask',{answer:'What should I check?'})};}};
  const asked=await assistant.ask(db,ctx,'Investigate the recorded stock positions for me.',{provider:model,conversationId:'chat_goal_'+tier,usageKey:'goal-'+tier});
  assert.equal(asked.goalStatus,'COMPLETED',tier+' '+asked.answer+' '+JSON.stringify((await db.query("SELECT kind,detail FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1 ORDER BY sequence DESC LIMIT 2",[asked.goalId])).rows));
  const goal=await require('../../src/assistant/postgres-goal-store').get(db,ctx,asked.goalId);
  const hrefs=goal.checkpoint.answerSources.map(link=>link.href);
  assert.ok(hrefs.includes('/inventory/'+f.item.itemId),tier+' '+JSON.stringify(hrefs));
  assert.ok(!hrefs.some(href=>href.startsWith('/locations')),tier+' a read the answer did not cite is not listed: '+JSON.stringify(hrefs));
  const progress=(await browser.get('/ask/goals/'+asked.goalId).expect(200)).body;
  assert.deepEqual(progress.sources.map(link=>link.href),hrefs,tier+' the live page receives the same records');
  const page=await opens(browser,'/ask?goal='+asked.goalId);
  assert.match(page,/data-goal-sources>\s*<details class="rm-chat-evidence" data-answer-sources/,tier);
  assert.ok(page.includes('href="/inventory/'+f.item.itemId+'"'),tier);
 }
 delete process.env.STOCKCHIEF_ADAPTIVE_ASK;

 // 7. The staging agent's verified answer lists the records of the reads its claims cite, and only those.
 const cited=require('../../src/assistant/postgres-codex-verification').citedSources([
  {claim:{path:'/outcomes/0/result/rows/0/onHand'},entry:{name:'business_operations',text:JSON.stringify({outcomes:[
   {capability:'read.inventory_positions',result:{status:'ANSWERED',columns:['product'],rows:[{product:'Parcel item',href:'/inventory/'+f.item.itemId}]}},
   {capability:'read.sales_orders',result:{status:'ANSWERED',columns:['order'],rows:[{order:saleNumber,href:'/orders/'+sale.salesOrderId}]}}]})}},
  {claim:{path:'/url'},entry:{name:'environment_browser',text:'{}'}}],registry);
 assert.deepEqual(cited,[{kind:'record',href:'/inventory/'+f.item.itemId,label:'Parcel item'}]);

 // 8. Only pages the asking person may open (job 203). A counter with sales access but no
 //    purchasing or accounting access sees the order, not the money pages or owner reviews.
 const auth=require('../../src/domain/postgres-auth-service'),app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 t.after(()=>app.locals.sessionStore.close());
 const email=randomUUID()+'@example.test',home=await auth.createBusiness(db,{name:'Counter',businessName:'Counter home',email,password:f.password}),counterId='member-'+randomUUID();
 await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Counter','staff',$4,now()::text)`,[counterId,ws,home.accountId,P.encodeGrant([P.VIEW,P.VIEW_SALES])]);
 const counter=request.agent(app),login=await counter.get('/login');
 await counter.post('/login').type('form').send({_csrf:f.csrf(login.text),email,password:f.password}).expect(302);
 const list=await counter.get('/inventories').expect(200);await counter.post('/inventories/switch').type('form').send({_csrf:f.csrf(list.text),workspaceId:ws}).expect(303);
 const counterCtx={workspaceId:ws,actorId:counterId,conversationId:'chat_counter'},counterActor=(await db.query('SELECT role,permissions FROM users WHERE id=$1',[counterId])).rows[0];
 const mixed=await assistant.recordCapabilityOutcome(db,counterCtx,'Which orders shipped and who owes for them?',{step:{contract:registry.get('read.sales_orders'),dependsOn:[]},args:{},provenance:{},
  result:{status:'ANSWERED',answer:'One order shipped.',rows:[],columns:[],sources:[...joined.result.sources,{kind:'record',href:'/money/invoices?party=fixture-customer',label:'Receiver'}]}});
 const all=await stored(mixed.interactionId),shown=answerSources.visible(counterActor,all);
 assert.ok(shown.some(link=>link.href==='/orders/'+sale.salesOrderId));
 assert.ok(!shown.some(link=>/^\/(?:money|autopilot\/reviews)/.test(link.href)),JSON.stringify(shown));
 const counterPage=await opens(counter,'/ask?chat=chat_counter','counter');
 assert.ok(counterPage.includes('href="/orders/'+sale.salesOrderId+'"'),'The counter sees the order the answer used');
 for(const hidden of ['/money/invoices?party=fixture-customer','/autopilot/reviews/stock-by-location'])assert.ok(!counterPage.includes(hidden),'The counter is not shown '+hidden);
 for(const link of shown)await opens(counter,link.href,'counter');
 for(const link of all.filter(link=>!shown.includes(link)))assert.ok([302,303,403].includes((await counter.get(link.href)).status),'A hidden link is one the counter cannot open: '+link.href);
 assert.deepEqual(answerSources.visible({role:'owner',permissions:null},all),all,'The owner sees every record');
});

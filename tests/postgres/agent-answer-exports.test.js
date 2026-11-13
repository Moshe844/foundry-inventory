'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const decision=(action,extra={})=>({action,progress:'Checking the recorded business details.',query:'',steps:[],answer:'',evidence:[],...extra});
const binary=(res,done)=>{const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>done(null,Buffer.concat(parts)));};
const TYPES={pdf:/application\/pdf/,xlsx:/spreadsheetml/,csv:/text\/csv/};

// Job 160: any Ask answer downloads as Excel or PDF, alone on every plan: written
// answers, answers with records, reports, reviews, the agent's answers, the
// documents the agent wrote for an answer, and a whole conversation.
test('every kind of Ask answer exports to Excel and PDF on every plan, only for the person who asked',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe,workflows}=f,ws=ctx.workspaceId;
 const assistant=require('../../src/assistant/postgres-service'),registry=require('../../src/assistant/postgres-capability-registry').registry;
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'export-sale',lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:9000}]});
 await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:'export-confirm'});
 await workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:'export-fulfill',lines:[{lineId:sale.lineIds[0],quantity:3,locationId:f.location.id}]});
 const download=async(agent,url,format)=>{const file=await agent.get(url).buffer(true).parse(binary);
  assert.equal(file.status,200,url);assert.match(file.headers['content-type'],TYPES[format],url);assert.match(file.headers['content-disposition'],/attachment/,url);
  assert.ok(file.body.length>20,url);return file;};
 const actor=(await db.query('SELECT role,permissions FROM users WHERE id=$1',[ctx.actorId])).rows[0],reports=require('../../src/reports/postgres-service');
 const flags={flag:process.env.STOCKCHIEF_ADAPTIVE_ASK,workspaces:process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES};
 t.after(()=>{for(const [key,value] of [['STOCKCHIEF_ADAPTIVE_ASK',flags.flag],['STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES',flags.workspaces]])if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const kept=[];
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);if(tier==='enterprise')await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',1000,'Funded Custom contract allowance') ON CONFLICT DO NOTHING",[randomUUID(),f.owner.accountId]);const chat='chat_export_'+tier;
  // An answer with records, a short written answer, a review, a report and the agent's own answer.
  const owed=await assistant.ask(db,ctx,'Who owes me money?',{requestKey:'owed-'+tier,conversationId:chat,usageKey:'owed-'+tier});
  const short=await assistant.recordCapabilityOutcome(db,{...ctx,conversationId:chat},'Is anything late?',{step:{contract:registry.get('read.sales_orders'),dependsOn:[]},args:{},provenance:{},
   result:{status:'ANSWERED',answer:'Nothing is late.',rows:[],columns:[]}});
  const reviewArgs={agentJob:'stock-by-location',search:code},review=registry.get('read.agent_review');
  const reviewed=await assistant.recordCapabilityOutcome(db,{...ctx,conversationId:chat},'Where is '+code+'?',{step:{contract:review,dependsOn:[]},args:reviewArgs,provenance:{},
   result:{status:'ANSWERED',answer:'Recorded at Dispatch.',...await review.prepare(null,db,ctx,'Where is it?',reviewArgs)}});
  const spec=reports.normalize({dataset:'stock',title:'Stock by location',columns:['product','sku','location','on_hand'],groups:[],aggregate:'count',measure:'',filters:[],sort:'product',direction:'asc',chart:'table'},actor),run=await reports.run(db,ctx,actor,spec,{limit:51});
  const report=await assistant.recordCapabilityOutcome(db,{...ctx,conversationId:chat},'Stock by location',{step:{contract:registry.get('read.custom_report'),dependsOn:[]},args:{},provenance:{},
   result:{status:'ANSWERED',answer:'Stock by location: 1 matching record.',rows:run.displayRows,columns:run.columns,reportConfig:spec}});
  for(const id of [owed.interactionId,short.interactionId,reviewed.interactionId,report.interactionId])for(const format of ['pdf','xlsx']){
   await download(browser,'/ask/answers/'+id+'/export.'+format+'?content=answer',format);
   if(id!==short.interactionId)await download(browser,'/ask/answers/'+id+'/export.'+format,format);
  }
  const sheet=await browser.get('/ask/answers/'+reviewed.interactionId+'/export.csv').expect(200);
  assert.match(sheet.text,new RegExp(code),tier+' a review answer exports its rows');
  process.env.STOCKCHIEF_ADAPTIVE_ASK='1';process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=ws;
  const plan=[decision('operate',{steps:[{capability:'read.inventory_positions',arguments:[],dependsOn:[]}]}),
   decision('finish',{answer:'### Stock\n\n| Product | On hand |\n|---|---:|\n| Parcel item | 17 |',evidence:[0]})];
  const model={name:'anthropic',model:PRICED_MODEL,async complete(input){
   if(['stockchief_adaptive_verification','stockchief_goal_authority_fit'].includes(input.schemaName))return {usage:pricedUsage(),data:{complete:true,grounded:true,reason:''}};
   return {usage:pricedUsage(),data:plan.shift()||decision('ask',{answer:'What should I check?'})};}};
  const goal=await assistant.ask(db,ctx,'Investigate the recorded stock positions for me.',{provider:model,conversationId:chat,usageKey:'goal-'+tier});
  delete process.env.STOCKCHIEF_ADAPTIVE_ASK;
  assert.equal(goal.goalStatus,'COMPLETED',tier+' '+goal.answer);
  for(const format of ['pdf','xlsx'])await download(browser,'/ask/goals/'+goal.goalId+'/export.'+format+'?content=answer',format);
  const goalSheet=await browser.get('/ask/goals/'+goal.goalId+'/export.csv?content=answer').expect(200);
  assert.match(goalSheet.text,/"Product","On hand"/);assert.match(goalSheet.text,/"Parcel item","17"/,tier+' the agent answer table keeps its columns');
  // The whole conversation downloads too, in every format, and still as text.
  for(const format of ['pdf','xlsx'])await download(browser,'/ask/chats/'+chat+'/download.'+format,format);
  const transcript=await browser.get('/ask/chats/'+chat+'/download.csv').expect(200);
  assert.match(transcript.text,/"You","Who owes me money\?"/);assert.match(transcript.text,/"StockChief","/);
  assert.match((await browser.get('/ask/chats/'+chat+'/download').expect(200)).text,/You: Who owes me money\?/);
  const page=await browser.get('/ask?chat='+chat).expect(200);
  for(const format of ['pdf','xlsx','csv'])assert.ok(page.text.includes('href="/ask/chats/'+chat+'/download.'+format+'"'),tier+' the conversation menu offers '+format);
  assert.match(page.text,new RegExp('href="/ask/chats/'+chat+'/download"[^>]*>Text</a>'),tier+' and still as text');
  kept.push({chat,interaction:owed.interactionId,goal:goal.goalId});
 }

 // Only the person who asked can download: another business gets nothing.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const auth=require('../../src/domain/postgres-auth-service'),email=randomUUID()+'@example.test';await auth.createBusiness(db,{name:'Other',businessName:'Other business',email,password:f.password});
 const outsider=request.agent(app),login=await outsider.get('/login');await outsider.post('/login').type('form').send({_csrf:f.csrf(login.text),email,password:f.password}).expect(302);
 for(const url of ['/ask/answers/'+kept[0].interaction+'/export.pdf','/ask/goals/'+kept[0].goal+'/export.xlsx?content=answer','/ask/chats/'+kept[0].chat+'/download.pdf'])
  assert.ok((await outsider.get(url)).status>=400,url);
 assert.ok((await browser.get('/ask/answers/'+kept[0].interaction+'/export.exe')).status>=400,'Only offered formats');

 // The documents the staging agent writes for an answer download as PDF, Excel and CSV too.
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 await subscribe('pro');process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 await require('../../src/assistant/postgres-codex-pilot').toggle(db,ctx,true);
 await db.query("UPDATE stockchief_runtime.codex_pilots SET stopped=false,approval_reference='OFFLINE UI ONLY',ceiling_micro_usd=1000000,period_ends_at=now()+interval '1 hour' WHERE workspace_id=$1",[ws]);
 const store=require('../../src/assistant/postgres-goal-store'),written=await store.create(db,ctx,'Draft a reorder note and a stock list'),saved=require('../../src/assistant/agent-delivery').create({status:'completed',answer:'Prepared.',claims:[],
  workProducts:[{title:'Reorder note',content:'Order 10 more Parcel item from Fixture parts.\nAsk for delivery next week.'},{title:'Stock list',content:'| Product | On hand |\n|---|---:|\n| Parcel item | 17 |'}],nextActions:[]});
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer='Prepared the reorder note and the stock list.',checkpoint=checkpoint||$2::jsonb WHERE id=$1",
  [written.id,JSON.stringify({runtime:'codex-staging',chatId:'chat_work',harness:{},delivery:saved})]);
 const [note,list]=saved.workProducts;
 for(const format of ['pdf','xlsx','csv'])for(const work of [note,list])await download(browser,'/ask/goals/'+written.id+'/work/'+work.id+'.'+format,format);
 const listSheet=await browser.get('/ask/goals/'+written.id+'/work/'+list.id+'.csv').expect(200);
 assert.match(listSheet.text,/"Product","On hand"/);assert.match(listSheet.text,/"Parcel item","17"/);
 assert.match((await browser.get('/ask/goals/'+written.id+'/work/'+note.id).expect(200)).text,/Order 10 more/,'The text download still works');
 const workPage=await browser.get('/ask?goal='+written.id).expect(200);
 for(const format of ['pdf','xlsx','csv'])assert.ok(workPage.text.includes('href="/ask/goals/'+encodeURIComponent(written.id)+'/work/'+note.id+'.'+format+'"'),'The work product offers '+format);
 assert.ok((await outsider.get('/ask/goals/'+written.id+'/work/'+note.id+'.pdf')).status>=400,'Another business cannot download the work');

 // Phone and desktop: every download format, the records behind an answer and the
 // placed-date order list can be seen and chosen without sideways scrolling.
 const server=await new Promise(ok=>{const listener=app.listen(0,'127.0.0.1',()=>ok(listener));}),origin='http://127.0.0.1:'+server.address().port;
 const chromium=await require('playwright').chromium.launch();
 t.after(async()=>{await chromium.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));});
 for(const width of [1280,390]){
  const page=await (await chromium.newContext({viewport:{width,height:900}})).newPage();
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/ask?chat='+kept[3].chat);
  const menu=page.locator('.rm-chat__new .ask-download');await menu.locator('summary').click();
  const shown=await menu.evaluate(element=>[...element.querySelectorAll('.ask-download__menu a')].map(link=>{const box=link.getBoundingClientRect();return link.textContent+':'+(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===link);}));
  assert.deepEqual(shown,['PDF:true','Excel:true','CSV:true','Text:true'],width+': the conversation download menu');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),width+': Ask has no sideways scroll');
  // Job 153: the records behind an answer open and fit the screen.
  const records=page.locator('[data-answer-sources]').last();await records.locator('summary').click();
  const fits=await records.evaluate(element=>[...element.querySelectorAll('a')].map(link=>{const box=link.getBoundingClientRect();return box.width>0&&box.right<=window.innerWidth+1;}));
  assert.ok(fits.length&&fits.every(Boolean),width+': every record link is visible within the screen '+JSON.stringify(fits));  await page.goto(origin+'/ask?goal='+written.id);
  assert.equal(await page.locator('.rm-agent__work .ask-download').count(),2,width+': each work product has its download menu');
  const orders=await page.goto(origin+'/orders?from=2000-01-01&to=2999-12-31');assert.equal(orders.status(),200);
  assert.ok(await page.locator('[data-placed-filter]').isVisible(),width+': the placed-date filter is shown');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),width+': orders have no sideways scroll');
  await page.context().close();
 }
});

'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{createHash,randomUUID}=require('node:crypto');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
async function setup(t){
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:20}),{db,ctx,owner}=f;
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 await require('../../src/assistant/postgres-codex-pilot').toggle(db,ctx,true);
 await db.query("UPDATE stockchief_runtime.codex_pilots SET stopped=false,approval_reference='OFFLINE UI ONLY',ceiling_micro_usd=1000000,period_ends_at=now()+interval '1 hour' WHERE workspace_id=$1",[ctx.workspaceId]);
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source) VALUES($1,$2,'pro','plan-services-2026-10-27:pro','COMP','CUSTOM','ISOLATED_TEST') ON CONFLICT(account_id) DO NOTHING",[randomUUID(),owner.accountId]);
 const store=require('../../src/assistant/postgres-goal-store'),actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 const authorityStamp=createHash('sha256').update(JSON.stringify({permissions:actor.permissions,role:actor.role})).digest('hex');
 const question=async(text,hoursAgo=1,runtime='hosted-business')=>{const goal=await store.create(db,ctx,'Request: '+text),id=randomUUID(),chatId='chat_'+randomUUID().replaceAll('-','');
  await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_USER',answer=$2,checkpoint=checkpoint||$3::jsonb,updated_at=now()-make_interval(hours=>$4::int) WHERE id=$1",[goal.id,text,JSON.stringify({runtime,chatId,harness:{authorityStamp,userQuestion:{id,question:text,missingInformation:[]}},conversationState:{version:1,goalId:goal.id,phase:'clarification',label:'Needs an answer',active:true,terminal:false,message:text,input:{id,question:text,missingInformation:[]},canReply:true,revision:1,history:[],recovery:null}}),hoursAgo]);return {goal,chatId};};
 return {...f,store,question,authorityStamp};
}
async function signIn(app,f){const agent=request.agent(app),page=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(page.text),email:f.email,password:f.password});return agent;}

test('a follow-up question leaves Needs you once dismissed, overtaken or a day old, and stays answerable',{timeout:180000},async t=>{
 const f=await setup(t),{db,ctx,question}=f,projection=require('../../src/assistant/postgres-approval-projection'),open=async()=>(await projection.pending(db,ctx.workspaceId,ctx.actorId)).filter(item=>item.question).map(item=>item.question.text);
 const kept=await question('Which blue one?'),dismissed=await question('Which supplier?'),overtaken=await question('Which location?');
 await question('Old question?',25);
 assert.deepEqual((await open()).sort(),['Which blue one?','Which location?','Which supplier?'],'A day-old question is gone; the agent that acts on changes has its questions shown too');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const agent=await signIn(app,f),inbox=await agent.get('/needs-you?category=clarification');
 assert.match(inbox.text,new RegExp('/needs-you/questions/'+dismissed.goal.id+'/dismiss'),'Every question has a Dismiss button');
 const done=await agent.post('/needs-you/questions/'+dismissed.goal.id+'/dismiss').type('form').send({_csrf:csrf(inbox.text)});assert.equal(done.status,303);
 assert.deepEqual((await open()).sort(),['Which blue one?','Which location?']);
 assert.equal((await f.store.get(db,ctx,dismissed.goal.id)).status,'WAITING_USER','Dismissing never cancels the request');
 await f.store.create(db,ctx,'Next request').then(next=>db.query("UPDATE stockchief_runtime.assistant_goals SET checkpoint=checkpoint||$2::jsonb WHERE id=$1",[next.id,JSON.stringify({runtime:'codex-staging',chatId:overtaken.chatId})]));
 assert.deepEqual(await open(),['Which blue one?'],'Moving on in that conversation clears its old question');
 await f.store.reply(db,ctx,kept.goal.id,'The blue shoe',{questionId:(await f.store.get(db,ctx,kept.goal.id)).checkpoint.harness.userQuestion.id});
 assert.deepEqual(await open(),[],'An answered question is gone');
 const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other business',email:randomUUID()+'@example.test',password:'Other-password-1!'});
 await projection.dismissQuestion(db,{workspaceId:foreign.workspaceId,actorId:foreign.userId},kept.goal.id);
 assert.equal((await db.query("SELECT checkpoint->>'needsYouDismissedAt' AS at FROM stockchief_runtime.assistant_goals WHERE id=$1",[kept.goal.id])).rows[0].at,null,'Another business cannot dismiss it');
});

test('every Ask table downloads as PDF, Excel and CSV, only for the person who asked',{timeout:180000},async t=>{
 const f=await setup(t),{db,ctx,workflows,store}=f,assistant=require('../../src/assistant/postgres-service');
 const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'export-sale',lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:9000}]});
 await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'export-confirm'});await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'export-fulfill',lines:[{lineId:order.lineIds[0],quantity:3,locationId:f.location.id}]});
 const answer=await assistant.ask(db,ctx,'Who ows me money?',{requestKey:'export-who',conversationId:'chat_export_answer',usageKey:'export-who'});
 assert.match(answer.answer,/Total owed: \$270\.00/);assert.doesNotMatch(answer.answer,/Filters:|balance minor/);
 const written=await store.create(db,ctx,'Show products');await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer=$2,checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE id=$1",[written.id,'### Products\n\n| Product | Price |\n|---|---:|\n| **Shoe** | $10.00 |\n| Hat | $5.00 |']);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const agent=await signIn(app,f);
 const page=await agent.get('/ask?chat=chat_export_answer');assert.match(page.text,new RegExp('/ask/answers/'+answer.interactionId+'/export\\.xlsx'));
 for(const [format,type] of [['csv',/text\/csv/],['xlsx',/spreadsheetml/],['pdf',/application\/pdf/]]){
  for(const url of ['/ask/answers/'+answer.interactionId+'/export.'+format,'/ask/goals/'+written.id+'/export.'+format]){const file=await agent.get(url).buffer(true).parse((res,done)=>{const parts=[];res.on('data',d=>parts.push(d));res.on('end',()=>done(null,Buffer.concat(parts)));});assert.equal(file.status,200,url);assert.match(file.headers['content-type'],type);assert.match(file.headers['content-disposition'],/attachment/);assert.ok(file.body.length>20,url);}
 }
 // Download answer as a spreadsheet: the answer's rows in their own columns, not its sentence in one cell.
 for(const url of ['/ask/answers/'+answer.interactionId+'/export.csv?content=answer','/ask/goals/'+written.id+'/export.csv?content=answer']){
  const whole=await agent.get(url),header=whole.text.replace(/^\W*?(?=")/,'').split('\r\n')[0];
  assert.equal(whole.status,200,url);assert.ok(header.split('","').length>1&&!/^"Answer"/.test(header),url+': the answer downloads in columns: '+header);
 }
 const csv=await agent.get('/ask/goals/'+written.id+'/export.csv');assert.match(csv.text,/"Product","Price"/);assert.match(csv.text,/"Shoe","\$10\.00"/,'Formatting marks stay out of the file');
 assert.equal((await agent.get('/ask/answers/'+answer.interactionId+'/export.exe')).status>=400,true);
 const foreign=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other business',email:'export-other@example.test',password:'Other-password-1!'}),outsider=await signIn(app,{email:'export-other@example.test',password:'Other-password-1!'});
 assert.equal(foreign.workspaceId!==ctx.workspaceId,true);
 assert.equal((await outsider.get('/ask/answers/'+answer.interactionId+'/export.csv')).status,404);
 assert.equal((await outsider.get('/ask/goals/'+written.id+'/export.csv')).status,404);
});

test('in the browser the Ask page cannot get stuck, and the top bar and customer list fit a phone',{timeout:180000},async t=>{
 const f=await setup(t),{db,ctx,store}=f,rows=Array.from({length:40},(_,i)=>`| Product ${i} | SKU-${i} | $${i}.00 |`).join('\n');
 const chatId='chat_stuck_page',written=await store.create(db,ctx,'Show every product');await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer=$2,checkpoint=checkpoint||$3::jsonb WHERE id=$1",[written.id,'### Catalogue\n\n| Product | SKU | Price |\n|---|---|---:|\n'+rows,JSON.stringify({runtime:'codex-staging',chatId,harness:{authorityStamp:f.authorityStamp}})]);
 await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'OBrien Trading LLC',email:'accounts.payable.department@obrien-trading-international.example.test'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));}),origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 const moved=page=>page.evaluate(()=>['html','body','.app','main#main','.sc-chat-workspace','.rm-chat'].map(s=>s==='html'?document.documentElement:document.querySelector(s)).filter(Boolean).filter(e=>e.scrollTop||e.scrollLeft).length);
 for(const [width,height] of [[1440,800],[390,844]]){
  const context=await browser.newContext({viewport:{width,height}}),page=await context.newPage();
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/ask?chat='+chatId+'&goal='+written.id+'#focused-goal');await page.waitForTimeout(500);
  assert.equal(await moved(page),0,width+': following a link to an answer leaves the page in place');
  assert.equal(await page.evaluate(()=>{const m=document.querySelector('main#main');return m.scrollHeight<=m.clientHeight+1;}),true,width+': nothing is left to scroll out of place');
  await page.evaluate(()=>{for(const s of ['main#main','.rm-chat'])document.querySelector(s).scrollTop=400;document.scrollingElement.scrollTop=400;});await page.waitForTimeout(150);
  assert.equal(await moved(page),0,width+': a forced move goes straight back');
  assert.equal(await page.locator('.ask-download--inline').count(),1,'The written table has a Download button');
  // Every format in a download menu can be seen and chosen, wherever its button sits in the chat.
  for(const place of ['start','end']){
   const shown=await page.evaluate(async place=>{document.querySelectorAll('.ask-download[open]').forEach(d=>{d.open=false;});
    const menu=[...document.querySelectorAll('.ask-download')].find(d=>/answer/i.test(d.querySelector('summary').textContent))||document.querySelector('.ask-download');
    menu.scrollIntoView({block:place});await new Promise(r=>setTimeout(r,120));menu.querySelector('summary').click();await new Promise(r=>setTimeout(r,200));
    return [...menu.querySelectorAll('.ask-download__menu a')].map(a=>{const r=a.getBoundingClientRect();return a.textContent+':'+(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===a);});},place);
   assert.deepEqual(shown,['PDF:true','Excel:true','CSV:true'],width+': every download format shows with its button at the '+place+' of the view');
  }
  await page.evaluate(()=>document.querySelectorAll('.ask-download[open]').forEach(d=>{d.open=false;}));
  assert.equal(await page.evaluate(()=>{const c=document.querySelector('[data-chat-scroll]');c.scrollTop=0;return c.scrollHeight>c.clientHeight;}),true,'The conversation itself still scrolls');
  for(const path of ['/','/orders','/money']){await page.goto(origin+path);const cut=await page.evaluate(()=>[...document.querySelectorAll('.sc-toolbar a,.sc-toolbar button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<-1);}).map(e=>e.textContent.trim()));assert.deepEqual(cut,[],width+' '+path+': nothing in the top bar is cut off');}
  await page.goto(origin+'/sales/customers?q=OBrien');
  const list=await page.evaluate(()=>{const row=document.querySelector('main table tbody tr'),name=row.querySelector('a').getBoundingClientRect(),contact=row.children[1],box=contact.getBoundingClientRect();let n=row,inner=false;while(n&&n.tagName!=='MAIN'){if(/(auto|scroll)/.test(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight+1)inner=true;n=n.parentElement;}return {separate:name.bottom<=box.top+1||innerWidth>800,wide:row.getBoundingClientRect().width>=Math.min(innerWidth,700)*.8,inner,sideways:document.documentElement.scrollWidth>innerWidth};});
  assert.deepEqual(list,{separate:true,wide:true,inner:false,sideways:false},width+': customer card');
  await context.close();
 }
});

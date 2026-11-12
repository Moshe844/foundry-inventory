'use strict';process.env.NODE_ENV='test';
// Job 93: when an item needs buying and the owner wants competition, one RFQ
// goes to several suppliers through the outbound mail queue; replies become
// quotations (job 92), silent suppliers get one reminder, and nothing is ever
// accepted or ordered on its own.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-rfq-fixture');
const competition=require('../../src/purchasing/agent-rfq-competition'),{addDays}=require('../../src/accounting/customer-money');

async function setup(t,plan){
 const f=await fixture(t,plan),{db,ctx}=f,today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const suppliers=(await db.query('SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id',[ctx.workspaceId,f.supplierIds])).rows;
 const connector=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[f.connectorId])).rows[0];
 const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>f.provider});
 const work=async kind=>{const out=[];for(let i=0;i<30;i++){const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'rfq-competition-test'});if(!r)break;assert.equal(r.status,'COMPLETED',JSON.stringify(r.lastError));out.push(r.result);}return out;};
 const category=async(skuId,name)=>db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) SELECT $1,item_id,$3,'{}',now()::text,now()::text FROM skus WHERE id=$2
  ON CONFLICT(workspace_id,item_id) DO UPDATE SET category=EXCLUDED.category`,[ctx.workspaceId,skuId,name]);
 const short=async(skuId,target=60)=>{await db.query('DELETE FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,skuId]);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,skuId,f.location.id,target-10,target]);};
 const product=async name=>(await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name,baseCode:name.toUpperCase().replace(/\W+/g,'-')+'-'+randomUUID().slice(0,6),trackingMode:'quantity'})).skuIds[0];
 const code=async skuId=>(await db.query('SELECT code FROM skus WHERE id=$1',[skuId])).rows[0].code;
 const rule=extra=>competition.save(db,ctx,{name:'Packaging quotes',categories:'Packaging',supplierNames:suppliers.map(s=>s.name).join('\n'),locationId:f.location.id,connectorId:f.connectorId,replyDays:'5',deliveryDays:'20',chaseDays:'3',maxRequestsPerWeek:'5',confirmed:'yes',...extra});
 const reply=(supplier,subject,bodyText)=>require('../../src/connections/postgres-mail').capture(db,connector,{messageId:randomUUID(),sender:supplier.email,subject,bodyText});
 const count=async(sql,args=[ctx.workspaceId])=>(await db.query(sql,args)).rows[0].n;
 return {...f,today,suppliers,work,category,short,product,code,rule,reply,count};
}

test('Pro drafts the first competition RFQ, learns from the sent example, captures replies as ranked quotes and reminds silent suppliers', {timeout:600000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service}=f,first=f.item.skuIds[0],firstCode=await f.code(first);
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.rule(),e=>e.code==='entitlement_required');}
 await f.subscribe('pro');
 await assert.rejects(f.rule({supplierNames:f.suppliers[0].name}),/two to twenty/);
 await assert.rejects(f.rule({categories:''}),/Choose when you want quotes/);
 const saved=await f.rule(),orders=await f.count('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1'),stock=await f.balance();
 await f.category(first,'Packaging');
 assert.equal((await competition.run(db,ctx.workspaceId)).rules[0].prepared,false,'Nothing needs buying yet');
 await f.short(first);
 const ran=(await competition.run(db,ctx.workspaceId)).rules[0];assert.ok(ran.requestId);assert.equal(ran.sent,false);assert.match(ran.needsPerson,/teach/);
 assert.equal((await competition.run(db,ctx.workspaceId)).rules[0].prepared,false,'The same product is not asked about again within 30 days');
 assert.equal(f.sent.length,0);
 const r=await service.request(db,ctx,ran.requestId),p=r.snapshot;
 assert.equal(p.lines.length,1);assert.equal(p.lines[0].skuId,first);assert.ok(p.lines[0].quantity>0);
 assert.equal(p.replyBy,addDays(f.today,5));assert.equal(p.deliverBy,addDays(f.today,20));assert.equal(p.location.id,f.location.id);
 const notices=await service.inbox(db,ctx.workspaceId,ctx.actorId);assert.ok(notices.some(n=>/Send supplier RFQ/.test(n.title)&&/teach/.test(n.why)));
 // The owner sends the first one; the mailbox worker delivers three emails.
 await f.send(r);await f.deliver();assert.equal(f.sent.length,3);
 for(const mail of f.sent){assert.match(mail.body,new RegExp(firstCode+' · '));assert.match(mail.body,new RegExp('Requested: '+p.lines[0].quantity+' '));assert.match(mail.body,new RegExp('by '+p.replyBy));
  assert.match(mail.body,new RegExp('Needed by '+p.deliverBy+', delivered to '));assert.match(mail.body,/not a purchase order/);}
 const ruleRow=await competition.rule(db,ctx,saved.id);
 await assert.rejects(competition.teach(db,ctx,saved.id,{requestId:'missing',revision:ruleRow.revision,confirmed:'yes'}),/Teach with an RFQ/);
 await competition.teach(db,ctx,saved.id,{requestId:r.id,revision:ruleRow.revision,confirmed:'yes'});
 // A second packaging item now goes out on its own within the taught rule.
 const second=await f.product('Packaging tape');await f.category(second,'Packaging');await f.short(second,40);
 const auto=(await competition.run(db,ctx.workspaceId)).rules[0];assert.equal(auto.sent,true,JSON.stringify(auto));await f.deliver();assert.equal(f.sent.length,6);
 const autoRequest=await service.request(db,ctx,auto.requestId);assert.deepEqual(autoRequest.snapshot.lines.map(l=>l.skuId),[second]);
 assert.equal(await f.count('SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_deliveries WHERE workspace_id=$1 AND automatic AND competition_rule_id IS NOT NULL'),3);
 // Replies to the first RFQ: two in the RFQ's format, one in free text.
 const [a,b,c]=f.suppliers,subject='Re: Request for quotation · '+p.reference,valid=addDays(f.today,30),arrive=addDays(f.today,15);
 await f.reply(a,subject,`Hello\n${firstCode}: ${p.lines[0].quantity} at USD 1.50 each\nFreight: USD 20.00\nValid through: ${valid}\nDelivery date: ${arrive}\nThanks`);
 await f.reply(b,subject,`${firstCode}: ${p.lines[0].quantity} at USD 1.25 each\nValid through: ${valid}`);
 const free=await f.reply(c,subject,'We can supply these for one dollar forty each, delivered in two weeks.');
 const captured=await f.work('mail.supplier-rfq-reply.v1');assert.equal(captured.length,3);
 assert.equal(captured.filter(x=>x.documentId).length,2);assert.ok(captured.some(x=>/no price lines/.test(x.needsPerson||'')));
 assert.equal(await f.count("SELECT count(*)::int n FROM supplier_documents WHERE workspace_id=$1 AND document_type='quotation' AND purchase_order_id IS NULL"),2);
 assert.ok((await service.inbox(db,ctx.workspaceId,ctx.actorId)).some(n=>/Record supplier quote/.test(n.title)));
 await assert.rejects(service.recordQuote(db,ctx,r.id,c.id,{messageId:free.messageId,['price_'+first]:'1.40',evidenceQuote:'one dollar ten each'}),/exact supporting quote/);
 await service.recordQuote(db,ctx,r.id,c.id,{messageId:free.messageId,['price_'+first]:'1.40',evidenceQuote:'one dollar forty each'});
 await service.recordQuote(db,ctx,r.id,c.id,{messageId:free.messageId,['price_'+first]:'1.40',evidenceQuote:'one dollar forty each'});
 assert.equal(await f.count("SELECT count(*)::int n FROM supplier_documents WHERE workspace_id=$1 AND document_type='quotation' AND purchase_order_id IS NULL"),3,'Recording the same reply again is idempotent');
 const view=await service.page(db,ctx,{id:r.id});
 assert.deepEqual(view.comparison.map(q=>[q.Supplier,q['Supplier unit price'],Number(q['Goods price rank'])]),[[b.name,'$1.25',1],[c.name,'$1.40',2],[a.name,'$1.50',3]]);
 assert.equal(view.comparison.find(q=>q.Supplier===a.name)['Quoted delivery charge'],'$20.00');assert.equal(view.totals.length,3);
 assert.ok((await service.inbox(db,ctx.workspaceId,ctx.actorId)).some(n=>/Compare supplier quotes/.test(n.title)));
 assert.ok((await require('../../src/autopilot/job-reviews').run(db,ctx,'compare-quotes',{filter:firstCode})).rows.some(q=>q.RFQ),'Job 92 comparison includes RFQ quotes');
 // Reminders: one supplier on the automatic RFQ replied; the other two get one reminder each.
 await f.reply(a,'Re: Request for quotation · '+autoRequest.snapshot.reference,'Thanks, we will get back to you.');await f.work('mail.supplier-rfq-reply.v1');
 await db.query(`UPDATE supplier_communications SET sent_at=$3 WHERE workspace_id=$1 AND id IN(SELECT communication_id FROM stockchief_runtime.agent_rfq_deliveries WHERE workspace_id=$1 AND request_id=$2)`,[ctx.workspaceId,auto.requestId,new Date(Date.now()-4*86400000).toISOString()]);
 const reminded=(await competition.run(db,ctx.workspaceId)).reminders;assert.equal(reminded.filter(x=>x.chased).length,2,JSON.stringify(reminded));
 assert.equal((await competition.run(db,ctx.workspaceId)).reminders.length,0,'Each supplier is reminded once');
 await f.deliver();const reminders=f.sent.filter(m=>/^Reminder: Request for quotation/.test(m.subject));assert.equal(reminders.length,2);assert.ok(reminders.every(m=>m.recipient!==a.email&&/No order has been placed/.test(m.body)));
 // Nothing was ordered, accepted or moved.
 assert.equal(await f.count('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1'),orders);assert.equal(await f.balance(),stock);
 await service.close(db,ctx,r.id,{confirmed:'yes'});assert.ok(!(await service.inbox(db,ctx.workspaceId,ctx.actorId)).some(n=>n.href==='/autopilot/supplier-rfqs/'+r.id&&/Compare/.test(n.title)));
 const audit=(await db.query("SELECT action FROM security_event_history WHERE workspace_id=$1 AND (action LIKE '%RFQ%' OR action LIKE '%quot%' OR action LIKE '%quote%') ORDER BY created_at",[ctx.workspaceId])).rows.map(r=>r.action);
 for(const action of ['Supplier quote rule saved','Supplier RFQ prepared from the owner’s quote rule for review','Supplier RFQ approved and queued','Supplier quote rule taught from a sent RFQ','Supplier RFQ prepared and sent from the owner’s quote rule','Supplier quotation captured from an RFQ reply on its own','Supplier quotation recorded from an RFQ reply','Supplier RFQ closed by the owner'])assert.ok(audit.includes(action),action);
 // The page renders the comparison and the rules on a desktop and a phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(res=>{const s=app.listen(0,'127.0.0.1',()=>res(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(res=>server.close(res));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;require('node:fs').mkdirSync('output',{recursive:true});
 for(const [width,height,name] of [[1440,900,'desktop'],[390,844,'phone']]){
  const page=await browser.newPage({viewport:{width,height},isMobile:width<500,hasTouch:width<500});page.setDefaultTimeout(15000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  assert.equal((await page.goto(origin+'/autopilot/supplier-rfqs/'+r.id)).status(),200);const text=await page.locator('main').innerText();
  assert.match(text,/Quotes so far/);assert.match(text,new RegExp('Needed by '+p.deliverBy));assert.match(text,/Start a purchase order with/);assert.match(text,/Prepared by your quote rule/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' has no sideways scrolling');
  await page.screenshot({path:'output/rfq-competition-'+name+'.png',fullPage:true});
  await page.goto(origin+'/autopilot/supplier-rfqs');assert.match(await page.locator('main').innerText(),/When to ask for quotes[\s\S]*Packaging quotes/);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.close();
 }
});

test('Custom sends on its own within the rule; shadow, watch-only, pause, Ask me first, limits, downgrade and bad data hold it', {timeout:600000},async t=>{
 const f=await setup(t,'enterprise'),{db,ctx,service}=f,modes=require('../../src/autopilot/job-modes');
 const [a]=f.suppliers;
 // Each trigger: named product, category, new item and purchase value.
 const named=await f.product('Named part'),boxed=await f.product('Boxed part'),fresh=await f.product('Fresh part'),costly=f.item.skuIds[0];
 await f.category(boxed,'Boxes');
 for(const sku of [named,boxed,fresh,costly])await f.short(sku,500);
 const base={supplier_ids:f.supplierIds,location_id:f.location.id,new_items:false,threshold_minor:null,currency:null,sku_ids:[],categories:[]};
 const why=async extra=>db.transaction(async c=>(await competition.needs(c,ctx,{...base,...extra},f.today)).map(x=>[x.skuId,x.why]));
 assert.deepEqual(await why({sku_ids:[named]}),[[named,'named in the rule']]);
 assert.deepEqual(await why({categories:['Boxes']}),[[boxed,'in the boxes category']]);
 const fresh3=new Set((await why({new_items:true})).map(x=>x[0]));assert.ok(fresh3.has(named)&&fresh3.has(boxed)&&fresh3.has(fresh)&&!fresh3.has(costly),'Only never-bought items are new');
 const pricey=await why({threshold_minor:100,currency:'USD'});assert.deepEqual(pricey.map(x=>x[0]),[costly]);assert.match(pricey[0][1],/at the last price/);
 assert.deepEqual(await why({threshold_minor:10000000,currency:'USD'}),[],'Below the amount needs no competition');
 const orders=await f.count('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1');
 // The page's quote rule form saves and stops a rule.
 const form=await f.browser.get('/autopilot/supplier-rfqs').expect(200);assert.match(form.text,/Add a quote rule/);
 await f.browser.post('/autopilot/supplier-rfq-competition').type('form').send({_csrf:f.csrf(form.text),ruleName:'Form rule',ruleNewItems:'yes',ruleThreshold:'250',ruleCurrency:'USD',ruleSuppliers:f.suppliers.map(s=>s.name).join('\n'),
  ruleLocationId:f.location.id,ruleConnectorId:f.connectorId,ruleReplyDays:'4',ruleDeliveryDays:'14',ruleChaseDays:'2',ruleMaxPerWeek:'3',confirmed:'yes'}).expect(303);
 const formRule=(await db.query("SELECT * FROM stockchief_runtime.agent_rfq_competition_rules WHERE workspace_id=$1 AND name='Form rule'",[ctx.workspaceId])).rows[0];
 assert.equal(formRule.new_items,true);assert.equal(Number(formRule.threshold_minor),25000);assert.equal(formRule.supplier_ids.length,3);assert.equal(formRule.reply_days,4);
 const listed=await f.browser.get('/autopilot/supplier-rfqs').expect(200);assert.match(listed.text,/Form rule/);
 await f.browser.post('/autopilot/supplier-rfq-competition/'+formRule.id+'/stop').type('form').send({_csrf:f.csrf(listed.text),revision:formRule.revision}).expect(303);
 assert.equal((await competition.rule(db,ctx,formRule.id)).enabled,false);
 // Shadow mode only watches.
 const saved=await f.rule({categories:'',skuCodes:await f.code(named),maxRequestsPerWeek:'1'});
 await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 assert.equal((await competition.run(db,ctx.workspaceId)).rules[0].watched,true);
 assert.match((await competition.rule(db,ctx,saved.id)).last_note,/would have asked 3 suppliers/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // Watch only changes nothing.
 await modes.save(db,ctx,93,{mode:'watch',revision:0});
 assert.ok((await competition.run(db,ctx.workspaceId)).rules[0].stopped);assert.equal(await f.count('SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_requests WHERE workspace_id=$1'),0);
 // Ask me first prepares the RFQ for approval instead of sending it.
 await modes.save(db,ctx,93,{mode:'ask',revision:1});
 const asked=(await competition.run(db,ctx.workspaceId)).rules[0];assert.equal(asked.sent,false);assert.match(asked.needsPerson,/Ask me first/);assert.equal(f.sent.length,0);
 await modes.save(db,ctx,93,{mode:'inherit',revision:2});
 // Pause holds the next one for a person too.
 const more=await f.product('Named part two');await f.short(more,300);
 await competition.save(db,ctx,{ruleId:saved.id,revision:(await competition.rule(db,ctx,saved.id)).revision,name:'Named parts',skuCodes:[await f.code(named),await f.code(more)].join('\n'),supplierNames:f.suppliers.map(s=>s.name).join('\n'),locationId:f.location.id,connectorId:f.connectorId,replyDays:'5',deliveryDays:'20',chaseDays:'3',maxRequestsPerWeek:'1',confirmed:'yes'});
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);
 const paused=(await competition.run(db,ctx.workspaceId)).rules[0];assert.equal(paused.sent,false);assert.ok(paused.needsPerson);
 await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 // Custom sends on its own without training, then the weekly limit holds the next one.
 const third=await f.product('Named part three');await f.short(third,300);
 await competition.save(db,ctx,{ruleId:saved.id,revision:(await competition.rule(db,ctx,saved.id)).revision,name:'Named parts',skuCodes:await f.code(third),supplierNames:f.suppliers.map(s=>s.name).join('\n'),locationId:f.location.id,connectorId:f.connectorId,replyDays:'5',deliveryDays:'20',chaseDays:'3',maxRequestsPerWeek:'1',confirmed:'yes'});
 const sent=(await competition.run(db,ctx.workspaceId)).rules[0];assert.equal(sent.sent,true,JSON.stringify(sent));
 assert.equal((await competition.rule(db,ctx,saved.id)).example_request_id,null,'Custom needs no taught example');
 const fourth=await f.product('Named part four');await f.short(fourth,300);
 await competition.save(db,ctx,{ruleId:saved.id,revision:(await competition.rule(db,ctx,saved.id)).revision,name:'Named parts',skuCodes:[await f.code(third),await f.code(fourth)].join('\n'),supplierNames:f.suppliers.map(s=>s.name).join('\n'),locationId:f.location.id,connectorId:f.connectorId,replyDays:'5',deliveryDays:'20',chaseDays:'3',maxRequestsPerWeek:'1',confirmed:'yes'});
 const limited=(await competition.run(db,ctx.workspaceId)).rules[0];assert.equal(limited.sent,false);assert.match(limited.needsPerson,/limit/);
 // A downgrade stops the queued automatic emails before the mailbox is called.
 const effect=(await db.query('SELECT e.id FROM stockchief_runtime.agent_rfq_deliveries d JOIN stockchief_runtime.provider_effects e ON e.workspace_id=d.workspace_id AND e.aggregate_id=d.communication_id WHERE d.workspace_id=$1 AND d.request_id=$2 ORDER BY d.id LIMIT 1',[ctx.workspaceId,sent.requestId])).rows[0];
 await f.subscribe('growth');let calls=0;
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,effect.id,{provider:{send:async()=>{calls++;return {externalMessageId:'unexpected'};}}}),/plan|Pro|Custom/i);assert.equal(calls,0);
 assert.equal((await competition.run(db,ctx.workspaceId)).skipped!==undefined,true);
 await f.subscribe('enterprise');
 // Bad data stops and asks: a supplier without an email address.
 const fifth=await f.product('Named part five');await f.short(fifth,300);
 await competition.save(db,ctx,{ruleId:saved.id,revision:(await competition.rule(db,ctx,saved.id)).revision,name:'Named parts',skuCodes:await f.code(fifth),supplierNames:f.suppliers.map(s=>s.name).join('\n'),locationId:f.location.id,connectorId:f.connectorId,replyDays:'5',deliveryDays:'20',chaseDays:'3',maxRequestsPerWeek:'5',confirmed:'yes'});
 await db.query("UPDATE suppliers SET email='' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,a.id]);
 const bad=(await competition.run(db,ctx.workspaceId)).rules[0];assert.ok(bad.problem,JSON.stringify(bad));assert.match((await competition.rule(db,ctx,saved.id)).last_note,/Could not prepare/);
 assert.equal(await f.count('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1'),orders,'No order is ever placed');
 // Saved rules count against the plan's rule allowance and can be stopped.
 await competition.stop(db,ctx,saved.id,{revision:(await competition.rule(db,ctx,saved.id)).revision});
 assert.equal((await competition.run(db,ctx.workspaceId)).rules.length,0);
});

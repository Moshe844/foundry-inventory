'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 167 is alone on every plan. The owner writes a rule in plain words; it
// is read without AI, its brand, category, supplier, location or tag is found
// in the records, and anything unclear is asked back. The worker checks every
// rule for stock under, over or out, selling price changes, sales above or
// below a number and batches about to expire, and raises and clears alerts in
// the app, Needs you and email, like job 166. Rules count against the plan's
// rule allowance.
test('watch rules in plain words follow brands, categories, suppliers, locations and tags through the worker on every plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,browser,subscribe,location,workflows}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const watch=require('../../src/autopilot/watch-rules'),parser=require('../../src/autopilot/watch-rule-parser'),alerts=require('../../src/autopilot/agent-alerts');
  const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service'),modes=require('../../src/autopilot/job-modes');
  const prices=require('../../src/pricing/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  const check=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const brooklyn=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Brooklyn',kind:'warehouse'});
  const product=async(code,facts,{category=null,lots=false}={})=>{
    const made=await catalog.createItem(db,ctx,{name:'Watch '+code,baseCode:code,trackingMode:lots?'lot':'quantity',...(lots?{purchaseCost:'2'}:{})});
    await db.query('INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,$4,now()::text,now()::text)',
      [ws,made.itemId,category,JSON.stringify(facts||{})]);
    return made.skuIds[0];
  };
  const receive=(skuId,quantity,at=location.id)=>inventory.receive(db,ctx,{skuId,quantity,locationId:at,idempotencyKey:randomUUID()});
  const sell=(skuId,quantity)=>inventory.issue(db,ctx,{skuId,quantity,locationId:location.id,reasonCode:'sold',idempotencyKey:randomUUID()});
  const open=async()=>(await db.query(`SELECT r.instruction,n.reference FROM stockchief_runtime.agent_operational_notices n
    JOIN stockchief_runtime.agent_watch_rules r ON r.id=n.kind WHERE n.workspace_id=$1 AND n.job_id=167 AND NOT n.resolved ORDER BY r.created_at,n.reference`,[ws])).rows
    .map(r=>r.instruction.replace(/^Tell me (?:if|when) /,'')+' → '+r.reference);
  const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);

  const NIKE=await product('NIKE-1',{brand:'Nike',tags:'school, kids'},{category:'Shoes'});
  const NIKE2=await product('NIKE-2',{Brand:'NIKE',tags:['Gym']},{category:'Shoes'});
  const ACME=await product('ACME-1',{brand:'Acme'},{category:'Tools'});
  const MILK=await product('MILK-1',{brand:'Dairyland'},{category:'Fresh',lots:true});
  await receive(NIKE,19);await receive(NIKE2,40);await receive(ACME,120);await receive(ACME,3,brooklyn.id);
  await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:ACME,isPreferred:true});
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:MILK,locationId:location.id,lotCode:'M-SOON',expiresAt:day(10),
    lotReceivedAt:day(-5),quantity:4,idempotencyKey:randomUUID()});
  await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:MILK,locationId:location.id,lotCode:'M-LATER',expiresAt:day(90),
    lotReceivedAt:day(-5),quantity:4,idempotencyKey:randomUUID()});
  await sell(NIKE2,6);await sell(NIKE2,6);
  await prices.setPrice(db,ctx,{skuId:ACME,amountMinor:1000,currency:'USD'});

  // The words are read the same way every time, without AI.
  const read=text=>{const r=parser.parse(text);return [r.subject.kind||r.subject.kinds.join('/'),r.subject.name||'',r.condition,r.amount,r.inclusive,r.days];};
  assert.deepEqual(read('Tell me if any Nike item drops under 20'),['BRAND/CATEGORY/SUPPLIER/LOCATION/TAG','Nike','STOCK_BELOW',20,false,null]);
  assert.deepEqual(read('Notify me when anything at Brooklyn is at or below 5.'),['LOCATION','Brooklyn','STOCK_BELOW',5,true,null]);
  assert.deepEqual(read('Tell me if any item from supplier Fixture parts goes over 100'),['SUPPLIER','Fixture parts','STOCK_ABOVE',100,false,null]);
  assert.deepEqual(read('Tell me when any item in the Shoes category runs out'),['CATEGORY','Shoes','OUT_OF_STOCK',null,false,null]);
  assert.deepEqual(read('Tell me when any item tagged gym sells more than 10 in a week'),['TAG','gym','SALES_ABOVE',10,false,7]);
  assert.deepEqual(read('Tell me if sales of any Nike item drop below 5 in the last 30 days'),['BRAND/CATEGORY/SUPPLIER/LOCATION/TAG','Nike','SALES_BELOW',5,false,30]);
  assert.deepEqual(read('Tell me if the price of any Acme item changes'),['BRAND/CATEGORY/SUPPLIER/LOCATION/TAG','Acme','PRICE_CHANGE',null,false,7]);
  assert.deepEqual(read('Tell me when any Fresh category item expires within 30 days'),['CATEGORY','Fresh','EXPIRES_WITHIN',null,false,30]);
  assert.deepEqual(read('Tell me if any item drops to 3 or fewer'),['ALL','','STOCK_BELOW',3,true,null]);
  // Unclear rules are asked back, never guessed.
  for(const [text,question] of [['Tell me if any Nike item drops',/Say the number/],['Tell me if any Nike item sells more than 5',/Over how many days/],
    ['Tell me if any item expires',/Within how many days/],['Tell me if the cost of any Nike item changes',/selling prices/],
    ['Tell me if any Nike item drops under 20 in a week',/stock on hand now/],['Reorder Nike shoes',/StockChief can watch stock under, over or out/]])
    assert.throws(()=>parser.parse(text),question,text);

  const page=async()=>browser.get(watch.path).expect(200);
  const post=async instruction=>{const p=await page();return browser.post(watch.path+'/rules').type('form').send({_csrf:f.csrf(p.text),instruction}).expect(303);};
  await subscribe('starter');
  // A name that could be two things is asked back, and the words stay on the page.
  await db.query("UPDATE catalogue_item_facts SET facts='{\"brand\":\"Nike\",\"tags\":\"school, kids, shoes\"}' WHERE workspace_id=$1 AND item_id=(SELECT item_id FROM skus WHERE id=$2)",[ws,NIKE]);
  await post('Tell me if any Shoes item runs out');
  let shown=await page();
  assert.match(shown.text,/“Shoes” is a category and a tag\. Say which: “any item in the Shoes category” or “any item tagged Shoes”/);
  assert.match(shown.text,/value="Tell me if any Shoes item runs out"/);
  await assert.rejects(watch.save(db,ctx,{instruction:'Tell me if any Puma item drops under 5'}),/No active product has the brand, category, supplier, location or tag “Puma”/);
  await assert.rejects(watch.save(db,ctx,{instruction:'Tell me if anything at Queens drops under 5'}),/No active location is called “Queens”/);
  await assert.rejects(watch.save(db,{...ctx,actorId:'someone-else'},{instruction:'Tell me if any Nike item drops under 20'}),/Only the owner/);
  assert.equal(await audits('Watch rule saved'),0);

  // Starter saves up to five rules in plain words.
  await post('Tell me if any Nike item drops under 20');
  await watch.save(db,ctx,{instruction:'Tell me when any item in the Shoes category runs out'});
  await watch.save(db,ctx,{instruction:'Tell me if anything at Brooklyn is at or below 5'});
  await watch.save(db,ctx,{instruction:'Tell me if any item from supplier Fixture parts goes over 100'});
  await watch.save(db,ctx,{instruction:'Tell me when any item tagged gym sells more than 10 in a week'});
  await assert.rejects(watch.save(db,ctx,{instruction:'Tell me if the price of any Acme item changes'}),/5 active rules/);
  const listed=await watch.list(db,ws);
  assert.deepEqual(listed.map(r=>r.meaning),['Any Nike brand item, when stock is below 20.','Any item in the Shoes category, when it runs out.',
    'Any item stocked at Brooklyn, when stock there is at or below 5.','Any item from supplier Fixture parts, when stock is above 100.',
    'Any item tagged gym, when it sells more than 10 in a week.']);
  assert.equal(await audits('Watch rule saved'),5);

  // Every plan checks the rules on its own through the worker.
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);await check();
    assert.deepEqual(await open(),['any Nike item drops under 20 → NIKE-1','anything at Brooklyn is at or below 5 → ACME-1 at Brooklyn',
      'any item from supplier Fixture parts goes over 100 → ACME-1','any item tagged gym sells more than 10 in a week → NIKE-2'],tier);
    const notice=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-167');
    assert.equal(notice.title,'Your watch rules found something');assert.equal(notice.happened,'4 products match your watch rules.');
    const review=await reviews.run(db,ctx,watch.key,{scheduled:true});
    assert.deepEqual(review.rows.map(r=>[r.SKU,r.Location,r.Found]),[['NIKE-1','All locations','19 units on hand'],['ACME-1','Brooklyn','3 units on hand'],
      ['ACME-1','All locations','123 units on hand'],['NIKE-2','All locations','12 units sold in the last 7 days']]);
    assert.match((await page()).text,/Any item tagged gym, when it sells more than 10 in a week\./);
  }

  // Growth allows more rules: price changes, sales below and expiry.
  await subscribe('growth');
  await watch.save(db,ctx,{instruction:'Tell me if the price of any Acme item changes'});
  await watch.save(db,ctx,{instruction:'Tell me if sales of any Nike item drop below 5 in the last 30 days'});
  await watch.save(db,ctx,{instruction:'Tell me when any Fresh category item expires within 30 days'});
  await check();
  assert.deepEqual((await open()).slice(4),['sales of any Nike item drop below 5 in the last 30 days → NIKE-1',
    'any Fresh category item expires within 30 days → MILK-1 batch M-SOON at Dispatch'],'A first price is not a change; NIKE-2 sold 12.');
  await prices.setPrice(db,ctx,{skuId:ACME,amountMinor:1250,currency:'USD'});
  await check();
  const priced=(await reviews.run(db,ctx,watch.key,{filter:'ACME-1'})).rows.find(r=>/price/.test(r.Rule));
  assert.match(priced.Found,/^Price changed from \$10\.00 to \$12\.50 on \d{4}-\d{2}-\d{2}$/);

  // Stock changes update and clear the alerts; replays add nothing.
  const before=await audits('Alerts updated');
  await check();await check();
  assert.equal(await audits('Alerts updated'),before);
  await receive(NIKE,1);await sell(ACME,30);await check();
  assert.ok(!(await open()).some(a=>a.endsWith('→ NIKE-1')&&a.includes('drops under 20')),'20 is not under 20.');
  assert.ok(!(await open()).some(a=>a.includes('goes over 100')));
  await watch.save(db,ctx,{instruction:'Notify me when any Nike item is at or below 20'});
  assert.equal((await watch.list(db,ws)).filter(r=>r.subject_name==='Nike'&&r.condition==='STOCK_BELOW').length,1,'The same brand and condition is one rule.');
  assert.ok((await open()).includes('Notify me when any Nike item is at or below 20 → NIKE-1'));
  const reminders=(await db.query("SELECT reminders FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=167 AND reference='NIKE-1' AND kind=(SELECT id FROM stockchief_runtime.agent_watch_rules WHERE workspace_id=$1 AND subject_name='Nike' AND condition='STOCK_BELOW')",[ws])).rows[0].reminders;
  assert.equal(reminders,2,'The rule kept its identity, so its alert reopened.');
  // A new product of a watched brand is watched at once.
  const NIKE3=await product('NIKE-3',{brand:'nike'},{category:'Shoes'});await check();
  assert.ok((await open()).includes('any item in the Shoes category runs out → NIKE-3'));
  assert.ok(NIKE3);
  // Removing a rule clears its alerts.
  await watch.save(db,ctx,{remove:'Shoes'});
  assert.ok(!(await open()).some(a=>a.includes('Shoes category')));
  assert.equal(await audits('Watch rule removed'),1);

  // Alerts are emailed like job 166, and wait for the job's Watch only.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  await modes.save(db,ctx,167,{mode:'watch',revision:0});
  await alerts.configure(db,ctx,167,{mailbox:connector});
  await check();
  let panel=await alerts.panel(db,ctx,167);
  assert.ok(panel.waiting>0);assert.match(panel.note,/Watch only/);
  await modes.save(db,ctx,167,{mode:'inherit',revision:1});
  await check();
  assert.equal((await alerts.panel(db,ctx,167)).waiting,0);
  const email=(await db.query(`SELECT DISTINCT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=167`,[ws])).rows;
  assert.equal(email.length,1);
  const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,email[0].id])).rows[0].id;
  const sent=[];await mail.executeSendEffect(db,ws,effect,{provider:{send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}}});
  assert.equal(sent[0].recipient,f.email);assert.match(sent[0].subject,/watch rule alerts$/);
  assert.match(sent[0].body,/- NIKE-1 \(Watch NIKE-1\)\. 20 units on hand\. Your rule: “Notify me when any Nike item is at or below 20”/);
  assert.match(sent[0].body,/- MILK-1 at Dispatch \(Watch MILK-1\)\. Batch M-SOON: 4 units expire on /);
  await check();
  assert.equal(await audits('Alert email queued'),1,'Replays never email again.');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+watch.path);
    assert(await tab.getByRole('heading',{name:'Watch rules',exact:true}).isVisible());
    assert(await tab.getByRole('button',{name:'Save rule'}).isVisible());
    assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'watch-rules-'+name+'.png'),fullPage:true});
    await tab.close();
  }
  assert.ok(workflows);
});

'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 207 is alone on every plan: Starter keeps up to 5 rules, Growth 50, Pro
// 500, Custom unlimited. The owner writes a rule in plain words. It is read
// without AI into one supported kind, the names in it are found exactly, and
// StockChief shows what it will do. Only the owner's confirmation saves it,
// through that kind's own service and the shared rule allowance. A rule that
// needs a higher plan says which plan; an unreadable rule is refused with the
// reason and examples. Supplier rules ("always/never order X from Y") are new
// here and steer reorder drafts and automatic reorders.
test('rules in plain words are read exactly, confirmed, and saved by their own service within every plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  const P=require('../../src/actions/permissions'),auth=require('../../src/domain/postgres-auth-service'),policy=require('../../src/commercial/agent-plan');
  const commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const rules=require('../../src/autopilot/plain-rules'),reader=require('../../src/autopilot/plain-rule-reader'),choice=require('../../src/purchasing/supplier-choice-rules');
  const instructions=require('../../src/manager/postgres-operating-instructions'),assistant=require('../../src/assistant/postgres-service');
  const autonomy=require('../../src/autopilot/postgres-service'),actions=require('../../src/purchasing/agent-reorder-workflows');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autonomy.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const account=await auth.createBusiness(db,{name:'Sarah Cohen',businessName:'Sarah elsewhere',email:randomUUID()+'@example.test',password:f.password});
  const sarah={workspaceId:ws,actorId:'member-'+randomUUID()};
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Sarah Cohen','staff',$4,now()::text)`,
    [sarah.actorId,ws,account.accountId,P.encodeGrant([P.VIEW_PURCHASING,P.APPROVE_PO])]);
  const acme=await commerce.createSupplier(db,ctx,{name:'Acme',currency:'USD'}),beta=await commerce.createSupplier(db,ctx,{name:'Beta',currency:'USD'});
  await db.query("UPDATE suppliers SET freight_terms_currency='USD',ordinary_freight_minor=1500,free_freight_threshold_minor=50000 WHERE workspace_id=$1 AND id=$2",[ws,acme.id]);
  const product=async(code,category)=>{const made=await catalog.createItem(db,ctx,{name:'Rule '+code,baseCode:code,trackingMode:'quantity'});
    await db.query('INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,$4,now()::text,now()::text)',[ws,made.itemId,category,'{}']);
    return made.skuIds[0];};
  const shoe=await product('A-SHOE','Shoes'),tool=await product('TOOL-1','Tools');
  await inventory.receive(db,ctx,{skuId:tool,quantity:5,locationId:f.location.id,idempotencyKey:randomUUID()});
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:shoe,lastUnitCost:1,purchaseUnit:'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,isPreferred:true,leadTimeDays:4});
  await commerce.linkSupplierItem(db,ctx,{supplierId:acme.id,skuId:shoe,lastUnitCost:2,purchaseUnit:'unit',unitsPerPurchaseUnit:1,minimumOrderQuantity:1,orderMultiple:1,isPreferred:false,leadTimeDays:4});
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,2,12,'manual',now()::text,now()::text)`,[randomUUID(),ws,shoe,f.location.id]);

  const page=async rule=>(await browser.get(rules.path).query(rule?{rule}:{}).expect(200)).text;
  const confirm=async rule=>{const text=await page(rule),key=/name="key" value="([^"]+)"/.exec(text)?.[1];assert.ok(key,'A confirm button for: '+rule);
    const saved=await browser.post(rules.path+'/confirm').type('form').send({_csrf:f.csrf(text),rule,key}).expect(303);
    return {location:saved.headers.location,shown:(await browser.get(saved.headers.location).expect(200)).text};};
  const used=async()=>(await rules.usage(db,await policy.accountState(db,ws))).used;
  const audits=async action=>Number((await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const draft=async()=>{const p=await assistant.prepareAction(db,ctx,'Prepare the supplier-grouped reorder list',{action:actions.DRAFT,skuCodes:'A-SHOE'});
    return (await assistant.getProposal(db,ws,p.proposal.id)).payload.output.map(g=>g.supplierId);};

  // An account still on its older terms sees the plan card.
  assert.match(await page(),/data-agent-plan-locked/);

  // The same words always give the same reading, without AI.
  assert.deepEqual(reader.read('Always split Acme POs over $10k by delivery date'),{kind:'split',supplier:'Acme',money:{amount:'10000',symbol:'$',code:null},strategy:'delivery-date',budget:null,places:null,sentence:'Always split Acme POs over $10k by delivery date'});
  assert.equal(reader.read('Orders over $5,000 go to Sarah for approval, not me').approval,'purchase');
  assert.equal(reader.read('Never order anything in the Shoes category from Beta').scope,'CATEGORY');
  assert.equal(reader.read('Keep a buffer of 10 units of A-SHOE at Dispatch').safetyStock,10);

  await subscribe('starter');
  // Unreadable, ambiguous or unknown: refused with the reason. Nothing saved.
  for(const [rule,why] of [['Every Friday at 4 pm, send me the slow movers',/can’t read that rule exactly, so it saved nothing/],
    ['Keep at least 20 of A-SHOE',/won’t guess what a minimum should do/],['Always split POs over $10,000 into two deliveries',/Name the supplier whose orders to split/],
    ['Order from Acme first; use Beta only if it’s 20% cheaper',/cannot read a supplier choice with a condition/],
    ['Always order A-SHOE from Gamma',/No active supplier is called “Gamma”/],['Reorder NOPE at 5',/No active product or SKU is called “NOPE”/]]){
    const text=await page(rule);assert.match(text,why,rule);assert.doesNotMatch(text,/name="key"/,rule);
  }
  assert.match(await page('Never order from a new supplier without my OK'),/Already how StockChief works[\s\S]*first order to a new supplier always needs a person/);
  assert.equal(await used(),0);

  // A supplier rule: the exact meaning, then the owner confirms it.
  assert.deepEqual(await draft(),['fixture-supplier'],'Without a rule the preferred supplier is used.');
  let text=await page('Never order A-SHOE from Fixture parts');
  assert.match(text,/Reorders of A-SHOE \(Rule A-SHOE\) never use Fixture parts\. If no other supplier sells it, StockChief asks you\./);
  await browser.post(rules.path+'/confirm').type('form').send({_csrf:f.csrf(text),rule:'Never order A-SHOE from Fixture parts',key:'stale'}).expect(303);
  assert.match(await page(),/Your records changed since StockChief read this rule/);assert.equal(await used(),0);
  await assert.rejects(rules.confirm(db,sarah,{rule:'Never order A-SHOE from Fixture parts',key:(await rules.read(db,ctx,'Never order A-SHOE from Fixture parts')).key}),/Only the owner/);
  let saved=await confirm('Never order A-SHOE from Fixture parts');
  assert.equal(saved.location,rules.path+'#supplier-rules');assert.match(saved.shown,/Rule saved: Reorders of A-SHOE/);
  assert.equal(await used(),1);assert.equal(await audits('Supplier rule saved'),1);assert.equal(await audits('Rule written in plain words'),1);
  saved=await confirm('Never order A-SHOE from Fixture parts');
  assert.match(saved.shown,/That rule is already saved\. Nothing changed\./);assert.equal(await used(),1);assert.equal(await audits('Rule written in plain words'),1);
  // It steers the reorder: the draft and the automatic choice use Acme.
  assert.deepEqual(await draft(),[acme.id]);
  assert.equal((await autonomy.lowestStockDraft(db,ws)).supplier,'Acme');
  // "Always" a supplier that does not sell it: the reorder stops and asks.
  await confirm('Always order anything in the Shoes category from Beta');
  assert.equal(await used(),2);
  await assert.rejects(draft(),/Your rules “Always order anything in the Shoes category from Beta” and “Never order A-SHOE from Fixture parts” leave no supplier for A-SHOE/);
  assert.match((await autonomy.lowestStockDraft(db,ws)).question,/Link a supplier/);
  const always=(await choice.list(db,ws)).find(r=>r.choice==='ALWAYS');
  text=await page();
  await browser.post(rules.path+'/supplier-rules/remove').type('form').send({_csrf:f.csrf(text),id:always.id}).expect(303);
  assert.equal(await used(),1);assert.equal(await audits('Supplier rule removed'),1);assert.deepEqual(await draft(),[acme.id]);

  // A watch rule is saved by job 167's service.
  saved=await confirm('Tell me if any item in the Shoes category runs out');
  assert.equal(saved.location,'/autopilot/reviews/watch-rules');assert.equal((await require('../../src/autopilot/watch-rules').list(db,ws)).length,1);
  assert.equal(await used(),2);
  // A reorder setting is prepared and then turned on from its review page.
  saved=await confirm('Reorder TOOL-1 at 5 up to 20');
  assert.match(saved.location,/^\/operating-instructions\/oin/);assert.match(saved.shown,/Check the exact setting and turn it on/);
  const again=await confirm('Reorder TOOL-1 at 5 up to 20');
  assert.equal(again.location,saved.location,'A second click reopens the same waiting setting.');
  let proposal=await instructions.get(db,ws,saved.location.split('/').pop());
  await instructions.approve(db,ctx,proposal.id,proposal.integrityHash);
  assert.equal(Number((await db.query('SELECT reorder_point FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2',[ws,tool])).rows[0].reorder_point),5);
  saved=await confirm('Keep a buffer of 3 units of A-SHOE');
  proposal=await instructions.get(db,ws,saved.location.split('/').pop());await instructions.approve(db,ctx,proposal.id,proposal.integrityHash);
  assert.equal(await used(),4);
  await confirm('Never order TOOL-1 from Beta');
  assert.equal(await used(),5);
  // Starter keeps five rules: the sixth is refused, nothing is saved.
  text=await page('Never order TOOL-1 from Acme');
  await browser.post(rules.path+'/confirm').type('form').send({_csrf:f.csrf(text),rule:'Never order TOOL-1 from Acme',key:/name="key" value="([^"]+)"/.exec(text)[1]}).expect(303);
  assert.match(await page(),/Your plan includes 5 active rules across your inventories/);assert.equal(await used(),5);
  assert.match(await page(),/You use 5 of 5 rules on Starter/);
  // A rule beyond the plan says which plan unlocks it, and cannot be saved.
  for(const [rule,plan] of [['Purchase orders over $5,000 go to Sarah for approval, not me','Pro'],['Combine Acme POs for Dispatch into one, up to $2,000','Growth'],
    ['Always split Acme POs over $10,000 by delivery date','Pro']]){
    text=await page(rule);assert.match(text,new RegExp('This rule needs '+plan+'\\. You are on Starter'),rule);assert.doesNotMatch(text,/name="key"/);
    await assert.rejects(rules.confirm(db,ctx,{rule,key:(await rules.read(db,ctx,rule)).key}),e=>e.code==='entitlement_required',rule);
  }

  await subscribe('growth');
  // Combining is trained on Growth: it needs one combined order approved by hand first.
  text=await page('Combine Acme POs for Dispatch into one, up to $2,000');
  assert.match(text,/Unsent draft purchase orders from Acme to Dispatch that are due the same day are combined into one order of up to \$2,000\.00/);
  assert.match(text,/StockChief first needs one combined order like this that you approved by hand/);
  saved=await browser.post(rules.path+'/confirm').type('form').send({_csrf:f.csrf(text),rule:'Combine Acme POs for Dispatch into one, up to $2,000',key:/name="key" value="([^"]+)"/.exec(text)[1]}).expect(303);
  assert.match(await page(),/Growth needs an individually approved freight-saving example/);
  assert.match(await page('Purchase orders over $5,000 go to Sarah for approval, not me'),/This rule needs Pro/);

  await subscribe('pro');
  text=await page('Orders over $5,000 go to Sarah for approval, not me');
  assert.match(text,/StockChief reads “orders” here as purchase orders/);assert.match(text,/Purchase orders over \$5,000\.00 go to Sarah Cohen for approval instead of you\./);
  await confirm('Orders over $5,000 go to Sarah for approval, not me');
  const route=(await db.query('SELECT kind,above_minor::int,currency,user_id FROM stockchief_runtime.agent_approval_routes WHERE workspace_id=$1 AND enabled',[ws])).rows;
  assert.deepEqual(route.map(r=>({...r})),[{kind:'purchase',above_minor:500000,currency:'USD',user_id:sarah.actorId}]);
  assert.match((await confirm('Orders over $5,000 go to Sarah for approval, not me')).shown,/already saved/);
  assert.match(await page('Refunds over $500 go to Sarah, not me'),/Sarah Cohen cannot approve refunds and credits/);
  await confirm('Combine Acme POs for Dispatch into one, up to $2,000');
  assert.equal(Number((await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_freight_combine_rules WHERE workspace_id=$1 AND supplier_id=$2',[ws,acme.id])).rows[0].maximum_minor),200000);
  assert.match(await page('Always split Acme POs over €10,000 by warehouse'),/Acme uses USD\. Write the amount in USD/);
  text=await page('Always split Acme POs over $10,000 by delivery date');
  assert.match(text,/split into one order for each delivery date on its lines\.[\s\S]*It covers receiving at Dispatch/);
  await browser.post(rules.path+'/confirm').type('form').send({_csrf:f.csrf(text),rule:'Always split Acme POs over $10,000 by delivery date',key:/name="key" value="([^"]+)"/.exec(text)[1]}).expect(303);
  assert.match(await page(),/Pro needs a completed individually approved split/);

  await subscribe('enterprise');
  await confirm('Always split Acme POs over $10,000 by delivery date');
  const split=(await db.query('SELECT strategy,maximum_source_minor::int,location_ids FROM stockchief_runtime.agent_purchase_split_rules WHERE workspace_id=$1 AND supplier_id=$2',[ws,acme.id])).rows[0];
  assert.deepEqual({...split},{strategy:'delivery-date',maximum_source_minor:1000000,location_ids:[f.location.id]});
  assert.match(await page(),/You use 8 of unlimited rules/);
  // The rules review lists the rules page.
  assert.ok((await require('../../src/autopilot/job-reviews').run(db,ctx,'plain-words-rules')).rows.some(r=>r.link===rules.path));

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1600,height:1000},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+rules.path);
    await tab.locator('textarea[name=rule]').fill('Never order A-SHOE from Beta');
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Read my rule'}).click()]);
    assert(await tab.getByRole('heading',{name:'What this rule will do'}).isVisible(),name);
    assert(await tab.getByRole('button',{name:'That’s right, save it'}).isVisible(),name);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'plain-rules-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
